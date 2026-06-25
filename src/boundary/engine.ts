// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
// #288 — the masking ENGINE: the domain-FREE routing/dispatch that turns a typed record into sealed
// leaves by consulting ONLY the resolved policy. This is where default-deny-by-absence lives: a leaf
// with no field-policy in any loaded pack becomes OPAQUE. The engine knows nothing about accounting.

import { createHash } from 'node:crypto';
import type { ResolvedPolicy } from './policy/registry.js';
import type { Token } from './token/token.js';
import { decideClear } from './clearAllow.js';

/** A sealed leaf: a token, a gate-cleared committed constant, or opaque. NEVER raw plaintext. */
export type SealedLeaf =
  | { t: 'token'; cls: string; v: Token }
  | { t: 'const'; field: string; v: string } // gate-cleared committed structural constant
  | { t: 'opaque'; v: Token };

export interface SealedRecord {
  schemaId: string;
  leaves: Record<string, SealedLeaf>;
}

/** #339 — PER-COLUMN token domain. The HMAC domain ALWAYS includes the (table, column) identity, so the
 *  SAME value in two different columns (or two tables) yields UNRELATED tokens: no cross-column / cross-table
 *  equal-token linkage (equi-join re-id) and no universal empty/null token. A pack's domainTag is retained as
 *  an extra namespace prefix, but column identity is what makes separation structural — shared pack tags (e.g.
 *  'inv.amt' across six amount columns) no longer collide. An intentional equi-join must be opted into
 *  explicitly later (a declared join-domain); by default every column is isolated. Length-prefixed so the
 *  three parts cannot be forged into one another by a value/tag that embeds the separator. */
function columnDomain(schemaId: string, fieldPath: string, packTag: string): string {
  const enc = (s: string): string => `${s.length}:${s}`;
  return `${enc(packTag)}${enc(schemaId)}${enc(fieldPath)}`;
}

/** #344-C — the per-record salt: a stable hash of the WHOLE record (canonical, key-sorted). Record-DERIVED
 *  (not random) so the deterministic assertProjection recompute still matches; two records that differ in ANY
 *  field get different salts, so the SAME value in different records tokenizes differently (breaks
 *  opaque-equality / frequency). Two identical records share a salt (k>=2 is unavoidable and fine). */
export function recordSaltOf(leaves: Record<string, string>): string {
  const h = createHash('sha256');
  // null/undefined leaves normalize to '' (R2: a null leaf salts identically to its empty-string twin, so the
  // record-salt cannot itself separate null from empty), and a null-injected row never crashes on `.length`.
  for (const k of Object.keys(leaves).sort()) {
    const v = leaves[k] ?? '';
    h.update(`${k.length}:${k}${v.length}:${v}`);
  }
  return h.digest('base64url').slice(0, 16);
}

/** The token domain for a leaf: the per-column domain, plus the per-record salt when the field is salted
 *  (#344-C). A salted field's domain is record-unique; a non-salted (join/dedup) field stays deterministic. */
function leafDomain(schemaId: string, fieldPath: string, packTag: string, salted: boolean, recordSalt: string | undefined): string {
  const base = columnDomain(schemaId, fieldPath, packTag);
  return salted && recordSalt !== undefined ? `${base}${recordSalt.length}:${recordSalt}` : base;
}

/** #339 — quantize an amount to a BAND before tokenizing, so near-equal amounts share a token and a UNIQUE
 *  amount is no longer a singleton (k-anon: defeats known-amount 1:1 linkage with auxiliary data). With committed
 *  equi-depth `boundaries` (the deployment band-schema, generated at the configured k_min) the value maps to its
 *  bucket index -> GUARANTEED >= k_min per bucket. WITHOUT a schema it falls back to a relative 2-significant-
 *  figure band (reduces singletons but does not prove k). Both are DETERMINISTIC, so the assertProjection
 *  recompute-equality invariant still holds. A non-numeric/zero value is returned unchanged. */
/** #340 crit-3: the NON-unique 'below-k_min' suppressed-band marker. A value in a band with < k_min members
 *  maps to THIS (per-column, via the domain) instead of a unique opaque-keyed token, hiding both the value and
 *  its uniqueness (fails-closed; operator criterion 3 — no k<5 cell exposed). */
