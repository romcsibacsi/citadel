// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { createExclusive, ensureDir } from '../core/fsx.js';
import { createLogger } from '../core/log.js';

const log = createLogger('db');

export interface Migration {
  id: string;
  up: (db: DatabaseSync) => void;
}

/**
 * Open (creating if needed) the embedded SQLite database.
 * SPEC §18: pre-create with O_EXCL 0600 to close the fresh-install TOCTOU
 * window; WAL mode; busy timeout for any future second reader.
 */
export function openDatabase(filePath: string): DatabaseSync {
  if (filePath !== ':memory:' && !existsSync(filePath)) {
    ensureDir(dirname(filePath), 0o700);
    createExclusive(filePath, '', 0o600);
  }
  const db = new DatabaseSync(filePath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA synchronous = NORMAL');
  return db;
}

/**
 * Apply migrations in order, additively and idempotently (SPEC §18):
 * re-running against an existing DB is a no-op for already-applied ids.
 * Returns the ids applied in this run.
 */
export function migrate(db: DatabaseSync, migrations: Migration[]): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);
  const appliedRows = db.prepare('SELECT id FROM schema_migrations').all() as Array<{ id: string }>;
  const applied = new Set(appliedRows.map((r) => r.id));
  const ran: string[] = [];
  for (const m of migrations) {
    if (applied.has(m.id)) continue;
    db.exec('BEGIN');
    try {
      m.up(db);
      db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(m.id, new Date().toISOString());
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`migration ${m.id} failed: ${String(err)}`);
    }
    log.info(`applied migration ${m.id}`);
    ran.push(m.id);
  }
  return ran;
}
