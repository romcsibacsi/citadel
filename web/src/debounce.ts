// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * Tiny debouncer (FIX-hardening C2): coalesce rapid calls into one trailing
 * invocation after `ms`, with an explicit `flush` (run now + cancel the pending
 * timer) and `cancel`. Pure + uses the ambient setTimeout, so it works in the
 * browser and is unit-testable under node fake-timers. Shared by the search
 * inputs (skills + memories) instead of the old per-view inline timer.
 */
export interface Debouncer {
  /** Schedule (or reschedule) the trailing invocation. */
  call: () => void;
  /** Run immediately and drop any pending timer (e.g. the Enter key). */
  flush: () => void;
  /** Drop any pending timer without running. */
  cancel: () => void;
}

export function makeDebouncer(fn: () => void, ms: number): Debouncer {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = (): void => {
    if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
  };
  return {
    call: () => { cancel(); timer = setTimeout(() => { timer = undefined; fn(); }, ms); },
    flush: () => { cancel(); fn(); },
    cancel,
  };
}
