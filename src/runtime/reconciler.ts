// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * Desired-run-state persistence + reconciler (SPEC §3, §19 CORE).
 *
 * The operator's intent ("which agents should be running") is persisted
 * separately from runtime reality; the reconciler moves reality toward intent:
 * start the desired-but-down (STAGGERED, to avoid a thundering herd after a
 * mass outage), stop the running-but-undesired, leave everything else alone.
 */

import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { createLogger } from '../core/log.js';
import { isoNow, systemClock, type Clock } from '../core/clock.js';

const log = createLogger('runtime.reconciler');

export type DesiredRunState = 'running' | 'stopped';

export interface DesiredStateRow {
  agentId: string;
  desired: DesiredRunState;
  updatedAt: string;
}

/** Persistent operator intent, table agent_desired_state (src/db/migrations.ts). */
export class DesiredStateStore {
  private readonly upsertStmt: StatementSync;
  private readonly getStmt: StatementSync;
  private readonly allStmt: StatementSync;

  constructor(
    db: DatabaseSync,
    private readonly clock: Clock = systemClock,
  ) {
    this.upsertStmt = db.prepare(
      `INSERT INTO agent_desired_state (agent_id, desired, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(agent_id) DO UPDATE SET desired = excluded.desired, updated_at = excluded.updated_at`,
    );
    this.getStmt = db.prepare('SELECT desired FROM agent_desired_state WHERE agent_id = ?');
    this.allStmt = db.prepare(
      'SELECT agent_id, desired, updated_at FROM agent_desired_state ORDER BY agent_id',
    );
  }

  setDesired(agentId: string, desired: DesiredRunState): void {
    this.upsertStmt.run(agentId, desired, isoNow(this.clock));
  }

  /** Absent agents default to 'stopped' — intent is opt-in. */
  getDesired(agentId: string): DesiredRunState {
    const row = this.getStmt.get(agentId) as { desired: DesiredRunState } | undefined;
    return row?.desired ?? 'stopped';
  }

  all(): DesiredStateRow[] {
    const rows = this.allStmt.all() as Array<{
      agent_id: string;
      desired: DesiredRunState;
      updated_at: string;
    }>;
    return rows.map((r) => ({ agentId: r.agent_id, desired: r.desired, updatedAt: r.updated_at }));
  }
}

export interface ReconcilerDeps {
  desired: { getDesired(agentId: string): DesiredRunState };
  supervisor: {
    start(agentId: string): Promise<void>;
    stop(agentId: string): Promise<void>;
  };
  isRunning: (id: string) => Promise<boolean>;
  /** The current roster of reconcilable agent ids (config-driven, never hardcoded). */
  roster: () => string[];
  /** Delay between consecutive staggered starts (first start is immediate). */
  staggerMs: number;
  /** Injectable for deterministic tests; default is a real setTimeout sleep. */
  sleep?: (ms: number) => Promise<void>;
}

export interface ReconcileResult {
  started: string[];
  stopped: string[];
}

export class Reconciler {
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: ReconcilerDeps) {
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * One reconciliation pass. Per-agent failures are logged and skipped — one
   * broken agent must never block the rest of the roster.
   */
  async reconcile(): Promise<ReconcileResult> {
    const toStart: string[] = [];
    const toStop: string[] = [];

    for (const agentId of this.deps.roster()) {
      const want = this.deps.desired.getDesired(agentId);
      let running: boolean;
      try {
        running = await this.deps.isRunning(agentId);
      } catch (err) {
        log.warn('isRunning probe failed; skipping agent this pass', {
          agentId,
          error: String(err),
        });
        continue;
      }
      if (want === 'running' && !running) toStart.push(agentId);
      else if (want === 'stopped' && running) toStop.push(agentId);
      // desired matches reality -> leave it alone.
    }

    const stopped: string[] = [];
    for (const agentId of toStop) {
      try {
        await this.deps.supervisor.stop(agentId);
        stopped.push(agentId);
      } catch (err) {
        log.warn('reconcile stop failed', { agentId, error: String(err) });
      }
    }

    const started: string[] = [];
    for (let i = 0; i < toStart.length; i++) {
      // Staggered starts: first immediately, then sleep(staggerMs) between
      // each subsequent start (SPEC §3 — no thundering herd on mass restart).
      if (i > 0) await this.sleep(this.deps.staggerMs);
      const agentId = toStart[i]!;
      try {
        await this.deps.supervisor.start(agentId);
        started.push(agentId);
      } catch (err) {
        log.warn('reconcile start failed', { agentId, error: String(err) });
      }
    }

    if (started.length > 0 || stopped.length > 0) {
      log.info('reconcile pass complete', { started: started.length, stopped: stopped.length });
    }
    return { started, stopped };
  }
}
