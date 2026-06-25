// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import type { Router, RouteContext } from '../router.js';
import { HttpError, requireOperator, sendJson } from '../router.js';
import type { AppContext } from '../../app/context.js';
import { sanitizeId, OPERATOR_ID } from '../../trust/sanitize.js';
import { PanelError, type CreatePanelInput } from '../../judge/service.js';

/**
 * Judge-panel routes (BUILD-judge-panel + FIX-panel-v1.1 Part A). An AGENT (e.g. NEXUS) may
 * CREATE + OBSERVE a panel (create/list/get accept an agent OR operator token) — creating a
 * panel applies nothing, it only runs the gate UP TO the operator-only approve checkpoint.
 * APPLY + REJECT stay operator-only, so the hard invariant holds: nothing reaches `applied`
 * without the operator. Approve/reject also reuse the existing kanban approve route.
 */
function requireOperatorOrAgent(c: RouteContext): void {
  if (c.auth.kind !== 'operator' && c.auth.kind !== 'agent') throw new HttpError(403, 'operator or agent token required');
}
function principalOf(c: RouteContext): string {
  return c.auth.kind === 'agent' ? sanitizeId(c.auth.agentId) : OPERATOR_ID;
}

export function registerPanelRoutes(router: Router, ctx: AppContext): void {
  router.post('/api/panels', async (c) => {
    requireOperatorOrAgent(c);
    // stamp the authenticated principal (override any client-supplied initiatedBy).
    const body = { ...((c.body ?? {}) as CreatePanelInput), initiatedBy: principalOf(c) };
    try {
      const panel = await ctx.panels.createPanel(body);
      sendJson(c.res, 201, ctx.panels.getFull(panel.id));
    } catch (err) {
      if (err instanceof PanelError) throw new HttpError(400, err.message);
      throw err;
    }
  });

  router.get('/api/panels', (c) => {
    requireOperatorOrAgent(c);
    sendJson(c.res, 200, { panels: ctx.panels.list() });
  });

  router.get('/api/panels/:id', (c) => {
    requireOperatorOrAgent(c);
    const id = Number(c.params.id);
    if (!Number.isInteger(id)) throw new HttpError(400, 'invalid panel id');
    const full = ctx.panels.getFull(id);
    if (full === undefined) throw new HttpError(404, 'no such panel');
    sendJson(c.res, 200, full);
  });

  /**
   * APPLY — the HARD GATE. The predicate (test=passed AND review=passed AND operator
   * approve=passed) is checked HERE, in the route handler, BEFORE any merge — never in
   * an error-tolerant onDispatch/onCardDone hook (a swallowed hook could not block).
   * test=passed is UNWAIVABLE; a HARD_LOCKED category never self-applies. Operator-only.
   */
  router.post('/api/panels/:id/apply', async (c) => {
    requireOperator(c);
    const id = Number(c.params.id);
    if (!Number.isInteger(id)) throw new HttpError(400, 'invalid panel id');
    if (ctx.panels.getFull(id) === undefined) throw new HttpError(404, 'no such panel');

    // THE hard predicate, in the route handler (defensive; PanelService.apply re-checks).
    const g = ctx.panels.gateSummary(id);
    if (g.test !== 'passed' || g.review !== 'passed' || g.approve !== 'passed') {
      throw new HttpError(409, `gate not satisfied — test=${g.test}, review=${g.review}, approve=${g.approve} (all must be 'passed' before apply)`);
    }
    try {
      const result = await ctx.panels.apply(id);
      sendJson(c.res, 200, ctx.panels.getFull(id) ?? result);
    } catch (err) {
      if (err instanceof PanelError) {
        // a hard-locked category hand-off is a deliberate block (operator must apply manually).
        throw new HttpError(err.code === 'hard_locked_handoff' ? 409 : 400, err.message);
      }
      throw err;
    }
  });

  /** REJECT — abandon the winner, archive branches, panel→rejected, signal the solver. */
  router.post('/api/panels/:id/reject', async (c) => {
    requireOperator(c);
    const id = Number(c.params.id);
    if (!Number.isInteger(id)) throw new HttpError(400, 'invalid panel id');
    if (ctx.panels.getFull(id) === undefined) throw new HttpError(404, 'no such panel');
    const body = (c.body ?? {}) as { reason?: string };
    const reason = typeof body.reason === 'string' && body.reason.trim() !== '' ? body.reason.trim() : 'operator rejected';
    try {
      await ctx.panels.rejectPanel(id, reason);
      sendJson(c.res, 200, ctx.panels.getFull(id));
    } catch (err) {
      if (err instanceof PanelError) throw new HttpError(400, err.message);
      throw err;
    }
  });
}
