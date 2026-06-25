// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import type { AgentStatus } from '../runtime/types.js';
import { createLogger } from '../core/log.js';

const log = createLogger('activity-sampler');

/**
 * Background fleet-activity sampler (FIX-activity-sampler).
 *
 * The Activity view used to compute its board ON EVERY request: a per-agent tmux
 * status capture across all agents. With a 3 s dashboard poll but a 6–9 s response
 * (15 agents × a slow capture under load), requests overlapped and each spawned 15
 * more captures → a contention spiral that blew past the 15 s client timeout
 * ("Could not fetch activity").
 *
 * This sampler moves the cost OUT of the request: a loop refreshes the board on a
 * timer with BOUNDED concurrency (a few captures at a time, never 15 at once, never
 * overlapping itself). The route then returns the cached snapshot in sub-millisecond
 * time. Because the sampler's status probes go through `supervisor.statusFast`, they
 * also keep the shared status cache warm, so the fleet LIST endpoint stops re-capturing
 * too. Staleness is bounded by the sample period (a few seconds), which is fine for a
 * monitoring view; an operator start/stop still invalidates the cache for correctness.
 */

export type ActivityState = 'working' | 'idle' | 'unknown' | 'error' | 'stopped';

export interface ActivityRow {
  name: string;
  agentId: string;
  isMain: boolean;
  running: boolean;
  state: ActivityState;
  tail: string[];
  /**
   * No-progress watchman (#80): present when the agent has been continuously
   * 'working' with an UNCHANGED tail past a threshold — a likely stuck busy-loop
   * (level 1 = alert, level 2 = restart-eligible). Absent on any progress/idle.
   */
  stuck?: { level: 1 | 2; sinceMs: number };
}

export interface StuckThresholds {
  /** Continuous no-progress before a level-1 alert (ms). */
  level1Ms: number;
  /** Continuous no-progress before a level-2 (restart-eligible) escalation (ms). */
  level2Ms: number;
}

/** Conservative inline fallback; the canonical defaults live in src/config/defaults.ts. */
const FALLBACK_STUCK_THRESHOLDS: StuckThresholds = { level1Ms: 10 * 60_000, level2Ms: 25 * 60_000 };

/**
 * The action a no-progress event warrants (#80): a level-2 escalation restarts the
 * agent fresh ONLY when its per-agent auto-restart flag is ON (operator opt-in);
 * otherwise — and for every level-1 — we just alert (never kill a legit long job).
 * Kept pure so the policy is unit-tested directly.
 */
export function stuckAction(level: 1 | 2, autoRestartOn: boolean): 'restart-fresh' | 'alert' {
  return level === 2 && autoRestartOn ? 'restart-fresh' : 'alert';
}

/**
 * Normalize a tmux tail for no-progress comparison (#80). COSMETIC animation must
 * collapse to a STABLE signature so a spinning/redrawing-but-idle pane reads as
 * no-progress and FIRES (the MUSE/REEL busy-loop) — otherwise the ever-changing
 * raw bytes would look like progress and the watchman would never trip. Genuinely
 * new log lines still change the signature and reset the streak. Strips ANSI/VT
 * escape & cursor sequences, carriage-return redraws, braille + standalone ascii
 * spinner glyphs, and stray control chars; collapses whitespace.
 * (Limitation: a spinner carrying an incrementing timer still looks like progress.)
 */
export function normalizeTailSig(tail: string[]): string {
  return tail
    .map((raw) => {
      const line = raw.includes('\r') ? raw.slice(raw.lastIndexOf('\r') + 1) : raw;
      return line
        .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '') // CSI: colours, cursor moves
        .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC … BEL/ST
        .replace(/\x1b[@-Z\\-_]/g, '') // other 2-char escapes
        .replace(/[⠀-⣿]/g, '') // braille spinner glyphs
        .replace(/\(\d+(?:m(?:\s*\d+s?)?|s)\)/g, '') // duration annotations: (45s), (2m), (2m 30s)
        .replace(/(^|\s)[|/\\-](?=\s|$)/g, '$1') // a STANDALONE ascii spinner glyph
        .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '') // stray control chars
        .replace(/\s+/g, ' ')
        .trim();
    })
    .join('\n')
    .trim();
}

export interface ActivitySamplerDeps {
  /** Visible roster (already sanitized ids), newest-first ordering is applied here. */
  agents: () => Array<{ id: string; displayName: string; hidden?: boolean }>;
  hubId: () => string;
  isRunning: (id: string) => Promise<boolean>;
  /** A FRESH status probe — the sampler is the cache warmer (pass statusFast with ttl 0). */
  status: (id: string) => Promise<AgentStatus>;
  tail: (id: string) => string[];
  watch: (id: string) => void;
  /** Max concurrent captures per sweep (default 5) — bounds tmux subprocess pressure. */
  concurrency?: number;
  now?: () => number;
  /** No-progress thresholds (#80); the inline fallback applies if omitted. */
  stuckThresholds?: StuckThresholds;
  /**
   * Fired ONCE per level when an agent crosses a no-progress threshold (#80).
   * The handler owns the policy (notify the hub; on level 2 restart-fresh iff the
   * agent's auto-restart flag is ON, else just alert). The sampler stays pure.
   */
  onStuck?: (info: { agentId: string; displayName: string; level: 1 | 2; sinceMs: number }) => void;
}

