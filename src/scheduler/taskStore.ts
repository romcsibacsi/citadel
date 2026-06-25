// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import type { DatabaseSync } from 'node:sqlite';
import { systemClock, isoNow, type Clock } from '../core/clock.js';
import { parseCron } from './cron.js';

/** Dashboard CRUD over scheduled_tasks (the runner only reads them). */

export type ScheduledTaskType = 'task' | 'heartbeat';

export interface ScheduledTask {
  id: string;
  title: string;
  prompt: string;
  cron: string;
  target: string;
  type: ScheduledTaskType;
  enabled: boolean;
  skipIfBusy: boolean;
  forceSend: boolean;
  bypassTriage: boolean;
  sessionTarget?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskInput {
  id: string;
  title: string;
  prompt: string;
  cron: string;
  target: string;
  type?: ScheduledTaskType;
  enabled?: boolean;
  skipIfBusy?: boolean;
  forceSend?: boolean;
  bypassTriage?: boolean;
  sessionTarget?: string;
}

export interface RetryRow {
  id: number;
  taskId: string;
  target: string;
  prompt: string;
  queuedAt: string;
  attempts: number;
  lastAttemptAt?: string;
  alerted: boolean;
  status: string;
  lastReason?: string;
}

interface DbTaskRow {
  id: string;
  title: string;
  prompt: string;
  cron: string;
  target: string;
  type: string;
  enabled: number;
  skip_if_busy: number;
  force_send: number;
  bypass_triage: number;
  session_target: string | null;
  created_at: string;
  updated_at: string;
}

function toTask(row: DbTaskRow): ScheduledTask {
  return {
    id: row.id,
    title: row.title,
    prompt: row.prompt,
    cron: row.cron,
    target: row.target,
    type: row.type === 'heartbeat' ? 'heartbeat' : 'task',
    enabled: row.enabled === 1,
    skipIfBusy: row.skip_if_busy === 1,
    forceSend: row.force_send === 1,
    bypassTriage: row.bypass_triage === 1,
    ...(row.session_target !== null ? { sessionTarget: row.session_target } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ScheduledTaskStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: Clock = systemClock,
  ) {}

  list(): ScheduledTask[] {
    const rows = this.db.prepare('SELECT * FROM scheduled_tasks ORDER BY id').all() as unknown as DbTaskRow[];
    return rows.map(toTask);
  }

  get(id: string): ScheduledTask | undefined {
    const row = this.db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as DbTaskRow | undefined;
    return row ? toTask(row) : undefined;
  }

  create(input: TaskInput): ScheduledTask {
    parseCron(input.cron); // validate up front — throws on a bad expression
    const now = isoNow(this.clock);
    this.db
      .prepare(
        `INSERT INTO scheduled_tasks
         (id, title, prompt, cron, target, type, enabled, skip_if_busy, force_send, bypass_triage, session_target, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.title,
        input.prompt,
        input.cron,
        input.target,
        input.type ?? 'task',
        input.enabled === false ? 0 : 1,
        input.skipIfBusy === true ? 1 : 0,
        input.forceSend === true ? 1 : 0,
        input.bypassTriage === true ? 1 : 0,
        input.sessionTarget ?? null,
        now,
        now,
      );
    return this.get(input.id)!;
  }

  update(id: string, patch: Partial<Omit<TaskInput, 'id'>>): ScheduledTask {
    const existing = this.get(id);
    if (!existing) throw new Error(`scheduled task not found: ${id}`);
    if (patch.cron !== undefined) parseCron(patch.cron);
    const merged = { ...existing, ...patch };
    this.db
      .prepare(
        `UPDATE scheduled_tasks SET title=?, prompt=?, cron=?, target=?, type=?, enabled=?, skip_if_busy=?, force_send=?, bypass_triage=?, session_target=?, updated_at=? WHERE id=?`,
      )
      .run(
        merged.title,
        merged.prompt,
        merged.cron,
        merged.target,
        merged.type ?? 'task',
        merged.enabled === false ? 0 : 1,
        merged.skipIfBusy === true ? 1 : 0,
        merged.forceSend === true ? 1 : 0,
        merged.bypassTriage === true ? 1 : 0,
        merged.sessionTarget ?? null,
        isoNow(this.clock),
        id,
      );
    return this.get(id)!;
  }

  toggle(id: string): ScheduledTask {
    const existing = this.get(id);
    if (!existing) throw new Error(`scheduled task not found: ${id}`);
    return this.update(id, { enabled: !existing.enabled });
  }

  delete(id: string): boolean {
    const res = this.db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
    return res.changes > 0;
  }

  pendingRetries(): RetryRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM task_retry_queue WHERE status = 'pending' ORDER BY queued_at`)
      .all() as unknown as Array<{
      id: number;
      task_id: string;
      target: string;
      prompt: string;
      queued_at: string;
      attempts: number;
      last_attempt_at: string | null;
      alerted: number;
      status: string;
      last_reason: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      taskId: r.task_id,
      target: r.target,
      prompt: r.prompt,
      queuedAt: r.queued_at,
      attempts: r.attempts,
      ...(r.last_attempt_at !== null ? { lastAttemptAt: r.last_attempt_at } : {}),
      alerted: r.alerted === 1,
      status: r.status,
      ...(r.last_reason !== null ? { lastReason: r.last_reason } : {}),
    }));
  }

  recentRuns(taskId?: string, limit = 50): Array<{ id: number; taskId: string; firedAt: string; outcome: string; detail?: string }> {
    const rows = (
      taskId !== undefined
        ? this.db.prepare('SELECT * FROM task_runs WHERE task_id = ? ORDER BY id DESC LIMIT ?').all(taskId, limit)
        : this.db.prepare('SELECT * FROM task_runs ORDER BY id DESC LIMIT ?').all(limit)
    ) as unknown as Array<{ id: number; task_id: string; fired_at: string; outcome: string; detail: string | null }>;
    return rows.map((r) => ({
      id: r.id,
      taskId: r.task_id,
      firedAt: r.fired_at,
      outcome: r.outcome,
      ...(r.detail !== null ? { detail: r.detail } : {}),
    }));
  }
}
