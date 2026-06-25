// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import type { Router } from '../router.js';
import { HttpError, requireOperator, sendJson } from '../router.js';
import type { AppContext } from '../../app/context.js';
import { sanitizeId, OPERATOR_ID, CHANNEL_ID } from '../../trust/sanitize.js';
import { stripSecurityTags } from '../../trust/frame.js';
import { PROCESS_SENTINEL } from '../../core/ids.js';
import { newlyNeedsApproval } from '../../kanban/approval.js';
import type { BreakdownChildSpec, CardStatus, CreateCardInput, KanbanCard, UpdateCardFields } from '../../kanban/store.js';

type AssigneeType = 'owner' | 'bot' | 'agent';
interface AssigneeRosterEntry {
  id: string;
  type: AssigneeType;
  displayName: string;
}

/** The typed assignee roster: owner (operator), bot (channel/system), + every visible agent. */
function assigneeRoster(ctx: AppContext): AssigneeRosterEntry[] {
  return [
    { id: OPERATOR_ID, type: 'owner', displayName: 'Operator' },
    { id: CHANNEL_ID, type: 'bot', displayName: 'System' },
    ...ctx.config.agents
      .filter((a) => a.hidden !== true)
      .map((a) => ({ id: sanitizeId(a.id), type: 'agent' as const, displayName: a.displayName })),
  ];
}

const STATUSES = new Set(['planned', 'in_progress', 'waiting', 'done']);

function author(c: { auth: { kind: string; agentId?: string } }): string {
  return c.auth.kind === 'agent' ? sanitizeId(c.auth.agentId ?? '') : OPERATOR_ID;
}

/**
 * Trust contract (PROMPT-05 §6.7 / FIX-05 §1): an approve/reject decision must
 * SIGNAL the responsible (assigned) agent so it learns to continue or stop —
 * the dashboard button only authorizes; the agent does the work. Mirrors the
 * dispatch wake: running agents only, security-tags stripped, error-tolerant
 * fire-and-forget so a signal failure never fails the decision.
 */
function signalAssignee(ctx: AppContext, card: KanbanCard, text: string): void {
  const assignee = sanitizeId(card.assignee ?? '');
  if (assignee === '' || assignee === OPERATOR_ID || assignee === CHANNEL_ID) return;
  if (!ctx.config.agents.some((a) => sanitizeId(a.id) === assignee)) return;
  void (async () => {
    if (!(await ctx.supervisor.isRunning(assignee))) return;
    await ctx.supervisor.injectInput(assignee, stripSecurityTags(text, PROCESS_SENTINEL), { source: 'machine' });
  })().catch(() => undefined);
}

/** One-shot operator notification when a card first enters needs-approval (§6.7 / FIX-05 §2). */
function notifyApprovalNeeded(ctx: AppContext, card: KanbanCard): void {
  void ctx
    .notifyOperator(ctx.i18n.t('kanban.notify.approval', { id: card.id, title: card.title }))
    .catch(() => undefined);
}

