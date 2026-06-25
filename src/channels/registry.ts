// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * Channel provider capability registry (FIX-channels). The shared UI builds its
 * provider dropdown and feature gating from this map, so a provider that is not
 * configured in this install is shown honestly (not-connected + setup
 * instructions), never faked as connected. Telegram and Discord have real runtime
 * clients (inbound + outbound); Slack has only the outbound REST client — its
 * Socket-Mode inbound transport is NOT wired in this build, so slack is
 * implemented:false (the UI shows "inbound not available" instead of silently
 * no-op'ing). Only Telegram mints invite links, so Discord/Slack carry
 * supportsInvite:false.
 */

export interface ChannelProviderInfo {
  id: string;
  /** A real runtime client exists (can connect / send / receive). */
  implemented: boolean;
  /** Supports minting invite links (Telegram). */
  supportsInvite: boolean;
}

export const CHANNEL_PROVIDERS: ChannelProviderInfo[] = [
  { id: 'telegram', implemented: true, supportsInvite: true },
  { id: 'discord', implemented: true, supportsInvite: false },
  // Slack inbound (Socket Mode WS) is NOT wired in this build (outbound REST works);
  // honest false so the Channels view surfaces "inbound not available" (FIX-release-gaps).
  { id: 'slack', implemented: false, supportsInvite: false },
];

export function channelProvider(id: string): ChannelProviderInfo | undefined {
  return CHANNEL_PROVIDERS.find((p) => p.id === id);
}
