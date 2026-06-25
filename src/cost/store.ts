// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import type { DatabaseSync, StatementSync } from 'node:sqlite';

/**
 * Cost / usage dashboard store (FIX-plugin-cost-dashboard). Holds the rolled-up
 * per-(agent, model, day) token totals so the dashboard renders fast and history
 * survives restarts.
 *
 *  - The table is created idempotently via a migration-style {@link ensureTable}
 *    (CREATE TABLE IF NOT EXISTS) so this plugin owns its own schema and never has
 *    to edit the shared core migrations.
 *  - A row is the *current* aggregate for one (agent, model, day): the rollup
 *    UPSERTs the freshly-recomputed totals, so re-running the rollup over the same
 *    session history is idempotent (no double counting).
 *
 * This store records TOKENS ONLY — never money. Any dollar figure is derived in
 * the view from an operator-editable price table and is always labelled an
 * estimate; in subscription billing mode no dollar figure is shown at all. The
 * store has no knowledge of billing mode and never reads or writes it.
 */

/** One rolled-up usage row: tokens for a single agent+model on a single UTC day. */
export interface UsageRow {
  agent: string;
  model: string;
  /** UTC calendar day, YYYY-MM-DD. */
  day: string;
  inTok: number;
  outTok: number;
  cacheTok: number;
  /** 'exact' when parsed from real per-turn usage; 'estimate' when heuristic. */
  source: 'exact' | 'estimate';
}

/** Aggregate keyed by an arbitrary dimension (agent or model). */
export interface UsageAggregate {
  key: string;
  inTok: number;
  outTok: number;
  cacheTok: number;
}

/** A per-day point across the whole fleet. */
export interface DayPoint {
  day: string;
  inTok: number;
  outTok: number;
  cacheTok: number;
}

/** Grand totals over a window, with whether ANY contributing row was an estimate. */
export interface UsageTotals {
  inTok: number;
  outTok: number;
  cacheTok: number;
  /** True when at least one contributing row was a labelled estimate. */
  hasEstimate: boolean;
}

interface DbUsageRow {
  agent: string;
  model: string;
  day: string;
  in_tok: number;
  out_tok: number;
  cache_tok: number;
  source: string;
}

export class CostStore {
  private readonly upsertStmt: StatementSync;

  constructor(private readonly db: DatabaseSync) {
    CostStore.ensureTable(db);
    // One aggregate row per (agent, model, day); the rollup overwrites the totals
    // it recomputes so a repeated rollup is idempotent rather than additive.
    this.upsertStmt = db.prepare(
      `INSERT INTO usage (agent, model, day, in_tok, out_tok, cache_tok, source)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (agent, model, day) DO UPDATE SET
         in_tok = excluded.in_tok,
         out_tok = excluded.out_tok,
         cache_tok = excluded.cache_tok,
         source = excluded.source`,
    );
  }

  /** Create the usage table + index idempotently (migration-style). Safe to call
   *  repeatedly — IF NOT EXISTS makes it a no-op once present. */
  static ensureTable(db: DatabaseSync): void {
    db.exec(`CREATE TABLE IF NOT EXISTS usage (
      agent     TEXT NOT NULL,
      model     TEXT NOT NULL,
      day       TEXT NOT NULL,
      in_tok    INTEGER NOT NULL DEFAULT 0,
      out_tok   INTEGER NOT NULL DEFAULT 0,
      cache_tok INTEGER NOT NULL DEFAULT 0,
      source    TEXT NOT NULL DEFAULT 'estimate' CHECK (source IN ('exact','estimate')),
      PRIMARY KEY (agent, model, day)
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_usage_day ON usage (day)`);
  }

  /** Upsert one rolled-up row (overwrites the totals for its agent/model/day). */
  upsert(row: UsageRow): void {
    this.upsertStmt.run(
      row.agent,
      row.model,
      row.day,
      Math.max(0, Math.round(row.inTok)),
      Math.max(0, Math.round(row.outTok)),
      Math.max(0, Math.round(row.cacheTok)),
      row.source,
    );
  }

