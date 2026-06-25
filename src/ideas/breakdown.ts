// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { guessLane } from '../kanban/laneRouter.js';
import type { LaneConfig } from '../config/types.js';
import type { CardPriority } from '../kanban/store.js';

/**
 * Deterministic idea -> subtask draft (PROMPT-11 §6). The idea's description is
 * split into bullet/numbered/newline items, markers stripped, deduped (case-
 * insensitive), and capped; each item is routed to an agent by the pure lane
 * router. With fewer than two splittable items the whole idea becomes a single
 * subtask seeded from its title. No DB writes — this is a proposal the operator
 * reviews in the breakdown modal before anything is created.
 */

export interface DraftSubtask {
  title: string;
  /** Suggested assignee (an agent id from the lane router, or '' for none). */
  assignee: string;
  priority: CardPriority;
}

/** Leading list markers: -, *, •, –, —, or "1." / "1)". */
const LIST_MARKER = /^\s*(?:[-*•–—]|\d+[.)])\s+/;
const MAX_SUBTASKS = 12;

export function draftSubtasks(
  idea: { title: string; description: string | null },
  lanes: LaneConfig[],
): DraftSubtask[] {
  const seen = new Set<string>();
  const items: string[] = [];
  for (const rawLine of (idea.description ?? '').split(/\r?\n/)) {
    const line = rawLine.replace(LIST_MARKER, '').trim();
    if (line === '') continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(line);
    if (items.length >= MAX_SUBTASKS) break;
  }
  const titles = items.length < 2 ? [idea.title] : items;
  return titles.map((title) => ({
    title,
    assignee: guessLane(title, lanes) ?? '',
    priority: 'normal' as CardPriority,
  }));
}
