// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/** Injectable time source so schedulers/decay logic are deterministic under test. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** Current time as an ISO-8601 UTC string — the canonical timestamp format in the DB. */
export function isoNow(clock: Clock = systemClock): string {
  return clock.now().toISOString();
}

/** A manually-advanced clock for tests. */
export class FixedClock implements Clock {
  private current: Date;

  constructor(start: Date | string) {
    this.current = typeof start === 'string' ? new Date(start) : new Date(start.getTime());
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  set(to: Date | string): void {
    this.current = typeof to === 'string' ? new Date(to) : new Date(to.getTime());
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}
