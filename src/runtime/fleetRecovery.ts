// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import {
  SessionRecovery,
  DEFAULT_SESSION_RECOVERY_THRESHOLDS,
  type SessionObservation,
  type SessionRecoveryThresholds,
} from './sessionRecovery.js';

/**
 * Fleet recovery coordinator (#175). The per-session SessionRecovery state machine
 * decides what ONE session needs; this coordinator arbitrates across the whole fleet so
 * extending auto-recovery to non-hub agents does not hammer the SHARED subscription pool
 * (the 2026-06-18 trigger was a rate-limit — if every wedged agent resume-restarted at
 * once it would sustain the limit). Pure logic + injected I/O, so the subtle parts
 * (rate-spacing, coalescing, ordering) are unit-tested directly; the driver supplies the
 * effects.
 *
 * Policy:
 *  - RATE-SPACER: at most `cap` resume-restart DISPATCHES per tick across the fleet
 *    (default 1). Hub first (SPOF), then non-hub OLDEST-stuck-first with a deterministic
 *    agent-id tie-break. A session denied the slot is deferred without burning its
 *    episode (SessionRecovery.canDispatchRestart=false).
 *  - AUTH COALESCE: the token is SHARED — one fleet-wide refresh per cooldown serves every
 *    auth-wedged session (hub + non-hub together).
 *  - ESCALATION NOISE: non-hub escalations are coalesced into ONE message and autonomy-
 *    gated (operator-facing only when permitted, else a quiet note). The hub stays
 *    immediate (SPOF). Routine non-hub resume-restarts are logged, not operator-pinged.
 */

/** One session to consider this tick. */
export interface RecoveryCandidate {
  id: string;
  isHub: boolean;
  obs: SessionObservation;
}

/** Injected effects + per-tick inputs. */
export interface FleetRecoveryDeps {
  now: number;
  /** Max resume-restart dispatches this tick across the whole fleet (rate-spacer). */
  cap: number;
  /** Resume-restart (--continue, context preserved) one session. */
  restart: (id: string) => void | Promise<void>;
  /** Refresh the SHARED subscription token ONCE for the whole fleet (coalesced). */
  refreshFleetToken: () => void | Promise<void>;
  /** Operator-facing notification. */
  notifyOperator: (msg: string) => void;
  /** Low-noise sink (idea/log) for events below the operator-facing autonomy level. */
  noteQuietly: (msg: string) => void;
  /** True when non-hub escalations may reach the operator now (autonomy level >= 2). */
  escalationReachesOperator: boolean;
  /** Min interval between fleet token refreshes (the coalesce window). */
  authRefreshCooldownMs: number;
}

export class FleetRecoveryCoordinator {
  private readonly recoveries = new Map<string, SessionRecovery>();
  private lastAuthRefreshAt = -Infinity;
  private readonly thresholds: SessionRecoveryThresholds;
  private readonly random: () => number;

  constructor(thresholds: SessionRecoveryThresholds = DEFAULT_SESSION_RECOVERY_THRESHOLDS, random: () => number = Math.random) {
    this.thresholds = thresholds;
    this.random = random;
  }

  private recoveryFor(id: string): SessionRecovery {
    let r = this.recoveries.get(id);
    if (r === undefined) {
      r = new SessionRecovery(this.thresholds, this.random);
      this.recoveries.set(id, r);
    }
    return r;
  }

  /** Sessions currently tracked (diagnostics/tests). */
  get tracked(): number {
    return this.recoveries.size;
  }

  async tick(candidates: RecoveryCandidate[], deps: FleetRecoveryDeps): Promise<void> {
    // Drop state for sessions no longer present (off-roster / desired-stopped).
    const live = new Set(candidates.map((c) => c.id));
    for (const id of [...this.recoveries.keys()]) if (!live.has(id)) this.recoveries.delete(id);

    // Hub FIRST (SPOF); then non-hub OLDEST-stuck-first with a deterministic agent-id
    // tie-break so equal stuck-times never flip the dispatch order across ticks.
    const ordered = [...candidates].sort((a, b) => {
      if (a.isHub !== b.isHub) return a.isHub ? -1 : 1;
      const ra = this.recoveryFor(a.id);
      const rb = this.recoveryFor(b.id);
      const sa = ra.stuckMs(deps.now);
      const sb = rb.stuckMs(deps.now);
      if (sa !== sb) return sb - sa; // longer-stuck first
      // Anti-starvation: when equally stuck (all hit the same rate-limit), the session
      // that has restarted FEWER times this episode gets the slot first, so one agent
      // can't monopolise the single dispatch. Final tie-break = agent-id (deterministic,
      // never flips per tick).
      if (ra.restartsThisEpisode !== rb.restartsThisEpisode) return ra.restartsThisEpisode - rb.restartsThisEpisode;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

    let dispatched = 0;
    const authNeeders: string[] = [];
    let hubAuthNeeded = false;
    const nonHubEscalations: string[] = [];

    for (const c of ordered) {
      const action = this.recoveryFor(c.id).decide(c.obs, dispatched < deps.cap);
      switch (action.kind) {
        case 'none':
          break;
        case 'restart-resume':
          dispatched += 1;
          await deps.restart(c.id);
          if (c.isHub) {
            // Match the original hub watchdog exactly: log every attempt, but ping the
            // operator on the FIRST attempt only (the hub SPOF stays visible without
            // spamming on each backoff retry).
            deps.noteQuietly(`hub ${c.id} resume-restart attempt ${action.attempt} (${action.wedgeClass})`);
            if (action.attempt === 1) deps.notifyOperator(`⚠ Hub (${c.id}) appears wedged (${action.wedgeClass}). Auto-recovering with a resume-restart (context preserved) — attempt ${action.attempt}.`);
          } else {
            deps.noteQuietly(`agent ${c.id} resume-restart attempt ${action.attempt}/${this.thresholds.maxRestarts} (${action.wedgeClass})`);
          }
          break;
        case 'auth-refresh':
          authNeeders.push(c.id);
          if (c.isHub) hubAuthNeeded = true;
          break;
        case 'escalate-final':
          if (c.isHub) deps.notifyOperator(`🚨 Hub (${c.id}) auto-recovery exhausted. ${action.reason}`);
          else nonHubEscalations.push(c.id);
          break;
      }
    }

    // Amendment C: ONE fleet-wide token refresh (hub + non-hub) per cooldown.
    if (authNeeders.length > 0 && deps.now - this.lastAuthRefreshAt >= deps.authRefreshCooldownMs) {
      this.lastAuthRefreshAt = deps.now;
      await deps.refreshFleetToken();
      const m = `shared token refresh for ${authNeeders.length} auth-wedged session(s): ${authNeeders.join(', ')}.`;
      if (hubAuthNeeded) deps.notifyOperator(`⚠ ${m}`); // hub is a SPOF — keep it visible
      else deps.noteQuietly(m);
    }

    // Amendment A: non-hub escalations -> ONE coalesced, autonomy-gated message.
    if (nonHubEscalations.length > 0) {
      const msg = `🚨 ${nonHubEscalations.length} agent(s) exhausted auto-recovery: ${nonHubEscalations.join(', ')}. Manual attention may be needed.`;
      if (deps.escalationReachesOperator) deps.notifyOperator(msg);
      else deps.noteQuietly(msg);
    }
  }
}
