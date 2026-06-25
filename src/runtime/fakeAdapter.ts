// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * In-memory AgentRuntimeAdapter for tests and the 'fake' runtime mode
 * (config runtime.adapter = 'fake'). Fully deterministic: busy state is
 * settable, input handling is scriptable, output is emitted manually, and
 * every adapter interaction is recorded in order.
 */

import { isoNow, systemClock, type Clock } from '../core/clock.js';
import type {
  AgentBusyState,
  AgentLaunchSpec,
  AgentRuntimeAdapter,
  AgentStatus,
  OutputEvent,
} from './types.js';

export interface FakeWrite {
  id: string;
  text: string;
}

export interface FakeAction {
  op: 'start' | 'stop' | 'write' | 'interrupt' | 'key' | 'literal';
  id: string;
  text?: string;
}

export class FakeAdapter implements AgentRuntimeAdapter {
  /** Every start() spec, in call order. */
  readonly startedSpecs: AgentLaunchSpec[] = [];
  /** Every writeInput, in call order. */
  readonly writes: FakeWrite[] = [];
  /** Every sendKey, in call order. */
  readonly keys: string[] = [];
  /** Every writeLiteral (raw keystroke text), in call order. */
  readonly literals: string[] = [];
  /** Unified ordered record of start/stop/write/interrupt calls. */
  readonly actions: FakeAction[] = [];
  /**
   * Scriptable hook awaited inside writeInput — lets tests make writes slow
   * (to prove single-in-flight serialization) or fail.
   */
  onInput?: (id: string, text: string) => void | Promise<void>;

  private readonly running = new Map<string, string>(); // id -> since (ISO)
  private readonly busyStates = new Map<string, AgentBusyState>();
  private readonly subs = new Map<string, Set<(e: OutputEvent) => void>>();
  private readonly screens = new Map<string, string>(); // id -> current rendered screen
  private activeSubs = 0;

  constructor(private readonly clock: Clock = systemClock) {}

  /** Flip an agent's busy state mid-test. */
  setBusyState(id: string, state: AgentBusyState): void {
    this.busyStates.set(id, state);
  }

  /** Per-agent real delay before status() resolves — exercises statusFast's timeout. */
  private readonly statusDelayMs = new Map<string, number>();
  setStatusDelay(id: string, ms: number): void {
    this.statusDelayMs.set(id, ms);
  }

  /** Manually push an event to current subscribers of an agent. */
  emitOutput(agentId: string, event: OutputEvent): void {
    for (const cb of [...(this.subs.get(agentId) ?? [])]) cb(event);
  }

  /** Number of live adapter subscriptions across all agents. */
  get subscriptionCount(): number {
    return this.activeSubs;
  }

  subscriptionsFor(id: string): number {
    return this.subs.get(id)?.size ?? 0;
  }

  /** Set the agent's current rendered screen (for captureScreen + the terminal view). */
  setScreen(id: string, text: string): void {
    this.screens.set(id, text);
  }

  /** The agent's current rendered screen, if any. */
  currentScreen(id: string): string | undefined {
    return this.screens.get(id);
  }

  /** One-shot screen snapshot for a new subscriber with nothing cached yet. */
  async captureScreen(id: string): Promise<OutputEvent | null> {
    if (!this.running.has(id)) return null;
    const text = this.screens.get(id) ?? `[fake:${id}] session ready`;
    return { agentId: id, ts: isoNow(this.clock), kind: 'screen', text };
  }

  async start(spec: AgentLaunchSpec): Promise<void> {
    this.startedSpecs.push(spec);
    this.actions.push({ op: 'start', id: spec.id });
    this.running.set(spec.id, isoNow(this.clock));
    // a multi-line banner so a freshly-opened terminal has real scrollback (the
    // current screen is shown immediately via captureScreen even for an idle agent)
    if (!this.screens.has(spec.id)) {
      this.screens.set(
        spec.id,
        Array.from({ length: 40 }, (_, i) => `[fake:${spec.id}] ready · line ${String(i + 1).padStart(2, '0')}`).join('\n'),
      );
    }
  }

  async stop(id: string): Promise<void> {
    this.actions.push({ op: 'stop', id });
    this.running.delete(id);
    this.screens.delete(id); // a stopped agent has no current screen
  }

  async isRunning(id: string): Promise<boolean> {
    return this.running.has(id);
  }

  async status(id: string): Promise<AgentStatus> {
    const delay = this.statusDelayMs.get(id);
    if (delay !== undefined && delay > 0) await new Promise((r) => setTimeout(r, delay));
    const since = this.running.get(id);
    const busyState = this.busyStates.get(id) ?? 'ready';
    return {
      running: since !== undefined,
      ...(since !== undefined ? { since } : {}),
      busyState,
      needsReauth: busyState === 'reauth-needed',
    };
  }

  async writeInput(id: string, text: string): Promise<void> {
    this.actions.push({ op: 'write', id, text });
    this.writes.push({ id, text });
    await this.onInput?.(id, text);
  }

  async sendKey(id: string, key: string): Promise<void> {
    this.actions.push({ op: 'key', id, text: key });
    this.keys.push(key);
  }

  /** Raw literal keystroke(s): record + append to the screen so the view reflects typing. */
  async writeLiteral(id: string, text: string): Promise<void> {
    this.actions.push({ op: 'literal', id, text });
    this.literals.push(text);
    this.screens.set(id, (this.screens.get(id) ?? '') + text);
  }

  async interrupt(id: string): Promise<void> {
    this.actions.push({ op: 'interrupt', id });
  }

  subscribeOutput(id: string, cb: (e: OutputEvent) => void): () => void {
    let set = this.subs.get(id);
    if (!set) {
      set = new Set();
      this.subs.set(id, set);
    }
    set.add(cb);
    this.activeSubs++;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      set.delete(cb);
      this.activeSubs--;
    };
  }
}
