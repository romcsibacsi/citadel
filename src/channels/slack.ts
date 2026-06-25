// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { createHash } from 'node:crypto';
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
 * Slack channel provider (FIX-plugin-channels-slack-discord) — parity with the
 * Telegram channel, mirrored onto Socket Mode.
 *
 *  - Inbound: Socket Mode delivers `message` events down a websocket. The
 *    websocket is abstracted behind {@link EventTransport} (built here from a
 *    {@link SlackSocketFactory}) so tests script a fake and never open a socket.
 *  - Outbound: chat.postMessage over HTTPS (injectable `transport`, defaults to
 *    global fetch), chunked at Slack's per-message text limit.
 *  - Credentials: a bot token (xoxb-) for the Web API + an app-level token
 *    (xapp-) for Socket Mode. Both are resolved from the vault by the caller and
 *    passed in; NEITHER ever appears in a log line or thrown error (redact()).
 *  - One connection per workspace (the SocketChannel dup guard, keyed by the
 *    app/team) — multiple agents enabling Slack share ONE listener that fans
 *    inbound to the right paired agent through the InboundRouter.
 *  - Honest disabled: with no bot token the provider is simply never constructed
 *    (the route reports it disabled); validateToken() returns false offline.
 */

const PROVIDER_ID = 'slack';
/** Slack chat.postMessage practical text cap; chunk well under it. */
const MAX_MESSAGE_LENGTH = 3_900;

/**
 * Builds the underlying Socket Mode connection. The real implementation calls
 * apps.connections.open to mint a WSS url and wraps a WebSocket; the test
 * implementation drives the handlers directly. Either way it satisfies
 * {@link EventTransport}.
 */
export type SlackSocketFactory = () => EventTransport;

export interface SlackChannelOptions extends SocketChannelOptions {
  /** Slack bot token (xoxb-…) for the Web API. Never logged. */
  botToken: string;
  /** Slack app-level token (xapp-…) for Socket Mode. Never logged. */
  appToken: string;
  /** Stable workspace/team id; the connection-guard key. Defaults to the app token tail. */
  teamId?: string;
  /** Injectable HTTPS transport for the Web API (tests script fakes). */
  transport?: typeof fetch;
  /** Injectable Socket Mode factory (tests script a fake EventTransport). */
  socketFactory: SlackSocketFactory;
}

interface SlackApiPayload {
  ok?: boolean;
  error?: string;
  team?: { id?: string; name?: string };
  user?: string;
  bot_id?: string;
}

/** A Slack Socket Mode `events_api` envelope carrying a message event. */
interface SlackEnvelope {
  type?: string;
  envelope_id?: string;
  payload?: {
    event?: {
      type?: string;
      subtype?: string;
      bot_id?: string;
      channel?: string;
      user?: string;
      text?: string;
      ts?: string;
      event_ts?: string;
      client_msg_id?: string;
    };
  };
}

const log = createLogger('channel.slack');

export class SlackChannel extends SocketChannel {
  readonly id = PROVIDER_ID;

  private readonly botToken: string;
  private readonly appToken: string;
  private readonly teamId: string;
  private readonly transport: typeof fetch;
  private readonly socketFactory: SlackSocketFactory;

  constructor(opts: SlackChannelOptions) {
    super(opts);
    this.botToken = opts.botToken;
    this.appToken = opts.appToken;
    // The connection key is LOGGED (duplicate-guard diagnostics), so never derive it
    // from the raw token tail (would leak a secret fragment). Use the operator teamId,
    // else a non-reversible hash of the app token.
    this.teamId = opts.teamId ?? `h${createHash('sha256').update(opts.appToken).digest('hex').slice(0, 10)}`;
    this.transport = opts.transport ?? fetch;
    this.socketFactory = opts.socketFactory;
  }

  protected connectionKey(): string {
    return `${PROVIDER_ID}:${this.teamId}`;
  }

  protected makeTransport(): EventTransport {
    return this.socketFactory();
  }

  protected log(): Logger {
    return log;
  }

