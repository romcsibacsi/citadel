// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { type Clock, systemClock, isoNow } from '../core/clock.js';
import { createLogger } from '../core/log.js';
import { guessLane } from './laneRouter.js';
import type { LaneConfig } from '../config/types.js';

const log = createLogger('kanban');

/**
 * Kanban board store (SPEC §11).
 *
 * Invariants enforced here (on top of the DB CHECKs):
 *  - status/priority enums are validated at the store level;
 *  - move() is THE only status transition path — update() rejects status;
 *  - dispatch-on-in_progress fires exactly once per card, guarded by an
 *    atomic dispatched_at claim, never on a generic update;
 *  - side-effect hooks (dispatch, card-done) are error-tolerant: a throwing
 *    hook can never fail or roll back the already-committed move;
 *  - archive is soft (archived_at) — the default; hardDelete is a deliberate
 *    operator-only + UI-confirmed PURGE (documented exception to inv §20.8)
 *    that cascades comments (FK) and orphans children safely;
 *  - epic→subtask nesting is exactly 1 level deep.
 */

export const CARD_STATUSES = ['planned', 'in_progress', 'waiting', 'done'] as const;
export type CardStatus = (typeof CARD_STATUSES)[number];

export const CARD_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type CardPriority = (typeof CARD_PRIORITIES)[number];

