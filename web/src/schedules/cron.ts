// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { t } from '../i18n.js';

/**
 * Cron <-> form mapping (PROMPT-07 §3.4/§6.6) + human-readable descriptions
 * (§6.7). The five core presets (daily/weekdays/weekly-mon/weekly-fri/hourly)
 * plus the interval presets compile to standard 5-field cron; anything that does
 * not round-trip to a preset falls back to a raw "custom" expression.
 */

export type FreqValue =
  | 'daily' | 'weekdays' | 'weekly-mon' | 'weekly-fri'
  | 'hourly' | 'every2h' | 'every4h' | 'every30m' | 'custom';

export interface FreqPreset { value: FreqValue; labelKey: string; showsTime: boolean }

export const FREQUENCIES: FreqPreset[] = [
  { value: 'daily', labelKey: 'schedules.freq.daily', showsTime: true },
  { value: 'weekdays', labelKey: 'schedules.freq.weekdays', showsTime: true },
  { value: 'weekly-mon', labelKey: 'schedules.freq.weeklyMon', showsTime: true },
  { value: 'weekly-fri', labelKey: 'schedules.freq.weeklyFri', showsTime: true },
  { value: 'hourly', labelKey: 'schedules.freq.hourly', showsTime: false },
  { value: 'every2h', labelKey: 'schedules.freq.every2h', showsTime: false },
  { value: 'every4h', labelKey: 'schedules.freq.every4h', showsTime: false },
  { value: 'every30m', labelKey: 'schedules.freq.every30m', showsTime: false },
  { value: 'custom', labelKey: 'schedules.freq.custom', showsTime: false },
];

/** Build a 5-field cron from the form's frequency + time + custom-cron field. */
export function formToCron(freq: FreqValue, time: string, customCron: string): string {
  const [hh, mm] = (time || '09:00').split(':');
  const h = String(Number(hh ?? 9));
  const m = String(Number(mm ?? 0));
  switch (freq) {
    case 'daily': return `${m} ${h} * * *`;
    case 'weekdays': return `${m} ${h} * * 1-5`;
    case 'weekly-mon': return `${m} ${h} * * 1`;
    case 'weekly-fri': return `${m} ${h} * * 5`;
    case 'hourly': return '0 * * * *';
    case 'every2h': return '0 */2 * * *';
    case 'every4h': return '0 */4 * * *';
    case 'every30m': return '*/30 * * * *';
    case 'custom': return customCron.trim();
  }
}

/**
 * Normalize a cron to its 5 standard fields: a 6-field (leading seconds) cron
 * (PROMPT-07 §9) is projected to its minute-granular 5-field form for display and
 * round-trip, since the UI/runner are minute-granular. Returns the trimmed input
 * unchanged for any other field count (callers already handle the !==5 case).
 */
function to5Fields(cron: string): string {
  const f = cron.trim().split(/\s+/).filter((x) => x.length > 0);
  return f.length === 6 ? f.slice(1).join(' ') : cron.trim();
}

/** Reverse-map a stored cron back into the form (preset where possible, else custom). */
export function cronToForm(cron: string): { freq: FreqValue; time: string; customCron: string } {
  const f = to5Fields(cron).split(/\s+/);
  const custom = { freq: 'custom' as FreqValue, time: '09:00', customCron: cron.trim() };
  if (f.length !== 5) return custom;
  const [min, hour, dom, mon, dow] = f as [string, string, string, string, string];
  if (min === '*/30' && hour === '*' && dom === '*' && mon === '*' && dow === '*') return { freq: 'every30m', time: '09:00', customCron: '' };
  if (min === '0' && hour === '*' && dom === '*' && mon === '*' && dow === '*') return { freq: 'hourly', time: '09:00', customCron: '' };
  if (min === '0' && hour === '*/2' && dom === '*' && mon === '*' && dow === '*') return { freq: 'every2h', time: '09:00', customCron: '' };
  if (min === '0' && hour === '*/4' && dom === '*' && mon === '*' && dow === '*') return { freq: 'every4h', time: '09:00', customCron: '' };
  // time-of-day forms need numeric minute + hour and unrestricted dom/month
  const nm = Number(min), nh = Number(hour);
  const numeric = /^\d+$/.test(min) && /^\d+$/.test(hour) && dom === '*' && mon === '*';
  if (numeric) {
    const time = `${String(nh).padStart(2, '0')}:${String(nm).padStart(2, '0')}`;
    if (dow === '*') return { freq: 'daily', time, customCron: '' };
    if (dow === '1-5') return { freq: 'weekdays', time, customCron: '' };
    if (dow === '1') return { freq: 'weekly-mon', time, customCron: '' };
    if (dow === '5') return { freq: 'weekly-fri', time, customCron: '' };
  }
  return custom;
}

