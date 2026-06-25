// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * Skills (Skillek) view (PROMPT-10): the fleet-wide skill library. A header +
 * "Új skill", an inheritance info box, a stats strip, and a responsive card grid;
 * each card opens a read-only detail modal. New skills are created from a plain
 * description (the manifest is templated) or imported from a host folder. All
 * global skills share the same HOME, so they are inherited by every agent.
 */

import { defineView } from './registry.js';
import { h, mount } from '../dom.js';
import { t } from '../i18n.js';
import { api, ApiError } from '../api.js';
import { icon } from '../icons.js';
import { toast } from '../toast.js';
import { collectDrop } from '../skillDrop.js';
import { makeDebouncer } from '../debounce.js';
import type { Store } from '../store.js';
import type { AppState } from '../main.js';

interface SkillMeta { name: string; description: string; scope: 'global' | 'local'; pinned: boolean; docPresent?: boolean; agentId?: string }
interface SkillDoc { meta: SkillMeta; body: string; helpers: string[] }
interface RosterAgent { id: string; displayName: string; isHub?: boolean }

function skillEmoji(name: string): string {
  const n = name.toLowerCase();
  if (/factory|creat|gyar|gener/.test(n)) return '🏭';
  if (/blog|post|write|ir|copy/.test(n)) return '✍️';
  if (/image|thumb|kep|palett|design/.test(n)) return '🎨';
  if (/video|youtube|seo|clip/.test(n)) return '🎬';
  if (/doc|report|riport|dok/.test(n)) return '📄';
  if (/research|kutat|market|piac/.test(n)) return '🔎';
  if (/skill/.test(n)) return '🧩';
  return '⚙️';
}

