// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { h, mount } from '../dom.js';
import { t } from '../i18n.js';
import { api, ApiError } from '../api.js';
import { toast } from '../toast.js';
import { PRIORITIES, priorityLabel, assigneeLabel, type Assignee, type Card, type CardPriority } from './model.js';

/**
 * Shared breakdown modal (PROMPT-05 §5.5, reused by PROMPT-11 §5C). Two modes:
 *
 *  - kanban: opens with blank editable rows the operator fills (title + include
 *    + assignee + editable priority); accepted rows become children of a card.
 *  - idea: opens seeded with the AI-drafted subtasks and the idea title as
 *    parent; the priority is a read-only pill (the draft's suggestion); accepted
 *    rows are sent to the idea promote-breakdown flow (parent + child cards).
 *
 * Only the checked, non-empty rows are created.
 */
interface ProposedRow {
  title: string;
  assignee: string;
  priority: CardPriority;
  include: boolean;
}

interface KanbanBreakdownOpts {
  mode?: 'kanban';
  parent: Card;
  roster: Assignee[];
  onAccepted: () => void;
}
interface IdeaBreakdownOpts {
  mode: 'idea';
  ideaId: number;
  parentTitle: string;
  roster: Assignee[];
  seed: Array<{ title: string; assignee: string; priority: CardPriority }>;
  onAccepted: () => void;
}
type BreakdownOpts = KanbanBreakdownOpts | IdeaBreakdownOpts;

export function openBreakdown(opts: BreakdownOpts): void {
  const isIdea = opts.mode === 'idea';
  const rows: ProposedRow[] = isIdea
    ? opts.seed.map((s) => ({ title: s.title, assignee: s.assignee, priority: s.priority, include: true }))
    : [
        { title: '', assignee: '', priority: 'normal', include: true },
        { title: '', assignee: '', priority: 'normal', include: true },
        { title: '', assignee: '', priority: 'normal', include: true },
      ];
  const parentTitle = isIdea ? opts.parentTitle : opts.parent.title;

  const listEl = h('div', { class: 'breakdown-rows' });

  const backdrop = h('div', { class: 'modal-backdrop' });
  // dismissing the modal without accepting (Cancel / Escape / backdrop) surfaces a
  // "Breakdown discarded" toast (PROMPT-05 §5.5 / FIX-05 §5); accept() sets the flag first.
  let accepted = false;
  const close = (): void => {
    if (!accepted) toast(t('kanban.breakdown.discarded'));
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    document.body.classList.remove('modal-open');
  };
  const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

  const renderRows = (): void => {
    mount(
      listEl,
      ...rows.map((row, i) => {
        const includeCb = h('input', { type: 'checkbox' }) as HTMLInputElement;
        includeCb.checked = row.include;
        includeCb.addEventListener('change', () => { row.include = includeCb.checked; });
        const titleEl = h('input', { type: 'text', value: row.title, placeholder: t('kanban.breakdown.subtaskPlaceholder') }) as HTMLInputElement;
        titleEl.addEventListener('input', () => { row.title = titleEl.value; });
        const assigneeEl = h('select', null, h('option', { value: '' }, t('kanban.assignee.none')), ...opts.roster.map((a) => h('option', { value: a.id, selected: row.assignee === a.id }, assigneeLabel(a)))) as HTMLSelectElement;
        assigneeEl.addEventListener('change', () => { row.assignee = assigneeEl.value; });
        // idea mode: priority is the AI's read-only suggestion (a pill);
        // kanban mode: the operator picks it from a select.
        const prioCell = isIdea
          ? h('span', { class: `badge prio-pill prio-${row.priority}` }, priorityLabel(row.priority))
          : (() => {
              const prioEl = h('select', { class: 'prio-select' }, ...PRIORITIES.map((p) => h('option', { value: p, selected: row.priority === p }, priorityLabel(p)))) as HTMLSelectElement;
              prioEl.addEventListener('change', () => { row.priority = prioEl.value as CardPriority; });
              return prioEl;
            })();
        return h(
          'div',
          { class: 'breakdown-row' },
          h('span', { class: 'bd-ord' }, `${i + 1}.`),
          h('label', { class: 'inline-check bd-include' }, includeCb, t('kanban.breakdown.include')),
          titleEl,
          assigneeEl,
          prioCell,
        );
      }),
    );
  };

  const addRow = (): void => { rows.push({ title: '', assignee: '', priority: 'normal', include: true }); renderRows(); };

  const accept = async (e: Event): Promise<void> => {
    const chosen = rows.filter((r) => r.include && r.title.trim() !== '');
    if (chosen.length === 0) { toast(t('kanban.breakdown.selectOne'), true); return; }
    const btn = e.currentTarget as HTMLButtonElement;
    btn.disabled = true;
    try {
      if (isIdea) {
        const res = await api.post<{ children: unknown[] }>(`/api/ideas/${opts.ideaId}/promote-breakdown`, {
          subtasks: chosen.map((r) => ({ title: r.title.trim(), assignee: r.assignee, priority: r.priority })),
        });
        toast(t('ideas.toast.promoted', { n: res.children.length }));
      } else {
        const res = await api.post<{ children: unknown[] }>('/api/kanban/breakdown', {
          parentId: opts.parent.id,
          children: chosen.map((r) => ({ title: r.title.trim(), assignee: r.assignee, priority: r.priority })),
        });
        toast(t('kanban.breakdown.created', { count: res.children.length }));
      }
      accepted = true; // suppress the discarded toast on this (successful) close
      close();
      opts.onAccepted();
    } catch (err) {
      toast(t('kanban.saveError', { msg: err instanceof ApiError ? err.message : String(err) }), true);
      btn.disabled = false;
    }
  };

  backdrop.append(
    h(
      'div',
      { class: 'modal breakdown-modal' },
      h('div', { class: 'agent-modal-titlebar' }, h('h2', null, t(isIdea ? 'ideas.breakdown.title' : 'kanban.breakdown.title')), h('button', { class: 'icon-btn', 'aria-label': t('kanban.close'), onclick: close }, '✕')),
      h('div', { class: 'field-note' }, t('kanban.breakdown.parent', { title: parentTitle })),
      listEl,
      ...(isIdea ? [] : [h('button', { class: 'add-row-btn', onclick: addRow }, t('kanban.breakdown.addRow'))]),
      h('div', { class: 'modal-actions' }, h('button', { onclick: close }, t('kanban.breakdown.cancel')), h('button', { class: 'primary', onclick: (e: Event) => void accept(e) }, t('kanban.breakdown.submit'))),
    ),
  );
  document.body.append(backdrop);
  document.body.classList.add('modal-open');
  renderRows();
}
