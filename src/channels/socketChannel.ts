// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { type Clock, systemClock, isoNow } from '../core/clock.js';
import type { Logger } from '../core/log.js';
import type { ChannelProvider, InboundEvent, InboundHandler } from './provider.js';

/**
 * Shared reconnecting event-stream base for the Slack (Socket Mode) and Discord
 * (Gateway) channel providers (FIX-plugin-channels-slack-discord).
 *
 * Telegram polls; Slack/Discord push events down a persistent socket. The shape
 * we keep IDENTICAL to TelegramChannel:
 *
 *   open transport -> per event: dedup-claim (channel_dedup) -> await onInbound
 *   (durable handoff) -> only after a successful handoff is the dedup claim kept;
 *   a handoff rejection releases the claim so a re-served event retries it.
 *
 * The transport (the actual websocket / HTTP) is injected behind {@link EventTransport}
 * so tests script a fake and NEVER open a real socket.
 *
 * THE MULTI-AGENT GOTCHA (spec): a user-level enabled channel could load for
 * EVERY agent, and several agents opening a Socket-Mode / gateway connection to
 * the SAME workspace/app splits or drops inbound events. We guarantee ONE
 * connection per workspace/app through {@link ConnectionRegistry}: a second
 * provider for the same key REFUSES to open a duplicate socket; a single shared
 * listener fans every inbound event to the InboundRouter, whose dynamic
 * allowlist (operator-approved bindings) routes it to the right paired agent.
 *
 * No credential (bot token / app token) ever appears in a log line or thrown
 * error — every outgoing string passes through the subclass redact().
 */

export interface BackoffConfig {
  baseMs: number;
  maxMs: number;
}

export const DEFAULT_SOCKET_BACKOFF: BackoffConfig = { baseMs: 1_000, maxMs: 30_000 };

/** One normalized inbound event from the transport, pre-dedup. */
export interface RawInbound {
  /** Globally-unique-per-provider id; the dedup key (channel_dedup.update_id). */
  id: string;
  chatId: string;
  messageId: string;
  user: string;
  ts: string;
  text: string;
}

/**
 * Injectable event-stream transport. A real impl wraps a WebSocket; the test
 * impl drives `onEvent`/`onClose` by hand. `open` resolves once the stream is
 * live (or rejects on a connect failure -> the base backs off and retries).
 */
export interface EventTransport {
  open(handlers: {
    onEvent: (raw: RawInbound) => void;
    onClose: (reason: string) => void;
  }): Promise<void>;
  close(): Promise<void>;
}

/**
 * Process-wide guard: at most one live connection per workspace/app key. The
 * key is provider-scoped (e.g. 'slack:T123', 'discord:app-456'). claim()
 * returns false when another provider already holds the key — the caller then
 * stays a passive "duplicate" (honest, no second socket).
 */
export class ConnectionRegistry {
  private readonly held = new Map<string, object>();

  claim(key: string, owner: object): boolean {
    const current = this.held.get(key);
    if (current !== undefined && current !== owner) return false;
    this.held.set(key, owner);
    return true;
  }

  release(key: string, owner: object): void {
    if (this.held.get(key) === owner) this.held.delete(key);
  }

  holder(key: string): object | undefined {
    return this.held.get(key);
  }
}

/** The default shared registry — one per process keeps the guard global. */
export const sharedConnectionRegistry = new ConnectionRegistry();

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });

export interface SocketChannelOptions {
  /** Open, migrated database — owns channel_dedup rows for this provider. */
  db: DatabaseSync;
  onInbound: InboundHandler;
  clock?: Clock;
  backoff?: BackoffConfig;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Override the connection-guard registry (tests isolate their own). */
  registry?: ConnectionRegistry;
}

/**
 * Base class the Slack/Discord providers extend. Subclasses supply: the provider
 * id, the workspace/app connection key, a factory that builds an EventTransport,
 * the outbound send/identity/validate, and redact(). Everything reconnect-,
 * dedup- and handoff-related lives here, shared and tested once.
 */
export abstract class SocketChannel implements ChannelProvider {
  abstract readonly id: string;

  protected readonly clock: Clock;
  private readonly backoff: BackoffConfig;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly onInbound: InboundHandler;
  private readonly registry: ConnectionRegistry;

  private readonly claimStmt: StatementSync;
  private readonly unclaimStmt: StatementSync;

  private running = false;
  private connected = false;
  private holdsConnection = false;
  private activeTransport: EventTransport | null = null;
  private loopDone: Promise<void> = Promise.resolve();
  private stopRequested: Promise<void> | null = null;
  private resolveStop: (() => void) | null = null;
  private reconnectSignal: (() => void) | null = null;

  constructor(opts: SocketChannelOptions) {
    this.clock = opts.clock ?? systemClock;
    this.backoff = opts.backoff ?? DEFAULT_SOCKET_BACKOFF;
    this.sleepFn = opts.sleep ?? defaultSleep;
    this.random = opts.random ?? Math.random;
    this.onInbound = opts.onInbound;
    this.registry = opts.registry ?? sharedConnectionRegistry;

    this.claimStmt = opts.db.prepare(
      'INSERT OR IGNORE INTO channel_dedup (provider, update_id, seen_at) VALUES (?, ?, ?)',
    );
    this.unclaimStmt = opts.db.prepare('DELETE FROM channel_dedup WHERE provider = ? AND update_id = ?');
  }

