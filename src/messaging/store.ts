// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { type Clock, systemClock, isoNow } from '../core/clock.js';
import { sanitizeId } from '../trust/sanitize.js';
import type { ChannelMeta } from '../trust/frame.js';

/**
 * Durable message queue store (SPEC §6). Persistence + read models only — the
 * routing decision lives in ./route.ts and timing/retries in ./delivery.ts.
 *
 * Status lifecycle: pending -> delivered -> done | failed. The consume path
 * (generator loop-breaker) and immediate rejections jump pending -> done/failed
 * directly; terminal states are never overwritten.
 *
 * The caller (public write endpoint / operator endpoint) has ALREADY validated
 * and stamped the sender — this store does not re-guard reserved ids, but it
 * DOES canonicalize both ids with THE sanitizer so storage, routing and the
 * read models all agree on one spelling.
 */

export type MessageStatus = 'pending' | 'delivered' | 'done' | 'failed';

export interface MessageRow {
  id: number;
  sender: string;
  recipient: string;
  body: string;
  status: MessageStatus;
  result: string | null;
  error: string | null;
  /** Parsed channel_meta JSON; null when absent or not a valid envelope. */
  channelMeta: ChannelMeta | null;
  createdAt: string;
  deliveredAt: string | null;
  completedAt: string | null;
}

export interface EnqueueInput {
  sender: string;
  recipient: string;
  body: string;
  channelMeta?: ChannelMeta;
}

export interface ThreadSummary {
  /** The other party of the thread (canonical id). */
  peer: string;
  lastBody: string;
  lastAt: string;
  lastId: number;
  /** All messages in the thread, both directions, any status. */
  total: number;
  /** Messages from this peer still pending delivery to the agent. */
  pendingIn: number;
}

export interface ConversationOptions {
  /** Exclusive upper bound: return messages with id < beforeId. */
  beforeId?: number;
  limit?: number;
}

export interface ConversationPage {
  /** Page rows in ascending id order (chronological within the page). */
  messages: MessageRow[];
  /** Cursor for the next (older) page; undefined when this page was short. */
  nextBeforeId?: number;
}

/**
 * One conversation between TWO peers (a↔b), for the system-wide / inter-agent view.
 * The pair is canonical (a < b) so a↔b and b↔a collapse to one thread.
 */
export interface PairThreadSummary {
  a: string;
  b: string;
  lastBody: string;
  lastAt: string;
  lastId: number;
  total: number;
}

const DEFAULT_PENDING_LIMIT = 500;
const DEFAULT_CONVERSATION_LIMIT = 50;
const DEFAULT_RECENT_LIMIT = 50;

const ROW_COLUMNS =
  'id, sender, recipient, body, status, result, error, channel_meta, created_at, delivered_at, completed_at';

interface DbMessageRow {
  id: number;
  sender: string;
  recipient: string;
  body: string;
  status: string;
  result: string | null;
  error: string | null;
  channel_meta: string | null;
  created_at: string;
  delivered_at: string | null;
  completed_at: string | null;
}

/**
 * Parse stored channel_meta defensively: only a shape frameDelivery can render
 * (string source + chatId) survives; anything else becomes null rather than a
 * crash at delivery time.
 */
function parseChannelMeta(raw: string | null): ChannelMeta | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o.source !== 'string' || typeof o.chatId !== 'string') return null;
  const meta: ChannelMeta = { source: o.source, chatId: o.chatId };
  if (typeof o.messageId === 'string') meta.messageId = o.messageId;
  if (typeof o.user === 'string') meta.user = o.user;
  if (typeof o.ts === 'string') meta.ts = o.ts;
  return meta;
}

function mapRow(r: DbMessageRow): MessageRow {
  return {
    id: r.id,
    sender: r.sender,
    recipient: r.recipient,
    body: r.body,
    status: r.status as MessageStatus,
    result: r.result,
    error: r.error,
    channelMeta: parseChannelMeta(r.channel_meta),
    createdAt: r.created_at,
    deliveredAt: r.delivered_at,
    completedAt: r.completed_at,
  };
}

