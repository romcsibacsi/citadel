// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { type Clock, systemClock, isoNow } from '../core/clock.js';

/**
 * Generic operator settings kv (PROMPT-16+). Non-secret values only — anything
 * sensitive lives encrypted in the vault, never here.
 */
export class SettingsStore {
  private readonly getStmt: StatementSync;
  private readonly setStmt: StatementSync;
  private readonly delStmt: StatementSync;
  private readonly allStmt: StatementSync;

  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: Clock = systemClock,
  ) {
    this.getStmt = db.prepare('SELECT v FROM app_settings WHERE k = ?');
    this.setStmt = db.prepare('INSERT OR REPLACE INTO app_settings (k, v, updated_at) VALUES (?, ?, ?)');
    this.delStmt = db.prepare('DELETE FROM app_settings WHERE k = ?');
    this.allStmt = db.prepare('SELECT k, v FROM app_settings');
  }

  get(key: string): string | undefined {
    return (this.getStmt.get(key) as { v: string } | undefined)?.v;
  }
  set(key: string, value: string): void {
    this.setStmt.run(key, value, isoNow(this.clock));
  }
  delete(key: string): void {
    this.delStmt.run(key);
  }
  all(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const r of this.allStmt.all() as Array<{ k: string; v: string }>) out[r.k] = r.v;
    return out;
  }
}
