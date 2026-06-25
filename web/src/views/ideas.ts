// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * Idea Box (Ötletláda) view (PROMPT-11): the operator's capture-and-triage
 * inbox. A header (category + status filters + "new idea"), a global counter
 * strip (computed from the unfiltered active + archived reads, never narrowed by
 * the filters), and a category-grouped list of compact idea cards with
 * status-dependent inline actions. Three modals: create/edit, the promote
 * phase-picker, and the shared breakdown proposal (reused from the board).
 */

import { defineView } from './registry.js';
import { h, mount } from '../dom.js';
import { t, currentLocale } from '../i18n.js';
import { api, ApiError } from '../api.js';
import { icon } from '../icons.js';
import { toast } from '../toast.js';
import { openBreakdown } from '../kanban/breakdownModal.js';
import type { Assignee, CardPriority } from '../kanban/model.js';
import type { Store } from '../store.js';
import type { AppState } from '../main.js';

type IdeaStatus = 'new' | 'reviewed' | 'kanban' | 'rejected' | 'archived';
type StatusFilter = 'active' | IdeaStatus;

interface Idea {
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

/** Counter tiles + status-filter options, in their fixed display order. */
const COUNTER_ORDER: IdeaStatus[] = ['new', 'reviewed', 'kanban', 'rejected', 'archived'];
const STATUS_FILTERS: StatusFilter[] = ['active', 'new', 'reviewed', 'kanban', 'rejected', 'archived'];
/** Seed category keys for the create/edit modal (stored as their localized label). */
const CATEGORY_KEYS = ['sales', 'education', 'automation', 'integration', 'system', 'other'] as const;

// Filter selections survive the re-render cycle (module state).
let categoryFilter = '';
let statusFilter: StatusFilter = 'active';

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(currentLocale());
}

function statusLabel(s: IdeaStatus | 'active'): string {
  return s === 'active' ? t('ideas.filter.active') : t(`ideas.status.${s}`);
}

function statusPill(s: IdeaStatus): HTMLElement {
  return h('span', { class: `badge idea-pill idea-pill-${s}` }, statusLabel(s));
}

function show404OrError(err: unknown, fallbackKey: string): void {
  if (err instanceof ApiError && err.status === 404) toast(t('ideas.notFound'), true);
  else toast(err instanceof ApiError ? err.message : t(fallbackKey), true);
}

