// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { type Clock, systemClock, isoNow } from '../core/clock.js';

/**
 * Background-task store (PROMPT-12). One row per launched one-shot job.
 *
 * Invariants:
 *  - status is constrained to running/done/failed/timeout (also a DB CHECK);
 *  - the per-agent concurrency cap is enforced by createAtomic() inside a single
 *    BEGIN IMMEDIATE transaction so two near-simultaneous launches can't both
 *    slip past the cap;
 *  - finalize() is the only path that writes a terminal status + output.
 */

export const BG_STATUSES = ['running', 'done', 'failed', 'timeout'] as const;
export type BackgroundStatus = (typeof BG_STATUSES)[number];

export interface BackgroundTask {
  id: string;
  agentId: string;
  prompt: string;
  status: BackgroundStatus;
  startedAt: string;
  finishedAt: string | null;
  output: string | null;
}

export interface ListOptions {
  agentId?: string;
  includeFinished?: boolean;
}

/** Thrown by createAtomic() when the agent is already at the running cap. */
export class CapReachedError extends Error {
  constructor(readonly cap: number) {
    super(`per-agent background cap reached: ${cap}`);
  }
}

const COLUMNS = 'task_id, agent_id, prompt, status, started_at, finished_at, output';

interface DbRow {
  task_id: string;
  agent_id: string;
  prompt: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  output: string | null;
}

function mapTask(r: DbRow): BackgroundTask {
  return {
    id: r.task_id,
    agentId: r.agent_id,
    prompt: r.prompt,
    status: r.status as BackgroundStatus,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    output: r.output,
  };
}

export class BackgroundTaskStore {
  private readonly insertStmt: StatementSync;
  private readonly getStmt: StatementSync;
  private readonly countRunningStmt: StatementSync;
  private readonly finalizeStmt: StatementSync;
  private readonly runningStmt: StatementSync;

  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: Clock = systemClock,
  ) {
    this.insertStmt = db.prepare(
      `INSERT INTO background_tasks (task_id, agent_id, prompt, status, started_at)
       VALUES (?, ?, ?, 'running', ?)`,
    );
    this.getStmt = db.prepare(`SELECT ${COLUMNS} FROM background_tasks WHERE task_id = ?`);
    this.countRunningStmt = db.prepare(
      `SELECT COUNT(*) AS n FROM background_tasks WHERE agent_id = ? AND status = 'running'`,
    );
    this.finalizeStmt = db.prepare(
      `UPDATE background_tasks SET status = ?, output = ?, finished_at = ?
       WHERE task_id = ? AND status = 'running'`,
    );
    this.runningStmt = db.prepare(
      `SELECT ${COLUMNS} FROM background_tasks WHERE status = 'running' ORDER BY rowid_pk DESC`,
    );
  }

  /**
   * Reserve a running slot for the agent, enforcing the cap atomically. Throws
   * CapReachedError (rolled back) when the agent is already at the cap.
   */
  createAtomic(input: { taskId: string; agentId: string; prompt: string }, cap: number): BackgroundTask {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const running = (this.countRunningStmt.get(input.agentId) as { n: number }).n;
      if (running >= cap) {
        this.db.exec('ROLLBACK');
        throw new CapReachedError(cap);
      }
      this.insertStmt.run(input.taskId, input.agentId, input.prompt, isoNow(this.clock));
      this.db.exec('COMMIT');
      return this.require(input.taskId);
    } catch (err) {
      if (err instanceof CapReachedError) throw err;
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  get(taskId: string): BackgroundTask | undefined {
    const row = this.getStmt.get(taskId) as DbRow | undefined;
    return row === undefined ? undefined : mapTask(row);
  }

  /** Running-first, newest-first. Finished rows only when asked, capped to 50. */
  list(opts: ListOptions = {}): BackgroundTask[] {
    const where: string[] = [];
    const params: string[] = [];
    if (opts.agentId !== undefined && opts.agentId !== '') {
      where.push('agent_id = ?');
      params.push(opts.agentId);
    }
    if (opts.includeFinished !== true) where.push("status = 'running'");
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const order = "ORDER BY (status = 'running') DESC, rowid_pk DESC";
    const limit = opts.includeFinished === true ? ' LIMIT 50' : '';
    const rows = this.db.prepare(`SELECT ${COLUMNS} FROM background_tasks ${clause} ${order}${limit}`).all(...params) as unknown as DbRow[];
    return rows.map(mapTask);
  }

  /** All still-running rows (for the completion poller + the restart sweep). */
  running(): BackgroundTask[] {
    return (this.runningStmt.all() as unknown as DbRow[]).map(mapTask);
  }

  /** Terminal write — only affects a still-running row (idempotent under races). */
  finalize(taskId: string, status: BackgroundStatus, output: string | null): BackgroundTask | undefined {
    this.finalizeStmt.run(status, output, isoNow(this.clock), taskId);
    return this.get(taskId);
  }

  private require(taskId: string): BackgroundTask {
    const task = this.get(taskId);
    if (task === undefined) throw new Error(`background task not found: ${taskId}`);
    return task;
  }
}
