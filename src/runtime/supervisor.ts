// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * AgentSupervisor — THE single owner / single serializer (SPEC §3, §20.13).
 *
 * - ALL input reaches an agent through injectInput, which funnels into one
 *   ordered per-agent FIFO (promise chain): exactly one adapter.writeInput is
 *   in flight per agent, ever. Machine delivery and live operator typing can
 *   never interleave.
 * - The supervisor is the sole owner of each agent's output stream: it holds
 *   at most ONE adapter subscription per agent and multicasts to any number of
 *   read-only subscribers. A throwing subscriber cannot affect the agent or
 *   other subscribers.
 * - Reauth is escalate-only: a 'reauth-needed' agent never receives input
 *   (credentials are NEVER auto-injected), and onReauthNeeded fires exactly
 *   once per reauth episode.
 */

import { createLogger } from '../core/log.js';
import { systemClock, type Clock } from '../core/clock.js';
import type { AgentLaunchSpec, AgentRuntimeAdapter, AgentStatus, OutputEvent } from './types.js';

const log = createLogger('runtime.supervisor');

export type InjectSource = 'machine' | 'operator';

export interface InjectOptions {
  /** 'machine' = scheduler/router/etc; 'operator' = a human typing live. */
  source: InjectSource;
  /** Escape hatch for must-run deliveries: interrupt a busy agent, then write. */
  force?: boolean;
  /**
   * Per-call override of the readiness-wait bound (ms). A best-effort, droppable
   * inject (e.g. the hub-picker nudge, FIX-telegram-hub-reply) sets this LOW so it
   * never holds the per-agent FIFO head for the full default while polling a busy
   * agent — which would delay a later operator force-send queued behind it.
   */
  waitMs?: number;
}

export interface AgentSupervisorDeps {
  adapter: AgentRuntimeAdapter;
  /** Builds the launch spec for an agent; fresh=true drops accumulated context. */
  specFactory: (agentId: string, opts: { fresh: boolean }) => AgentLaunchSpec;
  /**
   * Ledger attribution hook (SPEC §3): called BEFORE the write for every
   * operator-source injection so direct typing is auditable. If it throws,
   * the write is aborted (no unaudited operator input).
   */
  onOperatorInjection?: (agentId: string, text: string) => void;
  /** Escalation hook — fired exactly once per reauth episode (SPEC §3). */
  onReauthNeeded?: (agentId: string) => void;
  /**
   * Per-agent git worktree provisioning (#44). Called best-effort before the
   * adapter starts so the agent's isolated worktree exists. NON-DESTRUCTIVE and
   * idempotent (never touches existing uncommitted work). A failure here must
   * NOT block the agent from starting — it is logged and the start proceeds.
   */
  provisionWorktree?: (agentId: string) => Promise<void>;
  /** Readiness poll interval (ms) while waiting on a busy agent. */
  pollMs?: number;
  /**
   * Max time to wait for a busy/needs-input agent to become ready before REJECTING
   * an inject (ms). Without this the wait loop is unbounded: an agent that never
   * reaches 'ready' (e.g. stuck on an OAuth /login screen that classifies as busy)
   * would hang performInject forever, wedging the per-agent FIFO so every later
   * key/text/delivery — and the HTTP request that awaits it — never returns.
   */
  injectWaitMs?: number;
  clock?: Clock;
  /** Injectable for deterministic tests; default is a real setTimeout sleep. */
  sleep?: (ms: number) => Promise<void>;
}

interface FanOut {
  cbs: Set<(e: OutputEvent) => void>;
  /** Releases the single underlying adapter subscription. */
  release: () => void;
  /**
   * Most recent `screen` frame seen on this fan (FIX-terminal-ux). Replayed to
   * EVERY new subscriber so a freshly-opened terminal shows the current screen
   * at once — even an idle agent, even when another viewer already holds the
   * stream (the adapter's own per-subscribe replay only reaches the first).
   * Invalidated on stop/restart so a restarted agent never shows a stale screen.
   */
  lastScreen?: OutputEvent;
  /** In-flight one-shot capture shared by concurrent new subscribers (one tmux capture, not N). */
  capturing?: Promise<OutputEvent | null>;
}

const DEFAULT_POLL_MS = 250;
/** Default bound on the performInject readiness wait (ms) — see injectWaitMs. */
const DEFAULT_INJECT_WAIT_MS = 30_000;

