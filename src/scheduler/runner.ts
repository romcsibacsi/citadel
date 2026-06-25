// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import type { DatabaseSync } from 'node:sqlite';
import { type Clock, systemClock } from '../core/clock.js';
import { createLogger } from '../core/log.js';
import { firesInWindow, parseCron, type ParsedCron } from './cron.js';

const log = createLogger('scheduler');

/**
 * Scheduler runner (SPEC §9). Owns the catch-up window, the persisted
 * last-run map and the never-abandon retry queue on top of the pure cron
 * engine in ./cron.ts.
 *
 * Invariants enforced here:
 *  - A fire mark is CLAIMED (task_last_run written) BEFORE any delivery
 *    attempt, so a crash mid-delivery can never double-fire after restart.
 *  - The first tick after construction uses the longer boot catch-up window;
 *    combined with the persisted last-run map this neither misses fires
 *    within the boot window nor re-fires across restarts.
 *  - Busy/down targets default to the persisted retry queue and are retried
 *    until delivered or operator-cancelled. skipIfBusy (silent drop) is
 *    opt-in; forceSend bypasses the busy gate.
 *  - Retry-alert idempotency: the alerted flag is claimed (UPDATE ... WHERE
 *    alerted = 0) BEFORE the alert send; a transient send failure re-arms it.
 */

export type DeliveryResult = 'delivered' | 'busy' | 'down';

export interface DeliverOptions {
  /** Bypass the target's busy gate (forceSend tasks and their queued retries). */
  force: boolean;
  taskId: string;
  type: string;
}

export interface SchedulerRunnerConfig {
  /** Catch-up window (minutes) on a normal tick. */
  catchupWindowMinutes: number;
  /** Longer window used only for the first tick after construction. */
  bootCatchupWindowMinutes: number;
  /** Minimum minutes between attempts for a queued retry. */
  retryIntervalMinutes: number;
  /** Retry attempts at/after which the operator is alerted once (default 6). */
  alertThresholdAttempts?: number;
  /**
   * Seconds inserted between sequential fan-out deliveries of a target:'all' task, so the
   * whole roster does not start its turn at once and trip the subscription rate limit
   * (#194). Default 0 (disabled) at this layer — main.ts passes the config value (10s).
   */
  fanoutStaggerSeconds?: number;
}

export interface SchedulerDeps {
  db: DatabaseSync;
  /** The one delivery path into an agent (framing/injection live elsewhere). */
  deliver: (target: string, prompt: string, opts: DeliverOptions) => Promise<DeliveryResult>;
  /** Operator alert for a stuck retry (rendering/localization is the caller's). */
  onAlert: (taskId: string, target: string, minutesStuck: number) => Promise<void>;
  /** Non-hidden agent ids — the fan-out set for target 'all'. */
  roster: () => string[];
  config: SchedulerRunnerConfig;
  /** IANA timezone the cron expressions are evaluated in. */
  timeZone: string;
  clock?: Clock;
  /** Injectable for deterministic tests; default is a real setTimeout sleep. */
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_ALERT_THRESHOLD_ATTEMPTS = 6;

const MINUTE_MS = 60_000;

interface TaskRow {
  bypass_triage: number;
  id: string;
  title: string;
  prompt: string;
  cron: string;
  target: string;
  type: string;
  skip_if_busy: number;
  force_send: number;
}

interface RetryRow {
  id: number;
  task_id: string;
  target: string;
  prompt: string;
  force_send: number;
  queued_at: string;
  attempts: number;
  last_attempt_at: string | null;
  alerted: number;
  task_type: string | null;
}

export class SchedulerService {
  private readonly db: DatabaseSync;
  private readonly clock: Clock;
  private readonly alertThreshold: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly fanoutStaggerMs: number;
  private firstTick = true;

  constructor(private readonly deps: SchedulerDeps) {
    this.db = deps.db;
    this.clock = deps.clock ?? systemClock;
    this.alertThreshold = deps.config.alertThresholdAttempts ?? DEFAULT_ALERT_THRESHOLD_ATTEMPTS;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.fanoutStaggerMs = Math.max(0, deps.config.fanoutStaggerSeconds ?? 0) * 1000;
  }

  /** Attempts at/after which a stuck retry alerts — lets the UI mark a row "alert due". */
  get alertThresholdAttempts(): number {
    return this.alertThreshold;
  }

  /**
   * Reconcile-first scheduler pass (SPEC §9): the durable never-abandon retry
   * table is processed BEFORE evaluating new cron fires, so a previously-stuck
   * must-run task takes precedence over fresh fires on the same tick. This is
   * the runner's contract — callers use this, not tick() directly.
   */
  async reconcileAndTick(): Promise<void> {
    await this.processRetryQueue();
    await this.tick();
  }

