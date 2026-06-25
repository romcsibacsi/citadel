// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import type { ChannelProvider } from '../channels/provider.js';

/**
 * Operator reply routing (FIX-discord-gateway). The hub talks to the operator over
 * potentially several channels at once (Telegram + Discord). Two cases:
 *
 *  - REPLY to an operator message: it must go back to the SAME provider+chat the
 *    message came from (`channelMeta.source` + `channelMeta.chatId`) — a Discord
 *    question gets a Discord answer, not a Telegram one.
 *  - PROACTIVE notification (alerts, the morning brief — no source meta): fan out to
 *    every configured operator channel so the operator sees it wherever they are.
 *
 * Pure of any provider specifics: callers inject a provider lookup + the configured
 * operator chat ids, so this is unit-tested with fakes (no real sockets/tokens).
 */

export interface OperatorReplyMeta {
  source?: string;
  chatId?: string;
}

export interface OperatorReplyDeps {
  /** Live channel provider by id ('telegram'|'discord'|'slack'); undefined when not up. */
  providerById: (id: string) => ChannelProvider | undefined;
  /** Configured operator chat id for a provider (proactive fan-out target). */
  operatorChatId: (id: string) => string | undefined;
  /** Provider ids to fan a proactive notification out to. */
  fanOutProviders: () => string[];
  /** Record an outbound line in the conversation ledger (chatId, text). */
  recordOutbound: (chatId: string, text: string) => void;
  /** Info log sink (no channel bound / per-channel failure). */
  log: (msg: string) => void;
  /** Called after a successful send to a (providerId, chatId) — used to clear the typing indicator. */
  onDelivered?: (providerId: string, chatId: string) => void;
}

/**
 * Deliver a hub message to the operator. Returns the provider ids actually sent to.
 * A reply (usable `meta`) goes to the source provider+chat; otherwise it fans out to
 * every configured operator channel. A reply whose source provider is not live falls
 * back to the proactive fan-out so the message is never silently dropped.
 */
export async function deliverToOperator(
  deps: OperatorReplyDeps,
  text: string,
  meta?: OperatorReplyMeta | null,
): Promise<string[]> {
  if (meta?.source !== undefined && meta.source !== '' && meta.chatId !== undefined && meta.chatId !== '') {
    const provider = deps.providerById(meta.source);
    if (provider !== undefined) {
      await provider.send(meta.chatId, text);
      deps.recordOutbound(meta.chatId, text);
      deps.onDelivered?.(meta.source, meta.chatId);
      return [meta.source];
    }
    // source provider not live → fall through to the proactive fan-out below
  }

  const sentTo: string[] = [];
  for (const id of deps.fanOutProviders()) {
    const provider = deps.providerById(id);
    const chatId = deps.operatorChatId(id);
    if (provider === undefined || chatId === undefined || chatId === '') continue;
    try {
      await provider.send(chatId, text);
      deps.recordOutbound(chatId, text);
      deps.onDelivered?.(id, chatId);
      sentTo.push(id);
    } catch (err) {
      deps.log(`operator notify failed for ${id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (sentTo.length === 0) deps.log(`operator notification (no channel bound): ${text}`);
  return sentTo;
}
