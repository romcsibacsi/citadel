// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * Kanban board (PROMPT-05): the shared work board. A toolbar (project + assignee
 * filters, a "waiting on me" owner toggle, an archive toggle), four lifecycle
 * columns with drag-and-drop (a drop into In progress wakes the assigned agent
 * once, via the backend), and the three modals (new/edit, detail, breakdown).
 * Reloads are both action-driven and live: a guarded 7s self-poll keeps the
 * shared board in sync with background agent work (card moves, new subtasks,
 * approval-gated cards) — it repaints the lanes in place and skips while a modal
 * is open or a card is mid-drag (FIX-00).
 */

import { defineView } from './registry.js';
import { h, mount } from '../dom.js';
import { t, currentLocale } from '../i18n.js';
import { api } from '../api.js';
import { icon } from '../icons.js';
import { toast } from '../toast.js';
import { openCardModal } from '../kanban/cardModal.js';
import { openCardDetail } from '../kanban/cardDetail.js';
import { pollWhileMounted, modalOpen } from '../poll.js';
import {
  STATUSES,
  ADDABLE,
  statusLabel,
  resolveAssignee,
  ownerOf,
  shortDate,
  isOverdue,
  type Assignee,
  type Board,
  type Card,
  type CardStatus,
} from '../kanban/model.js';
import type { Store } from '../store.js';
import type { AppState } from '../main.js';

// filter state persists across the shell's periodic re-renders
let filterProject = '';
let filterAssignee = '';
let ownerActive = false;
let archiveView = false;

function matches(card: Card): boolean {
  if (filterProject !== '' && (card.project ?? '') !== filterProject) return false;
  if (filterAssignee !== '' && card.assignee.toLowerCase() !== filterAssignee.toLowerCase()) return false;
  return true;
}