/** Map an AgentStatus to the board state (shared by the sampler + the route's per-flip refresh). */
export function stateFromStatus(st: AgentStatus, hasTail: boolean): ActivityState {
  let state: ActivityState;
  if (st.needsReauth || st.busyState === 'reauth-needed') state = 'error';
  else if (st.busyState === 'busy') state = 'working';
  else if (st.busyState === 'ready' || st.busyState === 'needs-input') state = 'idle';
  else state = 'unknown';
  if (state !== 'error' && !hasTail) state = state === 'working' ? 'working' : 'unknown';
  return state;
}

/** Run `fn` over `items` with at most `limit` in flight; preserves order; never rejects per item. */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, async () => {
    for (;;) {
      const idx = next++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx]!);
    }
  });
  await Promise.all(workers);
  return out;
}

export class ActivitySampler {
  private board: ActivityRow[] = [];
  private sampledAt = 0;
  private sweep: Promise<void> | null = null; // single-flight: the in-flight sweep, if any
  /** No-progress streaks per agent (#80): the unchanged-tail signature, when the
   *  streak began, and the highest level already fired (so each level alerts once). */
  private progress = new Map<string, { sig: string; since: number; firedLevel: 0 | 1 | 2 }>();

  constructor(private readonly deps: ActivitySamplerDeps) {}

  /**
   * No-progress detection (#80). An agent that stays 'working' while its tail never
   * changes is making no progress (the MUSE/REEL busy-loop). A changing tail — e.g.
   * a streaming test run — is progress and resets the streak, so it never false-fires.
   * idle/stopped/error/unknown clear the streak and never fire. Returns the row's
   * `stuck` marker (for the dashboard) and fires `onStuck` once per crossed level.
   */
  private trackProgress(id: string, displayName: string, running: boolean, state: ActivityState, tail: string[], now: number): { level: 1 | 2; sinceMs: number } | undefined {
    if (!running || state !== 'working') {
      this.progress.delete(id);
      return undefined;
    }
    const sig = normalizeTailSig(tail); // cosmetic animation must not look like progress (#80)
    const prev = this.progress.get(id);
    if (!prev || prev.sig !== sig) {
      // a new working streak, or the tail advanced (progress) — (re)start the clock
      this.progress.set(id, { sig, since: now, firedLevel: 0 });
      return undefined;
    }
    const th = this.deps.stuckThresholds ?? FALLBACK_STUCK_THRESHOLDS;
    const sinceMs = now - prev.since;
    const level: 0 | 1 | 2 = sinceMs >= th.level2Ms ? 2 : sinceMs >= th.level1Ms ? 1 : 0;
    if (level > prev.firedLevel) {
      this.progress.set(id, { sig, since: prev.since, firedLevel: level });
      this.deps.onStuck?.({ agentId: id, displayName, level: level as 1 | 2, sinceMs });
    }
    return level > 0 ? { level: level as 1 | 2, sinceMs } : undefined;
  }

  /** The latest precomputed board (instant). `sampledAt` is 0 until the first sweep. */
  getBoard(): { board: ActivityRow[]; sampledAt: number } {
    return { board: this.board, sampledAt: this.sampledAt };
  }

  /** Recompute the board with bounded concurrency. Single-flight: a concurrent caller (the
   *  5s loop, or a first-paint request) AWAITS the in-flight sweep instead of starting a
   *  second one — so first-paint blocks once on the boot sweep, then everything is instant. */
  async tick(): Promise<void> {
    if (this.sweep !== null) {
      await this.sweep;
      return;
    }
    this.sweep = this.doSweep();
    try {
      await this.sweep;
    } finally {
      this.sweep = null;
    }
  }

  private async doSweep(): Promise<void> {
    try {
      const hubId = this.deps.hubId();
      const visible = this.deps.agents().filter((a) => a.hidden !== true);
      const ordered = [...visible.filter((a) => a.id === hubId), ...visible.filter((a) => a.id !== hubId)];
      const rows = await mapPool(ordered, this.deps.concurrency ?? 5, async (a) => this.sampleOne(a, hubId));
      this.board = rows;
      this.sampledAt = (this.deps.now ?? Date.now)();
    } catch (err) {
      log.warn('activity sweep failed', { error: String(err) });
    }
  }

  private async sampleOne(a: { id: string; displayName: string }, hubId: string): Promise<ActivityRow> {
    const id = a.id;
    this.deps.watch(id);
    const running = await this.deps.isRunning(id).catch(() => false);
    let state: ActivityState = 'stopped';
    let tail: string[] = [];
    if (running) {
      tail = this.deps.tail(id);
      try {
        state = stateFromStatus(await this.deps.status(id), tail.length > 0);
      } catch {
        state = 'unknown';
      }
    }
    const now = (this.deps.now ?? Date.now)();
    const stuck = this.trackProgress(id, a.displayName, running, state, tail, now);
    return { name: a.displayName, agentId: id, isMain: id === hubId, running, state, tail, ...(stuck ? { stuck } : {}) };
  }
}
