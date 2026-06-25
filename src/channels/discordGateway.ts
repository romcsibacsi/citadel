// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { DiscordChannel } from './discord.js';
import type { EventTransport, RawInbound } from './socketChannel.js';
import { createLogger } from '../core/log.js';

/**
 * Discord gateway WebSocket transport (FIX-discord-gateway) — the real inbound
 * leg the DiscordChannel needs (replaces the throwing `gatewayFactory` stub).
 *
 * It satisfies {@link EventTransport}: `open()` connects the gateway WSS, runs the
 * v10 handshake, and resolves once the connection is LIVE (READY/RESUMED); each
 * MESSAGE_CREATE becomes a {@link RawInbound} (via DiscordChannel.toRaw) pushed to
 * `onEvent`; a live connection that drops calls `onClose` so the SocketChannel base
 * reconnects (it builds a FRESH transport each attempt).
 *
 * Because the base discards the transport on every reconnect, the resumable session
 * state (session_id / resume url / last seq) lives in the FACTORY closure, shared
 * across the transports it builds — so a reconnect RESUMEs when possible, else a
 * fresh IDENTIFY.
 *
 * Zero runtime deps: the default WebSocket is Node's built-in global; tests inject a
 * fake socket + timers and never open a real connection. The bot token never appears
 * in a log/throw (redact()).
 */

const log = createLogger('channel.discord.gateway');

/** Discord gateway opcodes (v10). */
const OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const;

const DEFAULT_GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';
const DEFAULT_HEARTBEAT_MS = 41_250; // Discord's usual interval; only a fallback if HELLO omits it
/** GUILDS (1<<0) | GUILD_MESSAGES (1<<9) | MESSAGE_CONTENT (1<<15) — needed to read message text. */
export const DISCORD_INTENTS = (1 << 0) | (1 << 9) | (1 << 15);

/** The minimal WHATWG-WebSocket surface we use (Node's global `WebSocket` implements it). */
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (ev: { data?: unknown; code?: number; reason?: string }) => void): void;
}
export type WebSocketFactory = (url: string) => WebSocketLike;

/** Injectable interval timer so tests drive the heartbeat deterministically. */
export interface TimerFns {
  setInterval: (cb: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
}

export interface DiscordGatewayOptions {
  /** Bot token (IDENTIFY/RESUME). Never logged. */
  botToken: string;
  /** Gateway intents bitfield; defaults to GUILDS|GUILD_MESSAGES|MESSAGE_CONTENT. */
  intents?: number;
  /** Override the initial gateway url (tests). */
  gatewayUrl?: string;
  /** Injectable WebSocket factory; defaults to Node's global `WebSocket`. */
  wsFactory?: WebSocketFactory;
  /** Injectable interval timers; defaults to global setInterval/clearInterval (unref'd). */
  timers?: TimerFns;
  /** Strip the token from logs/errors; defaults to a token-split redactor. */
  redact?: (s: string) => string;
}

interface SessionState {
  sessionId: string | null;
  resumeUrl: string | null;
  seq: number | null;
}

interface GatewayFrame {
  op?: number;
  t?: string | null;
  s?: number | null;
  d?: unknown;
}

/** Ensure a resume_gateway_url carries the v10/json query params. */
function withGatewayQuery(base: string): string {
  return base.includes('?') ? base : `${base.replace(/\/$/, '')}/?v=10&encoding=json`;
}

/**
 * One gateway connection (one open()/close() cycle). The base builds a fresh one per
 * connect attempt; `shared` carries resume state across attempts.
 */
class DiscordGatewayConnection implements EventTransport {
  private phase: 'connecting' | 'live' | 'done' = 'connecting';
  private ws: WebSocketLike | null = null;
  private hbHandle: unknown = null;
  private acked = true;
  private missed = 0;
  private handlers: { onEvent: (raw: RawInbound) => void; onClose: (reason: string) => void } | null = null;
  private resolveOpen: (() => void) | null = null;
  private rejectOpen: ((e: Error) => void) | null = null;
  private readonly intents: number;
  private readonly wsFactory: WebSocketFactory;
  private readonly timers: TimerFns;
  private readonly redact: (s: string) => string;
  private readonly initialUrl: string;

  constructor(private readonly botToken: string, private readonly shared: SessionState, opts: Required<Pick<DiscordGatewayOptions, 'intents' | 'wsFactory' | 'timers' | 'redact' | 'gatewayUrl'>>) {
    this.intents = opts.intents;
    this.wsFactory = opts.wsFactory;
    this.timers = opts.timers;
    this.redact = opts.redact;
    this.initialUrl = opts.gatewayUrl;
  }

