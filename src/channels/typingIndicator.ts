// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import type { ChannelProvider } from './provider.js';

/**
 * Typing-indicator manager (FIX-channel-typing). A channel's "… is typing" hint
 * auto-expires provider-side after a few seconds (Telegram ~5s, Discord ~10s), so to
 * show NEXUS as typing for the whole time it composes a reply we must RE-TRIGGER it on
 * an interval. This keeps one pulse loop per (provider, chat): `start()` begins pulsing,
 * `stop()` ends it (called when the reply is sent). A safety cap auto-stops a session so
 * a missing reply can never leave the indicator stuck on forever.
 *
 * Best-effort throughout: a provider without `sendTyping` is a no-op, and every pulse
 * swallows its own errors — a typing hint must never disrupt real messaging.
 */

export interface TypingTimers {
  setInterval: (cb: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  setTimeout: (cb: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export interface TypingIndicatorOptions {
  /** Re-trigger cadence; must be < the shortest provider expiry (~5s). Default 4000ms. */
  pulseMs?: number;
  /** Hard cap on a single session, so a never-arriving reply can't pulse forever. Default 90000ms. */
  maxMs?: number;
  /** Injectable timers (tests drive them deterministically). */
  timers?: TypingTimers;
}

const DEFAULT_PULSE_MS = 4_000;
const DEFAULT_MAX_MS = 90_000;

const realTimers: TypingTimers = {
  setInterval: (cb, ms) => {
    const h = setInterval(cb, ms);
    (h as { unref?: () => void }).unref?.();
    return h;
  },
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  setTimeout: (cb, ms) => {
    const h = setTimeout(cb, ms);
    (h as { unref?: () => void }).unref?.();
    return h;
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

interface Session {
  pulse: unknown;
  cap: unknown;
}

export class TypingIndicator {
  private readonly pulseMs: number;
  private readonly maxMs: number;
  private readonly timers: TypingTimers;
  private readonly sessions = new Map<string, Session>();

  constructor(opts: TypingIndicatorOptions = {}) {
    this.pulseMs = opts.pulseMs ?? DEFAULT_PULSE_MS;
    this.maxMs = opts.maxMs ?? DEFAULT_MAX_MS;
    this.timers = opts.timers ?? realTimers;
  }

  private key(providerId: string, chatId: string): string {
    return `${providerId}:${chatId}`;
  }

  /**
   * Begin showing "typing" on (provider, chat) and keep it alive until stop().
   * Idempotent: re-starting an active session resets its safety cap. No-op if the
   * provider can't type.
   */
  start(provider: ChannelProvider, chatId: string): void {
    if (provider.sendTyping === undefined || chatId === '') return;
    const key = this.key(provider.id, chatId);
    this.stop(provider.id, chatId); // reset any existing session cleanly
    const fire = (): void => {
      // provider.sendTyping is best-effort; swallow any rejection so a typing hint
      // can never surface an unhandled rejection or disrupt messaging.
      void provider.sendTyping?.(chatId)?.catch(() => undefined);
    };
    fire(); // immediate, don't wait a full interval
    const pulse = this.timers.setInterval(fire, this.pulseMs);
    const cap = this.timers.setTimeout(() => this.stop(provider.id, chatId), this.maxMs);
    this.sessions.set(key, { pulse, cap });
  }

  /** Stop the pulse loop for (provider, chat). Safe to call when none is active. */
  stop(providerId: string, chatId: string): void {
    const key = this.key(providerId, chatId);
    const s = this.sessions.get(key);
    if (s === undefined) return;
    this.timers.clearInterval(s.pulse);
    this.timers.clearTimeout(s.cap);
    this.sessions.delete(key);
  }

  /** Number of live typing sessions (for tests/diagnostics). */
  activeCount(): number {
    return this.sessions.size;
  }
}
