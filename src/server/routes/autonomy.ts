// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import type { Router } from '../router.js';
import { HttpError, requireOperator, sendJson } from '../router.js';
import type { AppContext } from '../../app/context.js';

/**
 * Autonomy ladder routes (PROMPT-15). The hard lock + per-category cap are
 * enforced SERVER-SIDE — the validation here is defence in depth on top of the
 * ladder's own enforcement, so a bypassed UI can never raise a locked category.
 */
export function registerAutonomyRoutes(router: Router, ctx: AppContext): void {
  // Config document: version + last-updated (epoch secs) + the category dials.
  // The category set + ORDER come from the shipped seed (ctx.config.autonomySeed),
  // not the raw DB row list: this presents the canonical categories in a stable,
  // meaningful order and hides any obsolete/renamed rows left over from an earlier
  // seed (FIX-autonomy-categories). Effective level/cap/lock still come from the
  // ladder (operator-set levels survive; hard-locks are clamped to 1/1/locked).
  router.get('/api/autonomy', (c) => {
    requireOperator(c);
    const seen = new Set<string>();
    const categories: Array<{ key: string; label: string; level: number; locked: boolean; maxLevel: number }> = [];
    for (const s of ctx.config.autonomySeed) {
      if (s.category === '' || seen.has(s.category)) continue;
      seen.add(s.category);
      const eff = ctx.autonomy.get(s.category);
      categories.push({ key: eff.category, label: eff.category, level: eff.level, locked: eff.locked, maxLevel: eff.maxLevel });
    }
    sendJson(c.res, 200, { version: 1, updatedAt: ctx.autonomy.lastUpdatedEpoch(), doc: '', categories });
  });

  // Flat change endpoint (PROMPT-15 §6 Flow B): { key, level }.
  router.post('/api/autonomy', (c) => {
    requireOperator(c);
    const body = (c.body ?? {}) as { key?: string; level?: number };
    const key = typeof body.key === 'string' ? body.key : '';
    const level = body.level;
    if (typeof level !== 'number' || (level !== 1 && level !== 2 && level !== 3)) {
      throw new HttpError(400, ctx.i18n.t('autonomy.error.badLevel'));
    }
    const cat = ctx.autonomy.list().find((s) => s.category === key);
    if (cat === undefined) throw new HttpError(404, ctx.i18n.t('autonomy.error.notFound'));
    if (cat.locked && level > 1) throw new HttpError(403, ctx.i18n.t('autonomy.error.locked', { key }));
    if (level > cat.maxLevel) throw new HttpError(400, ctx.i18n.t('autonomy.error.overCap', { key, n: cat.maxLevel }));
    const updated = ctx.autonomy.set(key, level);
    sendJson(c.res, 200, { key, level: updated.level, updatedAt: ctx.autonomy.lastUpdatedEpoch() });
  });

  /** Legacy per-category endpoint (kept for existing callers). */
  router.post('/api/autonomy/:category', (c) => {
    requireOperator(c);
    const body = (c.body ?? {}) as { level?: number };
    if (typeof body.level !== 'number') throw new HttpError(400, 'level required');
    try {
      sendJson(c.res, 200, ctx.autonomy.set(c.params.category ?? '', body.level));
    } catch (err) {
      throw new HttpError(403, err instanceof Error ? err.message : 'autonomy change rejected');
    }
  });
}
