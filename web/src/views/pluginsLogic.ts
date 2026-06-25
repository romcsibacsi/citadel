// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * Pure plugins-view logic (FIX-hardening C2): no DOM/SPA imports, so it is
 * unit-testable under node. The bulk enable/disable summary message is built here
 * and rendered by plugins.ts via toast().
 */

/** The SPA's t() shape (web/src/i18n.ts), injected so this stays pure + testable. */
export type TFn = (key: string, params?: Record<string, string | number>) => string;

/**
 * Build the toast for a bulk enable/disable run. On any failure → the
 * attempted/succeeded/failed summary (isError); on a clean run → the success line.
 */
export function buildBulkSummary(
  t: TFn,
  a: { attempted: number; succeeded: number; failed: number; mode: 'enable' | 'disable' },
): { text: string; isError: boolean } {
  if (a.failed > 0) {
    const key = a.mode === 'enable' ? 'plugins.bulkEnabledSummary' : 'plugins.bulkDisabledSummary';
    return { text: t(key, { ok: a.succeeded, total: a.attempted, failed: a.failed }), isError: true };
  }
  return { text: t('plugins.bulkDone', { count: a.succeeded }), isError: false };
}