export const SUPPRESSED_BAND = 'bsup';

/** #344-R1/R2 — the presence-suppress sentinel (NEXUS policy). An empty OR null value collapses to THIS one
 *  marker so (R2) null and empty are indistinguishable and (R1) a rare-presence cohort carries NO mappable value
 *  (the re-id analysis treats `value === 'SUPPRESSED'` as ABSENT, like a k-anon suppression). Presence is a leak
 *  the per-record salt does NOT cover (salt hides the VALUE, not the filled-vs-null pattern), so it is suppressed,
 *  not salted. A non-empty value falls through to the normal (salted) tokenization below. */
export const SUPPRESSED_PRESENCE = 'SUPPRESSED';

export function bandAmount(value: string, boundaries?: readonly number[], suppressBands?: readonly number[]): string {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return value;
  if (boundaries !== undefined) {
    // committed equi-depth: the bucket index (count of boundaries strictly below the value) is the band.
    let lo = 0;
    let hi = boundaries.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (boundaries[mid]! < n) lo = mid + 1;
      else hi = mid;
    }
    // #340 crit-3: a band with < k_min members is strict-suppressed to a non-unique marker (never a singleton).
    if (suppressBands !== undefined && suppressBands.includes(lo)) return SUPPRESSED_BAND;
    return `b${lo}`;
  }
  const neg = n < 0;
  const a = Math.abs(n);
  const mag = Math.pow(10, Math.floor(Math.log10(a)) - 1); // step = 1/100 of the magnitude -> 2 significant figures
  const banded = Math.round(a / mag) * mag;
  return String(neg ? -banded : banded);
}

/** THE single source-of-truth for clear-vs-tokenize, used IDENTICALLY by the projector (sealRecord),
 *  the assert (assertProjection), and the gate (decideClear). One leaf -> one classification, derived
 *  ONLY from the FieldPolicy + the committed allowlist. Default-deny: no policy -> OPAQUE. */
export function classifyLeaf(
  schemaId: string,
  fieldPath: string,
  value: string,
  policy: ResolvedPolicy,
  recordSalt?: string,
): SealedLeaf {
  // #344-R1/R2: PRESENCE is hidden by the IRON-LAW per-record SALT, NOT a constant sentinel (NEXUS retraction
  // after PROBE's injection test: a salted empty/null cell is per-record-UNIQUE and unmappable -- a k=1 empty
  // cohort is a verifier-limit FALSE-positive, not a leak, indistinguishable from a filled salted cell). null
  // normalizes to '' (R2: null and empty salt identically within a record) and falls through to the salted path.
  const nv = value ?? '';
  const pol = policy.fieldPolicy(schemaId, fieldPath);
  // #344 TIER-2: a low-card flag's <k_min minority VALUE -> the absent sentinel (joint-k suppression), so the rare
  // cell carries no QI-taint (its (flag, id) joint reduces to the id-pseudonym). The common value stays normal.
  if (pol?.lowCardSuppress === true && policy.isCategoricalSuppressed(schemaId, fieldPath, nv)) {
    return { t: 'opaque', v: SUPPRESSED_PRESENCE as Token };
  }
  const dom = (packTag: string, salted: boolean): string => leafDomain(schemaId, fieldPath, packTag, salted, recordSalt);
  // #344-2 IRON LAW: a tokenized leaf is per-record SALTED by DEFAULT; determinism is the explicit exception —
  // a banded amount (band-aggregate / joint-k) or a `join`-whitelisted column stays deterministic.
  const salted = pol === undefined ? true : !(pol.band === true || pol.join === true);
  if (pol === undefined) {
    // DEFAULT-DENY BY ABSENCE: no pack supplies a policy for this leaf -> OPAQUE, per-column domain (#339), salted.
    return { t: 'opaque', v: policy.tokenize(nv, 'opaque', dom('opaque', salted)) };
  }
  if (pol.tokenClass === 'clear-eligible') {
    const field = pol.constField ?? pol.fieldPath;
    if (decideClear(field, nv, policy)) {
      return { t: 'const', field, v: nv }; // committed structural constant / universal vocabulary -> clear
    }
    return { t: 'token', cls: 'hmac', v: policy.tokenize(nv, 'hmac', dom(pol.domainTag, salted)) }; // not clear -> token
  }
  if (pol.tokenClass === 'vocab-clear') {
    // universal PUBLIC reference vocabulary (customer-independent) -> the whole column clears.
    return { t: 'const', field: pol.constField ?? pol.fieldPath, v: nv };
  }
  if (pol.tokenClass === 'opaque') {
    // #339: an amount column is quantized to a band first (k-anon), then tokenized per-column. Committed
    // equi-depth boundaries (deployment band-schema) guarantee >= k_min/bucket; a <k_min band is strict-
    // suppressed (#340 crit-3); absent => relative-band default. #344-2: a NON-banded opaque (free-text /
    // structural) is per-record SALTED by default -> no opaque-equality across records; a banded amount stays
    // deterministic (salted = false above) for the k-anon band-aggregate.
    const spec = pol.band === true ? policy.bandSpec(schemaId, fieldPath) : undefined;
    const bv = pol.band === true ? bandAmount(nv, spec?.boundaries, spec?.suppressBands) : nv;
    return { t: 'opaque', v: policy.tokenize(bv, 'opaque', dom(pol.domainTag, salted)) };
  }
  return { t: 'token', cls: pol.tokenClass, v: policy.tokenize(nv, pol.tokenClass, dom(pol.domainTag, salted)) };
}

