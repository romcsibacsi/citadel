// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
// #288 — the ENCODE-GUARD: Sealed<Wire> is a CLOSED TYPE that can only be constructed by sealEnvelope(),
// which runs assertSealed() first. There is NO raw variant: a record carrying a raw-plaintext leaf
// cannot be serialized, because every leaf must be a token/const/opaque (assertSealed throws otherwise).
// This is the structural default-deny — the INVERSE of the secretHeuristics fails-open antipattern
// (it does not scan for "sensitive"; nothing without token-provenance can leave). The deep wire-format
// + the on-box network re-validation land in #280.

import type { SealedRecord, SealedLeaf } from '../engine.js';
import { isClearLegit } from '../engine.js';
import type { ResolvedPolicy } from '../policy/registry.js';

/** Closed, branded egress type — only sealEnvelope() can produce it (after assertSealed). */
export type SealedWire = {
  readonly __sealed: unique symbol;
  scope: string;
  records: SealedRecord[];
};

function isSealedLeaf(l: SealedLeaf): boolean {
  return l.t === 'token' || l.t === 'const' || l.t === 'opaque';
}

/** Throws if any leaf lacks token-provenance, OR is a false-clear (a 'const' not backed by the committed
 *  allowlist / a vocab-clear field). Both checks are STRUCTURAL: a policy-less or non-allowlisted leaf
 *  cannot be sealed clean — it is the inverse of the secretHeuristics fails-open antipattern. The policy
 *  re-validates every clear at egress, so no construction path (even one that bypasses classifyLeaf) can
 *  emit a false-clear. */
export function assertSealed(records: SealedRecord[], policy: ResolvedPolicy): void {
  for (const r of records) {
    for (const [path, leaf] of Object.entries(r.leaves)) {
      if (!isSealedLeaf(leaf)) {
        throw new Error(`assertSealed: ${r.schemaId}.${path} lacks token-provenance/clear-stamp`);
      }
      if (!isClearLegit(leaf, policy)) {
        throw new Error(`assertSealed: ${r.schemaId}.${path} false-clear — value not in committed allowlist / vocab-clear field (fails-closed)`);
      }
    }
  }
}

/** The ONLY constructor of SealedWire. Plaintext is a different type and cannot reach this function;
 *  a false-clear const is rejected by assertSealed against the resolved policy. */
export function sealEnvelope(scope: string, records: SealedRecord[], policy: ResolvedPolicy): SealedWire {
  assertSealed(records, policy);
  return { scope, records } as unknown as SealedWire;
}