  /**
   * One scheduler pass: for every enabled task, scan the catch-up window
   * (boot-sized on the first tick) for due fire marks, claim each mark in
   * task_last_run, then deliver/queue/skip per task flags.
   */
  async tick(): Promise<void> {
    const now = this.clock.now();
    const windowMinutes = this.firstTick
      ? this.deps.config.bootCatchupWindowMinutes
      : this.deps.config.catchupWindowMinutes;
    this.firstTick = false;

    const tasks = this.db
      .prepare(
        `SELECT id, title, prompt, cron, target, type, skip_if_busy, force_send, bypass_triage
         FROM scheduled_tasks WHERE enabled = 1 ORDER BY id`,
      )
      .all() as unknown as TaskRow[];

    for (const task of tasks) {
      let parsed: ParsedCron;
      try {
        parsed = parseCron(task.cron);
      } catch (err) {
        // A broken expression must not take the whole tick down.
        log.warn('skipping task with invalid cron expression', { taskId: task.id, error: String(err) });
        continue;
      }
      const lastRunRow = this.db
        .prepare('SELECT last_run_at FROM task_last_run WHERE task_id = ?')
        .get(task.id) as { last_run_at: string } | undefined;
      const windowStartMs = now.getTime() - windowMinutes * MINUTE_MS;
      const lastRunMs = lastRunRow === undefined ? Number.NEGATIVE_INFINITY : Date.parse(lastRunRow.last_run_at);
      const fromExclusive = new Date(Math.max(windowStartMs, lastRunMs));
      const fires = firesInWindow(parsed, fromExclusive, now, this.deps.timeZone);
      for (const fire of fires) {
        // CLAIM before any delivery attempt (SPEC §9): once written, neither a
        // crash mid-delivery nor a restart can re-fire this mark.
        this.db
          .prepare(
            `INSERT INTO task_last_run (task_id, last_run_at) VALUES (?, ?)
             ON CONFLICT(task_id) DO UPDATE SET last_run_at = excluded.last_run_at`,
          )
          .run(task.id, fire.toISOString());
        await this.fireTask(task, fire.toISOString());
      }
    }
  }

  private async fireTask(task: TaskRow, firedAtIso: string): Promise<void> {
    const targets = task.target === 'all' ? this.deps.roster() : [task.target];
    if (targets.length === 0) {
      log.warn('task fired with an empty target set', { taskId: task.id, target: task.target });
      return;
    }
    for (let i = 0; i < targets.length; i++) {
      // Fan-out stagger (#194): space sequential target:'all' deliveries so the whole
      // roster does not begin its turn at once and trip the subscription rate limit.
      // BETWEEN deliveries only — never before the first, never after the last; a
      // single-target task or stagger=0 adds no delay. The fire mark is already claimed
      // (tick() wrote task_last_run before this), so an overlapping tick can never
      // re-fire the same mark while we sleep here.
      if (i > 0 && this.fanoutStaggerMs > 0) await this.sleep(this.fanoutStaggerMs);
      await this.deliverFire(task, targets[i]!, firedAtIso);
    }
  }

  private async deliverFire(task: TaskRow, target: string, firedAtIso: string): Promise<void> {
    // bypass-triage (SPEC §9): the task runs unconditionally — same busy-gate
    // bypass as forceSend (heartbeats that must fire even on quiet/busy days).
    const force = task.force_send === 1 || task.bypass_triage === 1;
    let result: DeliveryResult;
    try {
      result = await this.deps.deliver(target, task.prompt, { force, taskId: task.id, type: task.type });
    } catch (err) {
      log.error('delivery threw; treating target as down', { taskId: task.id, target, error: String(err) });
      result = 'down';
    }
    if (result === 'delivered') {
      this.recordRun(task.id, firedAtIso, 'delivered', target);
      return;
    }
    if (task.skip_if_busy === 1) {
      // Opt-in silent drop for short-cadence tasks ('down' is treated like
      // busy here — the next tick is imminent either way).
      this.recordRun(task.id, firedAtIso, 'skipped', `${target}: ${result}`);
      return;
    }
    // Never-abandon default: persist to the retry queue. One pending row per
    // (task, target) — a second fire while one is already queued would only
    // deliver the same prompt twice after recovery.
    const existing = this.db
      .prepare(`SELECT id FROM task_retry_queue WHERE task_id = ? AND target = ? AND status = 'pending'`)
      .get(task.id, target) as { id: number } | undefined;
    if (existing === undefined) {
      this.db
        .prepare(
          `INSERT INTO task_retry_queue (task_id, target, prompt, force_send, queued_at, attempts, alerted, status, last_reason)
           VALUES (?, ?, ?, ?, ?, 0, 0, 'pending', ?)`,
        )
        .run(task.id, target, task.prompt, force ? 1 : 0, this.clock.now().toISOString(), result);
    }
    this.recordRun(task.id, firedAtIso, 'queued', `${target}: ${result}`);
  }