/**
 * The ONLY keys the operator terminal may forward to a live pane (FIX-03 §3).
 * tmux `send-keys` names — an allow-list is the real guard: it is re-validated
 * here (server side) before anything reaches the driver, so no arbitrary string
 * (e.g. the `C-b` prefix or `-X` copy-mode tokens) can ever reach send-keys.
 * Digits 0-9 are allow-listed so a numbered picker ("1.Yes 2.No") can be answered
 * with the digit key (#69); a bare digit is inert as a send-keys name.
 */
export const KEY_ALLOW_LIST: ReadonlySet<string> = new Set([
  'Enter', 'Escape', 'Up', 'Down', 'Left', 'Right', 'BSpace', 'Tab', 'BTab', 'Space',
  'Home', 'End', 'PageUp', 'PageDown', 'C-c', 'C-d', 'C-u', 'C-l', 'C-a', 'C-e', 'C-k', 'C-w',
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
]);

export class AgentSupervisor {
  /** Per-agent FIFO tails — the serialization point for ALL input. */
  private readonly queues = new Map<string, Promise<void>>();
  /** Per-agent multicast state — at most one adapter subscription each. */
  private readonly fans = new Map<string, FanOut>();
  /** Agents whose current reauth episode has already been escalated. */
  private readonly reauthSurfaced = new Set<string>();
  /** Short-TTL fleet/overview status cache (FIX-agents-list-perf); start/stop invalidate. */
  private readonly statusCache = new Map<string, { at: number; value: AgentStatus }>();
  private readonly pollMs: number;
  private readonly injectWaitMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  // Clock is accepted for interface symmetry/future event stamping.
  private readonly clock: Clock;

  constructor(private readonly deps: AgentSupervisorDeps) {
    this.pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
    this.injectWaitMs = deps.injectWaitMs ?? DEFAULT_INJECT_WAIT_MS;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.clock = deps.clock ?? systemClock;
  }

