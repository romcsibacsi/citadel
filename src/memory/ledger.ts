// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { type Clock, systemClock, isoNow } from '../core/clock.js';

/**
 * Conversation ledger (SPEC §8 continuity invariant): a durable per-(agent,
 * chat) transcript of channel turns. Inbound capture is idempotent via the
 * unique index on (agent_id, chat_id, direction, message_id); outbound rows
 * carry a NULL message_id so they never dedupe against each other. The replay
 * (recent transcript + the open question) is injected on session start so an
 * agent keeps continuity across restarts.
 *
 * NOTE for callers: ledger bodies are channel/user text. When the replay is
 * injected into an agent it MUST be wrapped by the trust framing layer
 * (SPEC §6/§8) — this module returns raw transcript data only.
 */

export type LedgerDirection = 'in' | 'out';

export interface LedgerRow {
  id: number;
  agentId: string;
  chatId: string;
  direction: LedgerDirection;
  messageId: string | null;
  body: string;
  source: string;
  createdAt: string;
}

const DEFAULT_RECENT_LIMIT = 20;

interface DbLedgerRow {
  id: number;
  agent_id: string;
  chat_id: string;
  direction: string;
  message_id: string | null;
  body: string;
  source: string;
  created_at: string;
}

function mapRow(r: DbLedgerRow): LedgerRow {
  return {
    id: r.id,
    agentId: r.agent_id,
    chatId: r.chat_id,
    direction: r.direction as LedgerDirection,
    messageId: r.message_id,
    body: r.body,
    source: r.source,
    createdAt: r.created_at,
  };
}

/** SQLITE_CONSTRAINT_UNIQUE (2067) / SQLITE_CONSTRAINT_PRIMARYKEY (1555). */
function isUniqueViolation(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const errcode = (err as { errcode?: number }).errcode;
  return errcode === 2067 || errcode === 1555 || /UNIQUE constraint failed/i.test(err.message);
}

export class ConversationLedger {
  private readonly insertStmt: StatementSync;
  private readonly recentStmt: StatementSync;
  private readonly openQuestionStmt: StatementSync;

  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: Clock = systemClock,
  ) {
    this.insertStmt = db.prepare(
      `INSERT INTO conversation_ledger (agent_id, chat_id, direction, message_id, body, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.recentStmt = db.prepare(
      `SELECT * FROM conversation_ledger WHERE agent_id = ? AND chat_id = ?
       ORDER BY id DESC LIMIT ?`,
    );
    // Latest inbound row strictly newer than the latest outbound row = the open question.
    this.openQuestionStmt = db.prepare(
      `SELECT * FROM conversation_ledger
       WHERE agent_id = ? AND chat_id = ? AND direction = 'in'
         AND id > COALESCE((SELECT MAX(id) FROM conversation_ledger
                            WHERE agent_id = ? AND chat_id = ? AND direction = 'out'), 0)
       ORDER BY id DESC LIMIT 1`,
    );
  }

  /**
   * Record an inbound channel turn. Idempotent: re-delivering the same
   * (agent, chat, message_id) is absorbed by the unique index and reported as
   * {inserted: false} — never an error, never a duplicate row.
   */
  recordInbound(
    agentId: string,
    chatId: string,
    messageId: string,
    body: string,
    source = '',
  ): { inserted: boolean } {
    try {
      this.insertStmt.run(agentId, chatId, 'in', messageId, body, source, isoNow(this.clock));
      return { inserted: true };
    } catch (err) {
      if (isUniqueViolation(err)) return { inserted: false };
      throw err;
    }
  }

  /**
   * Record an outbound turn. message_id is always NULL so identical outbound
   * bodies never dedupe against each other. Returns the new row id.
   */
  recordOutbound(agentId: string, chatId: string, body: string, source = ''): number {
    const result = this.insertStmt.run(agentId, chatId, 'out', null, body, source, isoNow(this.clock));
    return Number(result.lastInsertRowid);
  }

  /** The most recent `limit` turns, returned oldest-first. */
  recent(agentId: string, chatId: string, limit = DEFAULT_RECENT_LIMIT): LedgerRow[] {
    const rows = this.recentStmt.all(agentId, chatId, limit) as unknown as DbLedgerRow[];
    return rows.map(mapRow).reverse();
  }

  /** The latest inbound turn with NO later outbound turn, or undefined. */
  openQuestion(agentId: string, chatId: string): LedgerRow | undefined {
    const row = this.openQuestionStmt.get(agentId, chatId, agentId, chatId) as unknown as
      | DbLedgerRow
      | undefined;
    return row === undefined ? undefined : mapRow(row);
  }

  /**
   * Session-start replay text: the recent transcript (oldest-first) with the
   * open question marked inline ('>>') and restated at the end (it is
   * restated even when it scrolled out of the recent window). Returns '' when
   * the (agent, chat) pair has no history — callers skip injection then.
   * Deterministic English protocol text addressed to the agent, not the
   * operator (same convention as the trust-frame preambles).
   */
  buildReplay(agentId: string, chatId: string, limit = DEFAULT_RECENT_LIMIT): string {
    const rows = this.recent(agentId, chatId, limit);
    if (rows.length === 0) return '';
    const open = this.openQuestion(agentId, chatId);
    const lines = rows.map((r) => {
      const marker = open !== undefined && r.id === open.id ? '>> ' : '';
      return `${marker}[${r.createdAt}] ${r.direction === 'in' ? 'IN' : 'OUT'}: ${r.body}`;
    });
    const parts = [
      `Conversation replay for chat ${chatId} (last ${rows.length} turns, oldest first):`,
      ...lines,
    ];
    if (open !== undefined) {
      parts.push(`Open question (latest inbound with no reply yet): ${open.body}`);
    }
    return parts.join('\n');
  }
}
