// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import type { Router } from '../router.js';
import { HttpError, requireOperator, sendJson } from '../router.js';
import type { AppContext } from '../../app/context.js';
import { sanitizeId } from '../../trust/sanitize.js';
import type { TaskInput } from '../../scheduler/taskStore.js';
import { loadTaskState, saveTaskState, type TaskState } from '../../scheduler/taskState.js';
import { nightlyDreamPath, writeNightlyDream } from '../../scheduler/learning.js';
import { readTextIfExists } from '../../core/fsx.js';

// Server-authoritative caps (PROMPT-07 §6.2/§6.3): a prompt over this is 413; a
// cron string over this is 400 (before shape parsing).
const MAX_PROMPT_CHARS = 50_000;
const MAX_CRON_CHARS = 100;

/** Throw the right status for an over-length prompt/cron field (no-op when absent/short). */
function enforceLengths(prompt: string | undefined, cron: string | undefined): void {
  if (typeof prompt === 'string' && prompt.length > MAX_PROMPT_CHARS) {
    throw new HttpError(413, `prompt too long (max ${MAX_PROMPT_CHARS} chars)`);
  }
  if (typeof cron === 'string' && cron.length > MAX_CRON_CHARS) {
    throw new HttpError(400, `cron too long (max ${MAX_CRON_CHARS} chars)`);
  }
}

export function registerScheduleRoutes(router: Router, ctx: AppContext): void {
  router.get('/api/schedules', ({ res }) => sendJson(res, 200, ctx.taskStore.list()));

  router.post('/api/schedules', (c) => {
    requireOperator(c);
    const body = (c.body ?? {}) as Partial<TaskInput>;
    for (const field of ['id', 'title', 'prompt', 'cron', 'target'] as const) {
      if (typeof body[field] !== 'string' || body[field].trim() === '') {
        throw new HttpError(400, `${field} required`);
      }
    }
    enforceLengths(body.prompt, body.cron);
    if (ctx.taskStore.get(body.id!) !== undefined) throw new HttpError(409, 'task id already exists');
    try {
      sendJson(c.res, 201, ctx.taskStore.create(body as TaskInput));
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : 'invalid task');
    }
  });

  router.patch('/api/schedules/:id', (c) => {
    requireOperator(c);
    const patch = (c.body ?? {}) as Partial<TaskInput>;
    enforceLengths(patch.prompt, patch.cron); // before the try so 413/400 aren't remapped to 400/404
    try {
      sendJson(c.res, 200, ctx.taskStore.update(c.params.id ?? '', patch));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'update failed';
      throw new HttpError(message.includes('not found') ? 404 : 400, message);
    }
  });

  router.post('/api/schedules/:id/toggle', (c) => {
    requireOperator(c);
    try {
      sendJson(c.res, 200, ctx.taskStore.toggle(c.params.id ?? ''));
    } catch {
      throw new HttpError(404, 'no such task');
    }
  });

  router.delete('/api/schedules/:id', (c) => {
    requireOperator(c);
    if (!ctx.taskStore.delete(c.params.id ?? '')) throw new HttpError(404, 'no such task');
    sendJson(c.res, 200, { deleted: c.params.id });
  });

  router.get('/api/schedules/runs', ({ res, url }) => {
    const taskId = url.searchParams.get('task');
    sendJson(res, 200, ctx.taskStore.recentRuns(taskId ?? undefined));
  });

  // never-abandon retry queue (SPEC §9): list + operator cancel. Each row is
  // annotated with `alertDue` (past the alert threshold but not yet alerted) so
  // the UI only shows the "alert due" badge when an alert is genuinely imminent.
  router.get('/api/schedules/retries', ({ res }) => {
    const threshold = ctx.scheduler.alertThresholdAttempts;
    const rows = ctx.taskStore.pendingRetries().map((r) => ({ ...r, alertDue: !r.alerted && r.attempts >= threshold }));
    sendJson(res, 200, rows);
  });

  router.post('/api/schedules/retries/:id/cancel', (c) => {
    requireOperator(c);
    if (!ctx.scheduler.cancelRetry(Number(c.params.id))) throw new HttpError(404, 'no such pending retry');
    sendJson(c.res, 200, { cancelled: Number(c.params.id) });
  });

  // --- agent task-state save/replay (SPEC §9) ---
  router.post('/api/agent-state/:id', (c) => {
    const agentId = c.auth.kind === 'agent' ? sanitizeId(c.auth.agentId) : sanitizeId(c.params.id ?? '');
    const body = (c.body ?? {}) as { state?: TaskState };
    if (body.state === undefined) throw new HttpError(400, 'state required');
    saveTaskState(ctx.db, agentId, body.state);
    sendJson(c.res, 200, { saved: agentId });
  });

  router.get('/api/agent-state/:id', (c) => {
    const agentId = c.auth.kind === 'agent' ? sanitizeId(c.auth.agentId) : sanitizeId(c.params.id ?? '');
    sendJson(c.res, 200, loadTaskState(ctx.db, agentId) ?? null);
  });

  // --- the nightly dream file (SPEC §9): single overwritten artifact ---
  router.get('/api/learning/dream', (c) => {
    sendJson(c.res, 200, { content: readTextIfExists(nightlyDreamPath(ctx.paths.stateDir)) ?? '' });
  });

  /** Hub (or operator) overwrites the consolidation file — never a channel message. */
  router.post('/api/learning/dream', (c) => {
    if (c.auth.kind === 'agent' && sanitizeId(c.auth.agentId) !== sanitizeId(ctx.config.hubId)) {
      throw new HttpError(403, 'only the hub writes the dream file');
    }
    const body = (c.body ?? {}) as { content?: string };
    if (typeof body.content !== 'string' || body.content.trim() === '') throw new HttpError(400, 'content required');
    writeNightlyDream(ctx.paths.stateDir, body.content);
    sendJson(c.res, 200, { written: true });
  });
}
