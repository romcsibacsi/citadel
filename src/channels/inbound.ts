// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { createLogger } from '../core/log.js';
import { CHANNEL_ID, OPERATOR_ID, sanitizeId } from '../trust/sanitize.js';
import type { InboundEvent } from './provider.js';

/**
 * Inbound pipeline (SPEC §7): turns a provider InboundEvent into a hub-bound
 * queue message with server-side sender stamping.
 *
 *  - The operator chat stamps sender = OPERATOR_ID (reserved identity; the
 *    operator trust frame follows downstream).
 *  - Any other chat is DEFAULT-DENY unless explicitly allowlisted; accepted
 *    non-operator chats stamp sender = CHANNEL_ID (untrusted-channel frame).
 *  - The recipient is ALWAYS the hub.
 *  - The conversation ledger is written FIRST: its uniqueness constraint on
 *    (agent, chat, direction, message_id) is the idempotency guard — a
 *    re-served update that was already recorded is skipped, so the provider's
 *    at-least-once re-queue stays idempotent (SPEC §7, §8).
 */

const log = createLogger('channel.inbound');

/**
 * The agent-visible body: the user's text/caption plus one line per downloaded
 * attachment carrying its ABSOLUTE local path (system-generated, safe) so the
 * agent can open it with the Read tool. The path lines live in the BODY, which
 * is security-tag-stripped on delivery (trust/frame.ts), so an untrusted caption
 * can neither forge a frame nor inject an attachment line the system would
 * trust — the only authoritative paths are the ones the provider resolved.
 */
function composeBody(e: InboundEvent): string {
  const lines: string[] = [];
  if (e.text.length > 0) lines.push(e.text);
  for (const m of e.media ?? []) {
    const meta = m.mimeType !== undefined ? ` (${m.mimeType})` : '';
    lines.push(`[attached ${m.kind}${meta}: ${m.path}]`);
  }
  return lines.join('\n');
}

export interface InboundChannelMeta {
  source: string;
  chatId: string;
  messageId: string;
  user: string;
  ts: string;
}

export interface InboundQueueMessage {
  sender: string;
  recipient: string;
  body: string;
  channelMeta: InboundChannelMeta;
}

export interface InboundLedger {
  recordInbound(
    agentId: string,
    chatId: string,
    messageId: string,
    body: string,
    source?: string,
  ): { inserted: boolean };
}

export interface InboundRouterDeps {
  enqueue: (msg: InboundQueueMessage) => void;
  ledger: InboundLedger;
  hubId: string;
  /** The reserved operator identity binds to exactly this chat id. */
  operatorChatId?: string;
  /** Static allowlist of non-operator chats (legacy/tests); everything else is dropped. */
  allowedChatIds?: string[];
  /**
   * Dynamic allowlist predicate (FIX-channels): consulted per message so an
   * operator approving a pairing takes effect WITHOUT a restart. Checked in
   * addition to `allowedChatIds`; absent ⇒ deny (default-deny preserved).
   */
  isAllowed?: (chatId: string) => boolean;
  /**
   * Called for an unknown (about-to-be-dropped) non-operator chat so the surface
   * can record a pending pairing. The message is STILL dropped (default-deny);
   * this only surfaces the chat for operator approval. Must never throw into the
   * decision — wrapped here defensively.
   */
  onUnknownChat?: (e: InboundEvent) => void;
  /**
   * Atomicity boundary for the ledger-claim + enqueue pair (SPEC §20.5): when
   * both write the same database, wire a real transaction here so a failed
   * enqueue rolls the dedup claim back — otherwise a crash between the two
   * would permanently suppress the message on provider re-serve. Defaults to
   * plain execution for callers whose stores are independent.
   */
  transact?: (fn: () => void) => void;
}

export interface InboundDecision {
  accepted: boolean;
  reason?: string;
}

export class InboundRouter {
  private readonly hubId: string;

  constructor(private readonly deps: InboundRouterDeps) {
    this.hubId = sanitizeId(deps.hubId);
  }

  handle(e: InboundEvent): InboundDecision {
    let sender: string;
    if (this.deps.operatorChatId !== undefined && e.chatId === this.deps.operatorChatId) {
      sender = OPERATOR_ID;
    } else if (this.deps.allowedChatIds?.includes(e.chatId) === true || this.deps.isAllowed?.(e.chatId) === true) {
      sender = CHANNEL_ID;
    } else {
      // Default-deny. The untrusted body is deliberately not logged. Surface the
      // unknown chat as a pending pairing (best-effort — never affects the deny).
      try {
        this.deps.onUnknownChat?.(e);
      } catch (err) {
        log.warn('pairing record failed', { provider: e.provider, error: String(err) });
      }
      log.info('inbound dropped: chat not allowed', {
        provider: e.provider,
        chatId: e.chatId,
        messageId: e.messageId,
      });
      return { accepted: false, reason: 'chat-not-allowed' };
    }

    // Ledger claim + enqueue run as ONE unit: the ledger's uniqueness
    // constraint is the idempotency guard for provider replays, and the
    // transaction guarantees a failed enqueue releases the claim (no loss).
    const body = composeBody(e);
    const transact = this.deps.transact ?? ((fn: () => void) => fn());
    let duplicate = false;
    transact(() => {
      const record = this.deps.ledger.recordInbound(this.hubId, e.chatId, e.messageId, body, e.provider);
      if (!record.inserted) {
        duplicate = true;
        return;
      }
      this.deps.enqueue({
        sender,
        recipient: this.hubId,
        body,
        channelMeta: {
          source: e.provider,
          chatId: e.chatId,
          messageId: e.messageId,
          user: e.user,
          ts: e.ts,
        },
      });
    });
    if (duplicate) {
      log.debug('inbound already in ledger; enqueue skipped', {
        provider: e.provider,
        chatId: e.chatId,
        messageId: e.messageId,
      });
      return { accepted: false, reason: 'duplicate' };
    }
    return { accepted: true };
  }
}
