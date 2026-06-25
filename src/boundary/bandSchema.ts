// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
// #339 — committed equi-depth band-schema generation + lookup. The band BOUNDARIES are deployment-data-derived
// (computed from the real (b)-DB column values at a configured k_min), NOT pack-hardcoded: the synthetic-canary
// schema is generated at K_MIN_CANARY (5), production at K_MIN_PRODUCTION_FLOOR (25, the design baseline). The
// schema is a RUNTIME input to the projector; the pack only marks WHICH columns band (FieldPolicy.band).

import type { BandSpec, BandSchema, SuppressPolicy, CategoricalSuppress } from './policy/types.js';

/** Production k-anonymity floor (the DECISION-DOC baseline / clearAllow joint-k). The shipped default. */
export const K_MIN_PRODUCTION_FLOOR = 25;
/** Synthetic-canary override ONLY (small dataset). MUST NOT silently become the shipped floor -- the audit
 *  report states which k_min it PASSed at so the external auditor is not over-told. */
export const K_MIN_CANARY = 5;

/** The canary suppress-policy for `<k_min` bands: 'suppress' (cleanest fails-closed). Production is TUNABLE
 *  ('suppress' vs 'opaque-keyed') -- a real-customer / external-audit choice; this is NOT a hardcoded shipped
 *  default. The chosen policy is recorded in every BandSchema so the audit states it. */
export const SUPPRESS_POLICY_CANARY: SuppressPolicy = 'suppress';

