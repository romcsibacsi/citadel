// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { type Clock, systemClock, isoNow } from '../core/clock.js';
import { sanitizeId } from '../trust/sanitize.js';
import { ConnectorStore, type ConnectorRecord, type ConnectorScope, type ConnectorType } from './store.js';
import { CATALOG, type CatalogEntry } from './catalog.js';

/**
 * Connector service (PROMPT-13). Owns the operator-facing connector lifecycle
 * over the store + the shipped catalog. The live `claude mcp` scan is behind a
 * seam (a manual refresh stamps the cache time); everything the operator adds
 * here is real and persisted. Secret VALUES never touch this layer — only env
 * var names.
 */

export type ConnectorErrorCode = 'name_required' | 'url_required' | 'command_required' | 'not_found' | 'invalid_path';

export class ConnectorError extends Error {
  constructor(readonly code: ConnectorErrorCode, readonly httpStatus = 400) {
    super(code);
  }
}

export interface AddConnectorInput {
  name?: string;
  type?: ConnectorType | 'http' | 'sse' | 'stdio';
  url?: string;
  command?: string;
  args?: string;
  scope?: ConnectorScope;
  env?: string[];
  agents?: string[];
}

/** Letters, numbers, hyphen, underscore — spaces become hyphens, rest dropped. */
export function sanitizeConnectorName(raw: string): string {
  return raw.trim().replace(/\s+/g, '-').replace(/[^A-Za-z0-9_-]/g, '');
}

/** stdio -> local, http/sse/remote -> remote. */
function transportType(t: string | undefined): ConnectorType {
  if (t === 'http' || t === 'sse' || t === 'remote') return 'remote';
  if (t === 'plugin') return 'plugin';
  return 'local';
}

/**
 * Does a repo name carry a catalog id as a *delimited token* (not a loose
 * substring)? Mirrors serverNameMatches' discipline so e.g. `acme/stripe-mcp`
 * matches `stripe` but `someone/striped-ui` / `foo/postgresql-utils` do not.
 */
function nameCarriesCatalogId(name: string, id: string): boolean {
  if (id === '') return false;
  const token = id.replace(/[^a-z0-9-]/g, '');
  if (token === '') return false;
  return new RegExp(`(^|[^a-z0-9])${token}([^a-z0-9]|$)`).test(name.toLowerCase());
}

/** A catalog entry matches a config-declared server by exact id/name-slug or the `<id>-<variant>` convention. */
function serverNameMatches(names: Set<string>, id: string, name: string): boolean {
  if (names.size === 0) return false;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  for (const raw of names) {
    const n = raw.toLowerCase();
    if (n === id || n === slug) return true;
    if (n.startsWith(`${id}-`) || (slug !== '' && n.startsWith(`${slug}-`))) return true;
  }
  return false;
}

export class ConnectorService {
  constructor(
    private readonly store: ConnectorStore,
    private readonly clock: Clock = systemClock,
  ) {}

  list(): ConnectorRecord[] {
    return this.store.list();
  }

  status(): { cacheLastRefreshed: string | null; cacheError: string | null; refreshing: boolean } {
    return {
      cacheLastRefreshed: this.store.getMeta('cacheLastRefreshed') ?? null,
      cacheError: this.store.getMeta('cacheError') ?? null,
      refreshing: false,
    };
  }

  /** Manual, non-destructive re-scan stamp (the heavy live scan is a seam). */
  refresh(): { ok: true; count: number; lastRefreshed: string; error: null } {
    const now = isoNow(this.clock);
    this.store.setMeta('cacheLastRefreshed', now);
    this.store.setMeta('cacheError', '');
    const count = this.store.list().filter((c) => c.scope === 'user' || c.scope === 'plugin').length;
    return { ok: true, count, lastRefreshed: now, error: null };
  }

