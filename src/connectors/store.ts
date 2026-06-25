// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { type Clock, systemClock, isoNow } from '../core/clock.js';

/**
 * Connector store (PROMPT-13 §9). Persists the operator-managed pieces:
 * configured connectors (with scope/source/agent), github-repo installs,
 * external project paths, and a tiny meta kv for the live-cache status. Secret
 * VALUES never live here — only env var names (values live in the vault).
 */

export type ConnectorScope = 'user' | 'project' | 'agent' | 'external' | 'plugin';
export type ConnectorType = 'local' | 'remote' | 'plugin';
export type ConnectorStatus = 'connected' | 'configured' | 'needs_auth' | 'failed' | 'unknown';

export interface ConnectorRecord {
  id: number;
  name: string;
  scope: ConnectorScope;
  agentId: string | null;
  type: ConnectorType;
  endpoint: string | null;
  source: string;
  status: ConnectorStatus;
  envNames: string[];
  catalogId: string | null;
  createdAt: string;
  /** Per-connector on/off (FIX-connectors-custom-mcp); defaults true. */
  enabled: boolean;
}

export interface NewConnector {
  name: string;
  scope: ConnectorScope;
  agentId?: string | null;
  type: ConnectorType;
  endpoint?: string | null;
  source: string;
  status?: ConnectorStatus;
  envNames?: string[];
  catalogId?: string | null;
}

export interface RepoRecord {
  name: string;
  url: string;
  installedAt: string;
}
export interface PathRecord {
  path: string;
  createdAt: string;
}

const COLS = 'rowid_pk, name, scope, agent_id, type, endpoint, source, status, env_names, catalog_id, created_at, enabled';

interface DbConnectorRow {
  rowid_pk: number;
  name: string;
  scope: string;
  agent_id: string | null;
  type: string;
  endpoint: string | null;
  source: string;
  status: string;
  env_names: string;
  catalog_id: string | null;
  created_at: string;
  enabled: number;
}

function mapConnector(r: DbConnectorRow): ConnectorRecord {
  let envNames: string[] = [];
  try {
    const parsed = JSON.parse(r.env_names) as unknown;
    if (Array.isArray(parsed)) envNames = parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    /* tolerate a corrupt row */
  }
  return {
    id: r.rowid_pk,
    name: r.name,
    scope: r.scope as ConnectorScope,
    agentId: r.agent_id,
    type: r.type as ConnectorType,
    endpoint: r.endpoint,
    source: r.source,
    status: r.status as ConnectorStatus,
    envNames,
    catalogId: r.catalog_id,
    createdAt: r.created_at,
    enabled: r.enabled !== 0,
  };
}

