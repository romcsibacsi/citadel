// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import type { Router } from '../router.js';
import { requireOperator, sendJson } from '../router.js';
import type { AppContext } from '../../app/context.js';
import type { RefuseReason } from '../../updates/service.js';

/**
 * Self-update routes (PROMPT-18). Status read + force-check + the operator-gated
 * apply. Apply refusals come back as 409 with a machine reason + a localized
 * human message so the frontend can show the real reason (and offer auto-stash
 * on a dirty tree). Operator-only; never auto-fired.
 */
const REASON_KEY: Record<RefuseReason, string> = {
  'detached-head': 'updates.reason.detachedHead',
  'not-on-main': 'updates.reason.notOnMain',
  'dirty-tree': 'updates.reason.dirtyTree',
  'already-running': 'updates.reason.alreadyRunning',
  'policy-blocked': 'updates.reason.policyBlocked',
};

export function registerUpdateRoutes(router: Router, ctx: AppContext): void {
  router.get('/api/updates/status', (c) => {
    requireOperator(c);
    sendJson(c.res, 200, ctx.updates.status() ?? null);
  });

  // Deploy-checkout divergence (#88): non-blocking visibility of a local main that
  // carries commits not on origin/main (e.g. a direct operator commit outside the PR flow).
  router.get('/api/deploy/divergence', (c) => {
    requireOperator(c);
    sendJson(c.res, 200, ctx.divergence.status() ?? null);
  });

  router.post('/api/updates/check', async (c) => {
    requireOperator(c);
    sendJson(c.res, 200, await ctx.updates.forceCheck());
  });

  router.post('/api/updates/apply', (c) => {
    requireOperator(c);
    const autoStash = ((c.body ?? {}) as { autoStash?: boolean }).autoStash === true;
    const result = ctx.updates.apply(autoStash);
    if (result.ok) { sendJson(c.res, 200, { ok: true, started: true }); return; }
    const reason = result.reason ?? 'dirty-tree';
    // 409 with the machine reason + a localized human message; the frontend reads
    // `reason` to offer auto-stash on a dirty tree (it parses the body on non-OK).
    sendJson(c.res, 409, {
      ok: false,
      reason,
      message: ctx.i18n.t(REASON_KEY[reason], { branch: result.branch ?? '', N: result.pid ?? 0 }),
      ...(result.branch ? { branch: result.branch } : {}),
      ...(result.pid ? { pid: result.pid } : {}),
    });
  });
}
