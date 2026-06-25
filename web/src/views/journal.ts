// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * Recall / Log (Napló) page (PROMPT-09 §B): a cross-agent search + timeline that
 * merges daily-log entries and memory records into one date-grouped, chronological
 * feed. The date / natural-language-date expression is resolved SERVER-side (so
 * "tegnap"/"last week" math is timezone-correct); free text adds a content filter;
 * the agent filter narrows scope. Read-only — no modals, no per-item actions.
 */

import { defineView } from './registry.js';
import { h, mount } from '../dom.js';
import { t } from '../i18n.js';
import { api, ApiError } from '../api.js';
import { icon } from '../icons.js';
import { todayYmd } from '../memory/dateExpr.js';
import { tierLabel, splitKeywords, type RosterAgent, type Tier } from '../memory/model.js';
import type { Store } from '../store.js';
import type { AppState } from '../main.js';

interface LogItem { agentId: string; line: string; createdAt: string; createdLabel: string }
interface MemItem { id: number; agentId: string; category: string; content: string; keywords: string; createdAt: string; createdLabel: string }
interface Recall { dateRange: { from: string; to: string }; logs: LogItem[]; memories: MemItem[]; summary: { logCount: number; memoryCount: number; agents: string[] } }

let agentFilter = '';

/** Exported so the merged Activity/Log view (#144) can embed the Napló viewpoint. */
export function renderJournal(host: HTMLElement, store: Store<AppState>): void {
  void store;
  let roster: RosterAgent[] = [];
  const labelOf = (id: string): string => roster.find((a) => a.id === id)?.displayName ?? id;
  const localDay = (iso: string): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Budapest', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));

  const summaryEl = h('div', { class: 'recall-summary' });
  const timeline = h('div', { class: 'recall-timeline' });

  const searchEl = h('input', { type: 'text', class: 'mem-search', placeholder: t('journal.searchPlaceholder') }) as HTMLInputElement;
  const dateEl = h('input', { type: 'date', value: todayYmd() }) as HTMLInputElement;
  const exprEl = h('input', { type: 'text', placeholder: t('journal.exprPlaceholder') }) as HTMLInputElement;
  const agentSel = h('select', { 'aria-label': t('journal.agentFilter') }) as HTMLSelectElement;

  const runRecall = async (): Promise<void> => {
    const expr = exprEl.value.trim();
    const date = expr || dateEl.value.trim();
    const text = searchEl.value.trim();
    mount(timeline, h('div', { class: 'muted-note center' }, t('journal.loading')));
    mount(summaryEl);
    const params = new URLSearchParams();
    if (date) params.set('date', date);
    else if (!text) params.set('date', todayYmd()); // default to today when nothing else is given
    if (text) params.set('q', text);
    if (agentFilter !== '') params.set('agent', agentFilter);
    try {
      const r = await api.get<Recall>(`/api/journal?${params.toString()}`);
      renderSummary(r);
      renderTimeline(r);
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) {
        mount(timeline, h('div', { class: 'muted-note err center' }, t('journal.badDate', { x: expr || date })));
      } else if (err instanceof ApiError) {
        mount(timeline, h('div', { class: 'muted-note err center' }, err.message));
      } else {
        mount(timeline, h('div', { class: 'muted-note err center' }, t('journal.netError')));
      }
    }
  };

  const renderSummary = (r: Recall): void => {
    const rangeText = r.dateRange.from === '' ? t('journal.search') : r.dateRange.from === r.dateRange.to ? r.dateRange.from : `${r.dateRange.from} – ${r.dateRange.to}`;
    mount(summaryEl,
      h('span', { class: 'rs-range' }, rangeText),
      h('span', null, t('journal.logCount', { n: r.summary.logCount })),
      h('span', null, t('journal.memCount', { n: r.summary.memoryCount })),
      r.summary.agents.length > 0 ? h('span', null, t('journal.agents', { list: r.summary.agents.map(labelOf).join(', ') })) : null,
    );
  };

  const renderTimeline = (r: Recall): void => {
    interface Item { ts: string; label: string; kind: 'log' | 'mem'; agentId: string; text: string; category?: string; keywords?: string }
    const items: Item[] = [
      ...r.logs.map((l) => ({ ts: l.createdAt, label: l.createdLabel, kind: 'log' as const, agentId: l.agentId, text: l.line })),
      ...r.memories.map((m) => ({ ts: m.createdAt, label: m.createdLabel, kind: 'mem' as const, agentId: m.agentId, text: m.content, category: m.category, keywords: m.keywords })),
    ].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

    if (items.length === 0) { mount(timeline, h('div', { class: 'muted-note center' }, t('journal.empty'))); return; }

    const nodes: HTMLElement[] = [];
    let curDay = '';
    for (const it of items) {
      const day = localDay(it.ts);
      if (day !== curDay) { curDay = day; nodes.push(h('div', { class: 'tl-day-header' }, day)); }
      const kws = it.keywords ? splitKeywords(it.keywords) : [];
      nodes.push(h('div', { class: `recall-item ${it.kind}` },
        h('div', { class: 'ri-head' },
          h('span', { class: 'ri-time' }, it.label),
          it.kind === 'mem' && it.category ? h('span', { class: `badge tier-badge tier-${it.category}` }, tierLabel(it.category as Tier)) : null,
          h('span', { class: 'badge muted' }, labelOf(it.agentId)),
        ),
        h('div', { class: 'ri-text' }, it.text),
        kws.length > 0 ? h('div', { class: 'ri-kw' }, t('journal.keywords', { list: kws.join(', ') })) : null,
      ));
    }
    mount(timeline, ...nodes);
  };

  searchEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') void runRecall(); });
  exprEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') void runRecall(); });
  agentSel.addEventListener('change', () => { agentFilter = agentSel.value; void refreshHint(); });

  const refreshHint = async (): Promise<void> => {
    try {
      const dates = await api.get<string[]>(`/api/daily-log/dates${agentFilter ? `?agent=${encodeURIComponent(agentFilter)}` : ''}`);
      dateEl.title = t('journal.daysWithLog', { n: dates.length });
    } catch { /* best-effort */ }
  };

  mount(host,
    h('div', { class: 'page-header' }, h('h1', null, t('journal.title')), h('p', { class: 'subtitle' }, t('journal.subtitle'))),
    h('div', { class: 'recall-toolbar' },
      h('div', { class: 'mem-search-wrap' }, icon('search', 16), searchEl),
      dateEl,
      exprEl,
      agentSel,
      h('button', { class: 'primary', onclick: () => void runRecall() }, t('journal.search')),
    ),
    summaryEl,
    timeline,
  );

  const load = async (): Promise<void> => {
    try {
      roster = await api.get<RosterAgent[]>('/api/agents');
      mount(agentSel, h('option', { value: '' }, t('journal.allAgents')), ...roster.map((a) => h('option', { value: a.id }, a.displayName)));
      void refreshHint();
      void runRecall();
    } catch { mount(timeline, h('div', { class: 'muted-note err center' }, t('journal.netError'))); }
  };
  void load();
}

defineView('journal', 'nav.journal', renderJournal);
