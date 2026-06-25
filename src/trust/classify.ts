// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { CHANNEL_ID, OPERATOR_ID, sanitizeId } from './sanitize.js';

/**
 * Trust tiers (SPEC §6). 'operator' and 'channel' are privileged and can only
 * be reached via server-side stamping (the public write endpoint rejects
 * senders that sanitize to a reserved id before this function ever runs).
 */
export type TrustTier = 'operator' | 'channel' | 'hub' | 'trusted-peer' | 'untrusted';

export interface TrustContext {
  /** Sanitized ids of every known (configured, non-hidden) agent, hub included. */
  knownAgentIds: ReadonlySet<string>;
  /** Sanitized hub id. */
  hubId: string;
}

export interface TrustClassification {
  tier: TrustTier;
  /** Canonical sender id after sanitization. */
  senderId: string;
}

/**
 * Classify a self-asserted `from` value. Trust is NEVER derived from the raw
 * string: reserved tiers match code constants, the peer tier matches the
 * known-agent graph, and the known-agent check runs BEFORE the hub shortcut
 * (SPEC §6) so an unknown id can never ride the hub's implicit-peer status.
 */
export function classifyTrust(rawFrom: string, ctx: TrustContext): TrustClassification {
  const senderId = sanitizeId(rawFrom);
  if (senderId === OPERATOR_ID) return { tier: 'operator', senderId };
  if (senderId === CHANNEL_ID) return { tier: 'channel', senderId };
  if (ctx.knownAgentIds.has(senderId)) {
    if (senderId === sanitizeId(ctx.hubId)) return { tier: 'hub', senderId };
    return { tier: 'trusted-peer', senderId };
  }
  return { tier: 'untrusted', senderId };
}
