// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { normalizeTailSig } from '../server/activitySampler.js';
import type { AgentBusyState } from './types.js';

/**
 * Hub-recovery watchdog state machine (#86). The hub (NEXUS) is a SPOF: if its
 * Claude Code session wedges on an API error it stays 'busy' forever, the
 * board-supervisor/heartbeat cycles and the operator channel stall, and nothing
 * revives it (the scheduler retry-queue only re-delivers + alerts, never restarts).
 *
 * This runs in the SUPERVISOR process (MainPID), never in the hub session — the hub
 * cannot revive itself. Recovery is a tmux session restart+RESUME (--continue), so
 * NEXUS stays an interactive subscription-pool session (never SDK/headless) and keeps
 * its orchestration context. The decision logic is a pure state machine so the
 * safety properties (no restart-loop, no false-restart on a legit long turn, bounded
 * escalation) are unit-tested directly; the driver in main.ts executes the actions.
 *
 * Design points (NEXUS-reviewed):
 *  - PROGRESS GUARD: the no-progress clock keys off a FROZEN normalized tail (the #80
 *    normalizeTailSig), NOT raw busy-duration — a legit long orchestration turn keeps
 *    changing the tail (tool calls / text), so it never trips. Only a frozen tail
 *    while not-ready is a real wedge.
 *  - ERROR CLASSES: auth (reauth-needed → token refresh first), transient (API/network
 *    banner → short grace for in-pane retry, then restart), hard (no marker → the
 *    no-progress catch-all that recovers ANY wedge even if the banner wasn't matched).
 *  - BOUNDED: a per-episode backoff (1→2→5→10m) and a max restart cap, then a durable
 *    operator escalation; we NEVER auto-switch to a context-wiping fresh restart.
 */

export interface SessionRecoveryThresholds {
  /** Transient API error: grace for Claude Code's own in-pane retry before we act (ms). */
  transientGraceMs: number;
  /** Hard wedge (no marker): frozen-tail no-progress while not-ready before we act (ms). */
  hardWedgeMs: number;
  /** Auth error: grace after triggering a token refresh before escalating to restart (ms). */
  authGraceMs: number;
  /** Backoff between successive restart attempts in one episode (ms), held at the last value. */
  backoffMs: number[];
  /** Max resume-restarts per episode before we STOP and escalate to the operator. */
  maxRestarts: number;
  /**
   * Random ± fraction applied to every backoff step (#87): without it the hub's
   * restarts could synchronize with the fleet's other retries against the shared
   * subscription endpoint (thundering herd). 0.2 = ±20%. (Retry-After is honored by
   * the Claude Code CLI's own sub-minute retry layer, which the watchdog cannot see;
   * the grace window deliberately sits ABOVE that ~60s window, so we only act on a
   * banner that persists past the CLI's own retries.)
   */
  jitterFraction: number;
}

export const DEFAULT_SESSION_RECOVERY_THRESHOLDS: SessionRecoveryThresholds = {
  transientGraceMs: 3 * 60_000,
  hardWedgeMs: 4 * 60_000,
  authGraceMs: 90_000,
  backoffMs: [60_000, 120_000, 300_000, 600_000], // 1m → 2m → 5m → 10m (cap)
  maxRestarts: 4,
  jitterFraction: 0.2,
};

export type WedgeClass = 'auth' | 'transient' | 'hard';

export type SessionRecoveryAction =
  | { kind: 'none' }
  | { kind: 'auth-refresh'; reason: string }
  | { kind: 'restart-resume'; attempt: number; wedgeClass: WedgeClass; reason: string }
  | { kind: 'escalate-final'; reason: string };

export interface SessionObservation {
  now: number;
  running: boolean;
  busyState: AgentBusyState;
  apiTransientError: boolean;
  tail: string[];
}

export class SessionRecovery {
  private readonly th: SessionRecoveryThresholds;
  private readonly random: () => number;
  private stuckSince: number | null = null; // when the frozen-tail+not-ready streak began
  private lastSig: string | null = null;
  private restarts = 0;
  private lastActionAt = 0;
  private nextBackoffMs = 0; // jittered wait before the NEXT restart (set when one fires)
  private authRefreshedAt: number | null = null;
  private finalEscalated = false;

  constructor(thresholds: SessionRecoveryThresholds = DEFAULT_SESSION_RECOVERY_THRESHOLDS, random: () => number = Math.random) {
    this.th = thresholds;
    this.random = random;
  }

  /** Apply ±jitterFraction to a backoff step (#87 thundering-herd guard). */
  private jitter(base: number): number {
    return Math.round(base * (1 + this.th.jitterFraction * (this.random() * 2 - 1)));
  }

  /** Restarts attempted in the current episode (0 when healthy). For diagnostics/tests. */
  get restartsThisEpisode(): number {
    return this.restarts;
  }

