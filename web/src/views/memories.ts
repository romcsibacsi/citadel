// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * Memory (Memória) view (PROMPT-08): the AI team's shared knowledge base. A stats
 * strip, a search/mode/agent toolbar, a tab strip (Hot/Warm/Cold/Shared tier
 * filters + Graph + Log lenses), the create/edit modal, and a force-directed
 * graph lens. Action-driven (no auto-poll). Vector/embedding search is absent on
 * a subscription-only host, so both search modes use FTS and the vectors card is
 * omitted (see PROGRESS ASSUMPTIONS).
 */

import { defineView } from './registry.js';
import { h, mount } from '../dom.js';
import { makeDebouncer } from '../debounce.js';
import { t, currentLocale } from '../i18n.js';
import { api } from '../api.js';
import { icon } from '../icons.js';
import { toast } from '../toast.js';
import { openMemoryModal } from '../memory/memoryModal.js';
import { renderGraph, type GraphController } from '../memory/graph.js';
import { todayYmd, shiftYmd } from '../memory/dateExpr.js';
import { TIERS, TIER_EMOJI, tierLabel, fmtMemDate, splitKeywords, classifyTier, splitImportChunks, type Memory, type MemoryStats, type RosterAgent, type Tier } from '../memory/model.js';
import type { Store } from '../store.js';
import type { AppState } from '../main.js';

type Tab = Tier | 'graph' | 'log';
let activeTab: Tab = 'hot';
let agentFilter = '';
let searchQuery = '';
let searchMode = 'hybrid';
let logDate = '';