  // ---- subclass contract ----

  /** Provider-scoped connection key, e.g. 'slack:T123'. Drives the dup guard. */
  protected abstract connectionKey(): string;
  /** Build a fresh transport for one connection attempt. */
  protected abstract makeTransport(): EventTransport;
  /** Component logger (so the right component string appears in logs). */
  protected abstract log(): Logger;
  /** Strip every credential from a string before it is logged/thrown. */
  protected abstract redact(s: string): string;

  abstract send(chatId: string, text: string): Promise<void>;
  abstract splitMessage(text: string): string[];
  abstract validateToken(): Promise<boolean>;

  // ---- lifecycle ----

  /**
   * Begin the connect loop. Idempotent; never throws. If another provider for
   * the SAME workspace/app already holds the connection, this instance stays a
   * passive duplicate (the dup guard) — it does NOT open a second socket.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopRequested = new Promise((resolve) => {
      this.resolveStop = resolve;
    });
    const key = this.connectionKey();
    this.holdsConnection = this.registry.claim(key, this);
    if (!this.holdsConnection) {
      this.log().warn('duplicate connection refused; another instance owns this workspace', { key });
      // Still "running" so isListening() reflects intent, but no socket is opened.
      this.loopDone = Promise.resolve();
      return;
    }
    this.loopDone = this.connectLoop();
    this.log().info('socket channel started', { key });
  }

  /** Stop the connection; resolves once the loop has fully exited. */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.connected = false;
    this.resolveStop?.();
    this.reconnectSignal?.();
    const t = this.activeTransport;
    this.activeTransport = null;
    if (t !== null) await t.close().catch(() => undefined);
    await this.loopDone;
    if (this.holdsConnection) {
      this.registry.release(this.connectionKey(), this);
      this.holdsConnection = false;
    }
    this.log().info('socket channel stopped');
  }

  /** True while the connect loop is active AND this instance owns the socket. */
  isListening(): boolean {
    return this.running && this.holdsConnection && this.connected;
  }

  /** True when this instance is the duplicate that yielded the connection. */
  isDuplicate(): boolean {
    return this.running && !this.holdsConnection;
  }

  // ---- connect loop ----

  private async connectLoop(): Promise<void> {
    let attempt = 0;
    while (this.running && this.holdsConnection) {
      const closed = this.makeReconnectSignal();
      try {
        const transport = this.makeTransport();
        this.activeTransport = transport;
        await transport.open({
          onEvent: (raw) => {
            void this.dispatch(raw);
          },
          onClose: (reason) => {
            this.connected = false;
            this.log().warn('socket closed', { reason: this.redact(reason) });
            this.reconnectSignal?.();
          },
        });
        this.connected = true;
        attempt = 0;
        this.log().info('socket connected');
        // Stay parked until the socket closes (onClose fires reconnectSignal)
        // or stop() is requested — the transport pushes events via onEvent.
        await Promise.race([closed, this.stopRequested ?? closed]);
        await this.activeTransport?.close().catch(() => undefined);
        this.activeTransport = null;
        if (!this.running) break;
      } catch (err) {
        this.connected = false;
        this.activeTransport = null;
        if (!this.running) break;
        attempt += 1;
        const cappedMs = Math.min(this.backoff.maxMs, this.backoff.baseMs * 2 ** (attempt - 1));
        const delayMs = this.jitter(cappedMs);
        this.log().warn('socket connect failed; backing off', {
          attempt,
          delayMs,
          error: this.redact(err instanceof Error ? err.message : String(err)),
        });
        await this.pause(delayMs);
      }
    }
  }

  /**
   * Dedup-claim one event, then hand it off durably. A duplicate (already in
   * channel_dedup) is dropped silently. A handoff rejection RELEASES the claim
   * so the event can be retried on the next delivery (no message loss).
   */
  private async dispatch(raw: RawInbound): Promise<void> {
    const fresh = Number(this.claimStmt.run(this.id, raw.id, isoNow(this.clock)).changes) > 0;
    if (!fresh) {
      this.log().debug('duplicate event suppressed', { id: raw.id });
      return;
    }
    const event: InboundEvent = {
      provider: this.id,
      chatId: raw.chatId,
      messageId: raw.messageId,
      user: raw.user,
      ts: raw.ts,
      text: raw.text,
    };
    try {
      await this.onInbound(event);
    } catch (err) {
      this.unclaimStmt.run(this.id, raw.id);
      this.log().warn('inbound handoff failed; claim released for retry', {
        id: raw.id,
        error: this.redact(err instanceof Error ? err.message : String(err)),
      });
    }
  }

  // ---- helpers ----

  private makeReconnectSignal(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.reconnectSignal = resolve;
    });
  }

  private jitter(ms: number): number {
    return Math.max(1, Math.floor(ms * (0.5 + 0.5 * this.random())));
  }

  /** Sleep that wakes early on stop() so shutdown never waits out a backoff. */
  protected async pause(ms: number): Promise<void> {
    if (this.running && this.stopRequested !== null) {
      await Promise.race([this.sleepFn(ms), this.stopRequested]);
      return;
    }
    await this.sleepFn(ms);
  }
}
