// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { h, mount } from '../dom.js';
import { t } from '../i18n.js';
import { api, ApiError } from '../api.js';
import { toast } from '../toast.js';
import { PRIORITIES, priorityLabel, assigneeLabel, type Assignee, type Card, type CardStatus } from './model.js';

/**
 * New / Edit Card modal (PROMPT-05 §5.1). Create mode lands the card in the
 * originating column (status set by the "+"); edit mode pre-fills every field
 * and PATCHes. Status is never changed here — that goes through move().
 */
interface CardModalOpts {
  card?: Card;
  status?: CardStatus;
  roster: Assignee[];
  projects: string[];
  onSaved: () => void;
}

function isoFromDateInput(v: string): string | null {
  return v ? new Date(`${v}T00:00:00`).toISOString() : null;
}
function dateInputFromIso(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

export function openCardModal(opts: CardModalOpts): void {
  const editing = opts.card !== undefined;
  const card = opts.card;

  const titleEl = h('input', { type: 'text', placeholder: t('kanban.new.titlePlaceholder'), value: card?.title ?? '' }) as HTMLInputElement;
  const descEl = h('textarea', { rows: 3, placeholder: t('kanban.new.descPlaceholder') }) as HTMLTextAreaElement;
  descEl.value = card?.description ?? '';
  const assigneeEl = h(
    'select',
    null,
    h('option', { value: '', selected: !card?.assignee }, t('kanban.assignee.none')),
    ...opts.roster.map((a) => h('option', { value: a.id, selected: card?.assignee?.toLowerCase() === a.id.toLowerCase() }, assigneeLabel(a))),
  ) as HTMLSelectElement;
  const priorityEl = h(
    'select',
    null,
    ...PRIORITIES.map((p) => h('option', { value: p, selected: (card?.priority ?? 'normal') === p }, priorityLabel(p))),
  ) as HTMLSelectElement;
  const dueEl = h('input', { type: 'date', value: dateInputFromIso(card?.dueAt ?? null) }) as HTMLInputElement;
  const projectListId = 'kanban-projects-list';
  const projectEl = h('input', { type: 'text', placeholder: t('kanban.new.projectPlaceholder'), value: card?.project ?? '', list: projectListId }) as HTMLInputElement;
  const projectList = h('datalist', { id: projectListId }, ...opts.projects.map((p) => h('option', { value: p })));

  const backdrop = h('div', { class: 'modal-backdrop' });
  const close = (): void => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    document.body.classList.remove('modal-open');
  };
  const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

  const field = (labelKey: string, control: HTMLElement): HTMLElement => h('div', { class: 'field' }, h('label', null, t(labelKey)), control);

  const save = async (e: Event): Promise<void> => {
    const title = titleEl.value.trim();
    if (title === '') { titleEl.focus(); return; }
    const btn = e.currentTarget as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = t('kanban.new.saving');
    const payload = {
      title,
      description: descEl.value,
      assignee: assigneeEl.value,
      priority: priorityEl.value,
      project: projectEl.value.trim() || null,
      dueAt: isoFromDateInput(dueEl.value),
    };
    try {
      if (editing && card) {
        await api.patch(`/api/kanban/cards/${card.id}`, payload);
        toast(t('kanban.updated'));
      } else {
        const created = await api.post<Card>('/api/kanban/cards', payload);
        const target = opts.status ?? 'planned';
        if (target !== 'planned') await api.post(`/api/kanban/cards/${created.id}/move`, { status: target });
        toast(t('kanban.created'));
      }
      close();
      opts.onSaved();
    } catch (err) {
      toast(t('kanban.saveError', { msg: err instanceof ApiError ? err.message : String(err) }), true);
      btn.disabled = false;
      btn.textContent = t('kanban.new.save');
    }
  };

  backdrop.append(
    h(
      'div',
      { class: 'modal card-modal' },
      h('div', { class: 'agent-modal-titlebar' }, h('h2', null, editing ? t('kanban.edit.title') : t('kanban.new.title')), h('button', { class: 'icon-btn', 'aria-label': t('kanban.close'), onclick: close }, '✕')),
      field('kanban.new.titleLabel', titleEl),
      field('kanban.new.descLabel', descEl),
      h('div', { class: 'field-row' }, field('kanban.new.assigneeLabel', assigneeEl), field('kanban.new.priorityLabel', priorityEl)),
      h('div', { class: 'field-row' }, field('kanban.new.dueLabel', dueEl), field('kanban.new.projectLabel', projectEl)),
      projectList,
      h('div', { class: 'modal-actions' }, h('button', { class: 'primary', onclick: (e: Event) => void save(e) }, t('kanban.new.save'))),
    ),
  );
  document.body.append(backdrop);
  document.body.classList.add('modal-open');
  titleEl.focus();
}
