// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { type Clock, systemClock, isoNow } from '../core/clock.js';
import { atomicWriteFile } from '../core/fsx.js';
import { createLogger } from '../core/log.js';
import { localFields, parseCron } from './cron.js';

const log = createLogger('learning');

/**
 * Learning-loop MACHINERY (SPEC §9). The specific tasks (heartbeat, nightly
 * dream, morning brief, ...) are seed CONTENT supplied by the caller; this
 * module only provides:
 *  - ensureSeedTasks: insert-if-absent seeding that NEVER overwrites a row an
 *    operator may have edited (prompt, schedule, enabled flag, ...).
 *  - the nightly-dream file contract: one atomically OVERWRITTEN file per
 *    night — no history accumulates on disk.
 *  - isWeeklySection: because the dream file is overwritten nightly, weekly
 *    cadence MUST be weekday-gated (Monday in the install timezone), never
 *    gated on file history.
 */

export interface SeedTask {
  id: string;
  title: string;
  prompt: string;
  cron: string;
  /** Agent id or 'all'. */
  target: string;
  type: 'task' | 'heartbeat';
  skipIfBusy?: boolean;
  forceSend?: boolean;
  bypassTriage?: boolean;
}

/**
 * Whether an agent is in the fan-out for GENERAL (target:'all') scheduled tasks —
 * the consolidation heartbeat and any future fleet-wide template. Excludes:
 *  - hidden/internal workers (SPEC §4), and
 *  - LOCAL-MODEL agents (runtime:'ollama') — the muse-brain model hallucinates into
 *    a busy-loop on general reasoning, so MUSE/REEL must run ONLY on explicit media
 *    dispatch (#83). Brand-neutral: keys off the runtime, never a hard-coded id, so
 *    any future local-model agent is auto-excluded. An explicit per-agent target
 *    (e.g. a dispatched media job) bypasses this — it is not a 'all' fan-out.
 */
export function eligibleForGeneralSchedule(agent: { hidden?: boolean; runtime?: string }): boolean {
  return agent.hidden !== true && agent.runtime !== 'ollama';
}

/**
 * Insert any seed tasks that do not exist yet; rows whose id already exists
 * are left completely untouched (operator edits survive every restart and
 * upgrade). Seed cron expressions are validated up front — a broken seed is a
 * build defect and fails fast. Returns the ids actually inserted.
 */
export function ensureSeedTasks(db: DatabaseSync, seeds: SeedTask[], clock: Clock = systemClock): string[] {
  for (const seed of seeds) parseCron(seed.cron); // fail fast before touching the DB
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO scheduled_tasks
       (id, title, prompt, cron, target, type, enabled, skip_if_busy, force_send, bypass_triage, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
  );
  const inserted: string[] = [];
  for (const seed of seeds) {
    const now = isoNow(clock);
    const res = stmt.run(
      seed.id,
      seed.title,
      seed.prompt,
      seed.cron,
      seed.target,
      seed.type,
      seed.skipIfBusy === true ? 1 : 0,
      seed.forceSend === true ? 1 : 0,
      seed.bypassTriage === true ? 1 : 0,
      now,
      now,
    );
    if (Number(res.changes) > 0) inserted.push(seed.id);
  }
  if (inserted.length > 0) log.info('seeded scheduled tasks', { ids: inserted });
  return inserted;
}

/** Canonical location of the nightly dream file under the state dir. */
export function nightlyDreamPath(stateDir: string): string {
  return join(stateDir, 'learning', 'nightly-dream.md');
}

/**
 * Write the nightly consolidation output. Always the SAME file, atomically
 * replaced — yesterday's content is gone by design (SPEC §9). Returns the path.
 */
export function writeNightlyDream(stateDir: string, content: string): string {
  const path = nightlyDreamPath(stateDir);
  atomicWriteFile(path, content);
  return path;
}

/**
 * Weekly-cadence gate for the dream's external-opportunity section: true on
 * Mondays in the given IANA timezone. Weekday-gated, NOT file-history-gated —
 * the dream file is overwritten nightly, so "did last week's file have the
 * section" is unanswerable by design.
 */
export function isWeeklySection(date: Date, timeZone: string): boolean {
  return localFields(date, timeZone).dayOfWeek === 1; // Monday
}
