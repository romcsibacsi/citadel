// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import type { Router } from '../router.js';
import { HttpError, requireOperator, sendJson } from '../router.js';
import type { AppContext } from '../../app/context.js';
import { sanitizeId } from '../../trust/sanitize.js';
import { fetchProviderStatus } from '../../status/provider.js';
import { collectSynthetic } from '../../tokens/collector.js';

/**
 * Observability routes (PROMPT-14): upstream provider status, token-usage
 * accounting (summary / timeline / details / collect), and the tool-call log
 * (write hook + read + analyze + operator-only prune). Usage is rate-limit
 * accounting, never money.
 */

function num(v: string | null, dflt: number): number {
  const n = v === null ? NaN : Number(v);
  return Number.isFinite(n) ? n : dflt;
}

export function registerObservabilityRoutes(router: Router, ctx: AppContext): void {
  const roster = (): string[] => ctx.config.agents.filter((a) => a.hidden !== true).map((a) => sanitizeId(a.id));

  router.get('/api/provider-status', async ({ res }) => {
    sendJson(res, 200, await fetchProviderStatus());
  });

  // --- token usage ---
  router.get('/api/token-usage/summary', ({ res, url }) => {
    const from = url.searchParams.get('from') ?? '';
    const to = url.searchParams.get('to') ?? new Date().toISOString();
    sendJson(res, 200, ctx.tokens.summary(from, to));
  });

  router.get('/api/token-usage/timeline', ({ res, url }) => {
    const from = url.searchParams.get('from') ?? '';
    const to = url.searchParams.get('to') ?? new Date().toISOString();
    const bucket = num(url.searchParams.get('bucket'), 60);
    const agent = url.searchParams.get('agent');
    sendJson(res, 200, ctx.tokens.timeline(from, to, bucket, agent ?? undefined));
  });

  router.post('/api/token-usage/collect', (c) => {
    const inserted = collectSynthetic(ctx.tokens, roster());
    sendJson(c.res, 200, { inserted });
  });

  router.get('/api/token-usage', ({ res, url }) => {
    const from = url.searchParams.get('from') ?? '';
    const to = url.searchParams.get('to') ?? new Date().toISOString();
    sendJson(res, 200, ctx.tokens.details(from, to, {
      agent: url.searchParams.get('agent') ?? undefined,
      minTokens: num(url.searchParams.get('min_tokens'), 0),
      q: url.searchParams.get('q') ?? undefined,
      limit: num(url.searchParams.get('limit'), 200),
    }));
  });

  // --- tool-call log ---
  router.post('/api/tool-log', (c) => {
    const body = (c.body ?? {}) as { session_id?: string; sessionId?: string; tool_name?: string; toolName?: string; input?: string; success?: boolean };
    const sessionId = body.session_id ?? body.sessionId ?? '';
    const toolName = body.tool_name ?? body.toolName ?? '';
    if (sessionId.trim() === '' || toolName.trim() === '') throw new HttpError(400, ctx.i18n.t('toollog.error.badPayload'));
    ctx.tokens.logTool({ sessionId, toolName, inputSummary: body.input ?? null, success: body.success !== false });
    sendJson(c.res, 201, { ok: true });
  });

  router.get('/api/tool-log', ({ res, url }) => {
    sendJson(res, 200, ctx.tokens.recentTools(num(url.searchParams.get('since'), 3600)));
  });

  router.get('/api/tool-log/analyze', ({ res, url }) => {
    sendJson(res, 200, ctx.tokens.analyze(num(url.searchParams.get('since'), 3600), num(url.searchParams.get('min_calls'), 3)));
  });

  router.post('/api/tool-log/prune', (c) => {
    requireOperator(c);
    const olderThan = num(String(((c.body ?? {}) as { older_than_secs?: number }).older_than_secs ?? ''), 86400);
    sendJson(c.res, 200, { deleted: ctx.tokens.prune(olderThan) });
  });
}
