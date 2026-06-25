// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { createHmac } from 'node:crypto';

/**
 * Content-free health telemetry (#106, management-plane code side). The product
 * instance emits an OUTBOUND, per-machine-HMAC-signed health beat to the operator's
 * aggregator. The non-negotiable security property (PROBE UPDATE 3): the payload
 * carries ONLY metrics — up/down, counts, resource gauges, version — and NEVER any
 * customer content (no agent output, no memory, no log tail, no identities). HMAC
 * provides integrity/authenticity, NOT confidentiality, so if content ever leaked
 * into the payload the shared aggregator would become a cross-customer content sink.
 * Hence buildHealthPayload constructs the output field-by-field from an explicit
 * allowlist and NEVER spreads the rich snapshot.
 */

/** Rich, possibly-sensitive input. May contain content; NONE of it is emitted verbatim. */
export interface HealthSnapshot {
  /**
   * OPAQUE per-machine deployment id, assigned by the operator at provisioning so the
   * aggregator can attribute the beat. NOT customer-derived (no customer name/domain) —
   * the aggregator must never be able to read a customer's identity from it.
   */
  machineId: string;
  version: string;
  /** ISO timestamp of this sample. */
  at: string;
  uptimeSec: number;
  agents: Array<{
    /** Used ONLY to count states; the id/name itself is NOT emitted (identity = content). */
    id: string;
    running: boolean;
    state: 'working' | 'idle' | 'unknown' | 'error' | 'stopped';
    /** Rich fields that MUST NOT leak (log tail, last output, etc.). */
    tail?: string[];
    lastOutput?: string;
  }>;
  cpuPercent?: number;
  /** Memory utilisation as a percentage (0..100), aggregator-friendly across machine sizes. */
  memPercent?: number;
  /** A pure count of recent errors — never the error text. */
  errorCount?: number;
}

/**
 * The ONLY shape that goes on the wire (the RELAY #107 receiver contract). No
 * free-form strings sourced from agent/customer data; machine_id is opaque.
 */
export interface HealthPayload {
  v: 1;
  machine_id: string;
  /** A beat itself means 'up'; the aggregator infers 'down' from MISSING beats. */
  status: 'up';
  version: string;
  at: string;
  uptimeSec: number;
  agents: { total: number; running: number; working: number; error: number; stopped: number };
  cpuPercent?: number;
  memPercent?: number;
  errorCount?: number;
}

/**
 * Build the content-free payload. Counts agent states; emits resource gauges, version
 * and the opaque machine id only. Deliberately does NOT include agent ids/names,
 * tails, outputs, or any string drawn from customer data.
 */
export function buildHealthPayload(s: HealthSnapshot): HealthPayload {
  let running = 0;
  let working = 0;
  let error = 0;
  let stopped = 0;
  for (const a of s.agents) {
    if (a.running) running += 1;
    if (a.state === 'working') working += 1;
    else if (a.state === 'error') error += 1;
    else if (a.state === 'stopped') stopped += 1;
  }
  const payload: HealthPayload = {
    v: 1,
    machine_id: s.machineId,
    status: 'up',
    version: s.version,
    at: s.at,
    uptimeSec: Math.max(0, Math.floor(s.uptimeSec)),
    agents: { total: s.agents.length, running, working, error, stopped },
  };
  if (typeof s.cpuPercent === 'number' && Number.isFinite(s.cpuPercent)) payload.cpuPercent = Math.round(s.cpuPercent * 10) / 10;
  if (typeof s.memPercent === 'number' && Number.isFinite(s.memPercent)) payload.memPercent = Math.round(s.memPercent * 10) / 10;
  if (typeof s.errorCount === 'number' && Number.isFinite(s.errorCount)) payload.errorCount = Math.max(0, Math.floor(s.errorCount));
  return payload;
}

/** Canonical JSON of the payload (stable key order is already fixed by construction). */
export function healthBody(payload: HealthPayload): string {
  return JSON.stringify(payload);
}

/** Per-machine HMAC-SHA256 over the exact body, hex — same primitive as the webhook layer. */
export function signHealthBody(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

export interface EmitHealthDeps {
  /** Where to POST (operator aggregator). */
  url: string;
  /** Per-machine HMAC secret (never shared across machines). */
  secret: string;
  /** Injected POST (reuse the SSRF-guarded webhook poster in production). */
  post: (url: string, body: string, headers: Record<string, string>) => Promise<{ ok: boolean; status: number }>;
}

/** Sign + POST one beat. Thin; the security guarantee lives in buildHealthPayload. */
export async function emitHealth(payload: HealthPayload, deps: EmitHealthDeps): Promise<{ ok: boolean; status: number }> {
  const body = healthBody(payload);
  const sig = signHealthBody(deps.secret, body);
  return deps.post(deps.url, body, { 'content-type': 'application/json', 'x-health-signature': sig });
}