export interface KanbanCard {
  id: number;
  title: string;
  description: string | null;
  status: CardStatus;
  assignee: string;
  priority: CardPriority;
  project: string | null;
  parentId: number | null;
  sortOrder: number;
  requiresApproval: boolean;
  dueAt: string | null;
  dispatchedAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCardInput {
  title: string;
  description?: string;
  assignee?: string;
  priority?: CardPriority;
  project?: string;
  parentId?: number;
  requiresApproval?: boolean;
  sortOrder?: number;
  dueAt?: string | null;
}

/** status is deliberately absent — move() is the only transition path. */
export interface UpdateCardFields {
  title?: string;
  description?: string | null;
  assignee?: string;
  priority?: CardPriority;
  project?: string | null;
  parentId?: number | null;
  requiresApproval?: boolean;
  sortOrder?: number;
  dueAt?: string | null;
}

export interface KanbanComment {
  id: number;
  cardId: number;
  author: string;
  body: string;
  createdAt: string;
}

export interface KanbanHooks {
  /** Called exactly once per card, on the winning in_progress claim. */
  onDispatch?: (card: KanbanCard) => void;
  /** Called whenever a card moves to done. */
  onCardDone?: (card: KanbanCard) => void;
  /** #399: called once when a single card is created (NOT for breakdown children). Used to push the
   *  owner a PII-safe alert when the bot escalates a CS case to a human (a requiresApproval card). */
  onCardCreated?: (card: KanbanCard) => void;
}

export interface BreakdownParentSpec {
  title: string;
  description?: string;
}

export interface BreakdownChildSpec {
  title: string;
  description?: string;
  priority?: CardPriority;
  /** Operator-chosen assignee; falls back to the lane router when omitted. */
  assignee?: string;
}

export type Board = Record<CardStatus, KanbanCard[]>;

const CARD_COLUMNS =
  'id, title, description, status, assignee, priority, project, parent_id, sort_order, ' +
  'requires_approval, due_at, dispatched_at, archived_at, created_at, updated_at';

interface DbCardRow {
  id: number;
  title: string;
  description: string | null;
  status: string;
  assignee: string;
  priority: string;
  project: string | null;
  parent_id: number | null;
  sort_order: number;
  requires_approval: number;
  due_at: string | null;
  dispatched_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

function mapCard(r: DbCardRow): KanbanCard {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    status: r.status as CardStatus,
    assignee: r.assignee,
    priority: r.priority as CardPriority,
    project: r.project,
    parentId: r.parent_id,
    sortOrder: r.sort_order,
    requiresApproval: r.requires_approval === 1,
    dueAt: r.due_at,
    dispatchedAt: r.dispatched_at,
    archivedAt: r.archived_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function assertStatus(status: string): asserts status is CardStatus {
  if (!(CARD_STATUSES as readonly string[]).includes(status)) {
    throw new Error(`invalid card status: ${status}`);
  }
}

function assertPriority(priority: string): asserts priority is CardPriority {
  if (!(CARD_PRIORITIES as readonly string[]).includes(priority)) {
    throw new Error(`invalid card priority: ${priority}`);
  }
}

function assertTitle(title: string): void {
  if (typeof title !== 'string' || title.trim() === '') {
    throw new Error('card title must be a non-empty string');
  }
}

export class KanbanStore {
  private readonly insertStmt: StatementSync;
  private readonly getStmt: StatementSync;
  private readonly boardStmt: StatementSync;
  private readonly boardProjectStmt: StatementSync;
  private readonly moveStmt: StatementSync;
  private readonly claimDispatchStmt: StatementSync;
  private readonly archiveStmt: StatementSync;
  private readonly unarchiveStmt: StatementSync;
  private readonly orphanChildrenStmt: StatementSync;
  private readonly deleteStmt: StatementSync;
  private readonly insertCommentStmt: StatementSync;
  private readonly commentsStmt: StatementSync;
  private readonly childrenStmt: StatementSync;
  private readonly projectsStmt: StatementSync;
  private readonly assigneesStmt: StatementSync;
  private readonly approvalsBadgeStmt: StatementSync;
  private readonly setSortOrderStmt: StatementSync;
  private readonly hasChildrenStmt: StatementSync;
  private readonly archivedStmt: StatementSync;

  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: Clock = systemClock,
    private readonly hooks: KanbanHooks = {},
  ) {
    this.insertStmt = db.prepare(
      `INSERT INTO kanban_cards
         (title, description, assignee, priority, project, parent_id, sort_order,
          requires_approval, due_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.getStmt = db.prepare(`SELECT ${CARD_COLUMNS} FROM kanban_cards WHERE id = ?`);
    this.boardStmt = db.prepare(
      `SELECT ${CARD_COLUMNS} FROM kanban_cards
       WHERE archived_at IS NULL ORDER BY sort_order ASC, id ASC`,
    );
    this.boardProjectStmt = db.prepare(
      `SELECT ${CARD_COLUMNS} FROM kanban_cards
       WHERE archived_at IS NULL AND project = ? ORDER BY sort_order ASC, id ASC`,
    );
    this.moveStmt = db.prepare('UPDATE kanban_cards SET status = ?, updated_at = ? WHERE id = ?');
    // Dispatch-once guard: only the first claimer wins (SPEC §11).
    this.claimDispatchStmt = db.prepare(
      'UPDATE kanban_cards SET dispatched_at = ? WHERE id = ? AND dispatched_at IS NULL',
    );
    this.archiveStmt = db.prepare(
      'UPDATE kanban_cards SET archived_at = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL',
    );
    this.unarchiveStmt = db.prepare(
      'UPDATE kanban_cards SET archived_at = NULL, updated_at = ? WHERE id = ?',
    );
    this.orphanChildrenStmt = db.prepare(
      'UPDATE kanban_cards SET parent_id = NULL, updated_at = ? WHERE parent_id = ?',
    );
    this.deleteStmt = db.prepare('DELETE FROM kanban_cards WHERE id = ?');
    this.insertCommentStmt = db.prepare(
      'INSERT INTO kanban_comments (card_id, author, body, created_at) VALUES (?, ?, ?, ?)',
    );
    this.commentsStmt = db.prepare(
      'SELECT id, card_id, author, body, created_at FROM kanban_comments WHERE card_id = ? ORDER BY id ASC',
    );
    this.childrenStmt = db.prepare(
      `SELECT ${CARD_COLUMNS} FROM kanban_cards WHERE parent_id = ? ORDER BY sort_order ASC, id ASC`,
    );
    this.projectsStmt = db.prepare(
      `SELECT DISTINCT project FROM kanban_cards
       WHERE project IS NOT NULL AND project != '' AND archived_at IS NULL ORDER BY project ASC`,
    );
    this.assigneesStmt = db.prepare(
      `SELECT DISTINCT assignee FROM kanban_cards
       WHERE assignee != '' AND archived_at IS NULL ORDER BY assignee ASC`,
    );
    this.approvalsBadgeStmt = db.prepare(
      `SELECT COUNT(*) AS n FROM kanban_cards
       WHERE requires_approval = 1 AND status != 'done' AND archived_at IS NULL`,
    );
    this.setSortOrderStmt = db.prepare(
      'UPDATE kanban_cards SET sort_order = ?, updated_at = ? WHERE id = ?',
    );
    this.hasChildrenStmt = db.prepare(
      'SELECT COUNT(*) AS n FROM kanban_cards WHERE parent_id = ?',
    );
    this.archivedStmt = db.prepare(
      `SELECT ${CARD_COLUMNS} FROM kanban_cards WHERE archived_at IS NOT NULL ORDER BY archived_at DESC, id DESC`,
    );
  }

  /** Archived (soft-deleted) cards, newest-archived first. */
  archived(): KanbanCard[] {
    return (this.archivedStmt.all() as unknown as DbCardRow[]).map(mapCard);
  }

  create(input: CreateCardInput): KanbanCard {
    const card = this.insertCard(input);
    this.runHook('onCardCreated', this.hooks.onCardCreated, card); // #399 owner-notify on a CS escalation/approval
    return card;
  }

  get(id: number): KanbanCard | undefined {
    const row = this.getStmt.get(id) as DbCardRow | undefined;
    return row === undefined ? undefined : mapCard(row);
  }

  /** Active (non-archived) cards grouped by status column. */
  board(opts: { project?: string } = {}): Board {
    const rows =
      opts.project === undefined
        ? (this.boardStmt.all() as unknown as DbCardRow[])
        : (this.boardProjectStmt.all(opts.project) as unknown as DbCardRow[]);
    const grouped: Board = { planned: [], in_progress: [], waiting: [], done: [] };
    for (const row of rows) {
      const card = mapCard(row);
      grouped[card.status].push(card);
    }
    return grouped;
  }

  /**
   * Field update. MUST NOT change status — move() is the only transition path,
   * so dispatch can only ever fire from a move. The status key is rejected even
   * when its value is undefined.
   */
  update(id: number, fields: UpdateCardFields): KanbanCard {
    if ('status' in (fields as Record<string, unknown>)) {
      throw new Error('status cannot be changed via update(); use move()');
    }
    const existing = this.requireCard(id);
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    if (fields.title !== undefined) {
      assertTitle(fields.title);
      sets.push('title = ?');
      values.push(fields.title);
    }
    if (fields.description !== undefined) {
      sets.push('description = ?');
      values.push(fields.description);
    }
    if (fields.assignee !== undefined) {
      sets.push('assignee = ?');
      values.push(fields.assignee);
    }
    if (fields.priority !== undefined) {
      assertPriority(fields.priority);
      sets.push('priority = ?');
      values.push(fields.priority);
    }
    if (fields.project !== undefined) {
      sets.push('project = ?');
      values.push(fields.project);
    }
    if (fields.parentId !== undefined) {
      this.assertValidParent(id, fields.parentId, existing);
      sets.push('parent_id = ?');
      values.push(fields.parentId);
    }
    if (fields.requiresApproval !== undefined) {
      sets.push('requires_approval = ?');
      values.push(fields.requiresApproval ? 1 : 0);
    }
    if (fields.sortOrder !== undefined) {
      sets.push('sort_order = ?');
      values.push(fields.sortOrder);
    }
    if (fields.dueAt !== undefined) {
      sets.push('due_at = ?');
      values.push(fields.dueAt);
    }
    if (sets.length > 0) {
      sets.push('updated_at = ?');
      values.push(isoNow(this.clock));
      this.db.prepare(`UPDATE kanban_cards SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
    }
    return this.requireCard(id);
  }

  /**
   * THE status transition operation. Side-effect hooks are keyed on the
   * DESTINATION status and error-tolerant: the move itself is committed before
   * any hook runs, and a throwing hook is logged, never propagated.
   *
   *  - -> in_progress: dispatch-once. The claim is a single atomic UPDATE
   *    guarded on dispatched_at IS NULL; only the winning claim calls
   *    onDispatch. Re-entering in_progress later never re-dispatches.
   *  - -> done: onCardDone (e.g. idea auto-archive).
   */
  move(id: number, toStatus: CardStatus): KanbanCard {
    assertStatus(toStatus);
    this.requireCard(id);
    this.moveStmt.run(toStatus, isoNow(this.clock), id);

    if (toStatus === 'in_progress') {
      const claimed = Number(this.claimDispatchStmt.run(isoNow(this.clock), id).changes);
      if (claimed > 0) {
        this.runHook('onDispatch', this.hooks.onDispatch, this.requireCard(id));
      }
    }
    const card = this.requireCard(id);
    if (toStatus === 'done') {
      this.runHook('onCardDone', this.hooks.onCardDone, card);
    }
    return card;
  }

  /** Soft archive: sets archived_at, never deletes — history preserved. */
  archive(id: number): KanbanCard {
    this.requireCard(id);
    const now = isoNow(this.clock);
    this.archiveStmt.run(now, now, id);
    return this.requireCard(id);
  }

  unarchive(id: number): KanbanCard {
    this.requireCard(id);
    this.unarchiveStmt.run(isoNow(this.clock), id);
    return this.requireCard(id);
  }

  /**
   * Hard delete — explicit operator action only. Children are orphaned
   * (parent_id nulled) first; comments cascade via the FK. Atomic.
   */
  hardDelete(id: number): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.orphanChildrenStmt.run(isoNow(this.clock), id);
      const deleted = Number(this.deleteStmt.run(id).changes) > 0;
      this.db.exec('COMMIT');
      return deleted;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Append-only comment trail (human + system). */
  comment(cardId: number, author: string, body: string): KanbanComment {
    this.requireCard(cardId);
    const now = isoNow(this.clock);
    const res = this.insertCommentStmt.run(cardId, author, body, now);
    return { id: Number(res.lastInsertRowid), cardId, author, body, createdAt: now };
  }

  comments(cardId: number): KanbanComment[] {
    const rows = this.commentsStmt.all(cardId) as Array<{
      id: number;
      card_id: number;
      author: string;
      body: string;
      created_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      cardId: r.card_id,
      author: r.author,
      body: r.body,
      createdAt: r.created_at,
    }));
  }