/** Bucket index for a value under ascending boundaries: count of boundaries strictly below the value. */
export function bandBucket(value: number, boundaries: readonly number[]): number {
  let lo = 0;
  let hi = boundaries.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (boundaries[mid]! < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Duplicate-safe greedy equi-depth boundaries for one column's integer values, guaranteeing EVERY bucket holds
 * >= kMin records (k-anon marginal floor). Equal values never split across a boundary; the tail is merged into
 * the last bucket so no bucket is left short. A column with < kMin values yields NO boundaries (one bucket).
 */
export function equiDepthBoundaries(values: readonly number[], kMin: number): number[] {
  const s = [...values].sort((a, b) => a - b);
  if (s.length < kMin * 2) return []; // can't make two buckets of >= kMin -> one bucket
  const bnds: number[] = [];
  let acc = 0;
  let i = 0;
  while (i < s.length) {
    let j = i;
    while (j < s.length && s[j] === s[i]) j += 1; // absorb all duplicates of s[i]
    acc += j - i;
    // close a bucket only if it has >= kMin AND the remaining tail can still fill >= kMin
    if (acc >= kMin && s.length - j >= kMin) {
      bnds.push(Math.floor((s[j - 1]! + s[j]!) / 2));
      acc = 0;
    }
    i = j;
  }
  return bnds;
}

/** A flat (b)-DB row as the projector sees it: one table + its column values (strings). */
export interface BandSourceRow {
  table: string;
  row: Record<string, string>;
}

/**
 * JOINT-SAFE boundaries for a quasi-identifier AMOUNT column (operator PASS-criterion 3: no k<k_min CELL exposed).
 * Starts from the marginal equi-depth boundaries and greedily MERGES adjacent amount bands (suppress-joint-where
 * -k<k_min) until EVERY (enum-combo x amount-band) joint cell holds >= k_min records. The enum columns are the
 * other quasi-identifiers in the same table (e.g. direction, currency). On a tiny stratum this can collapse the
 * amount to a single band -- that is a dataset-SIZE artifact (e.g. an 11-row stratum cannot host two >= 5
 * bands), not a base weakness; it relaxes at production scale. The projector stays per-column: the joint safety
 * is baked into the (coarser) committed boundaries, no per-record joint logic.
 */
export function jointSafeBoundaries(
  rows: readonly BandSourceRow[],
  table: string,
  enumCols: readonly string[],
  amountCol: string,
  kMin: number,
): number[] {
  const recs = rows
    .filter((r) => r.table === table && r.row[amountCol] !== undefined && r.row[amountCol] !== '')
    .map((r) => ({ amt: Number(r.row[amountCol]), key: enumCols.map((c) => r.row[c] ?? '').join('') }))
    .filter((r) => Number.isFinite(r.amt));
  let bnds = equiDepthBoundaries(recs.map((r) => r.amt), kMin);
  // greedily drop boundaries until every joint cell >= kMin (or only one band remains)
  for (;;) {
    const cell = new Map<string, number>();
    for (const r of recs) cell.set(`${r.key}${bandBucket(r.amt, bnds)}`, (cell.get(`${r.key}${bandBucket(r.amt, bnds)}`) ?? 0) + 1);
    if (bnds.length === 0 || Math.min(...cell.values()) >= kMin) return bnds;
    // remove the boundary whose adjacent merge most helps the smallest cell: simplest robust rule = drop the
    // boundary nearest the offending band. Here we drop the median boundary (coarsen uniformly); repeat.
    bnds.splice(Math.floor(bnds.length / 2), 1);
  }
}

/**
 * Build a committed band-schema from (b)-DB rows for the given banded columns, at kMin. Each column's boundaries
 * are computed from ITS values so every bucket holds >= kMin records (marginal k-anon). Non-numeric/empty values
 * are skipped for boundary computation (they still tokenize per-column).
 */
export function generateBandSchema(
  rows: readonly BandSourceRow[],
  bandedFields: ReadonlyArray<{ schemaId: string; fieldPath: string }>,
  kMin: number,
  suppressPolicy: SuppressPolicy = SUPPRESS_POLICY_CANARY,
): BandSchema {
  const specs: BandSpec[] = [];
  for (const { schemaId, fieldPath } of bandedFields) {
    const values: number[] = [];
    for (const r of rows) {
      if (r.table !== schemaId) continue;
      const raw = r.row[fieldPath];
      if (raw === undefined || raw === '') continue;
      const n = Number(raw);
      if (Number.isFinite(n)) values.push(n);
    }
    const boundaries = equiDepthBoundaries(values, kMin);
    // #340 crit-3 (GENERAL rule, not table-specific): under the 'suppress' policy, mark EVERY band with
    // < k_min members for strict-suppress. Under 'opaque-keyed', leave suppressBands empty -> the band keeps
    // its keyed (value-hidden) index (the production-tunable choice). The policy is recorded on the schema.
    const counts = new Map<number, number>();
    for (const v of values) counts.set(bandBucket(v, boundaries), (counts.get(bandBucket(v, boundaries)) ?? 0) + 1);
    const suppressBands: number[] = [];
    if (suppressPolicy === 'suppress') {
      for (let b = 0; b <= boundaries.length; b++) if ((counts.get(b) ?? 0) < kMin) suppressBands.push(b);
    }
    specs.push({ schemaId, fieldPath, boundaries, suppressBands });
  }
  return { kMin, suppressPolicy, specs };
}

/** Index a band-schema for O(1) lookup by `schemaId fieldPath`. */
export function indexBandSchema(schema: BandSchema | undefined): Map<string, BandSpec> {
  const m = new Map<string, BandSpec>();
  if (schema === undefined) return m;
  for (const s of schema.specs) m.set(`${s.schemaId} ${s.fieldPath}`, s);
  return m;
}

/**
 * #344 TIER-2: compute the categorical suppress-set for low-card fields. For each field, a VALUE whose cohort is
 * < kMin is suppressed (joint-k suppression). Empty/null are excluded (already presence-suppressed). Deployment-
 * data-derived (never pack-hardcoded), so the pack only MARKS a field lowCardSuppress; the rare value comes from
 * the real distribution at the configured kMin.
 */
export function generateCategoricalSuppress(
  rows: readonly BandSourceRow[],
  lowCardFields: ReadonlyArray<{ schemaId: string; fieldPath: string }>,
  kMin: number,
): CategoricalSuppress[] {
  const out: CategoricalSuppress[] = [];
  for (const { schemaId, fieldPath } of lowCardFields) {
    const counts = new Map<string, number>();
    for (const r of rows) {
      if (r.table !== schemaId) continue;
      const raw = r.row[fieldPath];
      if (raw === undefined || raw === '') continue;
      counts.set(raw, (counts.get(raw) ?? 0) + 1);
    }
    const suppressValues = [...counts.entries()].filter(([, n]) => n < kMin).map(([v]) => v).sort();
    out.push({ schemaId, fieldPath, suppressValues });
  }
  return out;
}

/** Index the categorical suppress-set -> `schemaId fieldPath` -> the Set of suppressed values. */
export function indexCategoricalSuppress(schema: BandSchema | undefined): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  for (const c of schema?.categoricalSuppress ?? []) m.set(`${c.schemaId} ${c.fieldPath}`, new Set(c.suppressValues));
  return m;
}