  /**
   * Retry every pending queue row whose last attempt (or enqueue) is at least
   * retryIntervalMinutes old. Alerting follows the RETRY-ALERT IDEMPOTENCY
   * protocol: claim alerted=1 BEFORE the send, re-arm only on a transient
   * (thrown) send failure — exactly one alert per threshold crossing even
   * across concurrent ticks.
   */
  async processRetryQueue(): Promise<void> {
    const now = this.clock.now();
    const intervalMs = this.deps.config.retryIntervalMinutes * MINUTE_MS;
    const rows = this.db
      .prepare(
        `SELECT q.id, q.task_id, q.target, q.prompt, q.force_send, q.queued_at,
                q.attempts, q.last_attempt_at, q.alerted, t.type AS task_type
         FROM task_retry_queue q
         LEFT JOIN scheduled_tasks t ON t.id = q.task_id
         WHERE q.status = 'pending' ORDER BY q.id`,
      )
      .all() as unknown as RetryRow[];
    for (const row of rows) {
      const referenceMs = Date.parse(row.last_attempt_at ?? row.queued_at);
      if (now.getTime() - referenceMs < intervalMs) continue;
      await this.attemptRetry(row, now);
    }
  }

  private async attemptRetry(row: RetryRow, now: Date): Promise<void> {
    // Re-check liveness: a concurrent pass may have settled this row already.
    const live = this.db.prepare('SELECT status FROM task_retry_queue WHERE id = ?').get(row.id) as
      | { status: string }
      | undefined;
    if (live === undefined || live.status !== 'pending') return;

    let result: DeliveryResult;
    try {
      result = await this.deps.deliver(row.target, row.prompt, {
        force: row.force_send === 1,
        taskId: row.task_id,
        type: row.task_type ?? 'task',
      });
    } catch (err) {
      log.error('retry delivery threw; treating target as down', {
        retryId: row.id,
        taskId: row.task_id,
        error: String(err),
      });
      result = 'down';
    }
    const nowIso = now.toISOString();
    if (result === 'delivered') {
      this.db
        .prepare(
          `UPDATE task_retry_queue SET status = 'delivered', attempts = attempts + 1, last_attempt_at = ?
           WHERE id = ? AND status = 'pending'`,
        )
        .run(nowIso, row.id);
      this.recordRun(row.task_id, nowIso, 'delivered', `retry to ${row.target}`);
      return;
    }
    this.db
      .prepare(
        `UPDATE task_retry_queue SET attempts = attempts + 1, last_attempt_at = ?, last_reason = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(nowIso, result, row.id);
    const fresh = this.db.prepare('SELECT attempts FROM task_retry_queue WHERE id = ?').get(row.id) as
      | { attempts: number }
      | undefined;
    if (fresh === undefined || fresh.attempts < this.alertThreshold) return;

    // RETRY-ALERT IDEMPOTENCY (SPEC §9): claim BEFORE the send. The
    // conditional UPDATE has exactly one winner across concurrent passes.
    const claim = this.db
      .prepare('UPDATE task_retry_queue SET alerted = 1 WHERE id = ? AND alerted = 0')
      .run(row.id);
    if (Number(claim.changes) === 0) return; // someone already alerted (or is about to)

    const minutesStuck = Math.round((now.getTime() - Date.parse(row.queued_at)) / MINUTE_MS);
    try {
      await this.deps.onAlert(row.task_id, row.target, minutesStuck);
    } catch (err) {
      // Transient alert failure: re-arm so a later attempt can alert again.
      this.db.prepare('UPDATE task_retry_queue SET alerted = 0 WHERE id = ?').run(row.id);
      log.warn('alert send failed; re-armed for a later attempt', {
        retryId: row.id,
        taskId: row.task_id,
        error: String(err),
      });
    }
  }

  /** Operator cancel for a stuck retry. Returns false when nothing was pending. */
  cancelRetry(id: number): boolean {
    const res = this.db
      .prepare(`UPDATE task_retry_queue SET status = 'cancelled' WHERE id = ? AND status = 'pending'`)
      .run(id);
    const cancelled = Number(res.changes) > 0;
    if (cancelled) log.info('retry cancelled by operator', { retryId: id });
    return cancelled;
  }

  private recordRun(
    taskId: string,
    firedAtIso: string,
    outcome: 'delivered' | 'queued' | 'skipped' | 'failed',
    detail: string,
  ): void {
    this.db
      .prepare('INSERT INTO task_runs (task_id, fired_at, outcome, detail) VALUES (?, ?, ?, ?)')
      .run(taskId, firedAtIso, outcome, detail);
  }
}
