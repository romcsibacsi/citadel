// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { type Clock, systemClock, isoNow } from '../core/clock.js';
import { createLogger } from '../core/log.js';
import type { AutonomyCategorySeed } from '../config/types.js';

const log = createLogger('autonomy');

/**
 * Autonomy ladder (SPEC §12): per-category trust level 1/2/3 with a hard
 * maxLevel and a locked flag. Enforcement is SERVER-SIDE, in code:
 *
 *  - HARD_LOCKED_CATEGORIES can never exceed level 1, no matter what a seed
 *    says, what the dashboard sends, or what a tampered DB row claims —
 *    the hard-lock list is a code constant, never config.
 *  - A missing category resolves to level 1: missing config must never
 *    default to fully-autonomous.
 *  - seed() is insert-if-absent: existing operator-set levels are never reset
 *    on re-seed/config upgrade; only newly-introduced categories are added.
 *    (The one exception: a hard-locked category's row is repaired back to
 *    1/1/locked — those rows are never operator-set, since set() refuses them.)
 */

// The five code-enforced, hard-locked categories (FIX-autonomy-categories): they
// can NEVER exceed level 1, regardless of seed/config/DB. The keys MUST match the
// operator's seed ids exactly (underscored) — a mismatch would silently un-lock
// the category, so this constant and the seed share one vocabulary.
export const HARD_LOCKED_CATEGORIES = [
  'publish_content',
  'payment',
  'data_delete',
  'permission_change',
  'external_message',
  'nav_submit',
] as const;

const HARD_LOCKED: ReadonlySet<string> = new Set(HARD_LOCKED_CATEGORIES);

export type AutonomyLevel = 1 | 2 | 3;

export interface AutonomySetting {
  category: string;
  level: AutonomyLevel;
  maxLevel: AutonomyLevel;
  locked: boolean;
}

interface DbAutonomyRow {
  category: string;
  level: number;
  max_level: number;
  locked: number;
}

function assertLevel(level: number): asserts level is AutonomyLevel {
  if (level !== 1 && level !== 2 && level !== 3) {
    throw new Error(`invalid autonomy level: ${level} (must be 1, 2 or 3)`);
  }
}

export class AutonomyLadder {
  private readonly getRowStmt: StatementSync;
  private readonly insertStmt: StatementSync;
  private readonly repairStmt: StatementSync;
  private readonly setLevelStmt: StatementSync;
  private readonly listStmt: StatementSync;
  private readonly lastUpdatedStmt: StatementSync;

