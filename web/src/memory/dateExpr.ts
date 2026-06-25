// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * Natural-language date-expression parser (PROMPT-08 §6.9) — client-side, so the
 * backend journal endpoint stays a plain YYYY-MM-DD `from`/`to` contract. Handles
 * ISO dates + ranges and a useful set of Hungarian + English relative phrases.
 * Returns a {from,to} day range, or null when the input can't be parsed.
 */

export interface DayRange { from: string; to: string }

const TZ = 'Europe/Budapest';

export function todayYmd(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

/** Shift a YYYY-MM-DD by n days (calendar arithmetic, tz-agnostic). */
export function shiftYmd(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

function weekdayMonFirst(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; // 0=Mon..6=Sun
}
function monthBounds(ymd: string): DayRange {
  const [y, m] = ymd.split('-').map(Number) as [number, number];
  const from = `${y}-${String(m).padStart(2, '0')}-01`;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from, to: `${y}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}` };
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Parse an expression into a day range; null if unparseable. */
export function parseDateExpr(raw: string): DayRange | null {
  const s = raw.trim().toLowerCase();
  if (s === '') return null;
  const today = todayYmd();

  // ISO range "A - B" (en dash, hyphen, " to ", " – ")
  const rangeMatch = /^(\d{4}-\d{2}-\d{2})\s*(?:-|–|—|to|—|\.\.)\s*(\d{4}-\d{2}-\d{2})$/.exec(s);
  if (rangeMatch) return { from: rangeMatch[1]!, to: rangeMatch[2]! };
  if (ISO.test(s)) return { from: s, to: s };

  if (s === 'ma' || s === 'today') return { from: today, to: today };
  if (s === 'tegnap' || s === 'yesterday') { const y = shiftYmd(today, -1); return { from: y, to: y }; }
  if (s === 'tegnapelőtt') { const y = shiftYmd(today, -2); return { from: y, to: y }; }

  let m: RegExpExecArray | null;
  // N days ago / N nappal ezelőtt / N napja
  if ((m = /^(\d+)\s*(?:nappal ezelőtt|napja|days? ago)$/.exec(s))) { const y = shiftYmd(today, -Number(m[1])); return { from: y, to: y }; }
  // last N days / elmúlt N nap / utolsó N nap
  if ((m = /^(?:elmúlt|utolsó|last)\s*(\d+)\s*(?:nap|days?)$/.exec(s))) { return { from: shiftYmd(today, -(Number(m[1]) - 1)), to: today }; }
  // N weeks ago / N héttel ezelőtt
  if ((m = /^(\d+)\s*(?:héttel ezelőtt|weeks? ago)$/.exec(s))) { const base = shiftYmd(today, -7 * Number(m[1])); const w = weekdayMonFirst(base); const from = shiftYmd(base, -w); return { from, to: shiftYmd(from, 6) }; }

  if (s === 'ezen a héten' || s === 'this week') { const w = weekdayMonFirst(today); const from = shiftYmd(today, -w); return { from, to: shiftYmd(from, 6) }; }
  if (s === 'múlt héten' || s === 'last week') { const w = weekdayMonFirst(today); const from = shiftYmd(today, -w - 7); return { from, to: shiftYmd(from, 6) }; }
  if (s === 'ebben a hónapban' || s === 'this month') return monthBounds(today);
  if (s === 'múlt hónapban' || s === 'last month') { const [y, mo] = today.split('-').map(Number) as [number, number]; const prev = new Date(Date.UTC(y, mo - 2, 1)).toISOString().slice(0, 10); return monthBounds(prev); }

  return null;
}
