// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import type { Router } from '../router.js';
import { HttpError, sendJson } from '../router.js';
import type { AppContext } from '../../app/context.js';
import { sanitizeId } from '../../trust/sanitize.js';
import { CapReachedError } from '../../background/service.js';
import type { BackgroundTask } from '../../background/store.js';

/**
 * Background-task routes (PROMPT-12). Wire shape is snake_case per the spec
 * contract; timestamps carry pre-formatted hu-HU / Budapest labels for display.
 * Also serves the agent roster the picker needs (the hub + every sub-agent).
 */

function label(iso: string | null, tz: string): string | null {
  if (iso === null) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('hu-HU', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}

function toWire(t: BackgroundTask, tz: string, liveOutput?: string): Record<string, unknown> {
  return {
    id: t.id,
    agent_id: t.agentId,
    prompt: t.prompt,
    status: t.status,
    started_at: t.startedAt,
    finished_at: t.finishedAt,
    output: liveOutput !== undefined ? liveOutput : t.output,
    started_label: label(t.startedAt, tz),
    finished_label: label(t.finishedAt, tz),
  };
}

export function registerBackgroundRoutes(router: Router, ctx: AppContext): void {
  const tz = ctx.config.timezone || 'Europe/Budapest';

  // Roster for the picker: the hub first, then every visible sub-agent. This
  // deliberately INCLUDES the hub (the launch backend accepts it as a target).
  router.get('/api/schedules/agents', ({ res }) => {
    const hubId = sanitizeId(ctx.config.hubId);
    const visible = ctx.config.agents.filter((a) => a.hidden !== true);
    const ordered = [
      ...visible.filter((a) => sanitizeId(a.id) === hubId),
      ...visible.filter((a) => sanitizeId(a.id) !== hubId),
    ];
    sendJson(res, 200, ordered.map((a) => ({ name: sanitizeId(a.id), label: a.displayName })));
  });

  router.get('/api/background-tasks', ({ res, url }) => {
    const agent = url.searchParams.get('agent');
    const all = url.searchParams.get('all') === 'true';
    const tasks = ctx.background.list({
      ...(agent !== null && agent !== '' ? { agentId: agent } : {}),
      includeFinished: all,
    });
    sendJson(res, 200, tasks.map((t) => toWire(t, tz)));
  });

  router.post('/api/background-tasks', async (c) => {
    const body = (c.body ?? {}) as { agent_id?: string; prompt?: string };
    const agentId = typeof body.agent_id === 'string' ? sanitizeId(body.agent_id) : '';
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (agentId === '') throw new HttpError(400, ctx.i18n.t('background.error.agentRequired'));
    if (prompt === '') throw new HttpError(400, ctx.i18n.t('background.error.promptRequired'));
    try {
      const task = await ctx.background.launch(agentId, prompt);
      sendJson(c.res, 201, toWire(task, tz));
    } catch (err) {
      if (err instanceof CapReachedError) throw new HttpError(429, ctx.i18n.t('background.error.capReached'));
      throw err;
    }
  });

  router.get('/api/background-tasks/:id', async (c) => {
    const detail = await ctx.background.detail(c.params.id ?? '');
    if (detail === undefined) throw new HttpError(404, ctx.i18n.t('background.error.notFound'));
    const live = detail.status === 'running' && detail.liveOutput !== undefined && detail.liveOutput !== ''
      ? detail.liveOutput
      : undefined;
    sendJson(c.res, 200, toWire(detail, tz, live));
  });

  router.delete('/api/background-tasks/:id', async (c) => {
    const ok = await ctx.background.stop(c.params.id ?? '');
    if (!ok) throw new HttpError(404, ctx.i18n.t('background.error.notFound'));
    sendJson(c.res, 200, { ok: true });
  });
}