  open(handlers: { onEvent: (raw: RawInbound) => void; onClose: (reason: string) => void }): Promise<void> {
    this.handlers = handlers;
    const resuming = this.shared.sessionId !== null && this.shared.resumeUrl !== null;
    const url = resuming ? this.shared.resumeUrl! : this.initialUrl;
    return new Promise<void>((resolve, reject) => {
      this.resolveOpen = resolve;
      this.rejectOpen = reject;
      let ws: WebSocketLike;
      try {
        ws = this.wsFactory(url);
      } catch (err) {
        this.fail(`gateway connect failed: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      this.ws = ws;
      ws.addEventListener('message', (ev) => this.onMessage(typeof ev.data === 'string' ? ev.data : String(ev.data ?? ''), resuming));
      ws.addEventListener('error', () => this.fail('gateway socket error'));
      ws.addEventListener('close', (ev) => this.fail(`gateway socket closed${ev.code !== undefined ? ` (${ev.code})` : ''}`));
    });
  }

  private onMessage(data: string, resuming: boolean): void {
    if (this.phase === 'done') return;
    let frame: GatewayFrame;
    try {
      frame = JSON.parse(data) as GatewayFrame;
    } catch {
      return; // ignore unparseable frames
    }
    if (typeof frame.s === 'number') this.shared.seq = frame.s;
    switch (frame.op) {
      case OP.HELLO: {
        const interval = (frame.d as { heartbeat_interval?: unknown } | undefined)?.heartbeat_interval;
        this.startHeartbeat(typeof interval === 'number' && interval > 0 ? interval : DEFAULT_HEARTBEAT_MS);
        if (resuming) this.sendResume();
        else this.sendIdentify();
        break;
      }
      case OP.HEARTBEAT:
        this.sendHeartbeat(); // server asked for an immediate heartbeat
        break;
      case OP.HEARTBEAT_ACK:
        this.acked = true;
        this.missed = 0;
        break;
      case OP.RECONNECT:
        this.fail('server requested reconnect'); // keep session → RESUME next attempt
        break;
      case OP.INVALID_SESSION:
        if (frame.d !== true) this.clearSession(); // not resumable → fresh IDENTIFY next attempt
        this.fail('invalid session');
        break;
      case OP.DISPATCH:
        this.onDispatch(frame.t ?? '', frame.d);
        break;
      default:
        break;
    }
  }

  private onDispatch(t: string, d: unknown): void {
    if (t === 'READY') {
      const ready = d as { session_id?: unknown; resume_gateway_url?: unknown } | undefined;
      this.shared.sessionId = typeof ready?.session_id === 'string' ? ready.session_id : null;
      this.shared.resumeUrl =
        typeof ready?.resume_gateway_url === 'string' ? withGatewayQuery(ready.resume_gateway_url) : this.initialUrl;
      this.markLive();
      return;
    }
    if (t === 'RESUMED') {
      this.markLive();
      return;
    }
    if (t === 'MESSAGE_CREATE') {
      const raw = DiscordChannel.toRaw({ op: OP.DISPATCH, t, d: d as never });
      if (raw !== undefined) this.handlers?.onEvent(raw);
    }
  }

  private markLive(): void {
    if (this.phase !== 'connecting') return;
    this.phase = 'live';
    this.resolveOpen?.();
    log.info('discord gateway live', {});
  }

  private sendIdentify(): void {
    this.sendJson({
      op: OP.IDENTIFY,
      d: { token: this.botToken, intents: this.intents, properties: { os: 'linux', browser: 'citadel', device: 'citadel' } },
    });
  }

  private sendResume(): void {
    this.sendJson({ op: OP.RESUME, d: { token: this.botToken, session_id: this.shared.sessionId, seq: this.shared.seq } });
  }

  private startHeartbeat(intervalMs: number): void {
    this.stopHeartbeat();
    this.acked = true;
    this.missed = 0;
    this.hbHandle = this.timers.setInterval(() => {
      if (!this.acked) {
        this.missed += 1;
        if (this.missed >= 2) {
          this.fail('heartbeat not acked (zombie connection)'); // ~two cycles without an ACK
          return;
        }
      } else {
        this.missed = 0;
      }
      this.acked = false;
      this.sendHeartbeat();
    }, intervalMs);
  }

  private sendHeartbeat(): void {
    this.sendJson({ op: OP.HEARTBEAT, d: this.shared.seq });
  }

  private sendJson(obj: unknown): void {
    try {
      this.ws?.send(JSON.stringify(obj));
    } catch (err) {
      this.fail(`gateway send failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private clearSession(): void {
    this.shared.sessionId = null;
    this.shared.resumeUrl = null;
    this.shared.seq = null;
  }

  /** A connect-time failure rejects open(); a post-live drop signals onClose. Idempotent. */
  private fail(reason: string): void {
    if (this.phase === 'done') return;
    const wasConnecting = this.phase === 'connecting';
    this.phase = 'done';
    this.stopHeartbeat();
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    const safe = this.redact(reason);
    if (wasConnecting) this.rejectOpen?.(new Error(safe));
    else this.handlers?.onClose(safe);
  }

  private stopHeartbeat(): void {
    if (this.hbHandle !== null) {
      this.timers.clearInterval(this.hbHandle);
      this.hbHandle = null;
    }
  }

  /** Graceful close requested by the base (stop/reconnect). Suppresses a redundant onClose. */
  async close(): Promise<void> {
    this.phase = 'done'; // the ensuing socket 'close' event is now a no-op
    this.stopHeartbeat();
    try {
      this.ws?.close(1000, 'client closing');
    } catch {
      /* ignore */
    }
    this.ws = null;
  }
}

/**
 * Build a DiscordGatewayFactory: a `() => EventTransport` whose closure holds the
 * resumable session state shared across reconnects. Pass to DiscordChannel as
 * `gatewayFactory`.
 */
export function createDiscordGateway(opts: DiscordGatewayOptions): () => EventTransport {
  const shared: SessionState = { sessionId: null, resumeUrl: null, seq: null };
  const intents = opts.intents ?? DISCORD_INTENTS;
  const gatewayUrl = opts.gatewayUrl ?? DEFAULT_GATEWAY_URL;
  const wsFactory = opts.wsFactory ?? ((url: string) => new WebSocket(url) as unknown as WebSocketLike);
  const timers: TimerFns =
    opts.timers ?? {
      setInterval: (cb, ms) => {
        const h = setInterval(cb, ms);
        (h as { unref?: () => void }).unref?.();
        return h;
      },
      clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
    };
  const redact = opts.redact ?? ((s: string) => (opts.botToken === '' ? s : s.split(opts.botToken).join('<redacted>')));
  return () => new DiscordGatewayConnection(opts.botToken, shared, { intents, wsFactory, timers, redact, gatewayUrl });
}
