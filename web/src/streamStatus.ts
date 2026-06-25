// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * Shared SSE connection-status state machine (FIX-terminal-ux) for the terminal
 * modal and the agent watch view. Rules:
 *   - connecting  → the initial state (before any open/frame).
 *   - connected   → on the stream `open` AND on every data frame (so the status
 *                   returns to connected the moment frames resume after a drop).
 *   - reconnecting→ on an `error` ONLY after we were connected at least once, so a
 *                   first-connect error on a degraded network doesn't spuriously
 *                   flip the indicator (EventSource fires `error` before `open`).
 */

export type StreamState = 'connecting' | 'connected' | 'reconnecting';

export function wireStreamStatus(
  es: EventSource,
  onState: (s: StreamState) => void,
  onReconnect?: () => void,
): { markFrame: () => void } {
  let everConnected = false;
  const markConnected = (): void => {
    everConnected = true;
    onState('connected');
  };
  es.addEventListener('open', () => markConnected());
  es.addEventListener('error', () => {
    if (everConnected) {
      onState('reconnecting');
      onReconnect?.();
    }
  });
  // call on each data frame: confirms/restores 'connected' even mid-reconnect
  return { markFrame: markConnected };
}
