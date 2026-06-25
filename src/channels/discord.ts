// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import type { Logger } from '../core/log.js';
import { createLogger } from '../core/log.js';
import { splitMessage } from './split.js';
import {
  SocketChannel,
  type EventTransport,
  type RawInbound,
  type SocketChannelOptions,
} from './socketChannel.js';

/**
 * Discord channel provider (FIX-plugin-channels-slack-discord) — parity with the
 * Telegram channel, mirrored onto the Discord gateway.
 *
 *  - Inbound: the gateway pushes MESSAGE_CREATE events down a websocket,
 *    abstracted behind {@link EventTransport} (built here from a
 *    {@link DiscordGatewayFactory}) so tests script a fake.
 *  - Outbound: POST /channels/:id/messages over the REST API (injectable
 *    `transport`, defaults to global fetch), chunked at Discord's 2000-char cap.
 *  - Credentials: one bot token (`Authorization: Bot <token>`), resolved from
 *    the vault by the caller; never logged or thrown (redact()).
 *  - One connection per app (the SocketChannel dup guard, keyed by the
 *    application/bot) — multiple agents sharing one bot share ONE gateway
 *    listener that fans inbound to the right paired agent via the InboundRouter.
 *  - Honest disabled: with no bot token the provider is never constructed;
 *    validateToken() returns false offline.
 */

const PROVIDER_ID = 'discord';
const MAX_MESSAGE_LENGTH = 2_000;
const API_BASE = 'https://discord.com/api/v10';

/**
 * Builds the underlying gateway connection. The real implementation opens the
 * gateway WSS, IDENTIFYs with the bot token + intents, and forwards
 * MESSAGE_CREATE dispatches; the test implementation drives the handlers
 * directly. Either way it satisfies {@link EventTransport}.
 */
export type DiscordGatewayFactory = () => EventTransport;

export interface DiscordChannelOptions extends SocketChannelOptions {
  /** Discord bot token. Never logged. */
  botToken: string;
  /** Stable application/bot id; the connection-guard key. Defaults to the token head. */
  applicationId?: string;
  /** Injectable HTTPS transport for the REST API (tests script fakes). */
  transport?: typeof fetch;
  /** Injectable gateway factory (tests script a fake EventTransport). */
  gatewayFactory: DiscordGatewayFactory;
}

interface DiscordUser {
  id?: string;
  username?: string;
  bot?: boolean;
}

/** A gateway dispatch payload (op 0) for MESSAGE_CREATE. */
interface DiscordDispatch {
  op?: number;
  t?: string;
  d?: {
    id?: string;
    channel_id?: string;
    content?: string;
    timestamp?: string;
    author?: DiscordUser;
    webhook_id?: string;
  };
}

interface DiscordRestError {
  message?: string;
  code?: number;
}

const log = createLogger('channel.discord');

export class DiscordChannel extends SocketChannel {
  readonly id = PROVIDER_ID;

  private readonly botToken: string;
  private readonly applicationId: string;
  private readonly transport: typeof fetch;
  private readonly gatewayFactory: DiscordGatewayFactory;

  constructor(opts: DiscordChannelOptions) {
    super(opts);
    this.botToken = opts.botToken;
    // The token head (the base64 bot/app id) is a stable, non-secret key prefix.
    this.applicationId = opts.applicationId ?? `bot-${opts.botToken.split('.')[0] ?? opts.botToken.slice(0, 8)}`;
    this.transport = opts.transport ?? fetch;
    this.gatewayFactory = opts.gatewayFactory;
  }

  protected connectionKey(): string {
    return `${PROVIDER_ID}:${this.applicationId}`;
  }

  protected makeTransport(): EventTransport {
    return this.gatewayFactory();
  }

  protected log(): Logger {
    return log;
  }

  protected redact(s: string): string {
    return this.botToken === '' ? s : s.split(this.botToken).join('<redacted>');
  }

