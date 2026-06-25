// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { type Clock, systemClock } from '../core/clock.js';

/**
 * Token-usage accounting store (PROMPT-14). This is USAGE accounting against the
 * subscription's rate-limit windows — never money. Rows are de-duplicated by
 * (agent, session, ts, input, output). Also hosts the tool-call log used to
 * surface workflow candidates (dense same-session tool bursts).
 */

export interface UsageRecord {
  agentId: string;
  sessionId?: string;
  ts: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheRead?: number;
  cacheCreation?: number;
  contentPreview?: string | null;
  toolName?: string | null;
  taskTitle?: string | null;
  project?: string | null;
}

export interface AgentSummary {
  agent: string;
  totalInput: number;
  totalOutput: number;
  totalCacheRead: number;
  totalCacheCreation: number;
  totalCalls: number;
}

export interface TimelinePoint {
  bucket: number; // epoch seconds
  agent: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface CallRow {
  timestamp: string;
  agent: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  content_preview: string | null;
  tool_name: string | null;
  task_title: string | null;
}

export interface ToolLogEntry {
  sessionId: string;
  toolName: string;
  inputSummary: string | null;
  success: boolean;
  ts: string;
}

export interface WorkflowCandidate {
  session: string;
  count: number;
  durationMin: number;
  start: string;
  end: string;
  tools: string[];
  steps: Array<{ tool: string; input: string }>;
}

export class TokenUsageStore {
  private readonly insertStmt: StatementSync;
  private readonly toolInsertStmt: StatementSync;

  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: Clock = systemClock,
  ) {
    this.insertStmt = db.prepare(
      `INSERT OR IGNORE INTO token_usage
        (agent_id, session_id, ts, input_tokens, output_tokens, cache_read, cache_creation, content_preview, tool_name, task_title, project)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.toolInsertStmt = db.prepare(
      `INSERT INTO tool_log (session_id, tool_name, input_summary, success, ts) VALUES (?, ?, ?, ?, ?)`,
    );
  }

  /** Insert a usage record (de-duplicated). Returns true if a row was added. */
  insert(r: UsageRecord): boolean {
    const res = this.insertStmt.run(
      r.agentId,
      r.sessionId ?? '',
      r.ts,
      r.inputTokens ?? 0,
      r.outputTokens ?? 0,
      r.cacheRead ?? 0,
      r.cacheCreation ?? 0,
      r.contentPreview ?? null,
      r.toolName ?? null,
      r.taskTitle ?? null,
      r.project ?? null,
    );
    return Number(res.changes) > 0;
  }

  summary(from: string, to: string): AgentSummary[] {
    const rows = this.db.prepare(
      `SELECT agent_id AS agent,
              SUM(input_tokens) AS totalInput, SUM(output_tokens) AS totalOutput,
              SUM(cache_read) AS totalCacheRead, SUM(cache_creation) AS totalCacheCreation,
              COUNT(*) AS totalCalls
       FROM token_usage WHERE ts >= ? AND ts <= ? GROUP BY agent_id`,
    ).all(from, to) as Array<Record<string, number | string>>;
    return rows.map((r) => ({
      agent: String(r.agent),
      totalInput: Number(r.totalInput ?? 0),
      totalOutput: Number(r.totalOutput ?? 0),
      totalCacheRead: Number(r.totalCacheRead ?? 0),
      totalCacheCreation: Number(r.totalCacheCreation ?? 0),
      totalCalls: Number(r.totalCalls ?? 0),
    }));
  }

  /** Bucketed per-agent usage. bucketMinutes drives granularity. */
  timeline(from: string, to: string, bucketMinutes: number, agent?: string): TimelinePoint[] {
    const bucketSecs = Math.max(1, Math.floor(bucketMinutes * 60));
    const params: Array<string | number> = [bucketSecs, bucketSecs, from, to];
    let sql =
      `SELECT (CAST(strftime('%s', ts) AS INTEGER) / ?) * ? AS bucket, agent_id AS agent,
              COUNT(*) AS calls, SUM(input_tokens + cache_read + cache_creation) AS inputTokens, SUM(output_tokens) AS outputTokens
       FROM token_usage WHERE ts >= ? AND ts <= ?`;
    if (agent !== undefined && agent !== '') { sql += ' AND agent_id = ?'; params.push(agent); }
    sql += ' GROUP BY bucket, agent ORDER BY bucket ASC';
    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, number | string>>;
    return rows.map((r) => ({ bucket: Number(r.bucket), agent: String(r.agent), calls: Number(r.calls), inputTokens: Number(r.inputTokens ?? 0), outputTokens: Number(r.outputTokens ?? 0) }));
  }

  details(from: string, to: string, opts: { agent?: string; minTokens?: number; q?: string; limit?: number }): CallRow[] {
    const params: Array<string | number> = [from, to];
    let sql =
      `SELECT ts AS timestamp, agent_id AS agent, input_tokens, output_tokens, cache_read AS cache_read_tokens,
              cache_creation AS cache_creation_tokens, content_preview, tool_name, task_title
       FROM token_usage WHERE ts >= ? AND ts <= ?`;
    if (opts.agent !== undefined && opts.agent !== '') { sql += ' AND agent_id = ?'; params.push(opts.agent); }
    if (opts.q !== undefined && opts.q.trim() !== '') {
      sql += ' AND (agent_id LIKE ? OR tool_name LIKE ? OR content_preview LIKE ? OR task_title LIKE ?)';
      const like = `%${opts.q.trim()}%`;
      params.push(like, like, like, like);
    } else if (opts.minTokens !== undefined && opts.minTokens > 0) {
      sql += ' AND (input_tokens + cache_read + cache_creation) >= ?';
      params.push(opts.minTokens);
    }
    sql += ' ORDER BY (input_tokens + cache_read + cache_creation) DESC LIMIT ?';
    params.push(Math.min(opts.limit ?? 200, 500));
    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      timestamp: String(r.timestamp),
      agent: String(r.agent),
      input_tokens: Number(r.input_tokens),
      output_tokens: Number(r.output_tokens),
      cache_read_tokens: Number(r.cache_read_tokens),
      cache_creation_tokens: Number(r.cache_creation_tokens),
      content_preview: r.content_preview === null ? null : String(r.content_preview),
      tool_name: r.tool_name === null ? null : String(r.tool_name),
      task_title: r.task_title === null ? null : String(r.task_title),
    }));
  }

  // --- tool-call log ---
  logTool(e: { sessionId: string; toolName: string; inputSummary?: string | null; success?: boolean; ts?: string }): void {
    this.toolInsertStmt.run(e.sessionId, e.toolName, e.inputSummary ?? null, e.success === false ? 0 : 1, e.ts ?? this.clock.now().toISOString());
  }

  recentTools(sinceSecs: number): ToolLogEntry[] {
    const cutoff = new Date(this.clock.now().getTime() - sinceSecs * 1000).toISOString();
    const rows = this.db.prepare(
      'SELECT session_id, tool_name, input_summary, success, ts FROM tool_log WHERE ts >= ? ORDER BY ts ASC',
    ).all(cutoff) as Array<Record<string, unknown>>;
    return rows.map((r) => ({ sessionId: String(r.session_id), toolName: String(r.tool_name), inputSummary: r.input_summary === null ? null : String(r.input_summary), success: Number(r.success) === 1, ts: String(r.ts) }));
  }

  /** Summarize dense same-session tool bursts into workflow candidates. */
  analyze(sinceSecs: number, minCalls: number): WorkflowCandidate[] {
    const entries = this.recentTools(sinceSecs);
    const bySession = new Map<string, ToolLogEntry[]>();
    for (const e of entries) (bySession.get(e.sessionId) ?? bySession.set(e.sessionId, []).get(e.sessionId)!).push(e);
    const out: WorkflowCandidate[] = [];
    for (const [session, list] of bySession) {
      if (list.length < minCalls) continue;
      const start = list[0]!.ts, end = list[list.length - 1]!.ts;
      out.push({
        session,
        count: list.length,
        durationMin: Math.round((Date.parse(end) - Date.parse(start)) / 60000),
        start,
        end,
        tools: [...new Set(list.map((e) => e.toolName))],
        steps: list.slice(0, 10).map((e) => ({ tool: e.toolName, input: e.inputSummary ?? '' })),
      });
    }
    return out.sort((a, b) => b.count - a.count);
  }

  prune(olderThanSecs: number): number {
    const cutoff = new Date(this.clock.now().getTime() - olderThanSecs * 1000).toISOString();
    return Number(this.db.prepare('DELETE FROM tool_log WHERE ts < ?').run(cutoff).changes);
  }
}
