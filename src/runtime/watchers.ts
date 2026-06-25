// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * Record-first substrate watchers (SPEC §19a).
 *
 * For the interactive-TUI subscription substrate these are MUST. Each watcher
 * RECORDS evidence before acting and only ever clears a flag IT ITSELF set:
 *  - stuck-input: input that never landed is re-submitted (the adapter's bounded
 *    retry already covers the in-call case; this catches the cross-tick case);
 *  - frozen tool-call: detected by WALL-CLOCK stagnation + LOW CPU, then the
 *    process is replaced IN PLACE (respawn) — never the session/server;
 *  - stuck-permission + API-error: ALERT-ONLY (record + notify the operator,
 *    never auto-act).
 *
 * The detection logic here is PURE and unit-tested; the caller wires the real
 * clock, CPU sampler, screen reader, alert sink and respawn action.
 */

export type WatcherAction =
  | { kind: 'none' }
  | { kind: 'resubmit-input'; agentId: string }
  | { kind: 'respawn-in-place'; agentId: string; evidence: string }
  | { kind: 'alert-operator'; agentId: string; category: 'stuck-permission' | 'api-error'; evidence: string }
  | { kind: 'recover-hub-modal'; agentId: string }
  | { kind: 'inject-compact'; agentId: string };

export interface FrozenToolSample {
  agentId: string;
  /** The rendered pane (or a stable hash of it). */
  screen: string;
  /** Recent CPU usage fraction of the agent process, 0..1. */
  cpu: number;
  /** Monotonic ms. */
  nowMs: number;
}

export interface FrozenToolMemory {
  /** Last screen we recorded for the agent. */
  lastScreen?: string;
  /** When the screen last CHANGED (ms). */
  lastChangeMs?: number;
  /** When we last respawned this agent (grace guard). */
  lastRespawnMs?: number;
}

export interface FrozenToolConfig {
  /** Wall-clock stagnation before a frozen tool-call is suspected. */
  stagnationMs: number;
  /** CPU must be below this to call it frozen (an active turn burns CPU). */
  cpuIdleBelow: number;
  /** Don't respawn again within this window of the last respawn. */
  respawnGraceMs: number;
}

/**
 * Decide whether a tool-call is frozen (SPEC §19a): the screen has not changed
 * for `stagnationMs` AND CPU is low (a busy turn would move the screen or burn
 * CPU). Mutates `mem` to record evidence (record-first). Honors a respawn grace.
 */
export function evaluateFrozenTool(
  sample: FrozenToolSample,
  mem: FrozenToolMemory,
  cfg: FrozenToolConfig,
): WatcherAction {
  // Record-first: update the change timestamp whenever the screen moves.
  if (mem.lastScreen !== sample.screen) {
    mem.lastScreen = sample.screen;
    mem.lastChangeMs = sample.nowMs;
    return { kind: 'none' };
  }
  if (mem.lastChangeMs === undefined) {
    mem.lastChangeMs = sample.nowMs;
    return { kind: 'none' };
  }
  const stagnantFor = sample.nowMs - mem.lastChangeMs;
  if (stagnantFor < cfg.stagnationMs) return { kind: 'none' };
  if (sample.cpu >= cfg.cpuIdleBelow) return { kind: 'none' }; // CPU-active: a real long turn, not frozen
  if (mem.lastRespawnMs !== undefined && sample.nowMs - mem.lastRespawnMs < cfg.respawnGraceMs) {
    return { kind: 'none' }; // inside the post-respawn grace window
  }
  mem.lastRespawnMs = sample.nowMs;
  mem.lastChangeMs = sample.nowMs; // reset so we don't immediately re-fire
  return {
    kind: 'respawn-in-place',
    agentId: sample.agentId,
    evidence: `screen unchanged ${stagnantFor}ms with cpu ${sample.cpu.toFixed(2)} < ${cfg.cpuIdleBelow}`,
  };
}

export interface AlertMemory {
  /** Whether we have already alerted for the current episode (a flag we own). */
  alerted: boolean;
}

/**
 * Stuck-permission / API-error watchers are ALERT-ONLY (SPEC §19a). They record
 * + notify exactly once per episode and never auto-act. The alert flag is one we
 * set ourselves and clear only when the condition clears (so the operator isn't
 * spammed and a new episode can re-alert).
 */