  /**
   * Normalize one gateway dispatch to a RawInbound, or undefined when it is not
   * a fresh human text message (only MESSAGE_CREATE dispatches; bot/webhook
   * authors and empty content are ignored). The dedup id is the Discord message
   * snowflake — globally unique — so a redelivered dispatch is suppressed.
   */
  static toRaw(msg: DiscordDispatch): RawInbound | undefined {
    if (msg.op !== 0 || msg.t !== 'MESSAGE_CREATE') return undefined;
    const d = msg.d;
    if (d === undefined) return undefined;
    if (d.webhook_id !== undefined && d.webhook_id !== '') return undefined;
    if (d.author?.bot === true) return undefined;
    if (typeof d.content !== 'string' || d.content === '' || typeof d.channel_id !== 'string' || d.channel_id === '') {
      return undefined;
    }
    if (typeof d.id !== 'string' || d.id === '') return undefined;
    const tsIso = d.timestamp !== undefined && !Number.isNaN(Date.parse(d.timestamp)) ? new Date(d.timestamp).toISOString() : new Date().toISOString();
    return {
      id: d.id,
      chatId: d.channel_id,
      messageId: d.id,
      user: d.author?.username ?? d.author?.id ?? '',
      ts: tsIso,
      text: d.content,
    };
  }

  splitMessage(text: string): string[] {
    return splitMessage(text, MAX_MESSAGE_LENGTH);
  }

  /** Post text to a Discord channel, chunked at 2000 chars. */
  async send(chatId: string, text: string): Promise<void> {
    for (const chunk of this.splitMessage(text)) {
      await this.postMessage(chatId, chunk);
    }
  }

  /** "… is typing" via the trigger-typing endpoint (auto-expires ~10s). Best-effort; never throws. */
  async sendTyping(chatId: string): Promise<void> {
    try {
      await this.transport(`${API_BASE}/channels/${encodeURIComponent(chatId)}/typing`, {
        method: 'POST',
        headers: { authorization: `Bot ${this.botToken}` },
      });
    } catch {
      /* best-effort: a failed typing hint must never disrupt messaging */
    }
  }

  private async postMessage(chatId: string, chunk: string): Promise<void> {
    let res: Response;
    try {
      res = await this.transport(`${API_BASE}/channels/${encodeURIComponent(chatId)}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bot ${this.botToken}` },
        body: JSON.stringify({ content: chunk }),
      });
    } catch (err) {
      throw new Error(this.redact(`discord create-message transport error: ${String(err)}`));
    }
    if (!res.ok) {
      const payload = (await this.readJson(res)) as DiscordRestError | undefined;
      throw new Error(this.redact(`discord create-message failed: HTTP ${res.status} ${payload?.message ?? ''}`.trim()));
    }
  }

  /** Cheap credential probe via GET /users/@me. Never throws the token. */
  async validateToken(): Promise<boolean> {
    let res: Response;
    try {
      res = await this.transport(`${API_BASE}/users/@me`, { headers: { authorization: `Bot ${this.botToken}` } });
    } catch (err) {
      log.warn('users/@me transport error', { error: this.redact(String(err)) });
      return false;
    }
    return res.ok;
  }

  /** Bot identity from GET /users/@me; null when unavailable. */
  async getIdentity(): Promise<{ username: string; name: string } | null> {
    let res: Response;
    try {
      res = await this.transport(`${API_BASE}/users/@me`, { headers: { authorization: `Bot ${this.botToken}` } });
    } catch (err) {
      log.warn('users/@me transport error', { error: this.redact(String(err)) });
      return null;
    }
    if (!res.ok) return null;
    const me = (await this.readJson(res)) as DiscordUser | undefined;
    if (me === undefined) return null;
    return { username: me.username ?? '', name: me.username ?? me.id ?? '' };
  }

  private async readJson(res: Response): Promise<unknown> {
    try {
      return await res.json();
    } catch {
      return undefined;
    }
  }
}
