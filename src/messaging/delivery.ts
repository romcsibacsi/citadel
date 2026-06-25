// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { type Clock, systemClock } from '../core/clock.js';
import { createLogger } from '../core/log.js';
import { frameDelivery } from '../trust/frame.js';
import { decideRoute, type RouteContext } from './route.js';
import type { MessageRow, MessageStore } from './store.js';

const log = createLogger('delivery');

/**
 * Delivery loop (SPEC §6). Owns timing and retries on top of the pure routing
 * decision in ./route.ts and the durable queue in ./store.ts.
 *
 * No-message-loss invariants enforced here:
 *  - A target that EXISTS in the roster is NEVER abandoned: busy targets are
 *    retried every tick forever, and 'down' (configured but not running)
 *    targets stay pending indefinitely.
 *  - Only roster ABSENCE ages a message out, and existence is checked BEFORE
 *    age on every tick (decideRoute runs against the live roster first), so a
 *    target that appears any time inside the retry window still gets its
 *    backlog delivered.
 *  - Operator messages are terminal: handed to the operator channel handler
 *    and marked delivered immediately.
 */

export type AgentRunState = 'ready' | 'busy' | 'down';

export interface DeliveryRuntime {
  /** Live run state of one agent ('down' = configured but no running session). */
  state(agentId: string): AgentRunState;
  /** The ONE input path into an agent (SPEC §3); force bypasses busy-gating. */
  inject(agentId: string, text: string, opts: { force?: boolean }): Promise<void>;
}

export interface DeliveryDeps {
  store: MessageStore;
  /** Live roster snapshot — re-read on every tick so config changes apply immediately. */
  routeCtx: () => RouteContext;
  runtime: DeliveryRuntime;
  /** Terminal hand-off for operator-bound messages (channel send / dashboard). */
  onOperatorMessage: (msg: MessageRow) => Promise<void>;
  /** Per-process random sentinel for tag neutralization (core/ids.PROCESS_SENTINEL). */
  sentinel: string;
  clock?: Clock;
  /** How long an absent (unknown) target is awaited before failing. */
  retryWindowMs?: number;
}

export type DeliveryOutcome = 'delivered' | 'done' | 'failed' | 'pending';

export const DEFAULT_RETRY_WINDOW_MS = 6 * 60 * 60 * 1000; // 6h

export class DeliveryService {
  private readonly clock: Clock;
  private readonly retryWindowMs: number;
  /**
   * Message ids currently mid-delivery (FIX-agent-permissions-permissive §5). A
   * message stays 'pending' until its inject RESOLVES, and an inject can block for
   * up to the supervisor's readiness bound while a busy agent finishes its turn.
   * The delivery loop is a bare setInterval (no overlap guard), so without this set
   * every tick during that wait re-selects the SAME pending row and queues ANOTHER
   * inject through the per-agent FIFO — all of which fire once the agent goes ready,
   * delivering the operator's message N times ("hatodszor érkezik ugyanaz"). Skipping
   * in-flight ids makes delivery exactly-once even under overlapping ticks.
   */
  private readonly inFlight = new Set<number>();

  constructor(private readonly deps: DeliveryDeps) {
    this.clock = deps.clock ?? systemClock;
    this.retryWindowMs = deps.retryWindowMs ?? DEFAULT_RETRY_WINDOW_MS;
  }

  /** Process every pending message oldest-first against one roster snapshot. */
  async tick(): Promise<void> {
    const ctx = this.deps.routeCtx();
    for (const msg of this.deps.store.pending()) {
      if (this.inFlight.has(msg.id)) continue; // already being delivered by an overlapping tick
      this.inFlight.add(msg.id);
      try {
        await this.process(msg, ctx, false);
      } finally {
        this.inFlight.delete(msg.id);
      }
    }
  }

  /**
   * Deliver one specific message now (forceSend paths, SPEC §9): with
   * force=true the busy gate is bypassed. 'down' still leaves it pending —
   * force changes priority, it cannot conjure a running session.
   */
  async deliverNow(id: number, opts: { force?: boolean } = {}): Promise<DeliveryOutcome> {
    const msg = this.deps.store.get(id);
    if (msg === undefined) throw new Error(`message ${id} not found`);
    if (msg.status !== 'pending') return msg.status; // already settled — idempotent
    if (this.inFlight.has(id)) return 'pending'; // a loop tick is already delivering it
    this.inFlight.add(id);
    try {
      return await this.process(msg, this.deps.routeCtx(), opts.force ?? false);
    } finally {
      this.inFlight.delete(id);
    }
  }

  private async process(msg: MessageRow, ctx: RouteContext, force: boolean): Promise<DeliveryOutcome> {
    const action = decideRoute(msg.sender, msg.recipient, ctx);
    switch (action.kind) {
      case 'operator-terminal': {
        try {
          await this.deps.onOperatorMessage(msg);
        } catch (err) {
          // Hand-off failed (channel down?) — keep pending, retried next tick.
          log.warn('operator hand-off failed; message stays pending', { id: msg.id, error: String(err) });
          return 'pending';
        }
        this.deps.store.markDelivered(msg.id);
        return 'delivered';
      }

      case 'consume': {
        this.deps.store.markDone(msg.id, 'consumed: generator loop-breaker');
        log.info('consumed generator-to-generator message', { id: msg.id });
        return 'done';
      }

      case 'reject': {
        if (action.reason === 'unknown-target') {
          // Existence-before-age order (SPEC §6): reaching this branch means
          // decideRoute just checked the LIVE roster and the target is absent
          // NOW. Only then may age fail the message.
          const ageMs = this.clock.now().getTime() - Date.parse(msg.createdAt);
          if (ageMs > this.retryWindowMs) {
            this.deps.store.markFailed(msg.id, 'target absent for retry window');
            log.warn('message failed: target absent for retry window', {
              id: msg.id,
              recipient: msg.recipient,
            });
            return 'failed';
          }
          return 'pending'; // target may yet appear — wait out the window
        }
        // reserved-target / hidden-target can never become valid: fail now.
        this.deps.store.markFailed(msg.id, `rejected: ${action.reason}`);
        log.warn('message rejected', { id: msg.id, reason: action.reason, recipient: msg.recipient });
        return 'failed';
      }

      case 'deliver': {
        const state = this.deps.runtime.state(action.recipientId);
        // A roster-known target is NEVER abandoned: 'down' (not running) and
        // 'busy' both just wait — no age check on this path, ever.
        if (state === 'down') return 'pending';
        if (state === 'busy' && !force) return 'pending';
        const text = frameDelivery({
          body: msg.body,
          tier: action.tier,
          senderId: action.senderId,
          sentinel: this.deps.sentinel,
          ...(msg.channelMeta === null ? {} : { channelMeta: msg.channelMeta }),
        });
        try {
          await this.deps.runtime.inject(action.recipientId, text, { force });
        } catch (err) {
          // Injection failed mid-flight — keep pending, retried next tick.
          log.warn('inject failed; message stays pending', { id: msg.id, error: String(err) });
          return 'pending';
        }
        this.deps.store.markDelivered(msg.id);
        return 'delivered';
      }
    }
  }
}