export function evaluateAlertOnly(
  agentId: string,
  category: 'stuck-permission' | 'api-error',
  conditionPresent: boolean,
  evidence: string,
  mem: AlertMemory,
): WatcherAction {
  if (!conditionPresent) {
    mem.alerted = false; // condition cleared -> a future episode may alert again
    return { kind: 'none' };
  }
  if (mem.alerted) return { kind: 'none' }; // already alerted this episode
  mem.alerted = true;
  return { kind: 'alert-operator', agentId, category, evidence };
}

export interface StuckInputMemory {
  /** The text we expect to have landed. */
  pending?: string;
  /** How many times we have re-submitted it. */
  resubmits: number;
}

/**
 * Stuck-input watcher (SPEC §19a): if the input box still shows our pending text
 * un-submitted across ticks, re-submit it — bounded, so we never loop forever.
 */
export function evaluateStuckInput(
  agentId: string,
  inputBoxShowsPending: boolean,
  mem: StuckInputMemory,
  maxResubmits = 2,
): WatcherAction {
  if (!inputBoxShowsPending) {
    mem.pending = undefined as string | undefined;
    mem.resubmits = 0;
    return { kind: 'none' };
  }
  if (mem.resubmits >= maxResubmits) return { kind: 'none' };
  mem.resubmits += 1;
  return { kind: 'resubmit-input', agentId };
}

export interface HubModalMemory {
  /** When the current picker episode was first seen (ms); undefined while absent. */
  firstSeenMs?: number;
  /** When we last issued a recovery (ms) — cooldown so we retry, not Escape every tick. */
  lastRecoverMs?: number;
}

export const HUB_MODAL_GRACE_MS = 30_000; // ~1–2 watcher ticks (grace ≈ loop interval): let a dashboard force-inject win first
export const HUB_MODAL_COOLDOWN_MS = 120_000; // retry a still-wedged hub, but not on every tick

/**
 * Hub interactive-picker recovery (FIX-telegram-hub-reply). The hub is the agent
 * the operator chats with THROUGH A CHANNEL — there is no human at its TTY, so a
 * blocking AskUserQuestion picker can never be answered locally and DEADLOCKS the
 * hub: while it waits, its busy state also gates the operator's inbound channel
 * messages (delivery.ts), so neither the hub's question nor the operator's reply
 * moves. After `graceMs` of a persistent picker (a short window so a dashboard
 * force-inject can still win), fire recovery — the caller Escapes the picker (which
 * DECLINES it, never selects an option) and nudges the hub to re-ask on the channel.
 * Then RETRY on a `cooldownMs` (not once-per-episode): a single best-effort Escape
 * may not clear it, and the operator stays stranded until it does, so the watchdog
 * keeps trying — bounded to one attempt per cooldown so it never Escape-spams. The
 * episode (and its grace) re-arms only when the picker clears. Time-based, so the
 * flag is never permanently sticky after a failed attempt.
 */
export function evaluateHubModalRecovery(
  agentId: string,
  pickerPresent: boolean,
  nowMs: number,
  mem: HubModalMemory,
  graceMs: number = HUB_MODAL_GRACE_MS,
  cooldownMs: number = HUB_MODAL_COOLDOWN_MS,
): WatcherAction {
  if (!pickerPresent) {
    mem.firstSeenMs = undefined;
    mem.lastRecoverMs = undefined;
    return { kind: 'none' };
  }
  // systemClock is wall-clock (not monotonic): re-base on a BACKWARD step (NTP/manual)
  // so a clock that jumps back can't wedge the grace forever or suppress retries.
  if (mem.firstSeenMs === undefined || nowMs < mem.firstSeenMs) mem.firstSeenMs = nowMs;
  if (mem.lastRecoverMs !== undefined && nowMs < mem.lastRecoverMs) mem.lastRecoverMs = undefined;
  if (nowMs - mem.firstSeenMs < graceMs) return { kind: 'none' }; // grace: a human/force may answer first
  if (mem.lastRecoverMs !== undefined && nowMs - mem.lastRecoverMs < cooldownMs) {
    return { kind: 'none' }; // attempted recently — retry only after the cooldown
  }
  mem.lastRecoverMs = nowMs;
  return { kind: 'recover-hub-modal', agentId };
}

