// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import type { Router } from '../router.js';
import { HttpError, requireOperator, sendJson } from '../router.js';
import type { AppContext } from '../../app/context.js';
import { sanitizeId } from '../../trust/sanitize.js';
import { parseDateExpr } from '../dateExpr.js';

/**
 * Log / recall read surface (PROMPT-09). The daily-log trail was write-only
 * before; these add the operator reads:
 *  - the Daily-Log tab reader (one agent, one day, oldest-first) + its day index,
 *  - the cross-agent Recall feed (a date / NL-date-expression / text search that
 *    merges logs + memories into a date-grouped, summarized timeline).
 * Natural-language date expressions are resolved SERVER-side in the configured
 * local timezone (Budapest) so midnight off-by-one errors can't happen.
 */

const YMD = /^\d{4}-\d{2}-\d{2}$/;

interface LogRow { id?: number; agent_id: string; day?: string; line: string; created_at: string }
interface MemRow { id: number; agent_id: string; category: string; content: string; keywords: string; salience: number; created_at: string }

function dayAfter(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}

export function registerJournalRoutes(router: Router, ctx: AppContext): void {
  const tz = ctx.config.timezone;
  const todayLocal = (): string => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const label = (iso: string): string => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : new Intl.DateTimeFormat('hu-HU', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(d);
  };

  // --- Daily-Log tab reader: one agent's entries on one day (oldest-first) ---
  router.get('/api/daily-log', (c) => {
    requireOperator(c);
    const agent = sanitizeId(c.url.searchParams.get('agent') ?? '') || sanitizeId(ctx.config.hubId);
    const date = c.url.searchParams.get('date') ?? todayLocal();
    if (!YMD.test(date)) throw new HttpError(400, 'date must be YYYY-MM-DD');
    const rows = ctx.db.prepare('SELECT id, line, created_at FROM daily_logs WHERE agent_id = ? AND day = ? ORDER BY created_at ASC, id ASC').all(agent, date) as unknown as LogRow[];
    sendJson(c.res, 200, rows.map((r) => ({ id: r.id, content: r.line, createdAt: r.created_at, createdLabel: label(r.created_at) })));
  });

  // --- the day index for an agent (most-recent first, capped) ---
  router.get('/api/daily-log/dates', (c) => {
    requireOperator(c);
    const agent = sanitizeId(c.url.searchParams.get('agent') ?? '') || sanitizeId(ctx.config.hubId);
    const limit = Math.min(365, Math.max(1, Number(c.url.searchParams.get('limit') ?? 365) || 365));
    const rows = ctx.db.prepare('SELECT DISTINCT day FROM daily_logs WHERE agent_id = ? ORDER BY day DESC LIMIT ?').all(agent, limit) as Array<{ day: string }>;
    sendJson(c.res, 200, rows.map((r) => r.day));
  });

  // legacy alias kept for the in-Memory log lens
  router.get('/api/journal/dates', (c) => {
    requireOperator(c);
    const agent = sanitizeId(c.url.searchParams.get('agent') ?? '');
    const rows = (agent === ''
      ? ctx.db.prepare('SELECT DISTINCT day FROM daily_logs ORDER BY day DESC').all()
      : ctx.db.prepare('SELECT DISTINCT day FROM daily_logs WHERE agent_id = ? ORDER BY day DESC').all(agent)) as Array<{ day: string }>;
    sendJson(c.res, 200, rows.map((r) => r.day));
  });

  // --- the cross-agent Recall feed: logs + memories, date-grouped + summarized ---
  router.get('/api/journal', (c) => {
    requireOperator(c);
    const agent = sanitizeId(c.url.searchParams.get('agent') ?? '');
    const q = (c.url.searchParams.get('q') ?? '').trim().toLowerCase();
    const limit = Math.min(300, Math.max(1, Number(c.url.searchParams.get('limit') ?? 50) || 50));

    // resolve the date scope: a NL/ISO expression wins, else explicit from/to
    let from = '';
    let to = '';
    const dateExpr = c.url.searchParams.get('date');
    if (dateExpr !== null && dateExpr.trim() !== '') {
      const r = parseDateExpr(dateExpr, tz);
      if (!r) throw new HttpError(400, `Nem értelmezhető dátum: "${dateExpr}"`);
      from = r.from; to = r.to;
    } else {
      from = c.url.searchParams.get('from') ?? '';
      to = c.url.searchParams.get('to') || from;
    }
    const dated = YMD.test(from) && YMD.test(to);
    // text-only with no date is allowed (pure search over recent items)
    if (!dated && q === '' && (from !== '' || to !== '')) throw new HttpError(400, 'from/to must be YYYY-MM-DD');

    let logs: Array<{ agentId: string; line: string; createdAt: string; createdLabel: string }>;
    let memories: Array<{ id: number; agentId: string; category: string; content: string; keywords: string; createdAt: string; createdLabel: string }>;

    if (dated) {
      const logP: unknown[] = [from, to];
      let logSql = 'SELECT agent_id, day, line, created_at FROM daily_logs WHERE day BETWEEN ? AND ?';
      if (agent !== '') { logSql += ' AND agent_id = ?'; logP.push(agent); }
      logSql += ' ORDER BY created_at ASC, id ASC';
      logs = (ctx.db.prepare(logSql).all(...(logP as never[])) as unknown as LogRow[]).map((r) => ({ agentId: r.agent_id, line: r.line, createdAt: r.created_at, createdLabel: label(r.created_at) }));

      const memP: unknown[] = [`${from}T00:00:00.000Z`, dayAfter(to)];
      let memSql = 'SELECT id, agent_id, category, content, keywords, salience, created_at FROM memories WHERE archived_at IS NULL AND created_at >= ? AND created_at < ?';
      if (agent !== '') { memSql += " AND (agent_id = ? OR category = 'shared')"; memP.push(agent); }
      memSql += ' ORDER BY created_at ASC, id ASC';
      memories = (ctx.db.prepare(memSql).all(...(memP as never[])) as unknown as MemRow[]).map((r) => ({ id: r.id, agentId: r.agent_id, category: r.category, content: r.content, keywords: r.keywords, createdAt: r.created_at, createdLabel: label(r.created_at) }));
    } else {
      // pure text search across recent items (no date constraint)
      const like = `%${q}%`;
      const logP: unknown[] = [like];
      let logSql = 'SELECT agent_id, line, created_at FROM daily_logs WHERE line LIKE ? COLLATE NOCASE';
      if (agent !== '') { logSql += ' AND agent_id = ?'; logP.push(agent); }
      logSql += ' ORDER BY created_at DESC LIMIT ?'; logP.push(limit);
      logs = (ctx.db.prepare(logSql).all(...(logP as never[])) as unknown as LogRow[]).map((r) => ({ agentId: r.agent_id, line: r.line, createdAt: r.created_at, createdLabel: label(r.created_at) }));

      const memP: unknown[] = [like, like];
      let memSql = "SELECT id, agent_id, category, content, keywords, salience, created_at FROM memories WHERE archived_at IS NULL AND (content LIKE ? COLLATE NOCASE OR keywords LIKE ? COLLATE NOCASE)";
      if (agent !== '') { memSql += " AND (agent_id = ? OR category = 'shared')"; memP.push(agent); }
      memSql += ' ORDER BY created_at DESC LIMIT ?'; memP.push(limit);
      memories = (ctx.db.prepare(memSql).all(...(memP as never[])) as unknown as MemRow[]).map((r) => ({ id: r.id, agentId: r.agent_id, category: r.category, content: r.content, keywords: r.keywords, createdAt: r.created_at, createdLabel: label(r.created_at) }));
    }

    if (q !== '' && dated) {
      logs = logs.filter((l) => l.line.toLowerCase().includes(q));
      memories = memories.filter((m) => m.content.toLowerCase().includes(q) || m.keywords.toLowerCase().includes(q));
    }

    const agents = [...new Set([...logs.map((l) => l.agentId), ...memories.map((m) => m.agentId)])].sort();
    sendJson(c.res, 200, {
      dateRange: { from: dated ? from : '', to: dated ? to : '' },
      logs, memories,
      summary: { logCount: logs.length, memoryCount: memories.length, agents },
    });
  });
}