function render(host: HTMLElement, store: Store<AppState>): void {
  void store;
  const statsStrip = h('div', { class: 'stat-row skills-stats' });
  const toolbar = h('div', { class: 'skills-toolbar' });
  const grid = h('div', { class: 'skills-grid' });

  // ---- filter state (FIX-skills-view-filter), render-scoped ----
  let scopeFilter: 'global' | 'local' = 'global';
  let agentFilter = '';
  let query = '';
  let documentedOnly = false;
  let roster: RosterAgent[] = [];
  let allItems: SkillMeta[] = [];

  // ---- detail modal ----
  const openDetail = (s: SkillMeta): void => {
    const body = h('div', { class: 'agent-modal-body' }, h('div', { class: 'muted-note' }, t('skills.loading')));
    const backdrop = h('div', { class: 'modal-backdrop' });
    const close = (): void => { backdrop.remove(); document.body.classList.remove('modal-open'); document.removeEventListener('keydown', onKey); };
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    backdrop.append(h('div', { class: 'modal skill-detail-modal' },
      h('div', { class: 'agent-modal-titlebar' }, h('h2', null, s.name || t('skills.detailTitle')), h('button', { class: 'icon-btn', 'aria-label': t('skills.close'), onclick: close }, '✕')),
      body));
    document.body.append(backdrop); document.body.classList.add('modal-open');
    // resolve the actual scope (FIX-10 §3): global reads through the hub view,
    // a local shadow reads from its agent — never hardcode 'global'.
    const readUrl = s.scope === 'local' && s.agentId
      ? `/api/skills/read/local/${encodeURIComponent(s.name)}?agent=${encodeURIComponent(s.agentId)}`
      : `/api/skills/read/${s.scope}/${encodeURIComponent(s.name)}`;
    void api.get<SkillDoc>(readUrl).then((doc) => {
      // structured frontmatter (name/scope badge/pinned + description) ABOVE the body
      const badges = h('div', { class: 'skill-detail-badges' },
        h('span', { class: 'badge muted src-badge' }, t(`skills.badge.${doc.meta.scope ?? s.scope}`)),
        ...(doc.meta.pinned ? [h('span', { class: 'badge' }, '📌 ', t('skills.pinned'))] : []),
      );
      const helpersBlock = doc.helpers.length > 0
        ? h('div', { class: 'skill-helpers' },
            h('div', { class: 'sec-title' }, t('skills.helpers')),
            h('ul', { class: 'skill-helper-list' }, ...doc.helpers.map((f) => h('li', { class: 'mono' }, f))))
        : h('div', { class: 'field-note' }, t('skills.noHelpers'));
      mount(body,
        badges,
        h('div', { class: 'skill-desc' }, doc.meta.description || t('skills.noDescription')),
        h('div', { class: 'skill-meta' },
          h('div', null, t('skills.detail.sourcePrefix'), ' ', h('strong', null, t(`skills.detail.source.${doc.meta.scope ?? s.scope}`))),
          h('div', { class: 'field-note' }, t('skills.detail.availability')),
        ),
        h('div', { class: 'sec-title manifest-label' }, t('skills.detail.manifestLabel')),
        h('pre', { class: 'skill-manifest' }, doc.body || t('skills.detail.missingManifest')),
        helpersBlock,
      );
    }).catch(() => mount(body, h('div', { class: 'muted-note err' }, t('skills.loadError'))));
  };

  // ---- create/import modal ----
  const openCreate = (): void => {
    let tab: 'create' | 'import' = 'create';
    const nameEl = h('input', { type: 'text', placeholder: t('skills.namePlaceholder') }) as HTMLInputElement;
    const descEl = h('textarea', { rows: 5, placeholder: t('skills.descPlaceholder') }) as HTMLTextAreaElement;
    const srcEl = h('input', { type: 'text', placeholder: t('skills.sourceDirPlaceholder') }) as HTMLInputElement;
    const tabs = h('div', { class: 'agent-modal-tabs' });
    const panel = h('div', { class: 'skill-create-panel' });
    const backdrop = h('div', { class: 'modal-backdrop' });
    const close = (): void => { backdrop.remove(); document.body.classList.remove('modal-open'); };
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    const field = (k: string, c: HTMLElement): HTMLElement => h('div', { class: 'field' }, h('label', null, t(k)), c);

    const generate = async (e: Event): Promise<void> => {
      const name = nameEl.value.trim();
      if (name === '') { nameEl.focus(); return; }
      const btn = e.currentTarget as HTMLButtonElement; btn.disabled = true; btn.textContent = t('skills.generating');
      const docBody = `# ${name}\n\n${descEl.value.trim()}\n`;
      try {
        await api.post('/api/skills', { scope: 'global', name, description: descEl.value.trim().split('\n')[0]!.slice(0, 120), body: docBody });
        close(); toast(t('skills.added')); void load();
      } catch (err) { toast(err instanceof ApiError ? err.message : t('skills.error'), true); btn.disabled = false; btn.textContent = t('skills.generate'); }
    };
    const doImport = async (e: Event): Promise<void> => {
      if (srcEl.value.trim() === '') { srcEl.focus(); toast(t('skills.chooseFile'), true); return; }
      const btn = e.currentTarget as HTMLButtonElement; btn.disabled = true; btn.textContent = t('skills.importing');
      try {
        const r = await api.post<{ name?: string }>('/api/skills/import', { scope: 'global', sourceDir: srcEl.value.trim() });
        close(); toast(t('skills.imported', { names: r.name ?? '' })); void load();
      } catch (err) { toast(err instanceof ApiError ? err.message : t('skills.error'), true); btn.disabled = false; btn.textContent = t('skills.import'); }
    };
    const onDrop = async (e: DragEvent): Promise<void> => {
      if (e.dataTransfer === null) return;
      let files;
      try { files = await collectDrop(e.dataTransfer); } catch { toast(t('skills.dropEmpty'), true); return; }
      if (files.length === 0) { toast(t('skills.dropEmpty'), true); return; }
      try {
        const r = await api.post<{ name?: string }>('/api/skills/import-files', { scope: 'global', files });
        close(); toast(t('skills.imported', { names: r.name ?? '' })); void load();
      } catch (err) { toast(err instanceof ApiError ? err.message : t('skills.error'), true); }
    };

    const renderTab = (): void => {
      mount(tabs,
        h('button', { class: `tab${tab === 'create' ? ' active' : ''}`, onclick: () => { tab = 'create'; renderTab(); } }, t('skills.tab.create')),
        h('button', { class: `tab${tab === 'import' ? ' active' : ''}`, onclick: () => { tab = 'import'; renderTab(); } }, t('skills.tab.import')),
      );
      if (tab === 'create') mount(panel, field('skills.name', nameEl), field('skills.description', descEl), h('div', { class: 'modal-actions' }, h('button', { class: 'primary', onclick: (e: Event) => void generate(e) }, t('skills.generate'))));
      else {
        // live drag/drop of a skill folder/files → global scope (FIX-10 §6)
        const dz = h('div', { class: 'file-dropzone' }, h('div', { class: 'dz-title' }, t('skills.uploadPrompt')), h('div', { class: 'dz-note' }, t('skills.importNote')));
        dz.addEventListener('dragover', (e: Event) => { e.preventDefault(); dz.classList.add('drag'); });
        dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
        dz.addEventListener('drop', (e: DragEvent) => { e.preventDefault(); dz.classList.remove('drag'); void onDrop(e); });
        mount(panel,
          h('div', { class: 'field' }, h('label', null, t('skills.fileLabel')), dz),
          field('skills.sourceDirLabel', srcEl),
          h('div', { class: 'modal-actions' }, h('button', { class: 'primary', onclick: (e: Event) => void doImport(e) }, t('skills.import'))),
        );
      }
    };
    backdrop.append(h('div', { class: 'modal skill-create-modal' },
      h('div', { class: 'agent-modal-titlebar' }, h('h2', null, t('skills.modalTitle')), h('button', { class: 'icon-btn', 'aria-label': t('skills.close'), onclick: close }, '✕')),
      tabs, panel));
    document.body.append(backdrop); document.body.classList.add('modal-open');
    renderTab(); setTimeout(() => nameEl.focus(), 0);
  };

  // ---- card ----
  const skillCard = (s: SkillMeta): HTMLElement => h('div', { class: 'skill-card', role: 'button', onclick: () => openDetail(s) },
    h('div', { class: 'skill-icon' }, skillEmoji(s.name)),
    h('div', { class: 'skill-body' },
      h('div', { class: 'skill-name' }, s.name, h('span', { class: 'badge muted src-badge' }, t(`skills.badge.${s.scope}`))),
      h('div', { class: 'skill-card-desc' }, s.description || t('skills.noDescription')),
    ),
  );

  // ---- client-side filtering (FIX-skills-view-filter) ----
  const applyFilters = (): void => {
    if (scopeFilter === 'local' && agentFilter === '') {
      mount(grid, h('div', { class: 'empty-block' }, h('div', { class: 'muted-note' }, t('skills.pickAgent'))));
      return;
    }
    const q = query.trim().toLowerCase();
    let items = allItems;
    if (q !== '') items = items.filter((s) => s.name.toLowerCase().includes(q) || (s.description ?? '').toLowerCase().includes(q));
    if (documentedOnly) items = items.filter((s) => s.docPresent === true);
    if (items.length === 0) {
      const emptyKey = allItems.length === 0 ? (scopeFilter === 'local' ? 'skills.noLocal' : 'skills.emptyGlobal') : 'skills.noMatch';
      mount(grid, h('div', { class: 'empty-block' }, icon('skills', 48), h('div', { class: 'muted-note' }, t(emptyKey))));
      return;
    }
    mount(grid, ...[...items].sort((a, b) => a.name.localeCompare(b.name)).map(skillCard));
  };

  // ---- toolbar: scope chips + agent picker + search + documented toggle ----
  const renderToolbar = (): void => {
    const chip = (key: 'global' | 'local', label: string): HTMLElement =>
      h('button', { class: `chip${scopeFilter === key ? ' active' : ''}`, onclick: () => { if (scopeFilter !== key) { scopeFilter = key; renderToolbar(); void load(); } } }, label);
    const agentSel = h('select', { class: 'skills-agent-select', onchange: (e: Event) => { agentFilter = (e.target as HTMLSelectElement).value; void load(); } },
      h('option', { value: '' }, t('skills.allAgents')),
      ...roster.filter((a) => a.isHub !== true).map((a) => h('option', { value: a.id, selected: a.id === agentFilter }, a.displayName)),
    ) as HTMLSelectElement;
    const search = h('input', { type: 'search', class: 'skills-search', placeholder: t('skills.searchPlaceholder'), value: query }) as HTMLInputElement;
    // debounce so a fast typist doesn't re-filter on every keystroke (FIX-hardening C);
    // Enter flushes immediately. Update `query` first so the latest value is always used.
    const debounced = makeDebouncer(() => applyFilters(), 220);
    search.addEventListener('input', () => { query = search.value; debounced.call(); });
    search.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Enter') { query = search.value; debounced.flush(); } });
    const docCb = h('input', { type: 'checkbox' }) as HTMLInputElement;
    docCb.checked = documentedOnly;
    docCb.addEventListener('change', () => { documentedOnly = docCb.checked; applyFilters(); });
    mount(toolbar,
      h('div', { class: 'chip-row' }, chip('global', t('skills.filter.global')), chip('local', t('skills.filter.local'))),
      ...(scopeFilter === 'local' ? [agentSel] : []),
      search,
      h('label', { class: 'inline-check' }, docCb, t('skills.filter.documented')),
    );
  };

  // ---- load (scope-aware) ----
  const load = async (): Promise<void> => {
    if (scopeFilter === 'local' && agentFilter === '') { allItems = []; applyFilters(); return; }
    mount(grid, h('div', { class: 'empty-block' }, h('div', { class: 'spinner-lg' }), h('div', { class: 'muted-note' }, t('skills.loading'))));
    try {
      const url = scopeFilter === 'local'
        ? `/api/skills?scope=local&agent=${encodeURIComponent(agentFilter)}`
        : '/api/skills';
      allItems = await api.get<SkillMeta[]>(url);
      applyFilters();
    } catch { mount(grid, h('div', { class: 'muted-note err center' }, t('skills.loadError'))); }
  };

  const loadStats = async (): Promise<void> => {
    const statCard = (labelKey: string, value: number, cls: string): HTMLElement =>
      h('div', { class: `stat-card ${cls}` }, h('div', { class: 'stat-label' }, t(labelKey)), h('div', { class: 'stat-value' }, String(value)));
    // real per-scope counts (FIX-10 §1): global / agent-local / documented
    const stats = await api
      .get<{ global: number; local: number; documented: number }>('/api/skills/stats')
      .catch(() => ({ global: 0, local: 0, documented: 0 }));
    mount(statsStrip,
      statCard('skills.stat.global', stats.global, 'global-stat'),
      statCard('skills.stat.local', stats.local, 'local-stat'),
      statCard('skills.stat.documented', stats.documented, 'doc-stat'),
    );
  };

  mount(host,
    h('div', { class: 'page-header skills-header' },
      h('div', null, h('h1', null, t('skills.title')), h('p', { class: 'subtitle' }, t('skills.subtitle'))),
      h('button', { class: 'primary', onclick: openCreate }, icon('plus', 16), t('skills.newSkill')),
    ),
    h('div', { class: 'info-box' }, t('skills.infoBox')),
    statsStrip,
    toolbar,
    grid,
  );
  // roster first (for the agent picker), then stats + the default global list
  void (async () => {
    roster = await api.get<RosterAgent[]>('/api/agents').catch(() => []);
    renderToolbar();
    void loadStats();
    void load();
  })();
}

defineView('skills', 'nav.skills', render);