function render(host: HTMLElement, store: Store<AppState>): void {
  void store;
  if (logDate === '') logDate = todayYmd();
  let roster: RosterAgent[] = [];
  let graph: GraphController | null = null;
  let embeddingEnabled = false; // set from stats; gates whether Hybrid search is real

  const labelOf = (id: string): string => roster.find((a) => a.id === id)?.displayName ?? id;

  const statsStrip = h('div', { class: 'mem-stats stat-row' });
  const toolbar = h('div', { class: 'mem-toolbar' });
  const tabStrip = h('div', { class: 'mem-tabs' });
  const body = h('div', { class: 'mem-body' });

  // ---------------------------------------------------------------- data
  const fetchMemories = async (tier?: Tier, q?: string, limit = 100): Promise<Memory[]> => {
    const agents = agentFilter ? [agentFilter] : roster.map((a) => a.id);
    const dedupe = new Map<number, Memory>();
    for (const ag of agents) {
      const rows = q && q.trim() !== ''
        ? await api.get<Memory[]>(`/api/memories/search?agent=${encodeURIComponent(ag)}&q=${encodeURIComponent(q)}&mode=${searchMode}`)
        : await api.get<Memory[]>(`/api/memories?agent=${encodeURIComponent(ag)}${tier ? `&category=${tier}` : ''}&limit=${limit}`);
      for (const r of rows) dedupe.set(r.id, r);
    }
    let list = [...dedupe.values()];
    if (q && q.trim() !== '' && tier) list = list.filter((m) => m.category === tier);
    list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return list;
  };

  const loadStats = async (): Promise<void> => {
    try {
      const s = await api.get<MemoryStats>(`/api/memories/stats${agentFilter ? `?agent=${encodeURIComponent(agentFilter)}` : ''}`);
      embeddingEnabled = s.embeddingEnabled === true;
      if (!embeddingEnabled) searchMode = 'fts'; // no provider → keyword-only, honestly
      mount(statsStrip,
        h('div', { class: 'stat-card' }, h('div', { class: 'stat-label' }, t('memory.stat.total')), h('div', { class: 'stat-value' }, String(s.total))),
        ...TIERS.filter((tier) => s.byCategory[tier] > 0).map((tier) =>
          h('div', { class: `stat-card tier-${tier}` }, h('div', { class: 'stat-label' }, tierLabel(tier)), h('div', { class: 'stat-value' }, String(s.byCategory[tier])))),
      );
    } catch { /* keep last */ }
  };

  // ---------------------------------------------------------------- list lens
  const memCard = (m: Memory): HTMLElement => {
    const kws = splitKeywords(m.keywords);
    const collapsed = m.content.length > 120 ? `${m.content.slice(0, 120)}…` : m.content;
    const contentEl = h('div', { class: 'mem-content' }, collapsed);
    let open = false;
    return h('div', { class: 'mem-card', onclick: (e: Event) => {
      if ((e.target as HTMLElement).closest('button')) return;
      open = !open; contentEl.textContent = open ? m.content : collapsed;
    } },
      h('div', { class: 'mem-head' },
        h('span', { class: `badge tier-badge tier-${m.category}` }, tierLabel(m.category)),
        h('span', { class: 'badge muted' }, labelOf(m.agentId)),
        h('span', { class: 'mem-date' }, fmtMemDate(m.createdAt)),
        h('span', { class: 'mem-salience', title: t('memory.salienceTip') }, `S: ${m.salience.toFixed(2)}`),
      ),
      contentEl,
      kws.length > 0 ? h('div', { class: 'mem-keywords' }, ...kws.map((k) => h('span', { class: 'kw-chip' }, k))) : null,
      h('div', { class: 'mem-foot' },
        h('button', { class: 'mem-edit', onclick: () => openMemoryModal({ memory: m, roster, onSaved: reloadLens }) }, t('memory.edit')),
        h('button', { class: 'mem-del danger', onclick: () => void del(m) }, t('memory.delete')),
      ),
    );
  };

  const del = async (m: Memory): Promise<void> => {
    if (!window.confirm(t('memory.deleteConfirm'))) return;
    try { await api.delete(`/api/memories/${m.id}`); toast(t('memory.deleted')); reloadLens(); void loadStats(); }
    catch { toast(t('memory.deleteError'), true); }
  };

  const renderList = async (): Promise<void> => {
    mount(body, h('div', { class: 'muted-note' }, t('memory.loading')));
    const list = await fetchMemories(activeTab as Tier, searchQuery);
    if (list.length === 0) { mount(body, h('div', { class: 'empty-block' }, icon('brain', 40), h('div', { class: 'muted-note' }, t('memory.emptyList')))); return; }
    mount(body, h('div', { class: 'mem-list' }, ...list.map(memCard)));
  };

  // ---------------------------------------------------------------- graph lens
  const renderGraphLens = async (): Promise<void> => {
    const list = await fetchMemories(undefined, '', 200);
    if (list.length < 2) { mount(body, h('div', { class: 'empty-block' }, h('div', { class: 'muted-note' }, t('memory.emptyGraph')))); return; }
    const canvas = h('canvas', { class: 'mem-canvas' }) as HTMLCanvasElement;
    const hint = h('div', { class: 'graph-hint' }, t('memory.graphHint'));
    const zoomInd = h('div', { class: 'zoom-ind', style: 'opacity:0' });
    const tooltip = h('div', { class: 'graph-tooltip', style: 'display:none' });
    const panel = h('div', { class: 'graph-detail', style: 'display:none' });
    mount(body, h('div', { class: 'graph-wrap' }, canvas, hint, zoomInd, tooltip, panel));

    let zoomTimer = 0;
    const showDetail = (m: Memory): void => {
      const kws = splitKeywords(m.keywords);
      mount(panel,
        h('div', { class: 'gd-head' },
          h('span', { class: `badge tier-badge tier-${m.category}` }, tierLabel(m.category)),
          h('span', { class: 'badge muted' }, labelOf(m.agentId)),
          h('button', { class: 'icon-btn', 'aria-label': t('memory.close'), onclick: () => { panel.style.display = 'none'; } }, '✕'),
        ),
        h('div', { class: 'gd-date' }, fmtMemDate(m.createdAt)),
        h('div', { class: 'gd-content' }, m.content),
        kws.length > 0 ? h('div', { class: 'mem-keywords' }, ...kws.map((k) => h('span', { class: 'kw-chip' }, k))) : null,
      );
      panel.style.display = '';
    };

    graph = renderGraph(canvas, list, {
      onClick: (m) => showDetail(m),
      onDblClick: (m) => openMemoryModal({ memory: m, roster, onSaved: reloadLens }),
      onHover: (m, cx, cy, conns) => {
        if (!m || panel.style.display !== 'none') { tooltip.style.display = 'none'; return; }
        const kws = splitKeywords(m.keywords).slice(0, 3).join(', ');
        mount(tooltip, h('div', { class: 'tt-title' }, `${t(`memory.tier.${m.category}`)} | ${labelOf(m.agentId)}`), h('div', { class: 'tt-sub' }, t('memory.connections', { n: conns })), kws ? h('div', { class: 'tt-kw' }, kws) : null);
        const rect = canvas.getBoundingClientRect();
        tooltip.style.left = `${cx - rect.left + 12}px`;
        tooltip.style.top = `${cy - rect.top + 12}px`;
        tooltip.style.display = '';
      },
      onZoom: (pct) => { zoomInd.textContent = `${pct}%`; zoomInd.style.opacity = '1'; clearTimeout(zoomTimer); zoomTimer = window.setTimeout(() => { zoomInd.style.opacity = '0'; }, 1200); },
    });
    graph.setSearch(searchQuery);
  };

  // ---------------------------------------------------------------- log lens (daily-log reader, PROMPT-09)
  const longDay = (ymd: string): string => {
    const d = new Date(`${ymd}T12:00:00`);
    return Number.isNaN(d.getTime()) ? ymd : d.toLocaleDateString(currentLocale() === 'hu' ? 'hu-HU' : 'en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  };
  const hhmm = (iso: string): string => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : new Intl.DateTimeFormat('hu-HU', { timeZone: 'Europe/Budapest', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  };
  const renderLog = async (): Promise<void> => {
    const nav = h('div', { class: 'log-nav' },
      h('button', { class: 'icon-btn', title: t('memory.prevDay'), onclick: () => { logDate = shiftYmd(logDate, -1); void renderLog(); } }, '‹'),
      h('span', { class: 'log-date' }, longDay(logDate)),
      h('button', { class: 'icon-btn', title: t('memory.nextDay'), onclick: () => { logDate = shiftYmd(logDate, 1); void renderLog(); } }, '›'),
    );
    const listEl = h('div', { class: 'log-entries' }, h('div', { class: 'muted-note' }, t('memory.loading')));
    mount(body, h('div', { class: 'log-lens' }, nav, listEl));
    // the daily-log reader needs exactly one agent; "all" falls back to the first
    const agent = agentFilter || roster[0]?.id || '';
    try {
      const entries = await api.get<Array<{ id: number; content: string; createdAt: string }>>(`/api/daily-log?agent=${encodeURIComponent(agent)}&date=${logDate}`);
      if (entries.length === 0) { mount(listEl, h('div', { class: 'muted-note center' }, t('memory.emptyLog'))); return; }
      mount(listEl, ...entries.map((e) => h('div', { class: 'log-entry' },
        h('span', { class: 'log-time' }, hhmm(e.createdAt)),
        h('div', { class: 'log-text' }, e.content))));
    } catch { mount(listEl, h('div', { class: 'muted-note center' }, t('memory.emptyLog'))); }
  };

  // ---------------------------------------------------------------- lens switch
  const reloadLens = (): void => {
    if (graph) { graph.destroy(); graph = null; }
    if (activeTab === 'graph') void renderGraphLens();
    else if (activeTab === 'log') void renderLog();
    else void renderList();
  };

  // ---------------------------------------------------------------- toolbar + tabs
  const buildToolbar = (): void => {
    const searchEl = h('input', { type: 'text', class: 'mem-search', placeholder: t('memory.searchPlaceholder'), value: searchQuery }) as HTMLInputElement;
    const debounced = makeDebouncer(reloadLens, 300); // shared util (FIX-hardening C2)
    searchEl.addEventListener('input', () => {
      searchQuery = searchEl.value;
      if (activeTab === 'graph') { graph?.setSearch(searchQuery); return; }
      debounced.call();
    });
    searchEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') debounced.flush(); });
    // Honest mode dropdown (FIX-08): show "Hibrid" only when a vector provider is
    // actually wired; otherwise expose a single, clearly-labelled FTS-only option
    // (no silent pretending that keyword and hybrid differ).
    const modeSel = (embeddingEnabled
      ? h('select', { 'aria-label': t('memory.searchMode') },
          h('option', { value: 'hybrid', selected: searchMode === 'hybrid' }, t('memory.modeHybrid')),
          h('option', { value: 'fts', selected: searchMode === 'fts' }, t('memory.modeKeyword')))
      : h('select', { 'aria-label': t('memory.searchMode'), disabled: true, title: t('memory.modeFtsOnlyTip') },
          h('option', { value: 'fts', selected: true }, t('memory.modeKeywordOnly')))) as HTMLSelectElement;
    modeSel.addEventListener('change', () => { searchMode = modeSel.value; if (searchQuery.trim()) reloadLens(); });
    const agentSel = h('select', { 'aria-label': t('memory.agentFilter') }, h('option', { value: '', selected: agentFilter === '' }, t('memory.allAgents')), ...roster.map((a) => h('option', { value: a.id, selected: agentFilter === a.id }, a.displayName))) as HTMLSelectElement;
    agentSel.addEventListener('change', () => { agentFilter = agentSel.value; void loadStats(); reloadLens(); });
    mount(toolbar, h('div', { class: 'mem-search-wrap' }, icon('search', 16), searchEl), modeSel, agentSel);
  };

  const buildTabs = (): void => {
    const tab = (id: Tab, label: string): HTMLElement => h('button', { class: `mem-tab${activeTab === id ? ' active' : ''}`, onclick: () => { activeTab = id; buildTabs(); reloadLens(); } }, label);
    mount(tabStrip, ...TIERS.map((tier) => tab(tier, tierLabel(tier))), tab('graph', `🕸️ ${t('memory.tab.graph')}`), tab('log', `📋 ${t('memory.tab.log')}`));
  };

  // ---------------------------------------------------------------- import
  // Splits pasted text into sensible chunks (markdown headings / paragraphs, not
  // bare newlines), auto-classifies each into a tier via a deterministic
  // heuristic (no local model on a subscription-only host), and reports a
  // per-tier breakdown of what landed where (FIX-08 §4).
  const openImport = (): void => {
    const ta = h('textarea', { rows: 8, placeholder: t('memory.importPlaceholder') }) as HTMLTextAreaElement;
    const agentSel = h('select', null, ...roster.map((a) => h('option', { value: a.id }, a.displayName))) as HTMLSelectElement;
    const backdrop = h('div', { class: 'modal-backdrop' });
    const close = (): void => { backdrop.remove(); document.body.classList.remove('modal-open'); };
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    const body = h('div', { class: 'mem-import-body' });

    const run = async (e: Event): Promise<void> => {
      const chunks = splitImportChunks(ta.value);
      if (chunks.length === 0) { ta.focus(); return; }
      (e.currentTarget as HTMLButtonElement).disabled = true;
      const tally: Record<Tier, number> = { hot: 0, warm: 0, cold: 0, shared: 0 };
      let failed = 0;
      for (const chunk of chunks) {
        const tier = classifyTier(chunk);
        try { await api.post('/api/memories', { agentId: agentSel.value, category: tier, content: chunk }); tally[tier] += 1; }
        catch { failed += 1; } // safety-filter rejects + transient errors are counted, not fatal
      }
      const n = tally.hot + tally.warm + tally.cold + tally.shared;
      toast(t('memory.imported', { n }));
      mount(body,
        h('div', { class: 'import-done' }, `✅ ${t('memory.importDone')}`),
        h('div', { class: 'import-breakdown' }, ...TIERS.map((tier) => h('span', { class: `badge tier-badge tier-${tier}` }, `${TIER_EMOJI[tier]} ${tally[tier]}`))),
        failed > 0 ? h('div', { class: 'field-note err' }, t('memory.importFailed', { n: failed })) : null,
        h('div', { class: 'modal-actions' }, h('button', { class: 'primary', onclick: close }, t('memory.close'))),
      );
      void loadStats(); reloadLens();
    };

    mount(body,
      h('div', { class: 'field-note' }, t('memory.importHint')),
      h('div', { class: 'field' }, h('label', null, t('memory.agent')), agentSel),
      h('div', { class: 'field' }, ta),
      h('div', { class: 'modal-actions' }, h('button', { class: 'primary', onclick: (e: Event) => void run(e) }, t('memory.importBtn'))),
    );
    backdrop.append(h('div', { class: 'modal memory-modal' },
      h('div', { class: 'agent-modal-titlebar' }, h('h2', null, t('memory.importTitle')), h('button', { class: 'icon-btn', 'aria-label': t('memory.close'), onclick: close }, '✕')),
      body,
    ));
    document.body.append(backdrop); document.body.classList.add('modal-open');
  };

  // ---------------------------------------------------------------- shell
  mount(host,
    h('div', { class: 'page-header mem-header' },
      h('div', null, h('h1', null, t('memory.title')), h('p', { class: 'subtitle' }, t('memory.subtitle'))),
      h('div', { class: 'mem-header-actions' },
        h('button', { class: 'primary', onclick: () => openMemoryModal({ roster, defaultTier: (activeTab === 'graph' || activeTab === 'log') ? 'warm' : (activeTab as Tier), onSaved: () => { reloadLens(); void loadStats(); } }) }, icon('plus', 16), t('memory.newMemory')),
        h('button', { class: 'refresh-btn', onclick: openImport }, t('memory.import')),
      ),
    ),
    statsStrip, toolbar, tabStrip, body,
  );

  const load = async (): Promise<void> => {
    try {
      roster = await api.get<RosterAgent[]>('/api/agents');
      await loadStats(); // sets embeddingEnabled before the toolbar's mode dropdown is built
      buildToolbar();
      buildTabs();
      reloadLens();
    } catch { mount(body, h('div', { class: 'muted-note err' }, t('memory.loadError'))); }
  };
  void load();

  window.addEventListener('hashchange', function onHash() {
    if (location.hash.slice(1).split('/')[0] !== 'memories') { graph?.destroy(); window.removeEventListener('hashchange', onHash); }
  });
}

defineView('memories', 'nav.memories', render);
