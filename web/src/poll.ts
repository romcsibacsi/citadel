// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * Host-guarded live-refresh helpers (FIX-00). The app no longer re-mounts a view
 * on the 7-second background fleet poll, so the two dashboards that must reflect
 * live fleet data refresh their own data region in place. Both helpers stop
 * themselves once the view's host leaves the document (a real navigation
 * replaces <main>), so nothing leaks across page switches.
 */

import type { Store } from './store.js';

/**
 * Run `tick` every `ms` while `host` stays mounted; auto-clears on detach.
 * `shouldSkip` (optional) suppresses a tick without stopping the timer — used by
 * views that refresh their data region in place but must NOT churn it while the
 * operator has a modal open or a drag in flight (which would yank the surface
 * out from under them). The timer resumes refreshing on the next idle tick.
 */
export function pollWhileMounted(host: HTMLElement, tick: () => void, ms: number, shouldSkip?: () => boolean): void {
  // idempotent per host: clear any prior interval before starting a new one, so
  // re-mounting into the SAME still-connected host (e.g. swapping a tabbed panel
  // in and out) never stacks duplicate timers.
  const prev = host.dataset.pwmPoll;
  if (prev !== undefined) clearInterval(Number(prev));
  const id = window.setInterval(() => {
    if (!host.isConnected) {
      clearInterval(id);
      delete host.dataset.pwmPoll;
      return;
    }
    if (shouldSkip?.()) return;
    tick();
  }, ms);
  host.dataset.pwmPoll = String(id);
}

/** True while any modal overlay is open (every modal renders a .modal-backdrop). */
export function modalOpen(): boolean {
  return document.querySelector('.modal-backdrop') !== null;
}

/** Re-run `paint` on every store change while `host` is mounted; auto-unsubscribes on detach. */
export function repaintOnStore<T extends object>(host: HTMLElement, store: Store<T>, paint: () => void): void {
  let unsub: () => void = () => {};
  unsub = store.subscribe(() => {
    if (!host.isConnected) {
      unsub();
      return;
    }
    paint();
  });
}