function hhmm(min: string, hour: string): string {
  return `${String(Number(hour)).padStart(2, '0')}:${String(Number(min)).padStart(2, '0')}`;
}

/** Friendly localized description of a cron (PROMPT-07 §6.7). */
export function humanCron(cron: string): string {
  const f = to5Fields(cron).split(/\s+/);
  if (f.length !== 5) return cron;
  const [min, hour, dom, mon, dow] = f as [string, string, string, string, string];
  const stepMin = /^\*\/(\d+)$/.exec(min);
  if (stepMin && hour === '*' && dom === '*' && dow === '*') return t('schedules.human.everyNmin', { n: stepMin[1]! });
  const stepHour = /^\*\/(\d+)$/.exec(hour);
  if (min === '0' && stepHour && dom === '*' && dow === '*') return t('schedules.human.everyNhours', { n: stepHour[1]! });
  if (min === '0' && hour === '*' && dom === '*' && dow === '*') return t('schedules.human.hourly');
  const numeric = /^\d+$/.test(min) && /^\d+$/.test(hour);
  if (numeric && dom === '*' && mon === '*') {
    const time = hhmm(min, hour);
    if (dow === '1-5') return t('schedules.human.weekdaysAt', { time });
    if (dow === '0,6' || dow === '6,0') return t('schedules.human.weekendsAt', { time });
    if (/^[0-6]$/.test(dow)) return t('schedules.human.weekdayAt', { day: dayName(Number(dow)), time });
    if (dow === '*') return t('schedules.human.dailyAt', { time });
  }
  if (numeric && /^\d+$/.test(dom) && dow === '*') return t('schedules.human.monthlyAt', { day: dom, time: hhmm(min, hour) });
  return cron;
}

/** Full localized day name for a cron weekday number (0/7=Sun, 1=Mon..6=Sat).
 *  Keyed Mon-first (schedules.day.0=Mon..6=Sun) to match the week view. */
export function dayName(n: number): string {
  const sun = n === 7 ? 0 : n; // 0=Sun..6=Sat
  const monFirst = sun === 0 ? 6 : sun - 1; // 0=Mon..6=Sun
  return t(`schedules.day.${monFirst}`);
}

/** Hours (0-23) at which a cron fires — for timeline marker placement. */
export function cronHours(cron: string): number[] {
  const f = to5Fields(cron).split(/\s+/);
  if (f.length !== 5) return [];
  return expandField(f[1]!, 0, 23);
}

/** Minute of a cron's first fire (for slight horizontal offset). */
export function cronMinute(cron: string): number {
  const f = to5Fields(cron).split(/\s+/);
  if (f.length !== 5) return 0;
  const m = expandField(f[0]!, 0, 59);
  return m[0] ?? 0;
}

/** Weekday indices (0=Mon .. 6=Sun) a cron matches — for the week view. */
export function cronWeekdaysMonFirst(cron: string): number[] {
  const f = to5Fields(cron).split(/\s+/);
  if (f.length !== 5) return [];
  // cron dow: 0/7=Sun, 1=Mon..6=Sat -> Mon-first index 0..6
  const cronDow = expandField(f[4]!, 0, 7).map((d) => (d === 7 ? 0 : d));
  const set = new Set(cronDow.map((d) => (d === 0 ? 6 : d - 1)));
  return [...set].sort((a, b) => a - b);
}

/** Expand a single cron field (*, n, a-b, lists, *​/step) to concrete values. */
function expandField(field: string, lo: number, hi: number): number[] {
  const out = new Set<number>();
  for (const part of field.split(',')) {
    const step = /^(.*)\/(\d+)$/.exec(part);
    const body = step ? step[1]! : part;
    const stride = step ? Number(step[2]) : 1;
    let from = lo, to = hi;
    if (body !== '*') {
      const range = /^(\d+)-(\d+)$/.exec(body);
      if (range) { from = Number(range[1]); to = Number(range[2]); }
      else if (/^\d+$/.test(body)) { from = to = Number(body); }
      else continue;
    }
    for (let v = from; v <= to; v += stride) if (v >= lo && v <= hi) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}
