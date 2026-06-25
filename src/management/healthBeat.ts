// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { buildHealthPayload, emitHealth, type HealthSnapshot, type EmitHealthDeps } from './health.js';
import type { AgentBusyState } from '../runtime/types.js';

/** One agent's live, cheap status (from supervisor.statusFast) for the snapshot. */
export interface AgentLiveStatus {
  id: string;
  running: boolean;
  busyState: AgentBusyState;
}

/**
 * Map the live fleet status to a content-free HealthSnapshot (pure — unit-tested). The
 * agent id is carried only so buildHealthPayload can COUNT states; it is never emitted.
 * State mapping: a non-running agent is 'stopped'; a running one is 'working' (busy),
 * 'error' (reauth-needed — needs attention), or 'idle' (ready / waiting on input).
 */
export function buildHealthSnapshot(input: {
  machineId: string;
  version: string;
  at: string;
  uptimeSec: number;
  agents: AgentLiveStatus[];
  cpuPercent?: number;
  memPercent?: number;
  errorCount?: number;
}): HealthSnapshot {
  return {
    machineId: input.machineId,
    version: input.version,
    at: input.at,
    uptimeSec: input.uptimeSec,
    agents: input.agents.map((a) => ({
      id: a.id,
      running: a.running,
      state: !a.running ? 'stopped' : a.busyState === 'busy' ? 'working' : a.busyState === 'reauth-needed' ? 'error' : 'idle',
    })),
    ...(input.cpuPercent !== undefined ? { cpuPercent: input.cpuPercent } : {}),
    ...(input.memPercent !== undefined ? { memPercent: input.memPercent } : {}),
    ...(input.errorCount !== undefined ? { errorCount: input.errorCount } : {}),
  };
}

/**
 * Periodic content-free health beat (#111, management-plane wiring). The #106 emitter
 * (buildHealthPayload + emitHealth) is complete and golden-matched against the RELAY
 * receiver contract, but nothing drove it on a timer — this module is that driver.
 *
 * Two responsibilities, both fail-safe:
 *  - DORMANCY: a beat is skipped whenever the per-machine HMAC secret is absent. The
 *    own fleet (and any instance the operator has not provisioned a secret for) simply
 *    never beats — no config, no noise.
 *  - RESILIENCE: a failed beat (aggregator down, network error) is swallowed via
 *    onError and NEVER throws, so a flaky aggregator can never take down the host.
 *
 * The content-free security guarantee lives entirely in buildHealthPayload (allowlist,
 * no customer data); this driver only schedules it and signs+POSTs the result.
 */
export interface HealthBeatDeps {
  intervalMs: number;
  /** Build the rich live snapshot at beat time (lazy — reflects current fleet state). */
  snapshot: () => HealthSnapshot | Promise<HealthSnapshot>;
  /** Per-machine HMAC secret from the vault; undefined/'' => skip the beat (dormant). */
  secret: () => string | undefined;
  /** Aggregator URL (non-secret). */
  url: string;
  /** Injected SSRF-guarded POST (reuse the webhook poster in production). */
  post: EmitHealthDeps['post'];
  /** Injectable scheduler (defaults to setInterval); the handle is opaque. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Non-throwing sink for a failed beat (a beat must never crash the loop/host). */
  onError?: (err: unknown) => void;
}

/**
 * The narrow SSRF allowlist for the health beat (#164): EXACTLY the configured
 * aggregator host. The operator's aggregator lives on a private VPN mesh (e.g.
 * *.internal / an RFC1918 address), which assertPublicUrl blocks by default; allowing
 * only this one configured host lets the beat reach it while every OTHER private or
 * blocked address stays refused (no blanket private-allow). Returns [] for an
 * unparseable URL so the guard then blocks — fail-safe.
 */
export function allowHostsForUrl(url: string): string[] {
  try {
    return [new URL(url).hostname.toLowerCase()];
  } catch {
    return [];
  }
}

export type BeatResult = 'sent' | 'dormant' | 'error';

/**
 * Run exactly one beat (deterministic; unit-tested directly). Returns 'dormant' when
 * unprovisioned, 'sent' on a successful POST, 'error' when the beat failed (already
 * routed to onError — the caller is never asked to handle a throw).
 */
export async function healthBeatOnce(deps: HealthBeatDeps): Promise<BeatResult> {
  try {
    const secret = deps.secret();
    if (secret === undefined || secret === '') return 'dormant';
    await emitHealth(buildHealthPayload(await deps.snapshot()), { url: deps.url, secret, post: deps.post });
    return 'sent';
  } catch (err) {
    deps.onError?.(err);
    return 'error';
  }
}

/**
 * Start the periodic beat. Returns a stop() handle that cancels the timer. Each tick
 * runs healthBeatOnce (fire-and-forget; its own try/catch keeps the loop alive).
 */
export function startHealthBeat(deps: HealthBeatDeps): () => void {
  const setTimer = deps.setTimer ?? ((fn, ms) => setInterval(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  const handle = setTimer(() => { void healthBeatOnce(deps); }, deps.intervalMs);
  return () => clearTimer(handle);
}

export type { HealthSnapshot };