  /**
   * Shipped catalog overlaid with user customs, annotated installed/source.
   * `configServers` (MCP server names declared in managed config files) lets a
   * catalog entry already present in a config show as installed via configMatch
   * (FIX-13 §3) — by exact id/name-slug or the `<id>-<variant>` convention.
   */
  catalog(configServers: Set<string> = new Set()): Array<CatalogEntry & { installed: boolean; installedSource: string | null; configMatch: boolean }> {
    const configured = this.store.list();
    const byCatalogId = new Map<string, ConnectorRecord>();
    for (const c of configured) {
      const key = c.catalogId ?? c.name;
      if (!byCatalogId.has(key)) byCatalogId.set(key, c);
    }
    const shipped = CATALOG.map((entry) => {
      const match = byCatalogId.get(entry.id);
      const cfg = serverNameMatches(configServers, entry.id, entry.name);
      return {
        ...entry,
        installed: match !== undefined || cfg,
        installedSource: match?.source ?? (cfg ? 'config' : null),
        configMatch: match === undefined && cfg,
      };
    });
    // user customs that are not shipped entries appear as appended catalog items
    const shippedIds = new Set(CATALOG.map((e) => e.id));
    const customs = configured
      .filter((c) => c.scope === 'user' && (c.catalogId === null || !shippedIds.has(c.catalogId)))
      .map((c) => ({
        id: c.name,
        name: c.name,
        description: '',
        type: (c.type === 'remote' ? 'remote' : 'local') as 'local' | 'remote',
        category: 'custom',
        icon: '🔧',
        ...(c.type === 'remote' ? { url: c.endpoint ?? '' } : { command: c.endpoint ?? '' }),
        env: c.envNames,
        authType: 'none' as const,
        installed: true,
        installedSource: c.source,
        configMatch: false,
      }));
    return [...shipped, ...customs];
  }

  installFromCatalog(id: string, env: Record<string, string>): { ok: true; message: string } {
    const entry = CATALOG.find((e) => e.id === id);
    if (entry === undefined) throw new ConnectorError('not_found', 404);
    // remove any prior install of the same id, then register (env NAMES only)
    this.store.byName(entry.id).forEach((c) => this.store.deleteByName(c.name));
    this.store.add({
      name: entry.id,
      scope: 'user',
      type: entry.type === 'remote' ? 'remote' : 'local',
      endpoint: entry.type === 'remote' ? (entry.url ?? null) : `${entry.command ?? ''} ${entry.args ?? ''}`.trim(),
      source: 'local-user',
      status: entry.authType === 'oauth' ? 'needs_auth' : 'configured',
      envNames: Object.keys(env),
      catalogId: entry.id,
    });
    const suffix = entry.authType === 'oauth' && entry.authNote ? ` ${entry.authNote}` : '';
    return { ok: true, message: `${entry.name} installed.${suffix}` };
  }

  uninstallFromCatalog(id: string): { ok: true; message: string } {
    const entry = CATALOG.find((e) => e.id === id);
    const name = entry?.id ?? id;
    const removed = this.store.deleteByName(name);
    if (removed === 0) throw new ConnectorError('not_found', 404);
    return { ok: true, message: `${entry?.name ?? name} removed.` };
  }

  addConnector(input: AddConnectorInput): { ok: true; name: string; nameChanged: boolean } {
    const raw = (input.name ?? '').trim();
    if (raw === '') throw new ConnectorError('name_required');
    const name = sanitizeConnectorName(raw);
    if (name === '') throw new ConnectorError('name_required');
    const type = transportType(input.type);
    const scope: ConnectorScope = input.scope === 'project' ? 'project' : 'user';
    let endpoint: string;
    if (type === 'remote') {
      const url = (input.url ?? '').trim();
      if (url === '') throw new ConnectorError('url_required');
      endpoint = url;
    } else {
      const command = (input.command ?? '').trim();
      if (command === '') throw new ConnectorError('command_required');
      endpoint = [command, (input.args ?? '').trim()].filter((s) => s !== '').join(' ');
    }
    this.store.byName(name).forEach((c) => this.store.deleteByName(c.name));
    this.store.add({
      name,
      scope,
      type,
      endpoint,
      source: scope === 'project' ? 'local-project' : 'local-user',
      status: 'configured',
      envNames: (input.env ?? []).filter((s) => typeof s === 'string' && s !== ''),
      catalogId: null,
    });
    if (scope === 'project' && Array.isArray(input.agents) && input.agents.length > 0) {
      const agents = input.agents.map((a) => sanitizeId(a)).filter((a) => a !== '');
      this.store.setAgentAssignments(name, agents, agents);
    }
    return { ok: true, name, nameChanged: name !== raw };
  }

