// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/** Minimal observable store: set/patch triggers subscribers (full re-render model). */

export type Unsubscribe = () => void;

export class Store<T extends object> {
  private listeners = new Set<(state: T) => void>();

  constructor(private state: T) {}

  get(): T {
    return this.state;
  }

  patch(partial: Partial<T>): void {
    this.state = { ...this.state, ...partial };
    for (const fn of this.listeners) fn(this.state);
  }

  subscribe(fn: (state: T) => void): Unsubscribe {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
