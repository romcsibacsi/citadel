// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
// #288 F0 — the CORE/MODULE contract (the cut-point).
//
// A PolicyPack is a DECLARATIVE domain module that supplies the domain knowledge (record schemas,
// per-field token policies, the committed clear-allowlist VALUES, deny-set, dictionaries, task
// manifests) to the domain-FREE boundary core. The core consults ONLY the loaded pack(s); with no
// pack, every leaf is OPAQUE (default-deny by absence). The core NEVER imports a module; modules
// import THIS interface and provide values. A new vertical (e.g. payroll) is a new pack, with ZERO
// crypto/guard/isolation change in the core (acceptance T3).
//
// Scope (#288): the CUT + the interface + the routing mechanism. The deep crypto/guard internals
// (FF3-1 FPE, keyed HMAC, SQC-guard) land in #280-build, wired via the HARBOR shadow-harness seam.

/** How the core transforms a leaf value at the boundary. */
export type TokenClass =
  | 'fpe' //            format-preserving (FF3-1) — non-country sorszám structure (e.g. invoiceNumber)
  | 'hmac' //           deterministic equality-token (join/dedup identity)
  | 'uniform' //        uniform fixed-length token — country-format identity (IBAN/tax/phone/email-domain), XC-2b
  | 'opaque' //         structureless opaque token — free-text / unknown / amount (VALUE-LOCAL, never crosses)
  | 'clear-eligible' // MAY pass clear IFF the value is in the pack's committed clearAllowlist; else token
  | 'vocab-clear'; //   whole-column clear: a universal PUBLIC reference vocabulary (chart-of-accounts code,
                     // account_class, vat-code) — customer-independent, so ALL its values clear (F7 schema-vocab)

export interface SchemaField {
  path: string; //               leaf path within the record, e.g. 'partner.taxNumber'
  kind?: 'scalar' | 'freetext';
}
export interface RecordSchema {
  id: string; //                 e.g. 'invoice'
  fields: SchemaField[];
}

/** Per (schemaId, fieldPath) -> how the core tokenizes this leaf. ABSENT => OPAQUE (default-deny). */
export interface FieldPolicy {
  schemaId: string;
  fieldPath: string;
  tokenClass: TokenClass;
  domainTag: string; //          token namespace (FPE/HMAC tweak domain); pack-defined
  constField?: string; //        for 'clear-eligible': the clearAllowlist field-name to check (e.g. 'vat')
  band?: boolean; //             #339: an opaque AMOUNT column -> quantize to a band before tokenizing (k-anon)
  salt?: boolean; //             #344-C: explicit per-record salt marker (now subsumed by the #344-2 default).
  join?: boolean; //             #344-2 (IRON LAW): a tokenized leaf is per-record SALTED by DEFAULT (no
  //                             opaque-equality / frequency / template across records). Determinism is the
  //                             EXPLICIT exception: only a `join`-whitelisted column (or a banded amount) stays
  //                             deterministic for a legitimate cloud-side join / dedup / band-aggregate.
  lowCardSuppress?: boolean; //  #344 TIER-2: a low-cardinality flag (e.g. is_individual) whose <k_min minority
  //                             VALUE is k-anon SUPPRESSED (joint-k suppression: the rare cell -> the absent
  //                             sentinel, so it carries no QI-taint). Which value is rare is DEPLOYMENT-DATA-
  //                             derived (the committed categoricalSuppress set), like the band suppress-bands.
}

/** A committed STRUCTURAL constant value that MAY pass clear (the VALUES; the mechanism is core). */
export interface ClearConstant {
  field: string; //              e.g. 'vat' | 'currency' | 'direction'
  value: string; //              e.g. '27' | 'HUF' | 'received'
}

/** #339: committed equi-depth band boundaries for ONE amount column (ascending). A value maps to the bucket
 *  index = count of boundaries < value; each bucket holds >= k_min records (k-anon). The boundaries are
 *  DEPLOYMENT-DATA-DERIVED (computed from the real (b)-DB at the configured k_min), NOT pack-hardcoded -- the
 *  synthetic-canary schema is generated at k=5, production at the k>=25 floor. Supplied to the engine as a
 *  RUNTIME input, never baked into the policy pack. */
