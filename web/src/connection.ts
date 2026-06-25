// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * Connection-health tracker (FIX-freeze-after-login follow-up). The dashboard is a
 * long-lived SPA over many small fetches + SSE streams. If the backend stalls or a
 * tab's per-origin connections get starved, the operator must NOT have to hard-reload
 * (Ctrl+Shift+R) to recover. Every API request reports its outcome here:
 *  - a network/timeout failure increments a counter; after a few in a row the status
 *    flips to 'reconnecting' (the shell shows a banner);
 *  - any received response (even a 4xx/5xx — the server IS reachable) resets it to
 *    'online'. The shell, on the reconnecting→online edge, re-mounts the active view
 *    so stale "Loading…" regions refill automatically — no manual reload.
 * Pure module (no DOM), so it is unit-testable in isolation.
 */

export type ConnectionStatus = 'online' | 'reconnecting';

/** Consecutive transport failures before we declare the connection degraded. */
const FAIL_THRESHOLD = 2;

let consecutiveFails = 0;
let status: ConnectionStatus = 'online';
const listeners = new Set<(s: ConnectionStatus) => void>();

function set(next: ConnectionStatus): void {
  if (next === status) return;
  status = next;
  for (const cb of [...listeners]) {
    try { cb(status); } catch { /* a listener must never break the tracker */ }
  }
}

/** A response was received (success OR an HTTP error) — the server is reachable. */
export function noteReachable(): void {
  consecutiveFails = 0;
  set('online');
}

/** A transport-level failure (timeout / network error / aborted) — no response. */
export function noteUnreachable(): void {
  consecutiveFails += 1;
  if (consecutiveFails >= FAIL_THRESHOLD) set('reconnecting');
}

export function connectionStatus(): ConnectionStatus {
  return status;
}

/** Subscribe to status transitions; returns an unsubscribe. */
export function onConnectionChange(cb: (s: ConnectionStatus) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Test-only reset of module state. */
export function __resetConnection(): void {
  consecutiveFails = 0;
  status = 'online';
  listeners.clear();
}