  /**
   * How long this session has been stuck on a frozen tail (ms), or 0 if not currently
   * stuck. READ-ONLY (no state change) — the fleet coordinator uses it to dispatch the
   * OLDEST-stuck session first when the per-tick restart slot is contended (#175).
   */
  stuckMs(now: number): number {
    return this.stuckSince === null ? 0 : Math.max(0, now - this.stuckSince);
  }

  /** A full reset — only on genuine recovery (hub 'ready') or a down hub (reconciler's job). */
  private fullReset(): void {
    this.stuckSince = null;
    this.restarts = 0;
    this.lastActionAt = 0;
    this.nextBackoffMs = 0;
    this.authRefreshedAt = null;
    this.finalEscalated = false;
  }

  /**
   * @param canDispatchRestart when false, a decision that WOULD fire a resume-restart is
   *   instead deferred to a later tick WITHOUT advancing the episode state — the fleet
   *   coordinator passes false once it has already spent this tick's single restart slot
   *   (#175 rate-spacer), so a capped session never burns a restart attempt it didn't run.
   *   Defaults to true: the hub (and any uncoordinated caller) always dispatches.
   */
  decide(obs: SessionObservation, canDispatchRestart = true): SessionRecoveryAction {
    // Healthy (ready/idle) or down (the reconciler owns desired-state restarts, not us):
    // close any episode. Capture the idle tail so the next not-ready turn compares fresh.
    if (!obs.running || obs.busyState === 'ready') {
      this.fullReset();
      this.lastSig = obs.running ? normalizeTailSig(obs.tail) : null;
      return { kind: 'none' };
    }

    const sig = normalizeTailSig(obs.tail);
    // PROGRESS GUARD: a changing tail = real work. Restart the no-progress clock but
    // KEEP the episode's restart counter (a post-restart fresh pane briefly changes the
    // tail — we must not let that reset the cap and loop). The counter only clears on
    // a genuine return to 'ready' (above).
    if (this.lastSig === null || sig !== this.lastSig) {
      this.lastSig = sig;
      this.stuckSince = obs.now;
      return { kind: 'none' };
    }

    // Frozen tail while not-ready: accumulate stuck time.
    if (this.stuckSince === null) this.stuckSince = obs.now;
    const stuckMs = obs.now - this.stuckSince;
    if (this.finalEscalated) return { kind: 'none' }; // gave up — awaiting the operator

    const wedgeClass: WedgeClass =
      obs.busyState === 'reauth-needed' ? 'auth' : obs.apiTransientError ? 'transient' : 'hard';

    // AUTH: refresh the shared token first (reuse the auth-broker). Only if that does
    // not clear it within authGraceMs do we fall through to a restart.
    if (wedgeClass === 'auth') {
      if (this.authRefreshedAt === null) {
        this.authRefreshedAt = obs.now;
        this.lastActionAt = obs.now;
        return { kind: 'auth-refresh', reason: 'hub auth error on the footer — refreshing the shared token before any restart' };
      }
      if (obs.now - this.authRefreshedAt < this.th.authGraceMs) return { kind: 'none' };
      // the refresh did not clear the auth error → restart path below
    }

    // Timing gate: the FIRST action waits a class-specific grace; later restarts wait
    // the per-attempt backoff measured from the last action.
    if (this.restarts === 0) {
      const grace = wedgeClass === 'transient' ? this.th.transientGraceMs : wedgeClass === 'auth' ? this.th.authGraceMs : this.th.hardWedgeMs;
      if (stuckMs < grace) return { kind: 'none' };
    } else {
      // a jittered wait, fixed when the last restart fired (#87) — stable across ticks
      if (obs.now - this.lastActionAt < this.nextBackoffMs) return { kind: 'none' };
    }

    if (this.restarts >= this.th.maxRestarts) {
      this.finalEscalated = true;
      return {
        kind: 'escalate-final',
        reason: `Session still wedged after ${this.restarts} resume-restart(s) (${wedgeClass}). Resume is not clearing it — likely context-related. A FRESH restart is the next possible step (operator decision); the watchdog will not auto-wipe context.`,
      };
    }
    // Per-tick rate-spacer (#175): the fleet allows ONE resume-restart dispatch per tick.
    // If this session didn't get the slot, defer WITHOUT advancing the episode (no burned
    // attempt, no backoff started) — it stays past-grace and competes again next tick.
    if (!canDispatchRestart) return { kind: 'none' };
    this.restarts += 1;
    this.lastActionAt = obs.now;
    // fix the (jittered) wait before the NEXT restart now, so it's stable across ticks
    this.nextBackoffMs = this.jitter(this.th.backoffMs[Math.min(this.restarts - 1, this.th.backoffMs.length - 1)] ?? this.th.backoffMs[this.th.backoffMs.length - 1]!);
    return {
      kind: 'restart-resume',
      attempt: this.restarts,
      wedgeClass,
      reason: `Session wedged (${wedgeClass}) for ~${Math.round(stuckMs / 60_000)}m with a frozen pane — resume-restart attempt ${this.restarts}/${this.th.maxRestarts}.`,
    };
  }
}
