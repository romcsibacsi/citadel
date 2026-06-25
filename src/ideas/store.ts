// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { type Clock, systemClock, isoNow } from '../core/clock.js';
import type { KanbanStore, KanbanCard, CardPriority } from '../kanban/store.js';
import { guessLane } from '../kanban/laneRouter.js';
import type { LaneConfig } from '../config/types.js';

/**
 * Idea box store (SPEC §12).
 *
 *  - Promote creates a linked kanban card; the idea↔card link is bidirectional
 *    and load-bearing (idea.kanban_id = card.id AND status = 'kanban'), written
 *    atomically in one transaction.
 *  - Archive is soft (status = 'archived' + archived_at) — the default lifecycle.
 *    remove() is a hard PURGE: a deliberate, operator-only + UI-confirmed exception
 *    to the archive-by-default invariant (§20.8), not part of the normal flow.
 *  - autoArchiveForCard is designed to be wired as the KanbanStore onCardDone
 *    hook (error-tolerant on the kanban side); reconcile() is the sweep that
 *    catches anything the hook missed.
 */

export const IDEA_STATUSES = ['new', 'reviewed', 'kanban', 'rejected', 'archived'] as const;
export type IdeaStatus = (typeof IDEA_STATUSES)[number];

/** Statuses settable via update(); lifecycle transitions own the rest. */
const UPDATABLE_STATUSES: readonly IdeaStatus[] = ['new', 'reviewed'];

