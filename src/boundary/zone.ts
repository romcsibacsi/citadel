// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
// #288 — the (b)-zone isolation CONTRACT. The cloud-boundary agent runs in a uid-isolated token-only
// zone where raw (a)-zone data is PHYSICALLY absent (enforced-by-absence, NOT a deny-list). The ONLY
// data-bearing capability in the zone is the masking-tool, which returns Sealed-IR. This file declares
// the contract the OS-level deployment (RELAY: netns + nftables-DROP + egress-allowlist + systemd)
// must satisfy in #280. The core owns the INVARIANT; RELAY owns the topology.

import type { SealedWire } from './guard/encode.js';

/** The single data-bridge into the (b=agent) zone: it returns ONLY sealed (token-only) payloads. */
export interface MaskingTool {
  /** The sole way the agent obtains data. Returns a Sealed<Wire> — never raw plaintext. */
  read(scope: string, taskKind: string): SealedWire;
}

/** The zone invariant the deployment must guarantee (asserted operationally in #280 live-T1-T9). */
export interface ZoneInvariant {
  /** No filesystem/DB/vault path carrying raw (a)-zone data is reachable by the agent uid. */
  noRawDataReachable: true;
  /** The masking-tool socket is the only IPC carrying data into the agent zone. */
  maskingToolIsSoleBridge: true;
  /** Network egress is allowlisted to the on-box guard chokepoint only (no other provider route). */
  egressAllowlistedToChokepoint: true;
}