async function render(host: HTMLElement, store: Store<AppState>): Promise<void> {
  const reload = (): void => void render(host, store);

  let list: Idea[] = [];
  let categories: string[] = [];
  let active: Idea[] = [];
  let archived: Idea[] = [];
  try {
    const q = `/api/ideas?status=${statusFilter}${categoryFilter !== '' ? `&category=${encodeURIComponent(categoryFilter)}` : ''}`;
    [list, categories, active, archived] = await Promise.all([
      api.get<Idea[]>(q),
      api.get<string[]>('/api/ideas/categories'),
      api.get<Idea[]>('/api/ideas?status=active'),
      api.get<Idea[]>('/api/ideas?status=archived'),
    ]);
  } catch {
    /* read failure: render chrome with empty data; a filter change retries */
  }
  // A category that no longer exists falls back to "all".
  if (categoryFilter !== '' && !categories.includes(categoryFilter)) categoryFilter = '';

  // ---------- create / edit modal ----------
  const openEditor = (existing?: Idea): void => {
    const backdrop = h('div', { class: 'modal-backdrop' });
    const close = (): void => { backdrop.remove(); document.body.classList.remove('modal-open'); document.removeEventListener('keydown', onKey); };
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

    const titleEl = h('input', { type: 'text', value: existing?.title ?? '', placeholder: t('ideas.field.titlePlaceholder') }) as HTMLInputElement;
    const descEl = h('textarea', { rows: 4, placeholder: t('ideas.field.descriptionPlaceholder') }, existing?.description ?? '') as HTMLTextAreaElement;
    const seedOptions = CATEGORY_KEYS.map((k) => t(`ideas.cat.${k}`));
    // include an agent-created category that isn't in the seed list so edit preserves it
    if (existing && existing.category !== '' && !seedOptions.includes(existing.category)) seedOptions.unshift(existing.category);
    const catEl = h('select', null, ...seedOptions.map((c) => h('option', { value: c, selected: existing?.category === c }, c))) as HTMLSelectElement;

    const save = async (e: Event): Promise<void> => {
      const title = titleEl.value.trim();
      if (title === '') { toast(t('ideas.toast.titleRequired'), true); titleEl.focus(); return; }
      const btn = e.currentTarget as HTMLButtonElement; btn.disabled = true;
      const description = descEl.value.trim();
      const category = catEl.value;
      try {
        if (existing) {
          await api.put(`/api/ideas/${existing.id}`, { title, description, category });
        } else {
          await api.post('/api/ideas', { title, description, category, source: 'manual', status: 'new' });
        }
        close(); toast(t('ideas.saved')); reload();
      } catch (err) { show404OrError(err, 'ideas.error'); btn.disabled = false; }
    };

    const field = (labelKey: string, ctrl: HTMLElement): HTMLElement => h('div', { class: 'field' }, h('label', null, t(labelKey)), ctrl);
    backdrop.append(h('div', { class: 'modal idea-editor-modal' },
      h('div', { class: 'agent-modal-titlebar' }, h('h2', null, t(existing ? 'ideas.modal.editTitle' : 'ideas.modal.createTitle')), h('button', { class: 'icon-btn', 'aria-label': t('ideas.btn.cancel'), onclick: close }, '✕')),
      h('div', { class: 'agent-modal-body' },
        field('ideas.field.title', titleEl),
        field('ideas.field.description', descEl),
        field('ideas.field.category', catEl),
      ),
      h('div', { class: 'modal-actions' },
        h('button', { onclick: close }, t('ideas.btn.cancel')),
        h('button', { class: 'primary', onclick: (e: Event) => void save(e) }, t('ideas.btn.save')),
      ),
    ));
    document.body.append(backdrop); document.body.classList.add('modal-open');
    setTimeout(() => titleEl.focus(), 0);
  };

  // ---------- promote phase-picker modal ----------
  const openPhasePicker = (idea: Idea): void => {
    const backdrop = h('div', { class: 'modal-backdrop' });
    const close = (): void => { backdrop.remove(); document.body.classList.remove('modal-open'); document.removeEventListener('keydown', onKey); };
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

    const promote = async (phase: 'detail' | 'plan'): Promise<void> => {
      try {
        const res = await api.post<{ card: { id: number } }>(`/api/ideas/${idea.id}/promote`, { phase });
        close(); toast(t('ideas.toast.kanbanCreated', { id: res.card.id })); reload();
      } catch (err) { show404OrError(err, 'ideas.error'); }
    };
    backdrop.append(h('div', { class: 'modal idea-phase-modal' },
      h('div', { class: 'agent-modal-titlebar' }, h('h2', null, t('ideas.promote.title')), h('button', { class: 'icon-btn', 'aria-label': t('ideas.btn.cancel'), onclick: close }, '✕')),
      h('div', { class: 'agent-modal-body' },
        h('div', { class: 'field-note' }, t('ideas.promote.prompt')),
        h('button', { class: 'phase-choice', onclick: () => void promote('detail') }, h('strong', null, t('ideas.promote.detail'))),
        h('button', { class: 'phase-choice primary', onclick: () => void promote('plan') }, h('strong', null, t('ideas.promote.plan'))),
      ),
      h('div', { class: 'modal-actions' }, h('button', { onclick: close }, t('ideas.btn.cancel'))),
    ));
    document.body.append(backdrop); document.body.classList.add('modal-open');
  };

  // ---------- AI breakdown promote ----------
  const startAiBreakdown = async (idea: Idea): Promise<void> => {
    let roster: Assignee[] = [];
    try { roster = await api.get<Assignee[]>('/api/kanban/assignees'); } catch { roster = []; }
    toast(t('ideas.toast.aiElaborating'));
    let draft: { subtasks: Array<{ title: string; assignee: string; priority: CardPriority }> };
    try {
      draft = await api.post<{ subtasks: Array<{ title: string; assignee: string; priority: CardPriority }> }>(`/api/ideas/${idea.id}/breakdown`);
    } catch (err) { show404OrError(err, 'ideas.toast.breakdownError'); return; }
    if (!Array.isArray(draft.subtasks) || draft.subtasks.length === 0) { toast(t('ideas.toast.noSubtasks'), true); return; }
    openBreakdown({ mode: 'idea', ideaId: idea.id, parentTitle: idea.title, roster, seed: draft.subtasks, onAccepted: () => reload() });
  };

  // ---------- inline lifecycle actions ----------
  const changeStatus = async (idea: Idea, status: IdeaStatus): Promise<void> => {
    try { await api.put(`/api/ideas/${idea.id}`, { status }); reload(); }
    catch (err) { show404OrError(err, 'ideas.toast.statusFail'); }
  };
  const archive = async (idea: Idea): Promise<void> => {
    try { await api.post(`/api/ideas/${idea.id}/archive`); toast(t('ideas.toast.archived')); reload(); }
    catch (err) { show404OrError(err, 'ideas.toast.archiveFail'); }
  };
  const remove = async (idea: Idea): Promise<void> => {
    if (!window.confirm(t('ideas.confirm.delete'))) return;
    try { await api.delete(`/api/ideas/${idea.id}`); reload(); }
    catch (err) { show404OrError(err, 'ideas.error'); }
  };

  // ---------- a single idea card ----------
  const mini = (labelKey: string, cls: string, onclick: () => void): HTMLElement =>
    h('button', { class: `btn-mini ${cls}`, onclick }, t(labelKey));

  const ideaCard = (idea: Idea): HTMLElement => {
    const actions: HTMLElement[] = [];
    if (idea.status === 'archived') {
      const note = idea.archivedAt ? t('ideas.card.archivedAt', { date: fmtDate(idea.archivedAt) }) : t('ideas.card.archivedNoDate');
      actions.push(h('span', { class: 'idea-archived-note muted-note' }, note));
    } else {
      if (idea.status === 'new' || idea.status === 'rejected') actions.push(mini('ideas.btn.reviewed', '', () => void changeStatus(idea, 'reviewed')));
      if (idea.status !== 'rejected') actions.push(mini('ideas.btn.reject', 'danger', () => void changeStatus(idea, 'rejected')));
      if (idea.status === 'reviewed' || idea.status === 'rejected') actions.push(mini('ideas.btn.reopen', '', () => void changeStatus(idea, 'new')));
      actions.push(mini('ideas.btn.edit', '', () => openEditor(idea)));
      if (idea.status !== 'kanban' && idea.status !== 'rejected') {
        actions.push(mini('ideas.btn.toKanban', 'primary', () => void startAiBreakdown(idea)));
        actions.push(mini('ideas.btn.toKanbanPhase', '', () => openPhasePicker(idea)));
      }
      actions.push(mini('ideas.btn.archive', '', () => void archive(idea)));
      actions.push(mini('ideas.btn.delete', 'danger', () => void remove(idea)));
    }
    const main = h('div', { class: 'idea-main' },
      h('div', { class: 'idea-card-row1' }, h('span', { class: 'idea-card-title' }, idea.title), statusPill(idea.status)),
    );
    if (idea.description !== null && idea.description.trim() !== '') {
      main.append(h('div', { class: 'idea-card-desc' }, idea.description));
    }
    return h('div', { class: 'idea-card' }, main, h('div', { class: 'idea-card-actions' }, ...actions));
  };

  // ---------- counter strip (global, filter-independent) ----------
  const counts: Record<IdeaStatus, number> = { new: 0, reviewed: 0, kanban: 0, rejected: 0, archived: archived.length };
  for (const i of active) if (i.status !== 'archived') counts[i.status] += 1;
  const counterStrip = h('div', { class: 'stat-row idea-counters' },
    ...COUNTER_ORDER.map((s) => h('div', { class: `stat-card idea-counter idea-counter-${s}` },
      h('div', { class: 'stat-value' }, String(counts[s])),
      h('div', { class: 'stat-label' }, statusLabel(s)),
    )),
  );

  // ---------- header controls ----------
  const catSelect = h('select', { class: 'idea-filter', onchange: (e: Event) => { categoryFilter = (e.target as HTMLSelectElement).value; reload(); } },
    h('option', { value: '', selected: categoryFilter === '' }, t('ideas.filter.allCategories')),
    ...categories.map((c) => h('option', { value: c, selected: c === categoryFilter }, c)),
  );
  const statusSelect = h('select', { class: 'idea-filter', onchange: (e: Event) => { statusFilter = (e.target as HTMLSelectElement).value as StatusFilter; reload(); } },
    ...STATUS_FILTERS.map((s) => h('option', { value: s, selected: s === statusFilter }, statusLabel(s))),
  );

  // ---------- grouped list ----------
  const groups = new Map<string, Idea[]>();
  for (const idea of list) {
    const arr = groups.get(idea.category);
    if (arr) arr.push(idea); else groups.set(idea.category, [idea]);
  }
  const listArea = h('div', { class: 'idea-list' });
  if (list.length === 0) {
    mount(listArea, h('div', { class: 'empty-block idea-empty' }, h('div', { class: 'muted-note' }, t('ideas.emptyList'))));
  } else {
    mount(listArea, ...[...groups.entries()].map(([cat, items]) =>
      h('div', { class: 'idea-group' },
        h('div', { class: 'idea-group-head' }, cat),
        ...items.map(ideaCard),
      ),
    ));
  }

  mount(host,
    h('div', { class: 'page-header ideas-header' },
      h('div', null, h('h1', null, t('ideas.title')), h('p', { class: 'subtitle' }, t('ideas.subtitle'))),
      h('div', { class: 'ideas-header-controls' }, catSelect, statusSelect,
        h('button', { class: 'primary ideas-new-btn', onclick: () => openEditor() }, icon('plus', 16), t('ideas.newIdea')),
      ),
    ),
    counterStrip,
    listArea,
  );
}

defineView('ideas', 'nav.ideas', (host, store) => {
  void render(host, store);
});