export interface Idea {
  id: number;
  title: string;
  description: string | null;
  category: string;
  status: IdeaStatus;
  source: string;
  kanbanId: number | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateIdeaInput {
  title: string;
  description?: string;
  category?: string;
  source?: string;
}

export interface UpdateIdeaFields {
  title?: string;
  description?: string | null;
  category?: string;
  source?: string;
  /** Only 'new'/'reviewed' — promote/reject/archive own the lifecycle statuses. */
  status?: IdeaStatus;
}

export interface ListIdeasOptions {
  status?: IdeaStatus;
  includeArchived?: boolean;
}

/** Options for the two promote paths (phase picker + AI breakdown). */
export interface PromoteOptions {
  /** detail -> 'waiting' column + marker prefix; plan -> 'planned' column as-is. */
  phase?: 'detail' | 'plan';
  /** Project the created card(s) live under (the "Development ideas" project). */
  project?: string;
  /** Assignee for the parent card (the orchestrator/hub agent). */
  assignee?: string;
}

/** One approved subtask for the AI-breakdown promote path. */
export interface PromoteSubtask {
  title: string;
  description?: string;
  /** Operator-chosen assignee; falls back to the lane router when blank. */
  assignee?: string;
  priority?: CardPriority;
}

/** Marker prefixed onto a "detail elaboration" card title (placeholder work). */
const DETAIL_MARKER = '[detail elaboration]';

const IDEA_COLUMNS =
  'id, title, description, category, status, source, kanban_id, archived_at, created_at, updated_at';

interface DbIdeaRow {
  id: number;
  title: string;
  description: string | null;
  category: string;
  status: string;
  source: string;
  kanban_id: number | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

function mapIdea(r: DbIdeaRow): Idea {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    category: r.category,
    status: r.status as IdeaStatus,
    source: r.source,
    kanbanId: r.kanban_id,
    archivedAt: r.archived_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function assertIdeaStatus(status: string): asserts status is IdeaStatus {
  if (!(IDEA_STATUSES as readonly string[]).includes(status)) {
    throw new Error(`invalid idea status: ${status}`);
  }
}

export class IdeaStore {
  private readonly insertStmt: StatementSync;
  private readonly getStmt: StatementSync;
  private readonly listAllStmt: StatementSync;
  private readonly listActiveStmt: StatementSync;
  private readonly listByStatusStmt: StatementSync;
  private readonly promoteStmt: StatementSync;
  private readonly setStatusStmt: StatementSync;
  private readonly archiveStmt: StatementSync;
  private readonly autoArchiveStmt: StatementSync;
  private readonly linkedKanbanStmt: StatementSync;
  private readonly deleteStmt: StatementSync;
  private readonly categoriesStmt: StatementSync;

  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: Clock = systemClock,
  ) {
    this.insertStmt = db.prepare(
      `INSERT INTO ideas (title, description, category, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.getStmt = db.prepare(`SELECT ${IDEA_COLUMNS} FROM ideas WHERE id = ?`);
    this.listAllStmt = db.prepare(`SELECT ${IDEA_COLUMNS} FROM ideas ORDER BY id DESC`);
    this.listActiveStmt = db.prepare(
      `SELECT ${IDEA_COLUMNS} FROM ideas WHERE status != 'archived' ORDER BY id DESC`,
    );
    this.listByStatusStmt = db.prepare(
      `SELECT ${IDEA_COLUMNS} FROM ideas WHERE status = ? ORDER BY id DESC`,
    );
    this.promoteStmt = db.prepare(
      `UPDATE ideas SET status = 'kanban', kanban_id = ?, updated_at = ? WHERE id = ?`,
    );
    this.setStatusStmt = db.prepare('UPDATE ideas SET status = ?, updated_at = ? WHERE id = ?');
    this.archiveStmt = db.prepare(
      `UPDATE ideas SET status = 'archived', archived_at = ?, updated_at = ? WHERE id = ?`,
    );
    // Hook-safe sweep target: archives whatever idea links to the card, no-op when none does.
    this.autoArchiveStmt = db.prepare(
      `UPDATE ideas SET status = 'archived', archived_at = ?, updated_at = ?
       WHERE kanban_id = ? AND status != 'archived'`,
    );
    this.linkedKanbanStmt = db.prepare(
      `SELECT id, kanban_id FROM ideas WHERE status = 'kanban' AND kanban_id IS NOT NULL ORDER BY id ASC`,
    );
    this.deleteStmt = db.prepare('DELETE FROM ideas WHERE id = ?');
    this.categoriesStmt = db.prepare(
      `SELECT DISTINCT category FROM ideas WHERE category != '' ORDER BY category COLLATE NOCASE ASC`,
    );
  }

  /** Distinct non-empty categories across all ideas (for the header filter). */
  categories(): string[] {
    return (this.categoriesStmt.all() as Array<{ category: string }>).map((r) => r.category);
  }

  /** Hard delete — the single irreversible path, an explicit operator action. */
  remove(id: number): boolean {
    return Number(this.deleteStmt.run(id).changes) > 0;
  }

  create(input: CreateIdeaInput): Idea {
    if (typeof input.title !== 'string' || input.title.trim() === '') {
      throw new Error('idea title must be a non-empty string');
    }
    const now = isoNow(this.clock);
    const res = this.insertStmt.run(
      input.title,
      input.description ?? null,
      input.category ?? 'general',
      input.source ?? '',
      now,
      now,
    );
    return this.requireIdea(Number(res.lastInsertRowid));
  }

  get(id: number): Idea | undefined {
    const row = this.getStmt.get(id) as DbIdeaRow | undefined;
    return row === undefined ? undefined : mapIdea(row);
  }

  /** Newest-first. Archived ideas are hidden unless asked for explicitly. */
  list(opts: ListIdeasOptions = {}): Idea[] {
    if (opts.status !== undefined) {
      assertIdeaStatus(opts.status);
      return (this.listByStatusStmt.all(opts.status) as unknown as DbIdeaRow[]).map(mapIdea);
    }
    const stmt = opts.includeArchived ? this.listAllStmt : this.listActiveStmt;
    return (stmt.all() as unknown as DbIdeaRow[]).map(mapIdea);
  }

  update(id: number, fields: UpdateIdeaFields): Idea {
    const existing = this.requireIdea(id);
    if (existing.status === 'archived') {
      throw new Error('archived ideas are immutable');
    }
    const sets: string[] = [];
    const values: Array<string | null> = [];
    if (fields.title !== undefined) {
      if (typeof fields.title !== 'string' || fields.title.trim() === '') {
        throw new Error('idea title must be a non-empty string');
      }
      sets.push('title = ?');
      values.push(fields.title);
    }
    if (fields.description !== undefined) {
      sets.push('description = ?');
      values.push(fields.description);
    }
    if (fields.category !== undefined) {
      sets.push('category = ?');
      values.push(fields.category);
    }
    if (fields.source !== undefined) {
      sets.push('source = ?');
      values.push(fields.source);
    }
    if (fields.status !== undefined) {
      assertIdeaStatus(fields.status);
      if (!UPDATABLE_STATUSES.includes(fields.status)) {
        throw new Error(
          `status '${fields.status}' cannot be set via update(); use promote()/reject()/archive()`,
        );
      }
      sets.push('status = ?');
      values.push(fields.status);
    }
    if (sets.length > 0) {
      sets.push('updated_at = ?');
      values.push(isoNow(this.clock));
      this.db.prepare(`UPDATE ideas SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
    }
    return this.requireIdea(id);
  }

  /**
   * Promote an idea into a linked kanban card. The bidirectional link
   * (idea.kanban_id = card.id AND idea.status = 'kanban') is load-bearing —
   * auto-archive and reconcile both depend on it — so the card creation and
   * the link write commit atomically.
   */
  promote(
    id: number,
    kanban: KanbanStore,
    opts: PromoteOptions = {},
  ): { idea: Idea; card: KanbanCard } {
    const idea = this.requireIdea(id);
    if (idea.status === 'archived') throw new Error('archived ideas cannot be promoted');
    if (idea.status === 'kanban' || idea.kanbanId !== null) {
      throw new Error(`idea ${id} is already promoted to card ${idea.kanbanId}`);
    }
    const title = opts.phase === 'detail' ? `${DETAIL_MARKER} ${idea.title}` : idea.title;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const card = kanban.create({
        title,
        description: idea.description ?? undefined,
        ...(opts.project !== undefined ? { project: opts.project } : {}),
        ...(opts.assignee !== undefined ? { assignee: opts.assignee } : {}),
      });
      // create() always lands in 'planned'; the detail path parks it in 'waiting'.
      if (opts.phase === 'detail') kanban.move(card.id, 'waiting');
      this.promoteStmt.run(card.id, isoNow(this.clock), id);
      this.db.exec('COMMIT');
      return { idea: this.requireIdea(id), card: kanban.get(card.id) ?? card };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * AI-breakdown promote: create one parent card (from the idea, 'planned',
   * under the ideas project, assigned to the orchestrator) plus one child card
   * per approved subtask, then link the idea to the parent — all atomically.
   * Children take the operator-chosen assignee or fall back to the lane router.
   */
  promoteBreakdown(
    id: number,
    kanban: KanbanStore,
    subtasks: PromoteSubtask[],
    lanes: LaneConfig[],
    opts: PromoteOptions = {},
  ): { idea: Idea; parent: KanbanCard; children: KanbanCard[] } {
    const idea = this.requireIdea(id);
    if (idea.status === 'archived') throw new Error('archived ideas cannot be promoted');
    if (idea.status === 'kanban' || idea.kanbanId !== null) {
      throw new Error(`idea ${id} is already promoted to card ${idea.kanbanId}`);
    }
    if (!Array.isArray(subtasks) || subtasks.length === 0) {
      throw new Error('at least one approved subtask is required');
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const parent = kanban.create({
        title: idea.title,
        description: idea.description ?? undefined,
        ...(opts.project !== undefined ? { project: opts.project } : {}),
        ...(opts.assignee !== undefined ? { assignee: opts.assignee } : {}),
      });
      const children = subtasks.map((st) => {
        const assignee =
          st.assignee !== undefined && st.assignee.trim() !== ''
            ? st.assignee
            : (guessLane(`${st.title} ${st.description ?? ''}`, lanes) ?? '');
        return kanban.create({
          title: st.title,
          ...(st.description !== undefined ? { description: st.description } : {}),
          priority: st.priority ?? 'normal',
          assignee,
          parentId: parent.id,
          ...(opts.project !== undefined ? { project: opts.project } : {}),
        });
      });
      this.promoteStmt.run(parent.id, isoNow(this.clock), id);
      this.db.exec('COMMIT');
      return { idea: this.requireIdea(id), parent: kanban.get(parent.id) ?? parent, children };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  reject(id: number): Idea {
    const idea = this.requireIdea(id);
    if (idea.status === 'archived') throw new Error('archived ideas are immutable');
    this.setStatusStmt.run('rejected', isoNow(this.clock), id);
    return this.requireIdea(id);
  }

  /** Manual soft archive (for ideas resolved without a card). Never deletes. */
  archive(id: number): Idea {
    this.requireIdea(id);
    const now = isoNow(this.clock);
    this.archiveStmt.run(now, now, id);
    return this.requireIdea(id);
  }

  /**
   * Archive the idea linked to a card — wired as the error-tolerant
   * onCardDone hook of KanbanStore. Safe no-op (returns 0) when no idea
   * links to the card.
   */
  autoArchiveForCard(cardId: number): number {
    const now = isoNow(this.clock);
    return Number(this.autoArchiveStmt.run(now, now, cardId).changes);
  }

  /**
   * Sweep: archive every promoted idea whose linked card is done. Catches
   * anything the move hook missed (e.g. a hook failure). Returns the count
   * of ideas archived in this pass.
   */
  reconcile(kanban: KanbanStore): number {
    const linked = this.linkedKanbanStmt.all() as Array<{ id: number; kanban_id: number }>;
    let archived = 0;
    for (const row of linked) {
      const card = kanban.get(row.kanban_id);
      if (card?.status === 'done') {
        this.archive(row.id);
        archived += 1;
      }
    }
    return archived;
  }

  private requireIdea(id: number): Idea {
    const idea = this.get(id);
    if (idea === undefined) throw new Error(`idea not found: ${id}`);
    return idea;
  }
}