export interface ContextWindowSample {
  agentId: string;
  /** Live context tokens for the session, or null if it could not be read. */
  contextTokens: number | null;
  /** The model's context window in tokens (1M for the [1m] Opus variants, else 200k). */
  windowTokens: number;
  /** Wall-clock ms. */
  nowMs: number;
}

export interface ContextWindowMemory {
  /** When we last CONFIRMED-injected /compact for this agent (ms) — the anti-thrash floor. Set by the CALLER
   *  ONLY after the injection is confirmed delivered (#336), NEVER on the mere decision: a dropped /compact
   *  (busy pane) must leave this un-armed so the next tick retries. Also un-set on a fresh memory (process
   *  restart), so an already-over-threshold session is never suppressed (the continuing-session-restart hazard). */
  lastCompactMs?: number;
}

export interface ContextWindowConfig {
  /** Inject /compact when contextTokens >= fraction * windowTokens. 0 disables. ~0.75 fires before the wedge,
   *  leaving headroom for retry-on-drop (#336) before a busy session reaches 100%. */
  thresholdFraction: number;
  /** Anti-thrash floor: never inject twice within this window of the last CONFIRMED injection. */
  minIntervalMs: number;
}

/**
 * Context-window watcher (#296): inject /compact into a heavy-but-idle session BEFORE its context window
 * fills and the session wedges ("No response from API · Retrying"). When that session is the hub, the wedge
 * halts dispatch and stalls the whole fleet (2026-06-20 incident, freed only by a manual /compact). The
 * trigger is window-RELATIVE (a fraction of the model's own window) so it works across the mixed 1M/200k
 * fleet -- a fixed token threshold would misfire on one model and never on the other. This function only
 * DECIDES; the caller arms the anti-thrash floor (lastCompactMs) ONLY after the /compact is CONFIRMED
 * delivered (#336), so a fresh memory after a process restart -- or a dropped inject into a busy pane --
 * never suppresses the threshold for a session that is already over-threshold. The caller gates on the pane
 * being idle before delivering /compact (an idle pane is safe; /compact is task-state-preserving).
 */
export function evaluateContextWindow(
  sample: ContextWindowSample,
  mem: ContextWindowMemory,
  cfg: ContextWindowConfig,
): WatcherAction {
  if (sample.contextTokens === null || cfg.thresholdFraction <= 0 || sample.windowTokens <= 0) {
    return { kind: 'none' };
  }
  // systemClock is wall-clock (not monotonic): re-base on a BACKWARD step (NTP/manual) so a clock that jumps
  // back can't wedge the anti-thrash floor forever.
  if (mem.lastCompactMs !== undefined && sample.nowMs < mem.lastCompactMs) mem.lastCompactMs = sample.nowMs;
  // Anti-thrash keyed on the last CONFIRMED injection only -> a fresh memory never suppresses the threshold.
  if (mem.lastCompactMs !== undefined && sample.nowMs - mem.lastCompactMs < cfg.minIntervalMs) {
    return { kind: 'none' };
  }
  if (sample.contextTokens < cfg.thresholdFraction * sample.windowTokens) return { kind: 'none' };
  // #336: DECIDE only -- do NOT arm the anti-thrash floor here. The caller sets `lastCompactMs` ONLY once the
  // /compact injection is CONFIRMED delivered; a dropped inject (pane busy >5s -> injectInput rejects) leaves
  // the floor un-armed so the NEXT tick retries (retry-on-drop), instead of a 10min unprotected window letting
  // the session run to 100% (the #296 named residual: arm-on-decision != arm-on-confirmed).
  return { kind: 'inject-compact', agentId: sample.agentId };
}

/**
 * Context window (tokens) for a model id. The 1M-context Opus variants carry a '1m' / '[1m]' marker
 * (e.g. 'claude-opus-4-8[1m]'); everything else is the standard 200k window. Unknown/empty -> the
 * conservative 200k so the threshold fires sooner rather than never.
 */
export function contextWindowForModel(model: string | null | undefined): number {
  if (typeof model === 'string' && /(\[1m\]|\b1m\b)/i.test(model)) return 1_000_000;
  return 200_000;
}