  /**
   * Split into parent + child cards ATOMICALLY (one transaction — a failing
   * child insert rolls back everything, including a freshly created parent).
   * Children get their assignee from the pure lane router (or '' on no match)
   * and inherit the parent's project. Nesting is 1-level only: a card that
   * itself has a parent cannot become a breakdown parent.
   */
  breakdown(
    parent: BreakdownParentSpec | number,
    children: BreakdownChildSpec[],
    lanes: LaneConfig[],
  ): { parent: KanbanCard; children: KanbanCard[] } {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      let parentCard: KanbanCard;
      if (typeof parent === 'number') {
        parentCard = this.requireCard(parent);
        if (parentCard.parentId !== null) {
          throw new Error('breakdown is 1-level only: the parent card itself has a parent');
        }
      } else {
        parentCard = this.insertCard({ title: parent.title, description: parent.description });
      }
      const childCards = children.map((child) => {
        // operator-chosen assignee wins; otherwise fall back to the lane router
        const assignee =
          child.assignee !== undefined && child.assignee !== ''
            ? child.assignee
            : (guessLane(`${child.title} ${child.description ?? ''}`, lanes) ?? '');
        return this.insertCard({
          title: child.title,
          description: child.description,
          priority: child.priority,
          assignee,
          parentId: parentCard.id,
          project: parentCard.project ?? undefined,
        });
      });
      this.db.exec('COMMIT');
      return { parent: parentCard, children: childCards };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  children(parentId: number): KanbanCard[] {
    return (this.childrenStmt.all(parentId) as unknown as DbCardRow[]).map(mapCard);
  }

  /** Distinct non-empty projects across active cards. */
  projects(): string[] {
    return (this.projectsStmt.all() as Array<{ project: string }>).map((r) => r.project);
  }

  /** Distinct non-empty assignees across active cards. */
  assignees(): string[] {
    return (this.assigneesStmt.all() as Array<{ assignee: string }>).map((r) => r.assignee);
  }

  /** Cards still waiting on human approval (badge count for the dashboard). */
  approvalsBadge(): number {
    return (this.approvalsBadgeStmt.get() as { n: number }).n;
  }

  setSortOrder(id: number, value: number): KanbanCard {
    this.requireCard(id);
    this.setSortOrderStmt.run(value, isoNow(this.clock), id);
    return this.requireCard(id);
  }

  // --- internals ---

  private requireCard(id: number): KanbanCard {
    const card = this.get(id);
    if (card === undefined) throw new Error(`kanban card not found: ${id}`);
    return card;
  }

  /**
   * Shared insert used by create() and breakdown(). Validation throws happen
   * before/inside the caller's transaction so breakdown stays atomic.
   */
  private insertCard(input: CreateCardInput): KanbanCard {
    assertTitle(input.title);
    const priority = input.priority ?? 'normal';
    assertPriority(priority);
    const parentId = input.parentId ?? null;
    if (parentId !== null) this.assertValidParent(null, parentId, null);
    const now = isoNow(this.clock);
    const res = this.insertStmt.run(
      input.title,
      input.description ?? null,
      input.assignee ?? '',
      priority,
      input.project ?? null,
      parentId,
      input.sortOrder ?? 0,
      input.requiresApproval ? 1 : 0,
      input.dueAt ?? null,
      now,
      now,
    );
    return this.requireCard(Number(res.lastInsertRowid));
  }

  /** Enforce the 1-level epic→subtask invariant on parent assignment. */
  private assertValidParent(
    cardId: number | null,
    parentId: number | null,
    card: KanbanCard | null,
  ): void {
    if (parentId === null) return;
    if (cardId !== null && parentId === cardId) {
      throw new Error('a card cannot be its own parent');
    }
    const parent = this.get(parentId);
    if (parent === undefined) throw new Error(`parent card not found: ${parentId}`);
    if (parent.parentId !== null) {
      throw new Error('nesting is 1-level only: the requested parent itself has a parent');
    }
    if (card !== null) {
      const n = (this.hasChildrenStmt.get(card.id) as { n: number }).n;
      if (n > 0) {
        throw new Error('nesting is 1-level only: a card with children cannot get a parent');
      }
    }
  }

  /** Error-tolerant hook runner: a throwing hook never affects the committed move. */
  private runHook(name: string, hook: ((card: KanbanCard) => void) | undefined, card: KanbanCard): void {
    if (hook === undefined) return;
    try {
      hook(card);
    } catch (err) {
      log.warn(`${name} hook failed; move already committed`, {
        cardId: card.id,
        error: String(err),
      });
    }
  }
}