  detail(name: string): { name: string; status: string; scope: string; type: string; command: string | null; env: string[]; enabled: boolean } {
    const records = this.store.byName(name);
    if (records.length === 0) throw new ConnectorError('not_found', 404);
    const base = records.find((c) => c.scope !== 'agent') ?? records[0]!;
    return {
      name: base.name,
      status: base.status,
      scope: base.scope,
      type: base.type,
      command: base.type === 'local' ? base.endpoint : null,
      // mask: env NAMES only, values are always *** (never stored here)
      env: base.envNames.map((k) => `${k}=***`),
      enabled: base.enabled,
    };
  }

  /** Enable/disable a connector (FIX-connectors-custom-mcp). On DISABLE, tear down
   *  the connector's live agent-scoped wiring immediately so it actually stops being
   *  available (FIX-hardening B); on enable it becomes eligible again at the next
   *  assign. The base row is kept either way (the connector stays visible). */
  setEnabled(name: string, enabled: boolean): { ok: true; name: string; enabled: boolean } {
    if (this.store.setEnabled(name, enabled) === 0) throw new ConnectorError('not_found', 404);
    if (!enabled) this.store.removeAgentCopies(name);
    return { ok: true, name, enabled };
  }

  /** Which sub-agents this connector is currently assigned to. */
  assignedAgents(name: string): string[] {
    return this.store.byName(name).filter((c) => c.scope === 'agent' && c.agentId).map((c) => c.agentId!);
  }

  assign(name: string, checked: string[], visible: string[]): { ok: true } {
    if (this.store.byName(name).length === 0) throw new ConnectorError('not_found', 404);
    const clean = (xs: string[]): string[] => xs.map((a) => sanitizeId(a)).filter((a) => a !== '');
    this.store.setAgentAssignments(name, clean(checked), clean(visible));
    return { ok: true };
  }

  deleteConnector(name: string): { ok: true; removed: number } {
    const removed = this.store.deleteByName(name);
    if (removed === 0) throw new ConnectorError('not_found', 404);
    return { ok: true, removed };
  }

  // --- github repos ---
  listRepos(): Array<{ name: string; url: string; installedAt: string }> {
    return this.store.listRepos();
  }
  installRepo(url: string): { ok: true; name: string; needsEnv: string[] } {
    const trimmed = url.trim();
    if (trimmed === '') throw new ConnectorError('url_required');
    const m = /github\.com[/:]([^/]+)\/([^/.]+)/i.exec(trimmed);
    const name = m ? `${m[1]}/${m[2]}` : sanitizeConnectorName(trimmed) || 'repo';
    this.store.addRepo(name, trimmed);
    // A real clone can't be inspected here; the honest signal for "this repo
    // declares required env vars" is a matching catalog entry that documents them
    // (FIX-13 §1). When the repo name carries a known apikey connector id as a
    // delimited token, surface its env so the UI can prompt + vault the values.
    const entry = CATALOG.find((e) => e.authType === 'apikey' && e.env.length > 0 && nameCarriesCatalogId(name, e.id));
    return { ok: true, name, needsEnv: entry ? [...entry.env] : [] };
  }
  updateRepo(name: string): { ok: true } {
    if (this.store.getRepo(name) === undefined) throw new ConnectorError('not_found', 404);
    this.store.addRepo(name, this.store.getRepo(name)!.url);
    return { ok: true };
  }
  deleteRepo(name: string): { ok: true } {
    if (!this.store.deleteRepo(name)) throw new ConnectorError('not_found', 404);
    return { ok: true };
  }

  // --- external paths ---
  listPaths(): Array<{ path: string; createdAt: string }> {
    return this.store.listPaths();
  }
  addPath(path: string): { ok: true } {
    const p = path.trim();
    if (p === '' || !p.startsWith('/')) throw new ConnectorError('invalid_path');
    this.store.addPath(p);
    return { ok: true };
  }
  deletePath(path: string): { ok: true } {
    if (!this.store.deletePath(path)) throw new ConnectorError('not_found', 404);
    return { ok: true };
  }
}
