// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * Pure 5-field cron engine (SPEC §9). No date library: timezone evaluation
 * goes through Intl.DateTimeFormat#formatToParts against IANA timezone names.
 *
 * Field grammar (minute hour day-of-month month day-of-week): '*', single
 * values, lists (1,2), ranges (1-5), steps ('*\/15', '1-30/5', and 'N/step'
 * meaning N..max/step — the common vixie extension). Aliases: @hourly @daily
 * @weekly @monthly. Day-of-week accepts 0-7 where both 0 and 7 are Sunday
 * (7 is normalized to 0 at parse time).
 *
 * dom/dow semantics (vixie-cron rule): when BOTH day-of-month and day-of-week
 * are restricted, a minute matches when EITHER field matches; when only one is
 * restricted, that one must match. Following vixie, a field counts as
 * "restricted" only when it does not begin with '*' (so '*\/2' is a star
 * field for this rule).
 *
 * DST behavior of minute-mark scanning (documented, tested): local times
 * skipped by a spring-forward transition never fire that day; local times
 * repeated by a fall-back transition fire on each occurrence.
 */

export interface ParsedCron {
  /** Original expression (pre-alias-expansion), kept for logging. */
  readonly expr: string;
  readonly minute: ReadonlySet<number>;
  readonly hour: ReadonlySet<number>;
  readonly dayOfMonth: ReadonlySet<number>;
  readonly month: ReadonlySet<number>;
  /** 0-6 with Sunday = 0 (an input of 7 is normalized to 0). */
  readonly dayOfWeek: ReadonlySet<number>;
  /** Vixie star rule: false when the raw field begins with '*'. */
  readonly domRestricted: boolean;
  readonly dowRestricted: boolean;
}

interface FieldSpec {
  name: string;
  min: number;
  max: number;
}

const SECOND_FIELD: FieldSpec = { name: 'second', min: 0, max: 59 };
const MINUTE_FIELD: FieldSpec = { name: 'minute', min: 0, max: 59 };
const HOUR_FIELD: FieldSpec = { name: 'hour', min: 0, max: 23 };
const DOM_FIELD: FieldSpec = { name: 'day-of-month', min: 1, max: 31 };
const MONTH_FIELD: FieldSpec = { name: 'month', min: 1, max: 12 };
const DOW_FIELD: FieldSpec = { name: 'day-of-week', min: 0, max: 7 };

const ALIASES: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
};

const MINUTE_MS = 60_000;

function parseNumber(token: string, spec: FieldSpec, expr: string): number {
  if (!/^\d+$/.test(token)) {
    throw new Error(`invalid cron "${expr}": "${token}" is not a number in the ${spec.name} field`);
  }
  return Number(token);
}

