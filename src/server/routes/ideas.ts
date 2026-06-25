// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import type { Router, RouteContext } from '../router.js';
import { HttpError, requireOperator, sendJson } from '../router.js';
import type { AppContext } from '../../app/context.js';
import { sanitizeId, OPERATOR_ID } from '../../trust/sanitize.js';
import type { CreateIdeaInput, IdeaStatus, PromoteSubtask, UpdateIdeaFields } from '../../ideas/store.js';
import { draftSubtasks } from '../../ideas/breakdown.js';
import { webhookBus } from '../../webhook/events.js';

/** Exact-match status values; 'active' (non-archived) is handled separately. */
const EXACT_STATUSES = new Set(['new', 'reviewed', 'kanban', 'rejected', 'archived']);
const NOT_FOUND = 'Ötlet nem található';

export function registerIdeaRoutes(router: Router, ctx: AppContext): void {
  /** The kanban project + assignee that promoted ideas land under. */
  const ideasProject = (): string =>
    ctx.config.locale.default === 'en' ? 'Development ideas' : 'Fejlesztési ötletek';
  const orchestrator = (): string => sanitizeId(ctx.config.hubId);
  const requireIdea = (id: number): void => {
    if (ctx.ideas.get(id) === undefined) throw new HttpError(404, NOT_FOUND);
  };

  // status=archived -> only archived; status=active|omitted -> non-archived;
  // any specific status -> exact match. category narrows the result in JS.
  router.get('/api/ideas', ({ res, url }) => {
    const status = url.searchParams.get('status');
    const category = url.searchParams.get('category');
    const includeArchived = url.searchParams.get('includeArchived') === 'true';
    let list =
      status === 'archived'
        ? ctx.ideas.list({ status: 'archived' })
        : status !== null && status !== 'active' && EXACT_STATUSES.has(status)
          ? ctx.ideas.list({ status: status as IdeaStatus })
          : ctx.ideas.list({ includeArchived });
    if (category !== null && category.trim() !== '') list = list.filter((i) => i.category === category);
    sendJson(res, 200, list);
  });

  router.get('/api/ideas/categories', ({ res }) => sendJson(res, 200, ctx.ideas.categories()));

  router.post('/api/ideas', (c) => {
    const body = (c.body ?? {}) as CreateIdeaInput;
    if (typeof body.title !== 'string' || body.title.trim() === '') throw new HttpError(400, 'title required');
    const source = c.auth.kind === 'agent' ? sanitizeId(c.auth.agentId ?? '') : OPERATOR_ID;
    const created = ctx.ideas.create({
      title: body.title,
      ...(body.description !== undefined ? { description: body.description } : {}),
      category: typeof body.category === 'string' && body.category.trim() !== '' ? body.category : 'Egyéb',
      source: body.source ?? source,
    });
    webhookBus.emit('idea.created', { ideaId: created.id, title: created.title }); // outbound webhook (FIX-plugin-webhook)
    sendJson(c.res, 201, created);
  });

  // Edit + reversible status transitions. PUT is the spec surface; PATCH stays
  // for back-compat. 'rejected'/'archived' route to their lifecycle ops.
  const updateIdea = (c: RouteContext): void => {
    const id = Number(c.params.id);
    requireIdea(id);
    const body = (c.body ?? {}) as UpdateIdeaFields;
    if (body.status === 'rejected') {
      sendJson(c.res, 200, ctx.ideas.reject(id));
      return;
    }
    if (body.status === 'archived') {
      sendJson(c.res, 200, ctx.ideas.archive(id));
      return;
    }
    sendJson(c.res, 200, ctx.ideas.update(id, body));
  };
  router.put('/api/ideas/:id', updateIdea);
  router.patch('/api/ideas/:id', updateIdea);

  router.post('/api/ideas/:id/reject', (c) => {
    const id = Number(c.params.id);
    requireIdea(id);
    sendJson(c.res, 200, ctx.ideas.reject(id));
  });

  router.post('/api/ideas/:id/archive', (c) => {
    const id = Number(c.params.id);
    requireIdea(id);
    sendJson(c.res, 200, ctx.ideas.archive(id));
  });

  // PURGE: a hard delete is a DELIBERATE, documented exception to the archive-by-
  // default invariant (§20.8) — operator-only + UI-confirmed. The everyday path is
  // POST /:id/archive (soft) above.
  router.delete('/api/ideas/:id', (c) => {
    requireOperator(c);
    if (!ctx.ideas.remove(Number(c.params.id))) throw new HttpError(404, NOT_FOUND);
    sendJson(c.res, 200, { deleted: Number(c.params.id) });
  });

  // Phase-picker promote: detail -> 'waiting' (+ marker), plan -> 'planned'.
  router.post('/api/ideas/:id/promote', (c) => {
    const id = Number(c.params.id);
    requireIdea(id);
    const phase = (c.body as { phase?: string } | undefined)?.phase === 'detail' ? 'detail' : 'plan';
    sendJson(c.res, 200, ctx.ideas.promote(id, ctx.kanban, {
      phase,
      project: ideasProject(),
      assignee: orchestrator(),
    }));
  });

  // AI-breakdown step 1: deterministic draft (read-only, no writes).
  router.post('/api/ideas/:id/breakdown', (c) => {
    const id = Number(c.params.id);
    const idea = ctx.ideas.get(id);
    if (idea === undefined) throw new HttpError(404, NOT_FOUND);
    sendJson(c.res, 200, { idea, subtasks: draftSubtasks(idea, ctx.config.lanes) });
  });

  // AI-breakdown step 2: create the parent + approved child cards, link the idea.
  router.post('/api/ideas/:id/promote-breakdown', (c) => {
    const id = Number(c.params.id);
    requireIdea(id);
    const raw = ((c.body ?? {}) as { subtasks?: PromoteSubtask[] }).subtasks ?? [];
    const subtasks = raw.filter((s) => typeof s?.title === 'string' && s.title.trim() !== '');
    if (subtasks.length === 0) throw new HttpError(400, 'Legalább egy jóváhagyott alfeladat kötelező');
    sendJson(c.res, 201, ctx.ideas.promoteBreakdown(id, ctx.kanban, subtasks, ctx.config.lanes, {
      project: ideasProject(),
      assignee: orchestrator(),
    }));
  });

  // Maintenance sweep (both the spec path and the original alias).
  const reconcile = (c: RouteContext): void =>
    sendJson(c.res, 200, { archived: ctx.ideas.reconcile(ctx.kanban) });
  router.post('/api/ideas/reconcile-archived', reconcile);
  router.post('/api/ideas/reconcile', reconcile);
}
