// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * Orphan reaping by PANE ATTRIBUTION (SPEC §19a).
 *
 * Before spawning, a stale/orphaned agent or poller process must be reaped — but
 * ONLY when it is provably an orphan: a process is an orphan iff neither it nor
 * any of its ancestors is a live multiplexer-pane pid. Attribution is by the
 * process tree, NOT by argv matching (argv matching reaps the wrong process).
 *
 * FAIL SAFE (load-bearing, §19a): if the set of live panes cannot be determined,
 * REFUSE to reap. A wrongly-reaped live poller (or a surviving stale one) hammers
 * the bot token, causes provider 409 conflicts, and is misread as "down".
 *
 * This module is PURE: it takes the pane-pid set and a parent-of(pid) lookup and
 * returns a decision. The caller wires the real tmux listPanes + /proc reads.
 */

export interface ReapInput {
  /** Candidate process to evaluate. */
  pid: number;
  /** Live multiplexer pane pids, or undefined if they could NOT be determined. */
  livePanePids: Set<number> | undefined;
  /** parent(pid) -> ppid, or undefined when unknown (process gone / unreadable). */
  parentOf: (pid: number) => number | undefined;
  /** Guard against runaway ancestor walks / cycles. */
  maxDepth?: number;
}

export type ReapDecision =
  | { reap: false; reason: 'panes-undeterminable' | 'attributed-to-live-pane' | 'invalid-pid' }
  | { reap: true; reason: 'orphan' };

const DEFAULT_MAX_DEPTH = 64;

/**
 * Decide whether `pid` is an orphan that may be reaped. The candidate is
 * attributed to a live pane if it or any ancestor is a live-pane pid.
 */
export function decideReap(input: ReapInput): ReapDecision {
  // FAIL SAFE: cannot determine the live panes -> never reap.
  if (input.livePanePids === undefined) {
    return { reap: false, reason: 'panes-undeterminable' };
  }
  if (!Number.isInteger(input.pid) || input.pid <= 1) {
    return { reap: false, reason: 'invalid-pid' }; // never touch pid<=1 (PID-recycling guard)
  }
  const maxDepth = input.maxDepth ?? DEFAULT_MAX_DEPTH;
  const seen = new Set<number>();
  let cursor: number | undefined = input.pid;
  for (let depth = 0; depth < maxDepth && cursor !== undefined && cursor > 1; depth++) {
    if (seen.has(cursor)) break; // cycle guard
    seen.add(cursor);
    if (input.livePanePids.has(cursor)) {
      return { reap: false, reason: 'attributed-to-live-pane' };
    }
    cursor = input.parentOf(cursor);
  }
  return { reap: true, reason: 'orphan' };
}