export function registerKanbanRoutes(router: Router, ctx: AppContext): void {
  router.get('/api/kanban/board', ({ res, url }) => {
    const project = url.searchParams.get('project');
    sendJson(res, 200, ctx.kanban.board(project !== null ? { project } : {}));
  });

  router.post('/api/kanban/cards', (c) => {
    const body = (c.body ?? {}) as CreateCardInput;
    if (typeof body.title !== 'string' || body.title.trim() === '') throw new HttpError(400, 'title required');
    const card = ctx.kanban.create(body);
    if (newlyNeedsApproval(undefined, card.requiresApproval)) notifyApprovalNeeded(ctx, card);
    sendJson(c.res, 201, card);
  });

  router.get('/api/kanban/cards/:id', (c) => {
    const card = ctx.kanban.get(Number(c.params.id));
    if (!card) throw new HttpError(404, 'no such card');
    sendJson(c.res, 200, { ...card, comments: ctx.kanban.comments(card.id) });
  });

  router.patch('/api/kanban/cards/:id', (c) => {
    const body = (c.body ?? {}) as UpdateCardFields & { status?: string };
    if (body.status !== undefined) throw new HttpError(400, 'status changes go through /move');
    const id = Number(c.params.id);
    const before = ctx.kanban.get(id)?.requiresApproval;
    const card = ctx.kanban.update(id, body);
    if (newlyNeedsApproval(before, card.requiresApproval)) notifyApprovalNeeded(ctx, card);
    sendJson(c.res, 200, card);
  });

  /** THE transition op — dispatch-once fires from here (SPEC §11). */
  router.post('/api/kanban/cards/:id/move', (c) => {
    const body = (c.body ?? {}) as { status?: string; sortOrder?: number };
    if (body.status === undefined || !STATUSES.has(body.status)) throw new HttpError(400, 'valid status required');
    const id = Number(c.params.id);
    const moved = ctx.kanban.move(id, body.status as CardStatus);
    // drag-and-drop also carries the new in-column position
    sendJson(c.res, 200, typeof body.sortOrder === 'number' ? ctx.kanban.setSortOrder(id, body.sortOrder) : moved);
  });

  router.post('/api/kanban/cards/:id/comments', (c) => {
    const body = (c.body ?? {}) as { body?: string; author?: string };
    if (typeof body.body !== 'string' || body.body.trim() === '') throw new HttpError(400, 'body required');
    // the operator may attribute a comment to any known identity (multi-party
    // discussion on a card); an agent token is always stamped as itself.
    let who = author(c);
    if (c.auth.kind !== 'agent' && typeof body.author === 'string' && body.author.trim() !== '') {
      const wanted = sanitizeId(body.author);
      const known = new Set<string>([OPERATOR_ID, CHANNEL_ID, ...ctx.config.agents.map((a) => sanitizeId(a.id))]);
      if (known.has(wanted)) who = wanted;
    }
    sendJson(c.res, 201, ctx.kanban.comment(Number(c.params.id), who, body.body));
  });

  router.post('/api/kanban/cards/:id/archive', (c) => {
    sendJson(c.res, 200, ctx.kanban.archive(Number(c.params.id)));
  });

  router.post('/api/kanban/cards/:id/unarchive', (c) => {
    sendJson(c.res, 200, ctx.kanban.unarchive(Number(c.params.id)));
  });

  /** Operator approval clears the requires_approval gate and logs it. The
   *  button only lowers the flag + records the decision — it never itself runs
   *  the (potentially risky) work; the responsible agent does (SPEC §6.7). */
  router.post('/api/kanban/cards/:id/approve', (c) => {
    requireOperator(c);
    const id = Number(c.params.id);
    const card = ctx.kanban.update(id, { requiresApproval: false });
    ctx.kanban.comment(id, OPERATOR_ID, ctx.i18n.t('kanban.approve.comment'));
    // TRUST CONTRACT (§6.7 / FIX-05 §1): tell the responsible agent to CONTINUE.
    signalAssignee(ctx, card, ctx.i18n.t('kanban.signal.approve', { id: card.id, title: card.title }));
    sendJson(c.res, 200, card);
  });

  /** Operator rejection — symmetric to approve: lowers the flag + records it. */
  router.post('/api/kanban/cards/:id/reject', (c) => {
    requireOperator(c);
    const id = Number(c.params.id);
    const card = ctx.kanban.update(id, { requiresApproval: false });
    ctx.kanban.comment(id, OPERATOR_ID, ctx.i18n.t('kanban.reject.comment'));
    // TRUST CONTRACT (§6.7 / FIX-05 §1): tell the responsible agent to STOP.
    signalAssignee(ctx, card, ctx.i18n.t('kanban.signal.reject', { id: card.id, title: card.title }));
    sendJson(c.res, 200, card);
  });

  // PURGE: a hard delete is a DELIBERATE, documented exception to the archive-by-
  // default invariant (§20.8). It is operator-only (requireOperator) and the UI
  // confirms first; everyday "delete" in the product is the soft archive above.
  router.delete('/api/kanban/cards/:id', (c) => {
    requireOperator(c);
    if (!ctx.kanban.hardDelete(Number(c.params.id))) throw new HttpError(404, 'no such card');
    sendJson(c.res, 200, { deleted: Number(c.params.id) });
  });

  router.post('/api/kanban/breakdown', (c) => {
    const body = (c.body ?? {}) as {
      parentId?: number;
      parent?: { title: string; description?: string };
      children?: BreakdownChildSpec[];
    };
    if (!Array.isArray(body.children) || body.children.length === 0) throw new HttpError(400, 'children required');
    const parentSpec = body.parentId !== undefined ? body.parentId : body.parent;
    if (parentSpec === undefined) throw new HttpError(400, 'parent or parentId required');
    const result = ctx.kanban.breakdown(parentSpec, body.children, ctx.config.lanes);
    // §5.5/§6.6 / FIX-05 §5: leave a summary on the parent listing the created subtasks.
    ctx.kanban.comment(
      result.parent.id,
      author(c),
      ctx.i18n.t('kanban.breakdown.summary', {
        n: result.children.length,
        ids: result.children.map((ch) => `#${ch.id}`).join(', '),
      }),
    );
    sendJson(c.res, 201, result);
  });

  router.get('/api/kanban/cards/:id/children', (c) => {
    sendJson(c.res, 200, ctx.kanban.children(Number(c.params.id)));
  });

  // the archive view (the live board endpoint only returns active cards)
  router.get('/api/kanban/archived', ({ res }) => sendJson(res, 200, ctx.kanban.archived()));

  router.get('/api/kanban/projects', ({ res }) => sendJson(res, 200, ctx.kanban.projects()));
  // typed assignee roster (owner/bot/agent) for the filters + assignee chips
  router.get('/api/kanban/assignees', ({ res }) => sendJson(res, 200, assigneeRoster(ctx)));
  router.get('/api/kanban/approvals/badge', ({ res }) => sendJson(res, 200, { count: ctx.kanban.approvalsBadge() }));
}
