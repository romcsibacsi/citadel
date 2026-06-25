// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * Channel provider abstraction (SPEC §7). A provider owns one external chat
 * surface (Telegram, ...) and exposes a uniform send/receive contract. Tokens
 * are resolved by the caller (Vault / 0600 env) and MUST never be logged.
 */

/**
 * One inbound media attachment, already resolved to a local file by the
 * provider (which owns the credential needed to download it). The `path` is
 * SYSTEM-controlled (provider-generated under a known inbox dir, with a
 * sanitized filename) and therefore safe to hand to the agent as a Read target;
 * the file CONTENTS remain untrusted, exactly like the surrounding text body.
 */
export interface InboundMedia {
  /** Coarse kind for the agent-facing label. */
  kind: 'photo' | 'document';
  /** Absolute local path to the downloaded file (system-controlled). */
  path: string;
  /** Sanitized original filename (no separators / traversal). */
  fileName: string;
  /** MIME type when the provider reports one. */
  mimeType?: string;
  /** Size in bytes when known. */
  size?: number;
}

/** One inbound chat message, normalized across providers. All fields are strings. */
export interface InboundEvent {
  /** Provider id ('telegram', ...). System-supplied, safe for routing. */
  provider: string;
  /** Provider-scoped chat id, stringified. */
  chatId: string;
  /** Provider-scoped message id, stringified — the ledger idempotency key. */
  messageId: string;
  /** Best-effort display handle of the external user (may be empty). */
  user: string;
  /** ISO-8601 timestamp of the message. */
  ts: string;
  /** Raw untrusted user text (may be empty when the message is media-only). */
  text: string;
  /**
   * Resolved media attachments (downloaded to local files). Optional/empty for
   * text-only messages. Providers without media support omit it.
   */
  media?: InboundMedia[];
}

/**
 * Durable-handoff contract: the provider treats an update as handed off only
 * once the returned promise RESOLVES (the handler has persisted it). A
 * rejection means "not handed off" and the provider must re-deliver.
 */
export type InboundHandler = (e: InboundEvent) => Promise<void>;

export interface ChannelProvider {
  /** Stable provider identity ('telegram', ...). Keys offsets and dedup rows. */
  id: string;
  /** Deliver text to a chat, chunking per provider limits. */
  send(chatId: string, text: string): Promise<void>;
  /** Optional media upload. */
  sendMedia?(chatId: string, filePath: string, caption?: string): Promise<void>;
  /**
   * Optional "… is typing" indicator (Telegram sendChatAction, Discord trigger-typing).
   * Best-effort: it auto-expires after a few seconds provider-side, so the caller
   * re-triggers it on an interval until the reply is sent. Never throws the token.
   */
  sendTyping?(chatId: string): Promise<void>;
  /** Cheap credential probe (e.g. Telegram getMe). Never throws the token. */
  validateToken(): Promise<boolean>;
  /** Split text per this provider's message-length limit (see ./split.ts). */
  splitMessage(text: string): string[];
  /** Bot identity (e.g. @username + display name); null when unavailable. Optional. */
  getIdentity?(): Promise<{ username: string; name: string } | null>;
  /** Mint an invite link for a chat (Telegram). Optional — providers omit when unsupported. */
  createInviteLink?(chatId: string, opts?: { expireSeconds?: number; memberLimit?: number }): Promise<string>;
}