  /** Both tokens are stripped from any string before it is logged or thrown. */
  protected redact(s: string): string {
    let out = s;
    if (this.botToken !== '') out = out.split(this.botToken).join('<redacted>');
    if (this.appToken !== '') out = out.split(this.appToken).join('<redacted>');
    return out;
  }

  /**
   * Normalize one Socket Mode envelope to a RawInbound, or undefined when it is
   * not a fresh human text message (bot echoes, edits, non-message events, the
   * bot's own messages and empty text are ignored). The dedup id is the Slack
   * client_msg_id when present, else channel+ts (Slack's natural idempotency
   * key) so a redelivered envelope is suppressed.
   */
  static toRaw(env: SlackEnvelope): RawInbound | undefined {
    if (env.type !== 'events_api') return undefined;
    const ev = env.payload?.event;
    if (ev === undefined || ev.type !== 'message') return undefined;
    // Skip bot messages, edits/deletes and other subtypes; require text + channel.
    if (ev.bot_id !== undefined && ev.bot_id !== '') return undefined;
    if (ev.subtype !== undefined && ev.subtype !== '') return undefined;
    if (typeof ev.text !== 'string' || ev.text === '' || typeof ev.channel !== 'string' || ev.channel === '') {
      return undefined;
    }
    const ts = ev.ts ?? ev.event_ts ?? '';
    const id = ev.client_msg_id !== undefined && ev.client_msg_id !== '' ? ev.client_msg_id : `${ev.channel}:${ts}`;
    const tsIso = (() => {
      const seconds = Number.parseFloat(ts);
      return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : new Date().toISOString();
    })();
    return {
      id,
      chatId: ev.channel,
      messageId: ts === '' ? id : ts,
      user: ev.user ?? '',
      ts: tsIso,
      text: ev.text,
    };
  }

  splitMessage(text: string): string[] {
    return splitMessage(text, MAX_MESSAGE_LENGTH);
  }

  /** Post text to a Slack channel via chat.postMessage, chunked. */
  async send(chatId: string, text: string): Promise<void> {
    for (const chunk of this.splitMessage(text)) {
      await this.postMessage(chatId, chunk);
    }
  }

  private async postMessage(chatId: string, chunk: string): Promise<void> {
    let res: Response;
    try {
      res = await this.transport('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${this.botToken}` },
        body: JSON.stringify({ channel: chatId, text: chunk }),
      });
    } catch (err) {
      throw new Error(this.redact(`slack chat.postMessage transport error: ${String(err)}`));
    }
    const payload = await this.readPayload(res);
    if (!res.ok || payload?.ok !== true) {
      throw new Error(
        this.redact(`slack chat.postMessage failed: HTTP ${res.status} ${payload?.error ?? ''}`.trim()),
      );
    }
  }

  /** Cheap credential probe via auth.test. Never throws the tokens. */
  async validateToken(): Promise<boolean> {
    let res: Response;
    try {
      res = await this.transport('https://slack.com/api/auth.test', {
        method: 'POST',
        headers: { authorization: `Bearer ${this.botToken}` },
      });
    } catch (err) {
      log.warn('auth.test transport error', { error: this.redact(String(err)) });
      return false;
    }
    if (!res.ok) return false;
    const payload = await this.readPayload(res);
    return payload?.ok === true;
  }

  /** Bot identity from auth.test (@user + team name); null when unavailable. */
  async getIdentity(): Promise<{ username: string; name: string } | null> {
    let res: Response;
    try {
      res = await this.transport('https://slack.com/api/auth.test', {
        method: 'POST',
        headers: { authorization: `Bearer ${this.botToken}` },
      });
    } catch (err) {
      log.warn('auth.test transport error', { error: this.redact(String(err)) });
      return null;
    }
    if (!res.ok) return null;
    const payload = await this.readPayload(res);
    if (payload?.ok !== true) return null;
    return { username: payload.user ?? '', name: payload.team?.name ?? payload.user ?? '' };
  }

  private async readPayload(res: Response): Promise<SlackApiPayload | undefined> {
    try {
      const parsed: unknown = await res.json();
      return typeof parsed === 'object' && parsed !== null ? (parsed as SlackApiPayload) : undefined;
    } catch {
      return undefined;
    }
  }
}