  /** Upsert a batch atomically. */
  upsertAll(rows: UsageRow[]): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const r of rows) this.upsert(r);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** All rows in [from, to] (inclusive UTC days), newest day first. */
  rows(from: string, to: string): UsageRow[] {
    const rows = this.db.prepare(
      `SELECT agent, model, day, in_tok, out_tok, cache_tok, source
       FROM usage WHERE day >= ? AND day <= ? ORDER BY day DESC, agent ASC, model ASC`,
    ).all(from, to) as unknown as DbUsageRow[];
    return rows.map(mapRow);
  }

  /** Grand totals over the window. */
  totals(from: string, to: string): UsageTotals {
    const r = this.db.prepare(
      `SELECT
         COALESCE(SUM(in_tok), 0) AS inTok,
         COALESCE(SUM(out_tok), 0) AS outTok,
         COALESCE(SUM(cache_tok), 0) AS cacheTok,
         SUM(CASE WHEN source = 'estimate' THEN 1 ELSE 0 END) AS estimates
       FROM usage WHERE day >= ? AND day <= ?`,
    ).get(from, to) as Record<string, number> | undefined;
    return {
      inTok: Number(r?.inTok ?? 0),
      outTok: Number(r?.outTok ?? 0),
      cacheTok: Number(r?.cacheTok ?? 0),
      hasEstimate: Number(r?.estimates ?? 0) > 0,
    };
  }

  /** Per-agent aggregate over the window, biggest consumer first. */
  byAgent(from: string, to: string): UsageAggregate[] {
    return this.aggregate('agent', from, to);
  }

  /** Per-model aggregate over the window, biggest consumer first. */
  byModel(from: string, to: string): UsageAggregate[] {
    return this.aggregate('model', from, to);
  }

  private aggregate(column: 'agent' | 'model', from: string, to: string): UsageAggregate[] {
    // column is a fixed literal ('agent' | 'model'), never user input — safe to inline.
    const rows = this.db.prepare(
      `SELECT ${column} AS key,
              COALESCE(SUM(in_tok), 0) AS inTok,
              COALESCE(SUM(out_tok), 0) AS outTok,
              COALESCE(SUM(cache_tok), 0) AS cacheTok
       FROM usage WHERE day >= ? AND day <= ?
       GROUP BY ${column}
       ORDER BY (SUM(in_tok) + SUM(out_tok) + SUM(cache_tok)) DESC`,
    ).all(from, to) as Array<Record<string, number | string>>;
    return rows.map((r) => ({
      key: String(r.key),
      inTok: Number(r.inTok ?? 0),
      outTok: Number(r.outTok ?? 0),
      cacheTok: Number(r.cacheTok ?? 0),
    }));
  }

  /** Per-day fleet series (oldest first) for the time-series chart. */
  daySeries(from: string, to: string): DayPoint[] {
    const rows = this.db.prepare(
      `SELECT day,
              COALESCE(SUM(in_tok), 0) AS inTok,
              COALESCE(SUM(out_tok), 0) AS outTok,
              COALESCE(SUM(cache_tok), 0) AS cacheTok
       FROM usage WHERE day >= ? AND day <= ?
       GROUP BY day ORDER BY day ASC`,
    ).all(from, to) as Array<Record<string, number | string>>;
    return rows.map((r) => ({
      day: String(r.day),
      inTok: Number(r.inTok ?? 0),
      outTok: Number(r.outTok ?? 0),
      cacheTok: Number(r.cacheTok ?? 0),
    }));
  }
}

function mapRow(r: DbUsageRow): UsageRow {
  return {
    agent: r.agent,
    model: r.model,
    day: r.day,
    inTok: Number(r.in_tok),
    outTok: Number(r.out_tok),
    cacheTok: Number(r.cache_tok),
    source: r.source === 'exact' ? 'exact' : 'estimate',
  };
}
