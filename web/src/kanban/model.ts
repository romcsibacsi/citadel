// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { t } from '../i18n.js';

/**
 * Kanban shared model + label/assignee helpers (PROMPT-05). Status + priority
 * are stored language-neutral and localized only at render time; assignees are
 * resolved against the typed roster (owner/bot/agent) with an unknown fallback
 * so a card never silently loses its assignee chip.
 */

export type CardStatus = 'planned' | 'in_progress' | 'waiting' | 'done';
export type CardPriority = 'low' | 'normal' | 'high' | 'urgent';
export const STATUSES: CardStatus[] = ['planned', 'in_progress', 'waiting', 'done'];
export const PRIORITIES: CardPriority[] = ['low', 'normal', 'high', 'urgent'];
/** Columns that get an "add card" button (Done is reached only by finishing). */
export const ADDABLE: CardStatus[] = ['planned', 'in_progress', 'waiting'];

export interface Card {
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
export interface Comment {
  id: number;
  cardId: number;
  author: string;
  body: string;
  createdAt: string;
}
export type Board = Record<CardStatus, Card[]>;

export type AssigneeType = 'owner' | 'bot' | 'agent';
export interface Assignee {
  id: string;
  type: AssigneeType;
  displayName: string;
}

export function statusLabel(s: CardStatus): string {
  return t(`kanban.col.${s}`);
}
export function statusShort(s: CardStatus): string {
  return s === 'waiting' ? t('kanban.short.waiting') : statusLabel(s);
}
export function priorityLabel(p: CardPriority): string {
  return t(`kanban.prio.${p}`);
}

/** Localized display label for a roster entry (owner/bot localized, agent by name). */
export function assigneeLabel(a: Assignee): string {
  if (a.type === 'owner') return t('kanban.assignee.owner');
  if (a.type === 'bot') return t('kanban.assignee.bot');
  return a.displayName || a.id;
}

export interface ResolvedAssignee {
  id: string;
  label: string;
  type: AssigneeType | 'unknown';
  letter: string;
}

/** Resolve a card's stored assignee against the roster (case-insensitive), with
 *  an unknown fallback so the chip always renders. Returns null when unassigned. */
export function resolveAssignee(roster: Assignee[], rawId: string): ResolvedAssignee | null {
  if (!rawId) return null;
  const found = roster.find((a) => a.id.toLowerCase() === rawId.toLowerCase());
  const label = found ? assigneeLabel(found) : rawId;
  return { id: found?.id ?? rawId, label, type: found?.type ?? 'unknown', letter: (label[0] ?? '?').toUpperCase() };
}

/** The board owner (assignee whose type is "owner"), or undefined. */
export function ownerOf(roster: Assignee[]): Assignee | undefined {
  return roster.find((a) => a.type === 'owner');
}

/** Short localized month/day for a due-date chip. */
export function shortDate(iso: string, locale: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
}
export function isOverdue(card: Card): boolean {
  if (!card.dueAt || card.status === 'done') return false;
  const d = new Date(card.dueAt).getTime();
  return !Number.isNaN(d) && d < Date.now();
}
