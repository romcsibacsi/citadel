// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * Server-side natural-language date-expression parser (PROMPT-09 §6B.4). The
 * Recall endpoint takes a `date` expression and resolves it here, in the
 * configured local timezone (Budapest), so off-by-one-day errors near midnight
 * can't happen. Returns a {from,to} YYYY-MM-DD range, or null when unparseable.
 */

export interface DayRange { from: string; to: string }

function ymdInTz(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** Calendar-shift a YYYY-MM-DD by n days (tz-agnostic arithmetic on the date). */
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
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, '0');
  return { from: `${y}-${mm}-01`, to: `${y}-${mm}-${String(last).padStart(2, '0')}` };
}

// weekday name -> Mon-first index (HU, accent-insensitive, + EN)
const WEEKDAYS: Record<string, number> = {
  hetfo: 0, hétfő: 0, monday: 0,
  kedd: 1, tuesday: 1,
  szerda: 2, wednesday: 2,
  csutortok: 3, csütörtök: 3, thursday: 3,
  pentek: 4, péntek: 4, friday: 4,
  szombat: 5, saturday: 5,
  vasarnap: 6, vasárnap: 6, sunday: 6,
};
const MONTHS: Record<string, number> = {
  januar: 1, január: 1, january: 1, februar: 2, február: 2, february: 2, marcius: 3, március: 3, march: 3,
  aprilis: 4, április: 4, april: 4, majus: 5, május: 5, may: 5, junius: 6, június: 6, june: 6,
  julius: 7, július: 7, july: 7, augusztus: 8, august: 8, szeptember: 9, september: 9,
  oktober: 10, október: 10, october: 10, november: 11, december: 12,
};

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function parseDateExpr(raw: string, tz: string): DayRange | null {
  const s = raw.trim().toLowerCase();
  if (s === '') return null;
  const today = ymdInTz(new Date(), tz);

  const range = /^(\d{4}-\d{2}-\d{2})\s*(?:-|–|—|to|\.\.)\s*(\d{4}-\d{2}-\d{2})$/.exec(s);
  if (range) return { from: range[1]!, to: range[2]! };
  if (ISO.test(s)) return { from: s, to: s };

  if (s === 'ma' || s === 'today') return { from: today, to: today };
  if (s === 'tegnap' || s === 'yesterday') { const y = shiftYmd(today, -1); return { from: y, to: y }; }
  if (s === 'tegnapelott' || s === 'tegnapelőtt') { const y = shiftYmd(today, -2); return { from: y, to: y }; }

  let m: RegExpExecArray | null;
  if ((m = /^(\d+)\s*(?:nappal ezelott|nappal ezelőtt|napja|days? ago)$/.exec(s))) { const y = shiftYmd(today, -Number(m[1])); return { from: y, to: y }; }
  if ((m = /^(?:elmult|elmúlt|utolso|utolsó|last)\s*(\d+)\s*(?:nap|days?)$/.exec(s))) { return { from: shiftYmd(today, -(Number(m[1]) - 1)), to: today }; }
  if ((m = /^(\d+)\s*(?:hete|héttel ezelott|héttel ezelőtt|hettel ezelott|weeks? ago)$/.exec(s))) { const base = shiftYmd(today, -7 * Number(m[1])); const w = weekdayMonFirst(base); const from = shiftYmd(base, -w); return { from, to: shiftYmd(from, 6) }; }

  if (s === 'ezen a heten' || s === 'ezen a héten' || s === 'this week') { const w = weekdayMonFirst(today); const from = shiftYmd(today, -w); return { from, to: shiftYmd(from, 6) }; }
  if (s === 'mult heten' || s === 'múlt héten' || s === 'last week') { const w = weekdayMonFirst(today); const from = shiftYmd(today, -w - 7); return { from, to: shiftYmd(from, 6) }; }
  if (s === 'ebben a honapban' || s === 'ebben a hónapban' || s === 'this month') return monthBounds(today);
  if (s === 'mult honapban' || s === 'múlt hónapban' || s === 'last month') { const [y, mo] = today.split('-').map(Number) as [number, number]; const prev = new Date(Date.UTC(y, mo - 2, 1)).toISOString().slice(0, 10); return monthBounds(prev); }

  // weekday name, optionally prefixed with múlt/előző ("last") -> most recent occurrence
  const wd = /^(?:mult |múlt |elozo |előző )?([a-zá-ű]+)$/.exec(s);
  if (wd && WEEKDAYS[wd[1]!] !== undefined) {
    const want = WEEKDAYS[wd[1]!]!;
    const cur = weekdayMonFirst(today);
    let back = (cur - want + 7) % 7;
    if (back === 0 && /mult|múlt|elozo|előző/.test(s)) back = 7;
    const day = shiftYmd(today, -back);
    return { from: day, to: day };
  }

  // "június 7" (month + day) or bare month name
  const md = /^([a-zá-ű]+)(?:\s+(\d{1,2}))?\.?$/.exec(s);
  if (md && MONTHS[md[1]!] !== undefined) {
    const mo = MONTHS[md[1]!]!;
    const year = Number(today.slice(0, 4));
    if (md[2]) { const day = `${year}-${String(mo).padStart(2, '0')}-${String(Number(md[2])).padStart(2, '0')}`; return { from: day, to: day }; }
    return monthBounds(`${year}-${String(mo).padStart(2, '0')}-01`);
  }

  return null;
}
