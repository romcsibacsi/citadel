// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { h, mount } from '../dom.js';
import { t, currentLocale } from '../i18n.js';
import { api, ApiError } from '../api.js';
import { toast } from '../toast.js';
import { openCardModal } from './cardModal.js';
import { openBreakdown } from './breakdownModal.js';
import {
  statusLabel,
  statusShort,
  priorityLabel,
  assigneeLabel,
  resolveAssignee,
  type Assignee,
  type Card,
  type Comment,
} from './model.js';

/**
 * Card Detail modal (PROMPT-05 §5.3): meta grid (with inline-editable assignee),
 * description, append-only comments with a selectable author, a subtasks list
 * (drill-down), and the action row (Breakdown / Edit / Archive / Delete).
 */
interface DetailOpts {
  id: number;
  roster: Assignee[];
  projects: string[];
  onChanged: () => void;
}

export function openCardDetail(opts: DetailOpts): void {
  const body = h('div', { class: 'agent-modal-body card-detail-body' });
  const titleEl = h('h2', null, '');

  const backdrop = h('div', { class: 'modal-backdrop' });
  const close = (): void => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    document.body.classList.remove('modal-open');
  };
  const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

  const fmtTs = (iso: string): string => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(currentLocale());
  };
  const fmtDate = (iso: string | null): string => {
    if (!iso) return t('kanban.detail.none');
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(currentLocale());
  };

  const metaRow = (labelKey: string, value: HTMLElement | string): HTMLElement =>
    h('div', { class: 'meta-row' }, h('span', { class: 'meta-key' }, t(labelKey)), h('span', { class: 'meta-val' }, value));

  const render = (card: Card, comments: Comment[], children: Card[]): void => {
    titleEl.textContent = `#${card.id} ${card.title}`;

    // inline-editable assignee
    const resolved = resolveAssignee(opts.roster, card.assignee);
    const assigneeVal = h('span', { class: 'editable', title: t('kanban.detail.clickToEdit') }, resolved ? resolved.label : t('kanban.detail.none'));
    assigneeVal.addEventListener('click', () => {
      const sel = h('select', null, h('option', { value: '', selected: !card.assignee }, t('kanban.assignee.none')), ...opts.roster.map((a) => h('option', { value: a.id, selected: card.assignee?.toLowerCase() === a.id.toLowerCase() }, assigneeLabel(a)))) as HTMLSelectElement;
      assigneeVal.replaceWith(sel);
      sel.focus();
      sel.addEventListener('change', () => {
        if (sel.value === card.assignee) { void load(); return; }
        void (async () => {
          try {
            await api.patch(`/api/kanban/cards/${card.id}`, { assignee: sel.value });
            toast(t('kanban.assigneeUpdated'));
            opts.onChanged();
            void load();
          } catch (err) {
            toast(t('kanban.saveError', { msg: err instanceof ApiError ? err.message : String(err) }), true);
            void load();
          }
        })();
      });
    });

    // comments
    const commentList = comments.length === 0
      ? h('div', { class: 'muted-note' }, t('kanban.detail.noComments'))
      : h('div', { class: 'comment-list' }, ...comments.map((m) => {
          const who = resolveAssignee(opts.roster, m.author);
          return h('div', { class: 'comment' }, h('div', { class: 'comment-head' }, h('span', { class: 'comment-author' }, who?.label ?? m.author), h('span', { class: 'comment-ts' }, fmtTs(m.createdAt))), h('div', { class: 'comment-body' }, m.body));
        }));

    const composerText = h('textarea', { rows: 2, placeholder: t('kanban.detail.commentPlaceholder') }) as HTMLTextAreaElement;
    const defaultAuthor = opts.roster.find((a) => a.type === 'bot')?.id ?? opts.roster[0]?.id ?? '';
    const authorSel = h('select', null, ...opts.roster.map((a) => h('option', { value: a.id, selected: a.id === defaultAuthor }, assigneeLabel(a)))) as HTMLSelectElement;
    const sendComment = async (): Promise<void> => {
      if (composerText.value.trim() === '') { composerText.focus(); return; }
      if (authorSel.value === '') { toast(t('kanban.detail.chooseAuthor'), true); return; }
      try {
        await api.post(`/api/kanban/cards/${card.id}/comments`, { body: composerText.value.trim(), author: authorSel.value });
        composerText.value = '';
        void load();
      } catch (err) {
        toast(t('kanban.saveError', { msg: err instanceof ApiError ? err.message : String(err) }), true);
      }
    };

    // subtasks
    const subtasksSection = children.length === 0
      ? null
      : h(
          'div',
          { class: 'detail-section' },
          h('div', { class: 'sec-title' }, t('kanban.detail.subtasks')),
          h('div', { class: 'subtask-list' }, ...children.map((ch) => {
            const sub = resolveAssignee(opts.roster, ch.assignee);
            const snippet = (ch.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
            return h(
              'div',
              { class: 'subtask-row', role: 'button', onclick: () => { close(); openCardDetail({ ...opts, id: ch.id }); } },
              h('div', { class: 'subtask-title' }, ch.title, h('span', { class: 'subtask-status' }, ` [${statusShort(ch.status)}]`)),
              h('div', { class: 'subtask-sub' }, [sub ? sub.label : null, snippet].filter(Boolean).join(' · ')),
            );
          })),
        );

    mount(
      body,
      h(
        'div',
        { class: 'meta-grid' },
        metaRow('kanban.detail.id', h('span', { class: 'mono', title: t('kanban.detail.idHint') }, `#${card.id}`)),
        metaRow('kanban.detail.status', statusLabel(card.status)),
        metaRow('kanban.detail.assignee', assigneeVal),
        metaRow('kanban.detail.priority', priorityLabel(card.priority)),
        metaRow('kanban.detail.project', card.project ?? t('kanban.detail.none')),
        metaRow('kanban.detail.due', fmtDate(card.dueAt)),
      ),
      h('div', { class: 'detail-section' }, h('div', { class: 'sec-title' }, t('kanban.detail.description')), h('div', { class: 'detail-desc' }, card.description?.trim() ? card.description : t('kanban.detail.noDescription'))),
      subtasksSection,
      h(
        'div',
        { class: 'detail-section' },
        h('div', { class: 'sec-title' }, t('kanban.detail.comments')),
        commentList,
        h('div', { class: 'comment-composer' }, composerText, h('div', { class: 'composer-row' }, h('label', null, t('kanban.detail.commentAuthor')), authorSel, h('button', { class: 'primary', onclick: () => void sendComment() }, t('kanban.detail.send')))),
      ),
      h(
        'div',
        { class: 'agent-modal-actions detail-actions' },
        h('button', { onclick: () => openBreakdown({ parent: card, roster: opts.roster, onAccepted: () => { close(); opts.onChanged(); } }) }, t('kanban.detail.breakdown')),
        h('div', { class: 'spacer-actions' }),
        h('button', { onclick: () => { close(); openCardModal({ card, roster: opts.roster, projects: opts.projects, onSaved: opts.onChanged }); } }, t('kanban.detail.edit')),
        h('button', { onclick: () => void archive(card) }, t('kanban.detail.archive')),
        h('button', { class: 'danger', onclick: () => void del(card) }, t('kanban.detail.delete')),
      ),
    );
  };

  const archive = async (card: Card): Promise<void> => {
    try {
      await api.post(`/api/kanban/cards/${card.id}/archive`, undefined);
      toast(t('kanban.archived'));
      close();
      opts.onChanged();
    } catch (err) {
      toast(t('kanban.saveError', { msg: err instanceof ApiError ? err.message : String(err) }), true);
    }
  };
  const del = async (card: Card): Promise<void> => {
    if (!window.confirm(t('kanban.detail.deleteConfirm'))) return;
    try {
      await api.delete(`/api/kanban/cards/${card.id}`);
      toast(t('kanban.deleted'));
      close();
      opts.onChanged();
    } catch (err) {
      toast(t('kanban.saveError', { msg: err instanceof ApiError ? err.message : String(err) }), true);
    }
  };

  const load = async (): Promise<void> => {
    try {
      const card = await api.get<Card & { comments: Comment[] }>(`/api/kanban/cards/${opts.id}`);
      const children = await api.get<Card[]>(`/api/kanban/cards/${opts.id}/children`).catch(() => [] as Card[]);
      render(card, card.comments ?? [], children);
    } catch (err) {
      mount(body, h('div', { class: 'muted-note err' }, t('kanban.notFound')));
      void err;
    }
  };

  backdrop.append(
    h(
      'div',
      { class: 'modal card-detail-modal' },
      h('div', { class: 'agent-modal-titlebar' }, titleEl, h('button', { class: 'icon-btn', 'aria-label': t('kanban.close'), onclick: close }, '✕')),
      body,
    ),
  );
  document.body.append(backdrop);
  document.body.classList.add('modal-open');
  mount(body, h('div', { class: 'muted-note' }, t('kanban.loading')));
  void load();
}