function render(host: HTMLElement, store: Store<AppState>): void {
  void store;
  let roster: Assignee[] = [];
  let projects: string[] = [];
  let board: Board = { planned: [], in_progress: [], waiting: [], done: [] };

  const toolbar = h('div', { class: 'kanban-toolbar' });
  const boardEl = h('div', { class: 'board kanban-board' });
  const archiveEl = h('div', { class: 'archive-list' });

  const reload = (): void => void load();

  // ---- card tile ----
  const tile = (card: Card): HTMLElement => {
    const res = resolveAssignee(roster, card.assignee);
    const foot = h('div', { class: 'kfoot' });
    if (card.requiresApproval) foot.append(h('span', { class: 'kbadge approval', title: t('kanban.tile.approvalTip') }, t('kanban.tile.approval')));
    if (res) foot.append(h('span', { class: 'assignee-chip' }, h('span', { class: `assignee-dot ${res.type}` }, res.letter), res.label));
    if (card.dueAt) foot.append(h('span', { class: `due-chip${isOverdue(card) ? ' overdue' : ''}` }, shortDate(card.dueAt, currentLocale())));

    const el = h(
      'div',
      { class: `kcard prio-${card.priority}`, draggable: 'true', 'data-id': String(card.id), 'data-status': card.status, onclick: () => openCardDetail({ id: card.id, roster, projects, onChanged: reload }) },
      card.project ? h('span', { class: 'kproject' }, card.project) : null,
      h('div', { class: 'ktitle' }, h('span', { class: 'knum' }, `#${card.id}`), ' ', card.title),
      foot,
    );
    if (card.requiresApproval) {
      el.append(
        h(
          'div',
          { class: 'kapprove-row' },
          h('button', { class: 'approve-btn', onclick: (e: Event) => { e.stopPropagation(); void decide(card.id, 'approve'); } }, t('kanban.tile.approve')),
          h('button', { class: 'reject-btn danger', title: t('kanban.tile.rejectTip'), onclick: (e: Event) => { e.stopPropagation(); void decide(card.id, 'reject'); } }, '✗'),
        ),
      );
    }
    // async subtask badge (only parents can have children — 1-level nesting)
    if (card.parentId === null) {
      void api.get<Card[]>(`/api/kanban/cards/${card.id}/children`).then((kids) => {
        if (kids.length > 0) el.append(h('button', { class: 'subtask-badge', onclick: (e: Event) => { e.stopPropagation(); openCardDetail({ id: card.id, roster, projects, onChanged: reload }); } }, t('kanban.tile.subtasks', { n: kids.length })));
      }).catch(() => undefined);
    }

    el.addEventListener('dragstart', (e) => {
      (e as DragEvent).dataTransfer?.setData('text/plain', String(card.id));
      el.classList.add('dragging');
    });
    el.addEventListener('dragend', () => el.classList.remove('dragging'));
    return el;
  };

  const decide = async (id: number, what: 'approve' | 'reject'): Promise<void> => {
    try {
      await api.post(`/api/kanban/cards/${id}/${what}`, undefined);
      reload();
    } catch {
      toast(t('kanban.error'), true);
    }
  };

  // ---- columns ----
  const column = (status: CardStatus, cards: Card[]): HTMLElement => {
    const bodyEl = h('div', { class: 'lane-body' }, ...cards.map(tile));
    const header = h(
      'div',
      { class: 'lane-head' },
      h('span', { class: 'lane-title' }, statusLabel(status)),
      h('span', { class: 'count-chip' }, String(cards.length)),
      ADDABLE.includes(status) ? h('button', { class: 'add-col-btn', title: t('kanban.col.add'), onclick: () => openCardModal({ status, roster, projects, onSaved: reload }) }, icon('plus', 14)) : null,
    );
    const lane = h('div', { class: 'lane', 'data-status': status }, header, bodyEl);
    lane.addEventListener('dragover', (e) => { e.preventDefault(); lane.classList.add('drag-over'); });
    lane.addEventListener('dragleave', () => lane.classList.remove('drag-over'));
    lane.addEventListener('drop', (e) => {
      e.preventDefault();
      lane.classList.remove('drag-over');
      const id = Number((e as DragEvent).dataTransfer?.getData('text/plain'));
      if (!id) return;
      // index = how many tiles sit above the drop point (the insertion position)
      const tiles = [...bodyEl.querySelectorAll('.kcard')];
      const y = (e as DragEvent).clientY;
      let index = tiles.length;
      for (let i = 0; i < tiles.length; i++) {
        const r = tiles[i]!.getBoundingClientRect();
        if (y < r.top + r.height / 2) { index = i; break; }
      }
      void move(id, status, index);
    });
    return lane;
  };

  const move = async (id: number, status: CardStatus, sortOrder: number): Promise<void> => {
    try {
      await api.post(`/api/kanban/cards/${id}/move`, { status, sortOrder });
      reload();
    } catch {
      toast(t('kanban.moveError'), true);
    }
  };

  // ---- toolbar ----
  const buildToolbar = (): void => {
    const projectSel = h('select', { 'aria-label': t('kanban.filter.project') }, h('option', { value: '', selected: filterProject === '' }, t('kanban.filter.all')), ...projects.map((p) => h('option', { value: p, selected: filterProject === p }, p))) as HTMLSelectElement;
    projectSel.addEventListener('change', () => { filterProject = projectSel.value; renderBoard(); });

    const assigneeSel = h('select', { 'aria-label': t('kanban.filter.assignee') }, h('option', { value: '', selected: filterAssignee === '' }, t('kanban.filter.all')), ...roster.map((a) => h('option', { value: a.id, selected: filterAssignee.toLowerCase() === a.id.toLowerCase() }, a.type === 'owner' ? t('kanban.assignee.owner') : a.type === 'bot' ? t('kanban.assignee.bot') : a.displayName))) as HTMLSelectElement;
    assigneeSel.addEventListener('change', () => { filterAssignee = assigneeSel.value; ownerActive = filterAssignee !== '' && filterAssignee === ownerOf(roster)?.id; renderBoard(); });

    const owner = ownerOf(roster);
    const ownerBtn = owner
      ? h('button', { class: `owner-toggle${ownerActive ? ' active' : ''}`, title: t('kanban.filter.ownerTip'), onclick: () => {
          ownerActive = !ownerActive;
          filterAssignee = ownerActive ? owner.id : '';
          buildToolbar();
          renderBoard();
        } }, t('kanban.filter.owner'))
      : null;

    const archiveBtn = h('button', { class: `archive-toggle${archiveView ? ' active' : ''}`, onclick: () => { archiveView = !archiveView; void load(); } }, archiveView ? t('kanban.archive.back') : t('kanban.archive.toggle'));

    mount(
      toolbar,
      h('div', { class: 'tb-left' },
        h('label', null, t('kanban.filter.project')), projectSel,
        h('label', null, t('kanban.filter.assignee')), assigneeSel,
        ownerBtn,
      ),
      h('div', { class: 'tb-right' }, archiveBtn),
    );
  };

  // ---- board / archive rendering ----
  const renderBoard = (): void => {
    const filtered = STATUSES.map((s) => ({ s, cards: board[s].filter(matches) }));
    const totalVisible = filtered.reduce((n, { cards }) => n + cards.length, 0);
    const cols = filtered.map(({ s, cards }) => column(s, cards));
    if (totalVisible === 0 && !archiveView) {
      cols.push(h('div', { class: 'board-empty-state muted-note' }, t('kanban.board.empty')));
    }
    mount(boardEl, ...cols);
  };

  const renderArchive = (cards: Card[]): void => {
    if (cards.length === 0) { mount(archiveEl, h('div', { class: 'muted-note center' }, t('kanban.archive.empty'))); return; }
    mount(archiveEl, ...cards.map((card) => {
      const res = resolveAssignee(roster, card.assignee);
      const meta = [`#${card.id}`, statusLabel(card.status), res ? res.label : '—', card.archivedAt ? new Date(card.archivedAt).toLocaleDateString(currentLocale()) : '', card.project ?? ''].filter((x) => x !== '').join(' · ');
      return h('div', { class: 'archive-row' },
        h('div', null, h('div', { class: 'arch-title' }, card.title), h('div', { class: 'arch-meta' }, meta)),
        h('button', { onclick: () => void restore(card.id) }, t('kanban.archive.restore')),
      );
    }));
  };

  const restore = async (id: number): Promise<void> => {
    try {
      await api.post(`/api/kanban/cards/${id}/unarchive`, undefined);
      toast(t('kanban.restored'));
      void load();
    } catch {
      toast(t('kanban.error'), true);
    }
  };

  // ---- load ----
  const load = async (): Promise<void> => {
    try {
      const [b, r, p] = await Promise.all([
        archiveView ? api.get<Card[]>('/api/kanban/archived') : api.get<Board>('/api/kanban/board'),
        api.get<Assignee[]>('/api/kanban/assignees'),
        api.get<string[]>('/api/kanban/projects'),
      ]);
      roster = r;
      projects = p;
      if (filterProject !== '' && !projects.includes(filterProject)) filterProject = ''; // vanished project → All
      buildToolbar();
      if (archiveView) {
        boardEl.style.display = 'none';
        archiveEl.style.display = '';
        renderArchive(b as Card[]);
      } else {
        boardEl.style.display = '';
        archiveEl.style.display = 'none';
        board = b as Board;
        renderBoard();
      }
    } catch {
      /* keep last good render on a transient fetch failure */
    }
  };

  mount(
    host,
    h('div', { class: 'page-header' }, h('h1', null, t('kanban.title')), h('p', { class: 'subtitle' }, t('kanban.subtitle'))),
    toolbar,
    boardEl,
    archiveEl,
  );
  archiveEl.style.display = 'none';
  void load();

  // Live refresh in place (FIX-00): the board is a SHARED operator/agent surface
  // — agents move cards, spawn subtasks and enqueue approval-gated cards in the
  // background. The app no longer re-mounts views on the 7s fleet poll, so this
  // view self-polls load() (which repaints the toolbar + lanes into their stable
  // nodes, preserving the filter/archive state). It skips a tick while a modal is
  // open or a card is mid-drag, so it never yanks the board out from under the
  // operator. Auto-clears once this host detaches.
  pollWhileMounted(host, () => void load(), 7000, () => modalOpen() || boardEl.querySelector('.kcard.dragging') !== null);
}

defineView('kanban', 'nav.kanban', render);
