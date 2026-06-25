// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { classifyTrust, type TrustTier } from '../trust/classify.js';
import { OPERATOR_ID, CHANNEL_ID, sanitizeId } from '../trust/sanitize.js';

/**
 * The routing decision (SPEC §6, §13) — pure and unit-tested. Decides what the
 * delivery loop does with one queued message; the loop owns timing/retries.
 */

export type RouteAction =
  | { kind: 'deliver'; recipientId: string; senderId: string; tier: TrustTier }
  | { kind: 'operator-terminal' } // messages to the operator are terminal: handed to channels, marked delivered immediately
  | { kind: 'consume'; reason: 'generator-loop-breaker' }
  | { kind: 'reject'; reason: 'unknown-target' | 'hidden-target' | 'reserved-target' };

export interface RouteContext {
  /** Sanitized ids of all configured agents (hub included), hidden ones too. */
  knownAgentIds: ReadonlySet<string>;
  /** Hidden/internal agents — excluded from inter-agent routing (SPEC §4). */
  hiddenAgentIds: ReadonlySet<string>;
  hubId: string;
  /** Media-generator identities for the 3-way pass/dispatch/consume rule (SPEC §13); empty when unused. */
  mediaAgentIds: ReadonlySet<string>;
}

export function decideRoute(rawFrom: string, rawTo: string, ctx: RouteContext): RouteAction {
  const to = sanitizeId(rawTo);
  if (to === OPERATOR_ID) return { kind: 'operator-terminal' };
  if (to === CHANNEL_ID) return { kind: 'reject', reason: 'reserved-target' };

  const { tier, senderId } = classifyTrust(rawFrom, ctx);

  if (!ctx.knownAgentIds.has(to)) return { kind: 'reject', reason: 'unknown-target' };
  if (ctx.hiddenAgentIds.has(to)) return { kind: 'reject', reason: 'hidden-target' };

  // Loop-breaker: a generator->generator message is consumed, never re-dispatched (SPEC §13).
  if (ctx.mediaAgentIds.has(senderId) && ctx.mediaAgentIds.has(to)) {
    return { kind: 'consume', reason: 'generator-loop-breaker' };
  }

  return { kind: 'deliver', recipientId: to, senderId, tier };
}