/** STRUCTURAL fails-closed invariant: a 'const' (clear) leaf is legitimate ONLY when its value is a
 *  committed-allowlist constant OR it comes from a whole-column vocab-clear field. ANY other clear is a
 *  fails-OPEN false-clear (the forbidden anti-pattern). Non-const leaves (token/opaque) are always egress-
 *  legitimate. The egress guard and the (b)-DB projector both enforce this, so default-deny is structural
 *  (not a per-column decision) regardless of how a SealedLeaf was constructed. */
export function isClearLegit(leaf: SealedLeaf, policy: ResolvedPolicy): boolean {
  if (leaf.t !== 'const') return true;
  return policy.isClearAllowed(leaf.field, leaf.v) || policy.isVocabClearField(leaf.field);
}

/** Seal a flat leaf-map (path -> raw value) for one record via the single classifyLeaf source-of-truth. */
export function sealRecord(
  schemaId: string,
  leaves: Record<string, string>,
  policy: ResolvedPolicy,
): SealedRecord {
  const out: Record<string, SealedLeaf> = {};
  const salt = recordSaltOf(leaves); // #344-C: one per-record salt for all salted fields in this record
  for (const [path, value] of Object.entries(leaves)) {
    out[path] = classifyLeaf(schemaId, path, value, policy, salt);
  }
  return { schemaId, leaves: out };
}

/** ZERO-RAW-ASSERT (shadow phase-2): the projected output MUST match the FieldPolicy classification
 *  exactly, and any cleared leaf MUST be a committed-allowlist-validated constant (never a raw sensitive
 *  value). Projector + assert share classifyLeaf -> the FieldPolicy is the single source-of-truth. */
export function assertProjection(
  schemaId: string,
  rawLeaves: Record<string, string>,
  sealed: SealedRecord,
  policy: ResolvedPolicy,
): void {
  const salt = recordSaltOf(rawLeaves); // #344-C: recompute the SAME per-record salt for the equality check
  for (const [path, value] of Object.entries(rawLeaves)) {
    const got = sealed.leaves[path];
    if (got === undefined) throw new Error(`assertProjection: ${schemaId}.${path} missing in projection`);
    // a cleared leaf must be gate-validated (in the committed allowlist) — never a leaked sensitive value.
    if (got.t === 'const' && !policy.isClearAllowed(got.field, got.v)) {
      throw new Error(`assertProjection: ${schemaId}.${path} cleared but value not in committed allowlist`);
    }
    // the projection must equal the single-source-of-truth classification (no divergence between projector
    // and policy) — this is what the shadow zero-raw-assert demands.
    const expect = classifyLeaf(schemaId, path, value, policy, salt);
    if (JSON.stringify(got) !== JSON.stringify(expect)) {
      throw new Error(`assertProjection: ${schemaId}.${path} projection diverges from FieldPolicy classification`);
    }
  }
}