export interface BandSpec {
  schemaId: string;
  fieldPath: string;
  boundaries: number[]; //       ascending; bucket = #(boundaries < value)
  suppressBands?: number[]; //   #340 crit-3 strict-suppress: bucket indices whose band has < k_min members ->
  //                             the engine emits a NON-unique 'below-k_min' suppressed token (hides the value
  //                             AND its uniqueness), never an opaque-keyed-unique fallback. Fails-closed.
}

/** #340 crit-3 suppress-policy for `<k_min` bands (a CONFIG parameter, like k_min — recorded in the schema so
 *  the audit states it; NEVER a hardcoded shipped default):
 *   - 'suppress'    : the band's values collapse to the NON-unique SUPPRESSED_BAND marker (value AND uniqueness
 *                     hidden). Cleanest fails-closed; the canary default.
 *   - 'opaque-keyed': the band keeps its keyed band-index token (value-hidden by the key, but the band identity
 *                     is exposed). Tunable for production: keying (known-plaintext dead) + per-column domain
 *                     (no linkage) keep the re-id risk low even value-hidden -> a utility/privacy choice
 *                     deferred to real-customer / external-audit. */
export type SuppressPolicy = 'suppress' | 'opaque-keyed';

/** #344 TIER-2 categorical suppress: the DEPLOYMENT-DATA-derived set of <k_min minority VALUES to suppress for a
 *  low-cardinality field (e.g. is_individual='true' when only 1 partner is an individual). Like a band's
 *  suppressBands but for a categorical column: the listed values map to the absent sentinel (joint-k suppression),
 *  the rest stay deterministic. Computed at the schema's k_min, never pack-hardcoded (the pack cannot know which
 *  value is rare in a given deployment). */
export interface CategoricalSuppress {
  schemaId: string;
  fieldPath: string;
  suppressValues: string[]; //   values whose cohort is < k_min -> suppressed to the absent sentinel
}

/** A whole committed band-schema (one BandSpec per banded column) + the k_min + suppress-policy it was generated
 *  at, so the audit report can state the k it PASSed at (k=5 canary vs k>=25 production floor) and how `<k_min`
 *  bands were handled. #344: also carries the TIER-2 categorical suppress-set for low-card flags. */
export interface BandSchema {
  kMin: number;
  suppressPolicy: SuppressPolicy;
  specs: BandSpec[];
  categoricalSuppress?: CategoricalSuppress[];
}

/** Intrinsic-rare values ALWAYS suppressed to token, even if a pack wrongly clear-eligible-listed them. */
export interface DenyRule {
  field: string;
  value?: string; //             specific value (e.g. vat '5'); absent => all values of the field
  reason: string; //             'intrinsic-rare' | 'foreign' | ...
}

/** Per task: which token dimensions cross to cloud (L1) and which ops MUST run local (compute-locus). */
export interface TaskManifest {
  taskKind: string; //           'categorize' | 'reconcile' | 'anomaly' | ...
  dimensionsToCloud: string[]; // field paths whose tokens may cross
  localOps: string[]; //         'arithmetic' | 'dedup' | 'reconcile' | 'dup-payment' | ...
}

/** Allow-structured B1 dictionary: closed keyword->label map; unknown span -> opaque (never raw prose). */
export interface DictionaryRef {
  id: string;
  entries: { keyword: string; label: string }[];
}

export interface ModuleConnectorRef {
  id: string; //                 'nav-billingo' — ingest connector (writes (a)-zone real data; #123)
}

export interface RetentionPolicy {
  legalRetentionYears: number; // 8 (NAV)
  erasureOrder: 'retention-first' | 'erasure-first';
}

/** The declarative contract a domain module implements. The core loads it; no values live in core. */
export interface PolicyPack {
  id: string;
  schemas: RecordSchema[];
  fieldPolicies: FieldPolicy[];
  clearAllowlist: ClearConstant[];
  denySet: DenyRule[];
  taskManifests: TaskManifest[];
  dictionaries: DictionaryRef[];
  connector?: ModuleConnectorRef;
  retention?: RetentionPolicy;
}