export class MessageStore {
  private readonly insertStmt: StatementSync;
  private readonly getStmt: StatementSync;
  private readonly pendingStmt: StatementSync;
  private readonly pendingForStmt: StatementSync;
  private readonly markDeliveredStmt: StatementSync;
  private readonly markDoneStmt: StatementSync;
  private readonly markFailedStmt: StatementSync;
  private readonly threadsStmt: StatementSync;
  private readonly allThreadsStmt: StatementSync;
  private readonly conversationStmt: StatementSync;
  private readonly recentStmt: StatementSync;

  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: Clock = systemClock,
  ) {
    this.insertStmt = db.prepare(
      `INSERT INTO messages (sender, recipient, body, channel_meta, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    this.getStmt = db.prepare(`SELECT ${ROW_COLUMNS} FROM messages WHERE id = ?`);
    this.pendingStmt = db.prepare(
      `SELECT ${ROW_COLUMNS} FROM messages WHERE status = 'pending' ORDER BY id ASC LIMIT ?`,
    );
    this.pendingForStmt = db.prepare(
      `SELECT ${ROW_COLUMNS} FROM messages WHERE status = 'pending' AND recipient = ? ORDER BY id ASC`,
    );
    // Transitions only move forward; a terminal row is never overwritten.
    this.markDeliveredStmt = db.prepare(
      `UPDATE messages SET status = 'delivered', delivered_at = ? WHERE id = ? AND status = 'pending'`,
    );
    this.markDoneStmt = db.prepare(
      `UPDATE messages SET status = 'done', result = ?, completed_at = ?
       WHERE id = ? AND status IN ('pending', 'delivered')`,
    );
    this.markFailedStmt = db.prepare(
      `UPDATE messages SET status = 'failed', error = ?, completed_at = ?
       WHERE id = ? AND status IN ('pending', 'delivered')`,
    );
    this.threadsStmt = db.prepare(
      `SELECT t.peer AS peer, t.total AS total, t.pending_in AS pending_in,
              m.body AS last_body, m.created_at AS last_at, m.id AS last_id
       FROM (
         SELECT CASE WHEN sender = ? THEN recipient ELSE sender END AS peer,
                COUNT(*) AS total,
                SUM(CASE WHEN recipient = ? AND status = 'pending' THEN 1 ELSE 0 END) AS pending_in,
                MAX(id) AS last_id
         FROM messages
         WHERE sender = ? OR recipient = ?
         GROUP BY peer
       ) t
       JOIN messages m ON m.id = t.last_id
       ORDER BY t.last_id DESC`,
    );
    // System-wide: EVERY distinct peer pair (a↔b collapsed canonically), newest-first.
    // Unlike threadsStmt this is not scoped to one agent — it surfaces inter-agent traffic.
    this.allThreadsStmt = db.prepare(
      `SELECT t.a AS a, t.b AS b, t.total AS total,
              m.body AS last_body, m.created_at AS last_at, m.id AS last_id
       FROM (
         SELECT CASE WHEN sender <= recipient THEN sender ELSE recipient END AS a,
                CASE WHEN sender <= recipient THEN recipient ELSE sender END AS b,
                COUNT(*) AS total,
                MAX(id) AS last_id
         FROM messages
         GROUP BY a, b
       ) t
       JOIN messages m ON m.id = t.last_id
       ORDER BY t.last_id DESC`,
    );
    this.conversationStmt = db.prepare(
      `SELECT ${ROW_COLUMNS} FROM messages
       WHERE ((sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?))
         AND (? IS NULL OR id < ?)
       ORDER BY id DESC
       LIMIT ?`,
    );
    this.recentStmt = db.prepare(`SELECT ${ROW_COLUMNS} FROM messages ORDER BY id DESC LIMIT ?`);
  }

  /**
   * Persist a new pending message and return its id. Sender validation
   * (reserved-id rejection / server-side stamping) happened at the endpoint;
   * here both ids are canonicalized so every later lookup matches.
   */
  enqueue(input: EnqueueInput): number {
    const meta = input.channelMeta === undefined ? null : JSON.stringify(input.channelMeta);
    const res = this.insertStmt.run(
      sanitizeId(input.sender),
      sanitizeId(input.recipient),
      input.body,
      meta,
      isoNow(this.clock),
    );
    return Number(res.lastInsertRowid);
  }

  get(id: number): MessageRow | undefined {
    const row = this.getStmt.get(id) as DbMessageRow | undefined;
    return row === undefined ? undefined : mapRow(row);
  }

  /** All pending messages, oldest-first across all recipients (the tick scan). */
  pending(limit = DEFAULT_PENDING_LIMIT): MessageRow[] {
    return (this.pendingStmt.all(limit) as unknown as DbMessageRow[]).map(mapRow);
  }

  /** Pending messages addressed to one recipient, oldest-first. */
  pendingFor(recipient: string): MessageRow[] {
    return (this.pendingForStmt.all(sanitizeId(recipient)) as unknown as DbMessageRow[]).map(mapRow);
  }

  /** pending -> delivered. Returns false when the row was not pending. */
  markDelivered(id: number): boolean {
    return Number(this.markDeliveredStmt.run(isoNow(this.clock), id).changes) > 0;
  }

  /** pending|delivered -> done. Returns false when already terminal/missing. */
  markDone(id: number, result?: string): boolean {
    return Number(this.markDoneStmt.run(result ?? null, isoNow(this.clock), id).changes) > 0;
  }

  /** pending|delivered -> failed. Returns false when already terminal/missing. */
  markFailed(id: number, error: string): boolean {
    return Number(this.markFailedStmt.run(error, isoNow(this.clock), id).changes) > 0;
  }

  /** Per-peer thread list for one agent, most-recently-active first. */
  threads(agentId: string): ThreadSummary[] {
    const a = sanitizeId(agentId);
    const rows = this.threadsStmt.all(a, a, a, a) as Array<{
      peer: string;
      total: number;
      pending_in: number;
      last_body: string;
      last_at: string;
      last_id: number;
    }>;
    return rows.map((r) => ({
      peer: r.peer,
      lastBody: r.last_body,
      lastAt: r.last_at,
      lastId: r.last_id,
      total: r.total,
      pendingIn: r.pending_in,
    }));
  }

  /**
   * System-wide thread list: every distinct peer pair (a↔b), most-recently-active
   * first — including agent↔agent traffic the per-agent {@link threads} never
   * surfaces. Operator-gated at the route (the whole-system view is operator-only).
   */
  allThreads(): PairThreadSummary[] {
    const rows = this.allThreadsStmt.all() as Array<{
      a: string;
      b: string;
      total: number;
      last_body: string;
      last_at: string;
      last_id: number;
    }>;
    return rows.map((r) => ({
      a: r.a,
      b: r.b,
      lastBody: r.last_body,
      lastAt: r.last_at,
      lastId: r.last_id,
      total: r.total,
    }));
  }

  /**
   * One thread, paginated by an id cursor (NOT by offset/time, so a
   * rarely-active thread pages exactly like a hot one — SPEC §6). Walk older
   * pages by passing back nextBeforeId.
   */
  conversation(agentId: string, peer: string, opts: ConversationOptions = {}): ConversationPage {
    const a = sanitizeId(agentId);
    const p = sanitizeId(peer);
    const limit = opts.limit ?? DEFAULT_CONVERSATION_LIMIT;
    const before = opts.beforeId ?? null;
    const rows = (
      this.conversationStmt.all(a, p, p, a, before, before, limit) as unknown as DbMessageRow[]
    ).map(mapRow);
    // Rows arrive newest-first; the cursor is the oldest id of a full page.
    const nextBeforeId = rows.length === limit ? rows[rows.length - 1]?.id : undefined;
    rows.reverse();
    return nextBeforeId === undefined ? { messages: rows } : { messages: rows, nextBeforeId };
  }

  /** Most recent messages across the whole system, newest-first. */
  recent(limit = DEFAULT_RECENT_LIMIT): MessageRow[] {
    return (this.recentStmt.all(limit) as unknown as DbMessageRow[]).map(mapRow);
  }
}