  /**
   * The ONE path by which anything reaches an agent's input (SPEC §3).
   * Serialized per agent via a promise chain; resolves when the text has been
   * written, rejects if delivery is impossible (e.g. reauth-needed).
   */
  injectInput(agentId: string, text: string, opts: InjectOptions): Promise<void> {
    const tail = this.queues.get(agentId) ?? Promise.resolve();
    const run = tail.then(() => this.performInject(agentId, text, opts));
    // Keep the chain alive even when an individual inject rejects.
    this.queues.set(
      agentId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  /**
   * Forward a single allow-listed control/navigation key to a live pane (FIX-03
   * §3). Serialized through the SAME per-agent FIFO as injectInput so a key and a
   * text/machine delivery can never interleave on the pane. Rejects a key not in
   * KEY_ALLOW_LIST (re-validated server side) or a runtime without key support.
   * This is OPERATOR-initiated (the route is operator-gated); like operator text
   * it is intentionally permitted during reauth-needed — keys are how the operator
   * answers the live /login prompt (it is not credential auto-injection).
   */
  sendKey(agentId: string, key: string): Promise<void> {
    if (!KEY_ALLOW_LIST.has(key)) return Promise.reject(new Error(`disallowed key: ${key}`));
    const adapter = this.deps.adapter;
    if (adapter.sendKey === undefined) return Promise.reject(new Error('runtime does not support key forwarding'));
    const tail = this.queues.get(agentId) ?? Promise.resolve();
    const run = tail.then(() => adapter.sendKey!(agentId, key));
    this.queues.set(
      agentId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  /**
   * Forward literal text to the live pane WITHOUT submitting (raw keystroke
   * typing, §6). Serialized through the SAME per-agent FIFO as injectInput/sendKey
   * so a literal char and a control key can never interleave mid-write.
   */
  sendLiteral(agentId: string, text: string): Promise<void> {
    const adapter = this.deps.adapter;
    if (adapter.writeLiteral === undefined) return Promise.reject(new Error('runtime does not support literal input'));
    const tail = this.queues.get(agentId) ?? Promise.resolve();
    const run = tail.then(() => adapter.writeLiteral!(agentId, text));
    this.queues.set(
      agentId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  /**
   * One-shot snapshot of the agent's current rendered screen text (or null when
   * the runtime can't capture). Used by the own-team login flow to surface the
   * OAuth URL the CLI prints. Read-only — never injects.
   */
  async captureScreen(agentId: string): Promise<string | null> {
    if (this.deps.adapter.captureScreen === undefined) return null;
    const ev = await this.deps.adapter.captureScreen(agentId);
    return ev?.text ?? null;
  }

  private async performInject(agentId: string, text: string, opts: InjectOptions): Promise<void> {
    const force = opts.force ?? false;
    const maxWaits = Math.max(1, Math.ceil((opts.waitMs ?? this.injectWaitMs) / this.pollMs));
    let waits = 0;
    for (;;) {
      const status = await this.deps.adapter.status(agentId);
      const state = status.busyState;

      if (state === 'reauth-needed') {
        // The OPERATOR is allowed to drive the re-login interactively (typing
        // /login, navigating the prompt) — that is NOT credential injection, it
        // is the human re-authenticating in the live pane (FIX-03 §2). Only
        // MACHINE/automatic delivery is blocked: escalate once, never write.
        if (opts.source === 'operator') {
          this.reauthSurfaced.delete(agentId);
          break;
        }
        if (!this.reauthSurfaced.has(agentId)) {
          this.reauthSurfaced.add(agentId);
          try {
            this.deps.onReauthNeeded?.(agentId);
          } catch (err) {
            log.warn('onReauthNeeded hook failed', { agentId, error: String(err) });
          }
        }
        throw new Error(`agent ${agentId} needs re-authentication; input not delivered`);
      }
      // Any non-reauth observation ends the current reauth episode.
      this.reauthSurfaced.delete(agentId);

      if (state === 'ready') break;

      if (force) {
        if (state === 'busy') {
          // forceSend semantics (SPEC §3): interrupt the in-flight turn first.
          await this.deps.adapter.interrupt(agentId);
          await this.sleep(this.pollMs); // grace for the runtime to settle
        }
        // force also answers a needs-input prompt directly (no interrupt).
        break;
      }

      // busy / needs-input without force: wait, never deliver into it — but BOUNDED.
      // A never-ready agent (e.g. stuck on a /login screen) must reject the inject,
      // not loop forever holding the per-agent FIFO (which would hang this request
      // and every queued key/text behind it).
      if (++waits >= maxWaits) {
        throw new Error(`agent ${agentId} not ready for input after ${Math.round(this.injectWaitMs / 1000)}s (state: ${state})`);
      }
      await this.sleep(this.pollMs);
    }

    if (opts.source === 'operator') {
      // Attribution BEFORE the write — if the ledger hook throws we must not
      // deliver unaudited operator input.
      this.deps.onOperatorInjection?.(agentId, text);
    }
    await this.deps.adapter.writeInput(agentId, text);
  }

  /**
   * Read-only live output stream with fan-out (SPEC §3): one adapter
   * subscription per agent regardless of subscriber count; the last
   * unsubscribe releases it. Returns an idempotent unsubscribe function.
   */
  streamOutput(agentId: string, cb: (e: OutputEvent) => void): () => void {
    let entry = this.fans.get(agentId);
    if (entry === undefined) {
      const fan: FanOut = { cbs: new Set<(e: OutputEvent) => void>(), release: () => undefined };
      fan.release = this.deps.adapter.subscribeOutput(agentId, (event) => {
        // cache the latest non-blank screen so EVERY later subscriber can be replayed it
        if (event.kind === 'screen' && (event.text ?? '').trim() !== '') fan.lastScreen = event;
        for (const subscriber of [...fan.cbs]) {
          try {
            subscriber(event);
          } catch (err) {
            // Subscribers can never affect the agent or each other.
            log.warn('output subscriber threw', { agentId, error: String(err) });
          }
        }
      });
      this.fans.set(agentId, fan);
      entry = fan;
    }
    const fan = entry;
    fan.cbs.add(cb);
    // Guarantee an initial frame to THIS new subscriber (FIX-terminal-ux): replay
    // the cached screen immediately, or — if nothing is cached yet (poll just
    // started) — do a one-shot capture for this subscriber rather than waiting
    // for the agent's next change.
    const deliver = (ev: OutputEvent): void => {
      if (!fan.cbs.has(cb)) return;
      try {
        cb(ev);
      } catch (err) {
        log.warn('initial screen replay threw', { agentId, error: String(err) });
      }
    };
    if (fan.lastScreen !== undefined) {
      const cached = fan.lastScreen;
      queueMicrotask(() => deliver(cached));
    } else if (this.deps.adapter.captureScreen !== undefined) {
      // share ONE capture across concurrent new subscribers (not N tmux captures)
      if (fan.capturing === undefined) {
        fan.capturing = this.deps.adapter.captureScreen(agentId).then((ev) => {
          if (ev !== null && (ev.text ?? '').trim() !== '' && fan.lastScreen === undefined) fan.lastScreen = ev;
          return ev;
        });
      }
      void fan.capturing
        .then((ev) => {
          if (ev !== null && (ev.text ?? '').trim() !== '') deliver(ev);
        })
        .catch((err: unknown) => log.warn('one-shot screen capture failed', { agentId, error: String(err) }));
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      fan.cbs.delete(cb);
      if (fan.cbs.size === 0 && this.fans.get(agentId) === fan) {
        this.fans.delete(agentId);
        fan.release();
      }
    };
  }

  /** Drop any cached screen for an agent so a (re)started session never replays a stale frame. */
  private invalidateScreen(agentId: string): void {
    const fan = this.fans.get(agentId);
    if (fan !== undefined) {
      fan.lastScreen = undefined;
      fan.capturing = undefined;
    }
  }

  async start(agentId: string, opts: { fresh?: boolean } = {}): Promise<void> {
    const spec = this.deps.specFactory(agentId, { fresh: opts.fresh ?? false });
    this.reauthSurfaced.delete(agentId); // a restart begins a clean episode
    this.invalidateScreen(agentId); // a new session: never replay the previous screen
    this.statusCache.delete(agentId); // a fresh session: never serve a stale cached status
    // Ensure the agent's isolated git worktree exists (#44) before it starts.
    // Best-effort: provisioning is non-destructive, but a git hiccup must never
    // wedge an agent — log and start anyway (the agent still boots in its workdir).
    if (this.deps.provisionWorktree !== undefined) {
      try {
        await this.deps.provisionWorktree(agentId);
      } catch (err) {
        log.warn('agent worktree provision failed', { agentId, error: err instanceof Error ? err.message : String(err) });
      }
    }
    await this.deps.adapter.start(spec);
    log.info('agent started', { agentId, fresh: opts.fresh ?? false });
  }

  async stop(agentId: string): Promise<void> {
    this.invalidateScreen(agentId); // a stopped agent has no current screen
    this.statusCache.delete(agentId); // drop any cached "running" snapshot
    await this.deps.adapter.stop(agentId);
    log.info('agent stopped', { agentId });
  }

  async restart(agentId: string, opts: { fresh?: boolean } = {}): Promise<void> {
    await this.stop(agentId);
    await this.start(agentId, opts);
  }

  status(agentId: string): Promise<AgentStatus> {
    return this.deps.adapter.status(agentId);
  }

  /**
   * Bounded, short-TTL status read for the fleet list + Overview/Team graph
   * (FIX-agents-list-perf). Two guarantees the raw `status()` can't give a
   * fan-out caller:
   *  - a hung/slow adapter probe NEVER blocks the list — it times out and falls
   *    back to the last known value (or the safe non-injectable down state), so
   *    one wedged agent can't stall a 15-agent sweep;
   *  - overlapping fleet + overview polls within `ttlMs` reuse ONE probe per
   *    agent (the 7s fleet poll and the 7s overview poll otherwise each capture
   *    every pane), cutting tmux load in half.
   * Correctness floor: TTL is a few seconds and start/stop invalidate the entry,
   * so running/busyState stay accurate within the poll window.
   */
  async statusFast(agentId: string, opts: { ttlMs?: number; timeoutMs?: number } = {}): Promise<AgentStatus> {
    const ttlMs = opts.ttlMs ?? 2500;
    const timeoutMs = opts.timeoutMs ?? 2000;
    const now = this.clock.now().getTime();
    const cached = this.statusCache.get(agentId);
    if (cached !== undefined && now - cached.at < ttlMs) return cached.value;
    let value: AgentStatus;
    try {
      value = await this.withTimeout(this.deps.adapter.status(agentId), timeoutMs);
    } catch {
      // hung/slow/unavailable probe: never block the fleet — reuse the last known
      // value (recent, just stale) or fall back to the safe down state.
      value = cached?.value ?? { running: false, busyState: 'busy', needsReauth: false };
    }
    this.statusCache.set(agentId, { at: now, value });
    return value;
  }

  /** Reject after `ms` if `p` hasn't settled; always clears its timer. */
  private withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('status probe timed out')), ms);
      p.then(
        (v) => { clearTimeout(timer); resolve(v); },
        (e: unknown) => { clearTimeout(timer); reject(e instanceof Error ? e : new Error(String(e))); },
      );
    });
  }

  isRunning(agentId: string): Promise<boolean> {
    return this.deps.adapter.isRunning(agentId);
  }
}
