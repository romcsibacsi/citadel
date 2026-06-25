// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import type { Clock } from '../core/clock.js';
import { systemClock } from '../core/clock.js';
import type { TokenUsageStore } from './store.js';

/**
 * Usage collector (PROMPT-14 §6c). The real collector scans local agent
 * transcript files for assistant-message usage and inserts de-duplicated rows
 * with a per-file cursor. Real transcript ingestion is a seam in this build;
 * collect() seeds a deterministic synthetic usage history for the roster so the
 * Token Monitor is demonstrable. It is anchored to the current hour so a second
 * collect in the same hour inserts nothing (insert-only + de-dup, idempotent).
 */

const HOUR = 3600_000;
const STEP_HOURS = 6;
const POINTS = 32;
const TOOLS = ['Read', 'Edit', 'Bash', 'Write', 'Grep'];

export function collectSynthetic(store: TokenUsageStore, agentIds: string[], clock: Clock = systemClock): number {
  const base = Math.floor(clock.now().getTime() / HOUR) * HOUR;
  let inserted = 0;
  agentIds.forEach((agentId, ai) => {
    for (let k = 0; k < POINTS; k += 1) {
      const ts = new Date(base - k * STEP_HOURS * HOUR - ai * 11 * 60_000).toISOString();
      const inputTokens = 2000 + (((ai * 7 + k * 13) % 50) * 1500);
      const cacheRead = (k % 5) * 5000;
      const cacheCreation = (ai % 3) * 3000 + ((k % 7) * 800);
      const outputTokens = 300 + (k % 10) * 220;
      const added = store.insert({
        agentId,
        sessionId: `sess-${agentId}-${Math.floor(k / 4)}`,
        ts,
        inputTokens,
        outputTokens,
        cacheRead,
        cacheCreation,
        contentPreview: `${TOOLS[k % TOOLS.length]} call by ${agentId} (step ${k})`,
        toolName: TOOLS[k % TOOLS.length]!,
        taskTitle: k % 6 === 0 ? `task #${ai}${k}` : null,
        project: 'workspace',
      });
      if (added) inserted += 1;
    }
  });
  return inserted;
}
