// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * Plugins view (FIX-plugins). Two operator surfaces, mirroring Connectors:
 *  - Part A: per-agent Claude Code plugin management (marketplaces + enabledPlugins
 *    written into each agent's config-root, with an Apply that restarts the agent).
 *  - Part B: the orchestrator extension host — loaded plugins with their status,
 *    an enable/disable toggle, their server-rendered views, and registered tools.
 * Everything is operator-gated; enabling is always a deliberate action.
 */

import { defineView } from './registry.js';
import { h, mount } from '../dom.js';
import { t } from '../i18n.js';
import { api, ApiError } from '../api.js';
import { icon } from '../icons.js';
import { toast } from '../toast.js';
import { buildBulkSummary } from './pluginsLogic.js';
import type { Store } from '../store.js';
import type { AppState } from '../main.js';

type Tab = 'agents' | 'extensions';

interface RosterAgent { id: string; displayName: string; isHub: boolean }
interface Marketplace { name: string; source: string }
interface AgentPlugins { agentId: string; marketplaces: Marketplace[]; enabledPlugins: Record<string, boolean> }
interface PluginState { manifest: { id: string; name: string; version: string; description?: string; author?: string; capabilities?: string[] }; status: 'active' | 'failed' | 'disabled'; error?: string; views: string[]; routes: string[]; tasks: string[]; tools: string[] }
interface NavView { pluginId: string; viewId: string; navLabel: string; icon?: string }
interface AgentTool { pluginId: string; name: string }
interface ExtensionList { plugins: PluginState[]; views: NavView[]; tools: AgentTool[] }

let activeTab: Tab = 'agents';
let selectedAgent = '';

function err(e: unknown): string {
  return e instanceof ApiError ? e.message : t('plugins.error');
}

// ---------------- Part A: Claude Code per-agent ----------------
async function renderAgents(wrap: HTMLElement): Promise<void> {
  let roster: RosterAgent[] = [];
  try { roster = await api.get<RosterAgent[]>('/api/agents'); } catch { /* keep chrome */ }
  if (roster.length === 0) { mount(wrap, h('div', { class: 'muted-note' }, t('plugins.noAgents'))); return; }
  if (selectedAgent === '' || !roster.some((a) => a.id === selectedAgent)) selectedAgent = roster[0]!.id;

  const sel = h('select', { 'aria-label': t('plugins.agent') }, ...roster.map((a) => h('option', { value: a.id, selected: a.id === selectedAgent }, a.displayName))) as HTMLSelectElement;
  sel.addEventListener('change', () => { selectedAgent = sel.value; void renderAgents(wrap); });

  const body = h('div', { class: 'plugin-agent-body' }, h('div', { class: 'muted-note' }, t('plugins.loading')));
  mount(wrap,
    h('div', { class: 'plugin-agent-bar' }, h('label', null, t('plugins.agent')), sel),
    body,
  );

  let data: AgentPlugins;
  try { data = await api.get<AgentPlugins>(`/api/plugins/agent/${encodeURIComponent(selectedAgent)}`); }
  catch (e) { mount(body, h('div', { class: 'muted-note err' }, err(e))); return; }

  const reload = (): void => void renderAgents(wrap);

  // marketplaces
  const mktList = h('div', { class: 'plugin-list' },
    ...(data.marketplaces.length === 0 ? [h('div', { class: 'muted-note' }, t('plugins.noMarketplaces'))]
      : data.marketplaces.map((m) => h('div', { class: 'plugin-row' },
        h('span', { class: 'plugin-row-main' }, m.name),
        h('span', { class: 'plugin-row-sub mono muted-note' }, m.source),
        h('button', { class: 'icon-btn danger', title: t('plugins.remove'), onclick: () => void (async () => {
          if (!window.confirm(t('plugins.confirmRemoveMarket', { name: m.name }))) return;
          try { await api.delete(`/api/plugins/agent/${encodeURIComponent(selectedAgent)}/marketplaces/${encodeURIComponent(m.name)}`); reload(); }
          catch (e) { toast(err(e), true); }
        })() }, '×'),
      ))),
  );
  const mName = h('input', { type: 'text', placeholder: t('plugins.marketNamePlaceholder') }) as HTMLInputElement;
  const mSrc = h('input', { type: 'text', placeholder: t('plugins.marketSrcPlaceholder') }) as HTMLInputElement;
  const addMkt = h('div', { class: 'plugin-add' }, mName, mSrc, h('button', { class: 'primary', onclick: () => void (async () => {
    if (mName.value.trim() === '' || mSrc.value.trim() === '') return;
    try { await api.post(`/api/plugins/agent/${encodeURIComponent(selectedAgent)}/marketplaces`, { name: mName.value.trim(), source: mSrc.value.trim() }); reload(); }
    catch (e) { toast(err(e), true); }
  })() }, t('plugins.addMarket')));

  // enabled plugins — a browse-fed CHECKLIST (Part A): the marketplace's offered
  // plugins, merged with the currently-enabled set, each a checkbox; plus an
  // "enable for all agents" toggle and a by-name fallback for git marketplaces
  // (browse can only enumerate LOCAL sources).
  const allAgents = h('input', { type: 'checkbox' }) as HTMLInputElement;
  // browse each marketplace with an EXPLICIT browsable verdict (FIX-hardening C): a
  // git/remote marketplace can't be enumerated here, so the operator gets a clear
  // "add by name" notice instead of an empty list that looks like "no plugins".
  const offered = new Set<string>();
  const unbrowsable: string[] = []; // git/remote (or errored) — can't enumerate here
  const emptyMarkets: string[] = []; // readable LOCAL but offers zero plugins (FIX-hardening C2)
  for (const m of data.marketplaces) {
    try {
      const r = await api.get<{ browsable: boolean; plugins: Array<{ name: string }> }>(`/api/plugins/agent/${encodeURIComponent(selectedAgent)}/browse?source=${encodeURIComponent(m.source)}`);
      if (!r.browsable) unbrowsable.push(m.name);
      else if (r.plugins.length === 0) emptyMarkets.push(m.name);
      else for (const p of r.plugins) offered.add(p.name);
    } catch { unbrowsable.push(m.name); }
  }
  const allNames = [...new Set([...offered, ...Object.keys(data.enabledPlugins)])].sort();
  const setEnabled = async (name: string, on: boolean, cb?: HTMLInputElement): Promise<void> => {
    try {
      const r = await api.put<{ appliedTo?: number }>(`/api/plugins/agent/${encodeURIComponent(selectedAgent)}/enabled`, { plugin: name, enabled: on, allAgents: allAgents.checked });
      toast(allAgents.checked ? t('plugins.enabledAll', { count: String(r.appliedTo ?? 0) }) : on ? t('plugins.enabledOne') : t('plugins.extToggled'));
    } catch (e) { toast(err(e), true); if (cb) cb.checked = !on; }
  };
  // FOUR honest states — NEVER an empty checklist without an explanation:
  // (iii) ≥1 plugin to show → checklist; (i) no marketplaces → guidance;
  // (ii) marketplace(s) but none browseable (git/remote) → marketUnbrowsable notice;
  // (iv) marketplace(s) browsed OK but offering ZERO plugins → marketEmpty notice (C2).
  const checklistKids = allNames.length > 0
    ? allNames.map((name) => {
        const cb = h('input', { type: 'checkbox' }) as HTMLInputElement;
        cb.checked = data.enabledPlugins[name] === true;
        cb.addEventListener('change', () => void setEnabled(name, cb.checked, cb));
        return h('label', { class: 'inline-check' }, cb, h('span', { class: 'mono' }, name));
      })
    : data.marketplaces.length === 0
      ? [h('div', { class: 'muted-note' }, t('plugins.noBrowsable'))]
      : [];
  const enabledList = h('div', { class: 'plugin-checklist' }, ...checklistKids);
  // Notices that explain a checklist with nothing to show. unbrowsable always informs
  // (even mixed with a checklist); marketEmpty only when there is otherwise nothing
  // (browsed OK but zero offered, no enabled) — so the empty checklist is never silent.
  const notices: HTMLElement[] = [];
  if (unbrowsable.length > 0) notices.push(h('div', { class: 'field-note' }, t('plugins.marketUnbrowsable', { name: unbrowsable.join(', ') })));
  if (emptyMarkets.length > 0 && allNames.length === 0) notices.push(h('div', { class: 'field-note' }, t('plugins.marketEmpty', { name: emptyMarkets.join(', ') })));
  const pName = h('input', { type: 'text', placeholder: t('plugins.pluginNamePlaceholder') }) as HTMLInputElement;
  const enableRow = h('div', null,
    ...notices,
    h('label', { class: 'inline-check' }, allAgents, t('plugins.allAgents')),
    h('div', { class: 'field-note' }, t('plugins.enableByName')),
    h('div', { class: 'plugin-add' }, pName,
      h('button', { class: 'secondary', onclick: () => { const n = pName.value.trim(); if (n !== '') { pName.value = ''; void setEnabled(n, true).then(reload); } } }, t('plugins.enable'))));

  const applyBtn = h('button', { class: 'secondary' }, icon('refresh', 16), t('plugins.apply')) as HTMLButtonElement;
  applyBtn.addEventListener('click', () => void (async () => {
    applyBtn.disabled = true;
    try { const r = await api.post<{ restarted: boolean }>(`/api/plugins/agent/${encodeURIComponent(selectedAgent)}/apply`, {}); toast(r.restarted ? t('plugins.applied') : t('plugins.applyNoop')); }
    catch (e) { toast(err(e), true); }
    finally { applyBtn.disabled = false; }
  })());

  mount(body,
    h('div', { class: 'field-note' }, t('plugins.agentNote')),
    h('div', { class: 'panel plugin-panel' }, h('div', { class: 'panel-title' }, t('plugins.marketplaces')), mktList, addMkt),
    h('div', { class: 'panel plugin-panel' }, h('div', { class: 'panel-title' }, t('plugins.browsePlugins')), enabledList, enableRow),
    h('div', { class: 'plugin-apply-row' }, applyBtn, h('span', { class: 'field-note inline' }, t('plugins.applyHint'))),
  );
}

// ---------------- Part B: orchestrator extension host ----------------
async function renderExtensions(wrap: HTMLElement): Promise<void> {
  const reload = (): void => void renderExtensions(wrap);
  let data: ExtensionList = { plugins: [], views: [], tools: [] };
  try { data = await api.get<ExtensionList>('/api/plugins/extensions'); }
  catch (e) { mount(wrap, h('div', { class: 'muted-note err' }, err(e))); return; }

  if (data.plugins.length === 0) { mount(wrap, h('div', { class: 'muted-note' }, t('plugins.noExtensions'))); return; }

  const statusBadge = (s: PluginState['status']): HTMLElement =>
    h('span', { class: `badge plugin-status status-${s}` }, t(`plugins.status.${s}`));

  const viewPanel = h('div', { class: 'plugin-view-panel' });
  const openView = (v: NavView): void => {
    mount(viewPanel, h('div', { class: 'muted-note' }, t('plugins.loading')));
    void api.get<{ html: string }>(`/api/plugins/ext/${encodeURIComponent(v.pluginId)}/view/${encodeURIComponent(v.viewId)}`)
      .then((r) => {
        // SECURITY: a plugin's view HTML is UNTRUSTED. Never innerHTML it into the
        // operator dashboard — that would let any enabled plugin run JS in the
        // operator origin with the operator bearer (a full privilege-escalation
        // bypass of the host-API boundary). Instead frame it in a fully-sandboxed
        // iframe: `sandbox=''` (no allow-scripts, no allow-same-origin) gives it an
        // opaque origin with NO script execution and NO access to the token or DOM.
        const frame = h('iframe', { class: 'plugin-view-frame', sandbox: '', srcdoc: r.html, title: v.navLabel, referrerpolicy: 'no-referrer' });
        mount(viewPanel, h('div', { class: 'plugin-view-head' }, v.navLabel), frame);
      })
      .catch((e) => mount(viewPanel, h('div', { class: 'muted-note err' }, err(e))));
  };

  // per-card selection for the multi-enable bar (Part B)
  const selected = new Map<string, HTMLInputElement>();
  const cards = data.plugins.map((p) => {
    const on = p.status === 'active';
    const toggle = h('button', { class: `pill-toggle${on ? ' on' : ''}`, title: on ? t('plugins.disable') : t('plugins.enable') }, on ? t('plugins.on') : t('plugins.off')) as HTMLButtonElement;
    toggle.addEventListener('click', () => void (async () => {
      try { const r = await api.put<{ restartRequired: boolean }>(`/api/plugins/ext/${encodeURIComponent(p.manifest.id)}/enabled`, { enabled: !on }); toast(r.restartRequired ? t('plugins.extToggledRestart') : t('plugins.extToggled')); reload(); }
      catch (e) { toast(err(e), true); }
    })());
    const selCb = h('input', { type: 'checkbox', 'aria-label': p.manifest.name }) as HTMLInputElement;
    selected.set(p.manifest.id, selCb);
    const pViews = data.views.filter((v) => v.pluginId === p.manifest.id);
    // "what it registers": the LIVE arrays for an active plugin; for a disabled one
    // (register() never ran, so the arrays are empty) fall back to the manifest's
    // DECLARED capabilities so the operator still sees what it would contribute.
    const capsLine = on || p.views.length + p.routes.length + p.tasks.length + p.tools.length > 0
      ? `${t('plugins.caps.views')}: ${p.views.length} · ${t('plugins.caps.routes')}: ${p.routes.length} · ${t('plugins.caps.tasks')}: ${p.tasks.length} · ${t('plugins.caps.tools')}: ${p.tools.length}`
      : `${t('plugins.declares')}: ${(p.manifest.capabilities ?? []).join(', ') || '—'}`;
    return h('div', { class: `panel plugin-ext-card${p.status === 'failed' ? ' failed' : ''}` },
      h('div', { class: 'plugin-ext-head' },
        selCb,
        h('span', { class: 'plugin-ext-name' }, p.manifest.name),
        h('span', { class: 'badge muted' }, `v${p.manifest.version}`),
        statusBadge(p.status),
        toggle,
      ),
      ...(p.manifest.description ? [h('div', { class: 'field-note' }, p.manifest.description)] : []),
      ...(p.error ? [h('div', { class: 'muted-note err' }, p.error)] : []),
      h('div', { class: 'plugin-ext-meta muted-note' }, capsLine),
      ...(pViews.length > 0 ? [h('div', { class: 'plugin-ext-views' }, ...pViews.map((v) => h('button', { class: 'link-btn', onclick: () => openView(v) }, icon('screen', 14), v.navLabel)))] : []),
    );
  });

  // multi-enable bar (Part B): apply enable/disable to every CHECKED plugin at once.
  const bulk = async (enable: boolean): Promise<void> => {
    const ids = [...selected.entries()].filter(([, cb]) => cb.checked).map(([id]) => id);
    if (ids.length === 0) { toast(t('plugins.noneSelected'), true); return; }
    const total = ids.length;
    let ok = 0;
    for (const id of ids) {
      try { await api.put(`/api/plugins/ext/${encodeURIComponent(id)}/enabled`, { enabled: enable }); ok++; }
      catch { /* aggregated below — don't spam a toast per failure */ }
    }
    const summary = buildBulkSummary(t, { attempted: total, succeeded: ok, failed: total - ok, mode: enable ? 'enable' : 'disable' });
    toast(summary.text, summary.isError);
    reload();
  };
  const selectAll = h('input', { type: 'checkbox', 'aria-label': t('plugins.selectAll') }) as HTMLInputElement;
  selectAll.addEventListener('change', () => { for (const cb of selected.values()) cb.checked = selectAll.checked; });
  const bulkBar = h('div', { class: 'plugin-bulk-bar' },
    h('label', { class: 'inline-check' }, selectAll, t('plugins.selectAll')),
    h('button', { class: 'secondary', onclick: () => void bulk(true) }, t('plugins.enableSelected')),
    h('button', { class: 'secondary', onclick: () => void bulk(false) }, t('plugins.disableSelected')),
  );

  mount(wrap,
    h('div', { class: 'info-box' }, t('plugins.extInfo')),
    bulkBar,
    h('div', { class: 'plugin-ext-grid' }, ...cards),
    ...(data.tools.length > 0 ? [h('div', { class: 'panel plugin-panel' }, h('div', { class: 'panel-title' }, t('plugins.agentTools')),
      h('div', { class: 'plugin-list' }, ...data.tools.map((tl) => h('div', { class: 'plugin-row' }, h('span', { class: 'plugin-row-main mono' }, tl.name), h('span', { class: 'plugin-row-sub muted-note' }, tl.pluginId)))))] : []),
    viewPanel,
  );
}

function render(host: HTMLElement, store: Store<AppState>): void {
  void store;
  const tabBar = h('div', { class: 'mcp-tabs plugin-tabs' },
    h('button', { class: `tab${activeTab === 'agents' ? ' active' : ''}`, onclick: () => { activeTab = 'agents'; render(host, store); } }, t('plugins.tab.agents')),
    h('button', { class: `tab${activeTab === 'extensions' ? ' active' : ''}`, onclick: () => { activeTab = 'extensions'; render(host, store); } }, t('plugins.tab.extensions')),
  );
  const tabBody = h('div', { class: 'plugin-tab-body' });
  mount(host,
    h('div', { class: 'page-header' },
      h('div', null, h('h1', null, t('plugins.title')), h('p', { class: 'subtitle' }, t('plugins.subtitle'))),
    ),
    tabBar,
    tabBody,
  );
  if (activeTab === 'agents') void renderAgents(tabBody); else void renderExtensions(tabBody);
}

defineView('plugins', 'nav.plugins', (host, store) => render(host, store));
