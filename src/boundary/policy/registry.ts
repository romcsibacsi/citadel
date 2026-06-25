// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
// #288 — the policy registry. Holds the loaded PolicyPack(s) and exposes the merged lookups the
// core consults. With NO pack registered, every lookup is empty => the engine OPAQUEs everything
// (default-deny by absence). Registration is config-driven in production (config.boundary.policyPacks);
// here the registry is the plain mechanism.

import type { PolicyPack, FieldPolicy, TokenClass, BandSpec } from './types.js';
import { stubTokenizer, type Token, type Tokenizer } from '../token/token.js';

export class PolicyRegistry {
  private readonly packs = new Map<string, PolicyPack>();

  register(pack: PolicyPack): void {
    this.packs.set(pack.id, pack);
  }

  has(id: string): boolean {
    return this.packs.has(id);
  }

  /** The merged, read-only view the boundary core consults. EMPTY when no pack is registered. The optional
   *  tokenizer is the key-injection seam (#312): production passes a KeyedTokenizer (vault K_mask); the tests
   *  + pre-key contexts use the keyless stub by default. The optional bandSchema (#339) is the committed
   *  equi-depth band boundaries per amount column (a RUNTIME, deployment-data-derived input; absent => the
   *  engine falls back to the relative-band default). */
  resolve(
    tokenizer: Tokenizer = stubTokenizer,
    bandSchema?: Map<string, BandSpec>,
    catSuppress?: Map<string, Set<string>>,
  ): ResolvedPolicy {
    return new ResolvedPolicy([...this.packs.values()], tokenizer, bandSchema, catSuppress);
  }
}

/** Read-only merged policy view. All lookups return "unknown/never" when no pack supplies the value. */
export class ResolvedPolicy {
  constructor(
    private readonly packs: readonly PolicyPack[],
    private readonly tokenizer: Tokenizer = stubTokenizer,
    private readonly bandSchema?: Map<string, BandSpec>,
    private readonly catSuppress?: Map<string, Set<string>>,
  ) {}

  /** #339/#340: the committed band spec (equi-depth boundaries + the <k_min suppress-bands) for an amount
   *  column, or UNDEFINED when no band-schema is wired (=> the engine uses the relative-band default). */
  bandSpec(schemaId: string, fieldPath: string): BandSpec | undefined {
    return this.bandSchema?.get(`${schemaId} ${fieldPath}`);
  }

  /** #344 TIER-2: true iff `value` is a committed <k_min minority value for a low-card field (-> the engine
   *  suppresses it to the absent sentinel, joint-k suppression). False when no suppress-set is wired. */
  isCategoricalSuppressed(schemaId: string, fieldPath: string, value: string): boolean {
    return this.catSuppress?.get(`${schemaId} ${fieldPath}`)?.has(value) ?? false;
  }

  /** Tokenize a leaf value via the resolved (keyed-in-production) tokenizer — the single token-producing path
   *  the engine uses, so the masking key is threaded through the policy that is already passed everywhere. */
  tokenize(value: string, cls: TokenClass, domainTag: string): Token {
    return this.tokenizer.tokenize(value, cls, domainTag);
  }

  /** Field policy for a leaf. UNDEFINED => the core OPAQUEs the leaf (default-deny by absence). */
  fieldPolicy(schemaId: string, fieldPath: string): FieldPolicy | undefined {
    for (const p of this.packs) {
      const fp = p.fieldPolicies.find((f) => f.schemaId === schemaId && f.fieldPath === fieldPath);
      if (fp !== undefined) return fp;
    }
    return undefined;
  }

  /** True iff the value is in some pack's committed clearAllowlist. EMPTY allowlist => always false. */
  isClearAllowed(field: string, value: string): boolean {
    return this.packs.some((p) => p.clearAllowlist.some((c) => c.field === field && c.value === value));
  }

  /** True iff a deny-rule suppresses the value (intrinsic-rare/foreign). Overrides clear-eligibility. */
  isDenied(field: string, value: string): boolean {
    return this.packs.some((p) =>
      p.denySet.some((d) => d.field === field && (d.value === undefined || d.value === value)),
    );
  }

  /** True iff `field` is a whole-column vocab-clear field-tag (constField ?? fieldPath of a vocab-clear
   *  policy). The egress guard admits legitimate whole-column clears via this, and rejects any other
   *  (false-)clear. EMPTY when no vocab-clear policy supplies the tag. */
  isVocabClearField(field: string): boolean {
    return this.packs.some((p) =>
      p.fieldPolicies.some((f) => f.tokenClass === 'vocab-clear' && (f.constField ?? f.fieldPath) === field),
    );
  }
}
