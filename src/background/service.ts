// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { randomBytes } from 'node:crypto';
import { type Clock, systemClock } from '../core/clock.js';
import { createLogger } from '../core/log.js';
import { BackgroundTaskStore, CapReachedError, type BackgroundTask, type ListOptions } from './store.js';
import type { BackgroundRunner } from './runner.js';

const log = createLogger('background');

export const PER_AGENT_CAP = 3;
export const TIMEOUT_MS = 30 * 60 * 1000;

export interface BackgroundDetail extends BackgroundTask {
  /** Live-captured snapshot for a running task (point-in-time, not persisted). */
  liveOutput?: string;
}

/**
 * Background-task service (PROMPT-12): the launch/poll/cancel orchestration over
 * the store + a pluggable runner. The per-agent cap (3) is enforced atomically
 * in the store; this service owns the completion poll (≈10s), the 30-minute
 * timeout guard, and the restart orphan sweep.
 */
export class BackgroundTaskService {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly store: BackgroundTaskStore,
    private readonly runner: BackgroundRunner,
    private readonly clock: Clock = systemClock,
    private readonly cap: number = PER_AGENT_CAP,
    private readonly timeoutMs: number = TIMEOUT_MS,
  ) {}

  /** Allocate a short uppercase 8-hex id (the public task id + the run handle). */
  private newId(): string {
    return randomBytes(4).toString('hex').toUpperCase();
  }

  /**
   * Reserve the slot atomically (cap-checked), then launch the detached run. A
   * launch failure finalizes the just-reserved row as failed rather than
   * leaking a phantom running task. Re-throws CapReachedError for the 429 path.
   */
  async launch(agentId: string, prompt: string): Promise<BackgroundTask> {
    const taskId = this.newId();
    const task = this.store.createAtomic({ taskId, agentId, prompt }, this.cap);
    try {
      await this.runner.launch({ taskId, agentId, prompt });
    } catch (err) {
      log.warn('background launch failed', { taskId, agentId, error: String(err) });
      this.store.finalize(taskId, 'failed', `(launch failed) ${String(err)}`);
      return this.store.get(taskId) ?? task;
    }
    return task;
  }

  list(opts: ListOptions): BackgroundTask[] {
    return this.store.list(opts);
  }

  get(taskId: string): BackgroundTask | undefined {
    return this.store.get(taskId);
  }

  /** Single-task detail; a running task carries a fresh live output snapshot. */
  async detail(taskId: string): Promise<BackgroundDetail | undefined> {
    const task = this.store.get(taskId);
    if (task === undefined) return undefined;
    if (task.status !== 'running') return task;
    const liveOutput = await this.runner.snapshot(taskId).catch(() => '');
    return { ...task, liveOutput };
  }

  /** Cancel: capture output, kill the run, mark failed "(cancelled)". */
  async stop(taskId: string): Promise<boolean> {
    const task = this.store.get(taskId);
    if (task === undefined) return false;
    if (task.status !== 'running') return true;
    const captured = await this.runner.kill(taskId).catch(() => task.output ?? '');
    this.store.finalize(taskId, 'failed', `${captured}\n(cancelled)`.trim());
    return true;
  }

  /** Completion poll + timeout guard for every still-running task. */
  async tick(): Promise<void> {
    const now = this.clock.now().getTime();
    for (const task of this.store.running()) {
      const snap = await this.runner.poll(task.id).catch(() => undefined);
      if (snap === undefined) continue;
      if (!snap.alive) {
        if (snap.exitCode === 0) this.store.finalize(task.id, 'done', snap.output);
        else if (snap.exitCode !== null) this.store.finalize(task.id, 'failed', snap.output);
        else this.store.finalize(task.id, 'failed', `${snap.output}\n(session ended)`.trim());
      } else if (now - Date.parse(task.startedAt) >= this.timeoutMs) {
        const captured = await this.runner.kill(task.id).catch(() => snap.output);
        this.store.finalize(task.id, 'timeout', (captured || '(timeout)').trim());
      }
    }
  }

  /**
   * Restart sweep: a running row whose underlying run is gone is marked failed
   * "(orphaned on restart)"; a genuinely-alive run is left for the poll loop.
   */
  async sweepOrphans(): Promise<void> {
    for (const task of this.store.running()) {
      const snap = await this.runner.poll(task.id).catch(() => ({ alive: false, output: '', exitCode: null }));
      if (!snap.alive) {
        this.store.finalize(task.id, 'failed', `${snap.output}\n(orphaned on restart)`.trim());
      }
    }
  }

  startPolling(intervalMs = 10_000): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      void this.tick().catch((err: unknown) => log.error('background tick failed', { error: String(err) }));
    }, intervalMs);
    this.timer.unref();
  }

  stopPolling(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}

export { CapReachedError };
