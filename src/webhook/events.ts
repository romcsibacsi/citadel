// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { createLogger } from '../core/log.js';
import { assertPublicUrl, parseAllowlist, SsrfError, type DnsResolver } from '../tools/ssrf.js';
import type { SettingsStore } from '../settings/store.js';
import type { VaultStore } from '../vault/store.js';
import { readTargets, readOutboundAllowlist, targetSecret, type WebhookEventKind } from './config.js';

const log = createLogger('webhook.events');

/**
 * The webhook event bus (FIX-plugin-webhook, outbound side).
 *
 * A tiny synchronous publish/subscribe bus the orchestrator emits system events
 * into (kanban move / card done / idea created / agent finished). The webhook
 * plugin subscribes once and, for each configured target subscribed to the event,
 * POSTs the event payload to that target's URL.
 *
 * Hard outbound rules (MUST):
 *  - the target URL is taken from operator config (a NAMED target) — never from
 *    the event payload, so an untrusted event can't redirect a POST;
 *  - every URL passes the SSRF guard (assertPublicUrl): localhost / link-local /
 *    private-LAN / cloud-metadata are refused unless the operator allowlisted the
 *    exact host;
 *  - a per-request timeout (AbortSignal) bounds the POST;
 *  - secrets (a target's auth header) come from the vault and are never logged.
 *
 * Emits are best-effort + isolated: a failed/blocked POST is logged, never thrown
 * back into the caller (a move/idea must not fail because a webhook is down).
 */

export interface WebhookEvent {
  kind: WebhookEventKind;
  /** The serializable event body (already redacted of secrets by the caller). */
  data: Record<string, unknown>;
}

type Listener = (event: WebhookEvent) => void;

export class WebhookEventBus {
  private readonly listeners = new Set<Listener>();

  /** Subscribe; returns an unsubscribe fn. */
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Publish an event to every subscriber. A throwing subscriber is isolated. */
  emit(kind: WebhookEventKind, data: Record<string, unknown>): void {
    const event: WebhookEvent = { kind, data };
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch (err) {
        log.warn('webhook event listener threw — isolated', { kind, error: String(err) });
      }
    }
  }
}

/**
 * The process-wide default bus. Emit sites (kanban/idea/supervisor) import THIS
 * and call `webhookBus.emit(...)` — a single line, no AppContext plumbing. The
 * integrator calls `wireOutbound(webhookBus, …)` ONCE at boot; until then an emit
 * is a cheap no-op (no subscribers), so the emit sites are safe to add eagerly.
 */
export const webhookBus = new WebhookEventBus();

/**
 * The "agent finished its turn" edge: a run-state transition from busy back to
 * ready. Pure so the supervisor poll can call it and a test can pin the edge
 * semantics (only the busy→ready edge fires; a steady ready or down never does).
 */
export function isAgentFinishEdge(prev: string | undefined, next: string): boolean {
  return prev === 'busy' && next === 'ready';
}

export interface OutboundDeps {
  settings: SettingsStore;
  vault: VaultStore;
  fetchImpl?: typeof fetch;
  resolver?: DnsResolver;
  timeoutMs?: number;
}

/**
 * POST a JSON body to ONE configured target by name, after the SSRF guard. This
 * is the single outbound primitive shared by the event dispatcher and the
 * `webhook_post` agent tool. Throws an Error (SsrfError when blocked) so the
 * caller can surface a clear message; the event dispatcher swallows it.
 */
export async function postToTarget(
  targetName: string,
  body: unknown,
  deps: OutboundDeps,
): Promise<{ status: number; ok: boolean }> {
  const target = readTargets(deps.settings).find((t) => t.name === targetName);
  if (target === undefined) throw new Error(`no such webhook target: ${targetName}`);

  const allow = parseAllowlist(readOutboundAllowlist(deps.settings));
  // throws SsrfError unless the host is public or on the operator allowlist
  const url = await assertPublicUrl(target.url, { allowHosts: allow, ...(deps.resolver !== undefined ? { resolver: deps.resolver } : {}) });

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (target.authHeader !== undefined) {
    const secret = targetSecret(deps.vault, target.name);
    if (secret !== undefined && secret !== '') headers[target.authHeader.toLowerCase()] = secret;
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  const res = await fetchImpl(url.toString(), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000),
  });
  return { status: res.status, ok: res.ok };
}

/**
 * Wire the bus to outbound delivery: on each event, fan out to every target
 * subscribed to that event kind. Best-effort + isolated. Returns the unsubscribe
 * fn. The integrator calls this once at boot with the live AppContext bits.
 */
export function wireOutbound(bus: WebhookEventBus, deps: OutboundDeps): () => void {
  return bus.subscribe((event) => {
    void (async () => {
      const targets = readTargets(deps.settings).filter((t) => t.events.includes(event.kind));
      for (const t of targets) {
        try {
          const r = await postToTarget(t.name, { event: event.kind, data: event.data }, deps);
          if (!r.ok) log.warn('webhook target returned non-2xx', { target: t.name, kind: event.kind, status: r.status });
        } catch (err) {
          if (err instanceof SsrfError) {
            log.warn('webhook target blocked by SSRF guard', { target: t.name, kind: event.kind, error: err.message });
          } else {
            log.warn('webhook target POST failed', { target: t.name, kind: event.kind, error: String(err) });
          }
        }
      }
    })();
  });
}