function parseField(raw: string, spec: FieldSpec, expr: string): Set<number> {
  const values = new Set<number>();
  for (const part of raw.split(',')) {
    if (part.length === 0) {
      throw new Error(`invalid cron "${expr}": empty list item in the ${spec.name} field`);
    }
    const slash = part.split('/');
    if (slash.length > 2) {
      throw new Error(`invalid cron "${expr}": multiple "/" in the ${spec.name} field`);
    }
    const base = slash[0]!;
    let step = 1;
    if (slash.length === 2) {
      step = parseNumber(slash[1]!, spec, expr);
      if (step < 1) {
        throw new Error(`invalid cron "${expr}": step must be >= 1 in the ${spec.name} field`);
      }
    }
    let lo: number;
    let hi: number;
    if (base === '*') {
      lo = spec.min;
      hi = spec.max;
    } else if (base.includes('-')) {
      const ends = base.split('-');
      if (ends.length !== 2) {
        throw new Error(`invalid cron "${expr}": malformed range "${base}" in the ${spec.name} field`);
      }
      lo = parseNumber(ends[0]!, spec, expr);
      hi = parseNumber(ends[1]!, spec, expr);
      if (lo > hi) {
        throw new Error(`invalid cron "${expr}": reversed range "${base}" in the ${spec.name} field`);
      }
    } else {
      lo = parseNumber(base, spec, expr);
      // 'N/step' is the common extension meaning N..max/step.
      hi = slash.length === 2 ? spec.max : lo;
    }
    if (lo < spec.min || hi > spec.max) {
      throw new Error(
        `invalid cron "${expr}": ${spec.name} value out of range (allowed ${spec.min}-${spec.max})`,
      );
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return values;
}

/**
 * Parse a 5-field cron expression, a 6-field (leading seconds) expression, or a
 * supported @alias. A 6-field expression's seconds column is validated (0-59) but
 * NOT honored for matching — the runner ticks at minute granularity, so a 6-field
 * cron fires at second 0 of each matching minute (documented limitation, SPEC §9).
 * Throws on anything invalid.
 */
export function parseCron(expr: string): ParsedCron {
  const trimmed = expr.trim();
  let spec = trimmed;
  if (trimmed.startsWith('@')) {
    const alias = ALIASES[trimmed];
    if (alias === undefined) {
      throw new Error(`invalid cron "${expr}": unknown alias (supported: ${Object.keys(ALIASES).join(' ')})`);
    }
    spec = alias;
  }
  const all = spec.split(/\s+/).filter((f) => f.length > 0);
  if (all.length !== 5 && all.length !== 6) {
    throw new Error(`invalid cron "${expr}": expected 5 or 6 fields, got ${all.length}`);
  }
  // 6-field form prepends a seconds column — validate it, then map the rest as 5-field.
  const fields = all.length === 6 ? all.slice(1) : all;
  if (all.length === 6) parseField(all[0]!, SECOND_FIELD, expr);
  const [minRaw, hourRaw, domRaw, monRaw, dowRaw] = fields as [string, string, string, string, string];
  const dayOfWeek = parseField(dowRaw, DOW_FIELD, expr);
  if (dayOfWeek.delete(7)) dayOfWeek.add(0); // 7 == Sunday == 0
  return {
    expr,
    minute: parseField(minRaw, MINUTE_FIELD, expr),
    hour: parseField(hourRaw, HOUR_FIELD, expr),
    dayOfMonth: parseField(domRaw, DOM_FIELD, expr),
    month: parseField(monRaw, MONTH_FIELD, expr),
    dayOfWeek,
    domRestricted: !domRaw.startsWith('*'),
    dowRestricted: !dowRaw.startsWith('*'),
  };
}

/** Wall-clock fields of a UTC instant evaluated in an IANA timezone. */
export interface LocalFields {
  minute: number;
  hour: number;
  dayOfMonth: number;
  month: number;
  /** 0-6, Sunday = 0. */
  dayOfWeek: number;
}

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// Formatter construction is expensive; cache per timezone (pure: no observable state).
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatterCache.get(timeZone);
  if (fmt === undefined) {
    // en-US fixes the weekday names the WEEKDAY_INDEX map relies on; h23 pins hours to 0-23.
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      minute: 'numeric',
      hour: 'numeric',
      day: 'numeric',
      month: 'numeric',
      weekday: 'short',
    });
    formatterCache.set(timeZone, fmt);
  }
  return fmt;
}

/**
 * Resolve a Date to its wall-clock fields in the given IANA timezone.
 * Throws (from Intl) on an unknown timezone name.
 */
export function localFields(date: Date, timeZone: string): LocalFields {
  const parts = formatterFor(timeZone).formatToParts(date);
  const out: LocalFields = { minute: 0, hour: 0, dayOfMonth: 1, month: 1, dayOfWeek: 0 };
  for (const part of parts) {
    switch (part.type) {
      case 'minute':
        out.minute = Number(part.value);
        break;
      case 'hour':
        out.hour = Number(part.value) % 24; // defensive: some ICU builds emit 24 at midnight
        break;
      case 'day':
        out.dayOfMonth = Number(part.value);
        break;
      case 'month':
        out.month = Number(part.value);
        break;
      case 'weekday': {
        const idx = WEEKDAY_INDEX[part.value];
        if (idx === undefined) throw new Error(`unrecognized weekday "${part.value}" from Intl`);
        out.dayOfWeek = idx;
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/** Does the cron match the minute containing `date`, evaluated in `timeZone`? */
export function cronMatchesAt(parsed: ParsedCron, date: Date, timeZone: string): boolean {
  const f = localFields(date, timeZone);
  if (!parsed.minute.has(f.minute)) return false;
  if (!parsed.hour.has(f.hour)) return false;
  if (!parsed.month.has(f.month)) return false;
  const domMatch = parsed.dayOfMonth.has(f.dayOfMonth);
  const dowMatch = parsed.dayOfWeek.has(f.dayOfWeek);
  // Vixie rule: both restricted -> EITHER matches; one restricted -> that one.
  if (parsed.domRestricted && parsed.dowRestricted) return domMatch || dowMatch;
  if (parsed.domRestricted) return domMatch;
  if (parsed.dowRestricted) return dowMatch;
  return true;
}

/**
 * Every minute mark in (fromExclusive, toInclusive] where the cron fires,
 * evaluated in `timeZone`. Marks are UTC instants at second 0 of each minute.
 */
export function firesInWindow(
  parsed: ParsedCron,
  fromExclusive: Date,
  toInclusive: Date,
  timeZone: string,
): Date[] {
  const fires: Date[] = [];
  // First candidate: the minute mark strictly after fromExclusive (a mark
  // exactly at fromExclusive is excluded — it belongs to the previous window).
  let t = Math.floor(fromExclusive.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  for (; t <= toInclusive.getTime(); t += MINUTE_MS) {
    const mark = new Date(t);
    if (cronMatchesAt(parsed, mark, timeZone)) fires.push(mark);
  }
  return fires;
}