  constructor(
    db: DatabaseSync,
    private readonly clock: Clock = systemClock,
  ) {
    this.lastUpdatedStmt = db.prepare('SELECT MAX(updated_at) AS m FROM autonomy_settings');
    this.getRowStmt = db.prepare(
      'SELECT category, level, max_level, locked FROM autonomy_settings WHERE category = ?',
    );
    this.insertStmt = db.prepare(
      `INSERT INTO autonomy_settings (category, level, max_level, locked, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    this.repairStmt = db.prepare(
      `UPDATE autonomy_settings SET level = 1, max_level = 1, locked = 1, updated_at = ?
       WHERE category = ?`,
    );
    this.setLevelStmt = db.prepare(
      'UPDATE autonomy_settings SET level = ?, updated_at = ? WHERE category = ?',
    );
    this.listStmt = db.prepare(
      'SELECT category, level, max_level, locked FROM autonomy_settings ORDER BY category ASC',
    );
  }

  /**
   * Insert-if-absent seeding (config upgrade path). Existing rows are never
   * reset — an operator-chosen level survives every re-seed. Hard-locked
   * categories are FORCED to level 1 / maxLevel 1 / locked, even against a
   * hostile seed; an existing tampered hard-locked row is repaired.
   */
  seed(seeds: AutonomyCategorySeed[]): void {
    const now = isoNow(this.clock);
    for (const s of seeds) {
      const hard = HARD_LOCKED.has(s.category);
      const existing = this.getRowStmt.get(s.category) as DbAutonomyRow | undefined;
      if (existing !== undefined) {
        if (hard && (existing.level !== 1 || existing.max_level !== 1 || existing.locked !== 1)) {
          this.repairStmt.run(now, s.category);
          log.warn('repaired hard-locked autonomy row back to level 1', {
            category: s.category,
          });
        }
        continue; // never reset operator-set rows on re-seed
      }
      let level: AutonomyLevel;
      let maxLevel: AutonomyLevel;
      let locked: boolean;
      if (hard) {
        level = 1;
        maxLevel = 1;
        locked = true;
        if (s.level !== 1 || s.maxLevel !== 1 || !s.locked) {
          log.warn('hostile/incorrect seed for hard-locked category forced to level 1', {
            category: s.category,
          });
        }
      } else {
        assertLevel(s.maxLevel);
        assertLevel(s.level);
        maxLevel = s.maxLevel;
        // A seed can never start above its own ceiling.
        level = s.level > maxLevel ? maxLevel : s.level;
        locked = s.locked;
      }
      this.insertStmt.run(s.category, level, maxLevel, locked ? 1 : 0, now);
    }
  }

  /**
   * Effective setting for a category. A MISSING category resolves to level 1
   * across the board (fail-safe floor, never fully-autonomous). Hard-locked
   * categories always read as 1/1/locked, even from a tampered row.
   */
  get(category: string): AutonomySetting {
    if (HARD_LOCKED.has(category)) {
      return { category, level: 1, maxLevel: 1, locked: true };
    }
    const row = this.getRowStmt.get(category) as DbAutonomyRow | undefined;
    if (row === undefined) {
      return { category, level: 1, maxLevel: 1, locked: false };
    }
    return this.mapRow(row);
  }

  /**
   * Operator escalation path. Throws when the category is locked, when the
   * level exceeds maxLevel, and ALWAYS for level > 1 on a hard-locked
   * category — checked against the code constant before any DB read, so a
   * tampered row cannot open the gate.
   */
  set(category: string, level: number): AutonomySetting {
    assertLevel(level);
    if (HARD_LOCKED.has(category) && level > 1) {
      throw new Error(`category '${category}' is hard-locked at level 1`);
    }
    const row = this.getRowStmt.get(category) as DbAutonomyRow | undefined;
    if (row === undefined) throw new Error(`unknown autonomy category: ${category}`);
    if (row.locked === 1 || HARD_LOCKED.has(category)) {
      throw new Error(`autonomy category '${category}' is locked`);
    }
    if (level > row.max_level) {
      throw new Error(
        `level ${level} exceeds maxLevel ${row.max_level} for category '${category}'`,
      );
    }
    this.setLevelStmt.run(level, isoNow(this.clock), category);
    return this.get(category);
  }

  /** True when the category's effective level reaches the required level. */
  isAllowed(category: string, requiredLevel: number): boolean {
    return this.get(category).level >= requiredLevel;
  }

  /** All stored settings, hard-lock clamping applied. */
  list(): AutonomySetting[] {
    return (this.listStmt.all() as unknown as DbAutonomyRow[]).map((r) => this.mapRow(r));
  }

  /** Most recent write across all rows, as epoch seconds (0 when empty). */
  lastUpdatedEpoch(): number {
    const row = this.lastUpdatedStmt.get() as { m: string | null };
    if (row.m === null) return 0;
    const ms = Date.parse(row.m);
    return Number.isNaN(ms) ? 0 : Math.floor(ms / 1000);
  }

  private mapRow(row: DbAutonomyRow): AutonomySetting {
    if (HARD_LOCKED.has(row.category)) {
      return { category: row.category, level: 1, maxLevel: 1, locked: true };
    }
    // Clamp a tampered level back under its ceiling on read.
    const maxLevel = row.max_level as AutonomyLevel;
    const level = (row.level > maxLevel ? maxLevel : row.level) as AutonomyLevel;
    return { category: row.category, level, maxLevel, locked: row.locked === 1 };
  }
}