export class ConnectorStore {
  private readonly insertStmt: StatementSync;
  private readonly listStmt: StatementSync;
  private readonly byNameStmt: StatementSync;
  private readonly deleteByNameStmt: StatementSync;
  private readonly deleteAgentCopyStmt: StatementSync;
  private readonly insertRepoStmt: StatementSync;
  private readonly listReposStmt: StatementSync;
  private readonly getRepoStmt: StatementSync;
  private readonly deleteRepoStmt: StatementSync;
  private readonly insertPathStmt: StatementSync;
  private readonly listPathsStmt: StatementSync;
  private readonly deletePathStmt: StatementSync;
  private readonly getMetaStmt: StatementSync;
  private readonly setMetaStmt: StatementSync;

  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: Clock = systemClock,
  ) {
    this.insertStmt = db.prepare(
      `INSERT INTO connectors (name, scope, agent_id, type, endpoint, source, status, env_names, catalog_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.listStmt = db.prepare(`SELECT ${COLS} FROM connectors ORDER BY rowid_pk ASC`);
    this.byNameStmt = db.prepare(`SELECT ${COLS} FROM connectors WHERE name = ? ORDER BY rowid_pk ASC`);
    this.deleteByNameStmt = db.prepare('DELETE FROM connectors WHERE name = ?');
    this.deleteAgentCopyStmt = db.prepare("DELETE FROM connectors WHERE name = ? AND scope = 'agent' AND agent_id = ?");
    this.insertRepoStmt = db.prepare('INSERT OR REPLACE INTO connector_repos (name, url, installed_at) VALUES (?, ?, ?)');
    this.listReposStmt = db.prepare('SELECT name, url, installed_at FROM connector_repos ORDER BY rowid_pk DESC');
    this.getRepoStmt = db.prepare('SELECT name, url, installed_at FROM connector_repos WHERE name = ?');
    this.deleteRepoStmt = db.prepare('DELETE FROM connector_repos WHERE name = ?');
    this.insertPathStmt = db.prepare('INSERT OR IGNORE INTO connector_paths (path, created_at) VALUES (?, ?)');
    this.listPathsStmt = db.prepare('SELECT path, created_at FROM connector_paths ORDER BY rowid_pk DESC');
    this.deletePathStmt = db.prepare('DELETE FROM connector_paths WHERE path = ?');
    this.getMetaStmt = db.prepare('SELECT v FROM connector_meta WHERE k = ?');
    this.setMetaStmt = db.prepare('INSERT OR REPLACE INTO connector_meta (k, v) VALUES (?, ?)');
  }

  list(): ConnectorRecord[] {
    return (this.listStmt.all() as unknown as DbConnectorRow[]).map(mapConnector);
  }

  byName(name: string): ConnectorRecord[] {
    return (this.byNameStmt.all(name) as unknown as DbConnectorRow[]).map(mapConnector);
  }

  add(c: NewConnector): ConnectorRecord {
    this.insertStmt.run(
      c.name,
      c.scope,
      c.agentId ?? null,
      c.type,
      c.endpoint ?? null,
      c.source,
      c.status ?? 'configured',
      JSON.stringify(c.envNames ?? []),
      c.catalogId ?? null,
      isoNow(this.clock),
    );
    return this.byName(c.name)[0]!;
  }

  deleteByName(name: string): number {
    return Number(this.deleteByNameStmt.run(name).changes);
  }

  /** Flip a connector (all its scoped rows) on/off. Returns rows changed. */
  setEnabled(name: string, enabled: boolean): number {
    return Number(this.db.prepare('UPDATE connectors SET enabled = ? WHERE name = ?').run(enabled ? 1 : 0, name).changes);
  }

  /** Remove ALL agent-scoped copies of a connector (used to tear down live wiring
   *  when a connector is disabled — FIX-hardening B). Returns rows removed. */
  removeAgentCopies(name: string): number {
    return Number(this.db.prepare("DELETE FROM connectors WHERE name = ? AND scope = 'agent'").run(name).changes);
  }

  /**
   * Set which sub-agents have an agent-scoped copy of a connector (assign). This is
   * the single materialization choke point for live MCP wiring, so it ENFORCES the
   * enabled flag (FIX-hardening B): a DISABLED base connector wires to NO agent —
   * create no agent copies and tear down any existing ones. Derived purely from the
   * stored flag (no separate disabled-list); idempotent.
   */
  setAgentAssignments(name: string, checked: string[], visible: string[]): void {
    const rows = this.byName(name);
    const template = rows.find((c) => c.scope !== 'agent') ?? rows[0];
    if (template === undefined) return;
    if (template.enabled === false) {
      this.removeAgentCopies(name); // disabled → no live wiring, ever
      return;
    }
    const existing = new Set(rows.filter((c) => c.scope === 'agent' && c.agentId).map((c) => c.agentId!));
    for (const agent of checked) {
      if (!existing.has(agent)) {
        this.add({ ...template, scope: 'agent', agentId: agent, source: 'agent' });
      }
    }
    for (const agent of visible) {
      if (!checked.includes(agent) && existing.has(agent)) {
        this.deleteAgentCopyStmt.run(name, agent);
      }
    }
  }

  // --- github repos ---
  listRepos(): RepoRecord[] {
    return (this.listReposStmt.all() as Array<{ name: string; url: string; installed_at: string }>).map((r) => ({ name: r.name, url: r.url, installedAt: r.installed_at }));
  }
  getRepo(name: string): RepoRecord | undefined {
    const r = this.getRepoStmt.get(name) as { name: string; url: string; installed_at: string } | undefined;
    return r === undefined ? undefined : { name: r.name, url: r.url, installedAt: r.installed_at };
  }
  addRepo(name: string, url: string): RepoRecord {
    this.insertRepoStmt.run(name, url, isoNow(this.clock));
    return this.getRepo(name)!;
  }
  deleteRepo(name: string): boolean {
    return Number(this.deleteRepoStmt.run(name).changes) > 0;
  }

  // --- external paths ---
  listPaths(): PathRecord[] {
    return (this.listPathsStmt.all() as Array<{ path: string; created_at: string }>).map((r) => ({ path: r.path, createdAt: r.created_at }));
  }
  addPath(path: string): void {
    this.insertPathStmt.run(path, isoNow(this.clock));
  }
  deletePath(path: string): boolean {
    return Number(this.deletePathStmt.run(path).changes) > 0;
  }

  // --- live-cache meta ---
  getMeta(key: string): string | undefined {
    const r = this.getMetaStmt.get(key) as { v: string } | undefined;
    return r?.v;
  }
  setMeta(key: string, value: string): void {
    this.setMetaStmt.run(key, value);
  }
}
