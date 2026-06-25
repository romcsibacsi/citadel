// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
// #288 — the clear-allow MECHANISM (no values; the VALUES come from the pack).
//
// Final F7-collapse spec (ORACLE §9): clear IFF the value is in the pack's COMMITTED clearAllowlist
// AND not in the denySet. The allowlist is committed at setup, NEVER recomputed at runtime — there
// is NO counter (batch_k/history_k) consulted, because any counter itself races/flips (transition-leak).
// The decision is pure static membership in the committed structural-constant allowlist.
//
// EMPTY allowlist (no pack) => never clear (default-deny by absence). The JOINT-k is auto-satisfied by
// the collapse (only universal-dominant constants clear, so their joint is the dominant cell, k>>25),
// hence no separate runtime joint-counter is needed here — a property of the committed allowlist, not a
// mechanism. (Optional passive joint-audit over the committed set belongs to #280, never gates a value.)

import type { ResolvedPolicy } from './policy/registry.js';

/** True iff this committed structural-constant value may pass clear. Pure static membership. */
export function decideClear(field: string, value: string, policy: ResolvedPolicy): boolean {
  if (policy.isDenied(field, value)) return false; // intrinsic-rare/foreign suppress overrides
  return policy.isClearAllowed(field, value); // committed-static allowlist membership; empty => false
}
