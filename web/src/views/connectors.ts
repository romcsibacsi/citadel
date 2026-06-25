// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * MCP / Connectors view (PROMPT-13). The operator's surface for managing MCP
 * connectors: an info banner, two tabs (Installed / Gallery), the configured
 * grid grouped by scope with a stats strip + a built-in-capabilities row, a
 * Tools sub-section (GitHub repos, Vault, Paths), and a browseable catalog. Five
 * modal flows. The configured list does not auto-poll — refresh is explicit
 * (it can spawn connectors).
 */

import { defineView } from './registry.js';
import { h, mount } from '../dom.js';
import { t, currentLocale } from '../i18n.js';
import { api, ApiError } from '../api.js';
import { icon } from '../icons.js';
import { toast } from '../toast.js';
import type { Store } from '../store.js';
import type { AppState } from '../main.js';

type Tab = 'installed' | 'gallery';
interface Connector { name: string; status: string; endpoint: string | null; type: string; source: string; scope: string; agentId: string | null; enabled?: boolean }
interface CatalogItem { id: string; name: string; description: string; type: 'local' | 'remote'; category: string; icon: string; command?: string; args?: string; url?: string; env: string[]; authType: 'none' | 'apikey' | 'oauth'; authNote?: string; infoUrl?: string; installed: boolean; installedSource: string | null; configMatch: boolean }
interface RosterAgent { id: string; displayName: string; isHub: boolean }
interface CacheStatus { cacheLastRefreshed: string | null; cacheError: string | null; refreshing: boolean }

const BUILTINS = [
  { id: 'computer-use', label: 'computer-use', descKey: 'connectors.builtin.computer.desc', bodyKey: 'connectors.builtin.computer.body' },
  { id: 'browser', label: 'browser', descKey: 'connectors.builtin.browser.desc', bodyKey: 'connectors.builtin.browser.body' },
];
const CATEGORIES = ['all', 'productivity', 'communication', 'search', 'development', 'ai', 'finance', 'system'];
const SOURCE_LABEL: Record<string, string> = {
  plugin: 'plugin', 'local-user': 'local (user)', 'local-project': 'local (project)', local: 'local',
  agent: 'agent', 'agent-project': 'project', 'external-project': 'external', 'claude.ai': 'claude.ai',
};

let activeTab: Tab = 'installed';
let galleryCategory = 'all';

function statusLabel(s: string): string {
  return t(`connectors.status.${s}`) || s;
}

/** Probe an MCP endpoint/command (FIX-connectors-custom-mcp) and toast the result.
 *  Sends only type/url/command — never secret env values. */
async function runTest(input: { type: string; url?: string; command?: string }): Promise<void> {
  try {
    const r = await api.post<{ ok: boolean; state: string; status?: number; command?: string }>('/api/connectors/test', input);
    const key = ({
      reachable: 'connectors.test.reachable', resolved: 'connectors.test.resolved',
      unreachable: 'connectors.test.unreachable', not_found: 'connectors.test.notFound',
      invalid: 'connectors.test.invalid', refused: 'connectors.test.refusedInternal',
    } as Record<string, string>)[r.state] ?? 'connectors.test.unknown';
    toast(t(key, { status: r.status ?? 0, command: r.command ?? '' }), !r.ok);
  } catch (err) { toast(err instanceof ApiError ? err.message : t('connectors.error'), true); }
}
function closer(backdrop: HTMLElement): () => void {
  return () => { backdrop.remove(); document.body.classList.remove('modal-open'); };
}
function modal(titleEl: HTMLElement, body: HTMLElement, cls = ''): { backdrop: HTMLElement; close: () => void } {
  const backdrop = h('div', { class: 'modal-backdrop' });
  const close = closer(backdrop);
  const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) { close(); document.removeEventListener('keydown', onKey); } });
  backdrop.append(h('div', { class: `modal ${cls}` },
    h('div', { class: 'agent-modal-titlebar' }, titleEl, h('button', { class: 'icon-btn', 'aria-label': t('connectors.close'), onclick: () => { close(); document.removeEventListener('keydown', onKey); } }, '✕')),
    body));
  document.body.append(backdrop); document.body.classList.add('modal-open');
  return { backdrop, close };
}

async function render(host: HTMLElement, store: Store<AppState>): Promise<void> {
  void store;
  const reload = (): void => void render(host, store);

  let connectors: Connector[] = [];
  let status: CacheStatus = { cacheLastRefreshed: null, cacheError: null, refreshing: false };
  try {
    [connectors, status] = await Promise.all([
      api.get<Connector[]>('/api/connectors'),
      api.get<CacheStatus>('/api/connectors/status'),
    ]);
  } catch { /* keep chrome, show empties */ }

  // ---------- modals ----------
  const openBuiltin = (b: typeof BUILTINS[number]): void => {
    const body = h('div', { class: 'agent-modal-body' },
      h('div', { class: 'field-note' }, t(b.descKey)),
      h('div', { class: 'builtin-body' }, t(b.bodyKey)),
    );
    const { backdrop } = modal(h('h2', null, b.label), body, 'builtin-modal');
    const closeBtn = backdrop.querySelector<HTMLButtonElement>('.icon-btn');
    setTimeout(() => closeBtn?.focus(), 0);
  };

  const openDetail = (c: Connector): void => {
    const info = h('div', { class: 'conn-detail-info' }, h('div', { class: 'muted-note' }, t('connectors.loading')));
    const assignWrap = h('div', { class: 'conn-assign' });
    const body = h('div', { class: 'agent-modal-body' }, info, assignWrap);
    const { close } = modal(h('h2', null, c.name), body, 'conn-detail-modal');
    void Promise.all([
      api.get<{ status: string; scope: string; type: string; command: string | null; env: string[]; enabled?: boolean; assignedAgents: string[] }>(`/api/connectors/${encodeURIComponent(c.name)}`),
      api.get<RosterAgent[]>('/api/agents').catch(() => [] as RosterAgent[]),
    ]).then(([detail, roster]) => {
      const row = (labelKey: string, value: string, valueCls = ''): HTMLElement =>
        h('div', { class: 'kv-row' }, h('span', { class: 'kv-k' }, t(labelKey)), h('span', { class: `kv-v ${valueCls}` }, value));
      mount(info,
        row('connectors.detail.status', statusLabel(detail.status), `status-${detail.status}`),
        row('connectors.detail.scope', detail.scope),
        row('connectors.detail.type', detail.type),
        row('connectors.toggle.enabled', detail.enabled === false ? t('connectors.toggle.disabled') : t('connectors.toggle.enabled'), detail.enabled === false ? 'status-failed' : 'status-connected'),
        ...(detail.command ? [row('connectors.detail.command', detail.command, 'mono')] : []),
        ...(detail.env.length > 0 ? [row('connectors.detail.env', detail.env.join('  '), 'mono')] : []),
      );
      const testBtn = h('button', { class: 'link-btn', onclick: () => void runTest({ type: c.type, url: c.endpoint ?? '', command: c.endpoint ?? '' }) }, t('connectors.test.btn'));
      const toggle = async (): Promise<void> => {
        const next = detail.enabled === false;
        try {
          await api.patch(`/api/connectors/${encodeURIComponent(c.name)}/enabled`, { enabled: next });
          toast(t(next ? 'connectors.toast.enabled' : 'connectors.toast.disabled')); close(); reload();
        } catch (err) { toast(err instanceof ApiError ? err.message : t('connectors.error'), true); }
      };
      const assigned = new Set(detail.assignedAgents);
      const subs = roster.filter((a) => !a.isHub);
      const checks: Array<{ id: string; cb: HTMLInputElement }> = [];
      const hub = roster.find((a) => a.isHub);
      const rows: HTMLElement[] = [];
      if (hub) {
        const cb = h('input', { type: 'checkbox', disabled: true, title: t('connectors.assign.autoTip') }) as HTMLInputElement;
        cb.checked = true;
        rows.push(h('label', { class: 'inline-check' }, cb, hub.displayName, h('span', { class: 'badge muted' }, t('connectors.assign.automatic'))));
      }
      for (const a of subs) {
        const cb = h('input', { type: 'checkbox' }) as HTMLInputElement;
        cb.checked = assigned.has(a.id);
        checks.push({ id: a.id, cb });
        rows.push(h('label', { class: 'inline-check' }, cb, a.displayName));
      }
      if (subs.length === 0 && !hub) rows.push(h('div', { class: 'muted-note' }, t('connectors.assign.none')));
      const save = async (): Promise<void> => {
        try {
          await api.post(`/api/connectors/${encodeURIComponent(c.name)}/assign`, { agents: checks.filter((x) => x.cb.checked).map((x) => x.id), allAgents: checks.map((x) => x.id) });
          toast(t('connectors.toast.assignUpdated')); close(); reload();
        } catch (err) { toast(err instanceof ApiError ? err.message : t('connectors.error'), true); }
      };
      const del = async (): Promise<void> => {
        if (!window.confirm(t('connectors.confirm.delete', { name: c.name }))) return;
        try { await api.delete(`/api/connectors/${encodeURIComponent(c.name)}`); toast(t('connectors.toast.deleted')); close(); reload(); }
        catch (err) { toast(err instanceof ApiError ? err.message : t('connectors.error'), true); }
      };
      mount(assignWrap,
        h('div', { class: 'sec-title' }, t('connectors.assign.title')),
        h('div', { class: 'check-list' }, ...rows),
        h('div', { class: 'modal-actions' },
          h('button', { class: 'danger-btn', onclick: () => void del() }, t('connectors.btn.delete')),
          testBtn,
          h('button', { class: 'toggle-btn', onclick: () => void toggle() }, detail.enabled === false ? t('connectors.toggle.enable') : t('connectors.toggle.disable')),
          h('button', { class: 'primary', onclick: () => void save() }, t('connectors.btn.save')),
        ),
      );
    }).catch(() => mount(info, h('div', { class: 'muted-note err' }, t('connectors.detail.loadError'))));
  };

  const openAdd = (): void => {
    let type = 'stdio'; let scope = 'user';
    const nameEl = h('input', { type: 'text', placeholder: t('connectors.add.namePlaceholder') }) as HTMLInputElement;
    const urlEl = h('input', { type: 'text', placeholder: 'https://mcp.example.com/mcp' }) as HTMLInputElement;
    const cmdEl = h('input', { type: 'text', placeholder: 'npx -y @my/mcp-server' }) as HTMLInputElement;
    const argsEl = h('input', { type: 'text', placeholder: '--port 3000' }) as HTMLInputElement;
    const envRows: Array<{ k: HTMLInputElement; v: HTMLInputElement; row: HTMLElement }> = [];
    const envList = h('div', { class: 'env-list' });
    const typeSel = h('select', null, ...['stdio', 'http', 'sse'].map((tp) => h('option', { value: tp, selected: tp === type }, t(`connectors.add.type.${tp}`)))) as HTMLSelectElement;
    const scopeSel = h('select', null, ...['user', 'project'].map((sc) => h('option', { value: sc, selected: sc === scope }, t(`connectors.add.scope.${sc}`)))) as HTMLSelectElement;
    const urlGroup = h('div', { class: 'field' }, h('label', null, t('connectors.add.url')), urlEl);
    const cmdGroup = h('div', null,
      h('div', { class: 'field' }, h('label', null, t('connectors.add.command')), cmdEl),
      h('div', { class: 'field' }, h('label', null, t('connectors.add.args')), argsEl),
      h('div', { class: 'field' }, h('label', null, t('connectors.add.env')), envList, h('button', { class: 'link-btn', onclick: () => addEnvRow() }, t('connectors.add.addVar'))),
    );
    const assignGroup = h('div', { class: 'field conn-assign-group' });
    const addEnvRow = (): void => {
      const k = h('input', { type: 'text', placeholder: t('connectors.add.keyPlaceholder') }) as HTMLInputElement;
      const v = h('input', { type: 'text', placeholder: t('connectors.add.valuePlaceholder') }) as HTMLInputElement;
      const row = h('div', { class: 'env-row' }, k, h('span', { class: 'env-eq' }, '='), v, h('button', { class: 'icon-btn', onclick: () => { row.remove(); } }, '×'));
      envRows.push({ k, v, row });
      envList.append(row);
    };
    let roster: RosterAgent[] = [];
    const renderConditional = (): void => {
      urlGroup.style.display = type === 'http' || type === 'sse' ? '' : 'none';
      cmdGroup.style.display = type === 'stdio' ? '' : 'none';
      assignGroup.style.display = scope === 'project' ? '' : 'none';
      if (scope === 'project' && assignGroup.childElementCount === 0) {
        mount(assignGroup, h('label', null, t('connectors.add.assign')),
          h('div', { class: 'check-list' }, ...roster.filter((a) => !a.isHub).map((a) => h('label', { class: 'inline-check' }, h('input', { type: 'checkbox', value: a.id, 'data-agent': a.id }), a.displayName))));
      }
    };
    typeSel.addEventListener('change', () => { type = typeSel.value; renderConditional(); });
    scopeSel.addEventListener('change', () => { scope = scopeSel.value; renderConditional(); });
    const submit = h('button', { class: 'primary' }, t('connectors.add.submit')) as HTMLButtonElement;
    const testBtn = h('button', { class: 'link-btn', onclick: () => void runTest({ type, url: urlEl.value, command: [cmdEl.value.trim(), argsEl.value.trim()].filter((s) => s !== '').join(' ') }) }, t('connectors.test.btn'));
    const body = h('div', { class: 'agent-modal-body' },
      h('div', { class: 'field' }, h('label', null, t('connectors.add.name'), h('span', { class: 'field-note inline' }, t('connectors.add.nameHelp'))), nameEl),
      h('div', { class: 'two-col' }, h('div', { class: 'field' }, h('label', null, t('connectors.add.typeLabel')), typeSel), h('div', { class: 'field' }, h('label', null, t('connectors.add.scopeLabel')), scopeSel)),
      urlGroup, cmdGroup, assignGroup,
      h('div', { class: 'modal-actions' }, testBtn, submit),
    );
    const { close } = modal(h('h2', null, t('connectors.add.title')), body, 'conn-add-modal');
    renderConditional();
    void api.get<RosterAgent[]>('/api/agents').then((r) => { roster = r; if (scope === 'project') { assignGroup.replaceChildren(); renderConditional(); } }).catch(() => undefined);
    submit.addEventListener('click', () => void (async () => {
      submit.disabled = true; submit.textContent = t('connectors.add.submitting');
      const env = envRows.filter((r) => r.k.value.trim() !== '').map((r) => r.k.value.trim());
      const agents = scope === 'project' ? [...assignGroup.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked')].map((c) => c.value) : [];
      try {
        const res = await api.post<{ nameChanged: boolean; name: string }>('/api/connectors', { name: nameEl.value, type, scope, url: urlEl.value, command: cmdEl.value, args: argsEl.value, env, agents });
        toast(res.nameChanged ? t('connectors.toast.addedRenamed', { name: res.name }) : t('connectors.toast.added')); close(); reload();
      } catch (err) { toast(err instanceof ApiError ? err.message : t('connectors.error'), true); submit.disabled = false; submit.textContent = t('connectors.add.submit'); }
    })());
  };

  const openCatalogInstall = (item: CatalogItem): void => {
    const envInputs: Array<{ key: string; el: HTMLInputElement }> = [];
    const fields: HTMLElement[] = [];
    if (item.authType === 'apikey') {
      for (const key of item.env) {
        const el = h('input', { type: 'password', placeholder: t('connectors.install.envPlaceholder', { key }) }) as HTMLInputElement;
        envInputs.push({ key, el });
        fields.push(h('div', { class: 'field' }, h('label', null, key), el));
      }
    }
    const installBtn = h('button', { class: 'primary block' }, t('connectors.install.btn')) as HTMLButtonElement;
    const body = h('div', { class: 'agent-modal-body' },
      h('p', { class: 'conn-desc' }, item.description),
      ...fields,
      ...(item.authNote ? [h('div', { class: 'field-note' }, item.authNote)] : []),
      h('div', { class: 'modal-actions' }, installBtn),
    );
    const { close } = modal(h('h2', null, t('connectors.install.title', { icon: item.icon, name: item.name })), body, 'catalog-install-modal');
    installBtn.addEventListener('click', () => void (async () => {
      const env: Record<string, string> = {};
      for (const { key, el } of envInputs) {
        if (el.value.trim() === '') { el.focus(); toast(t('connectors.install.required', { key }), true); return; }
        env[key] = el.value.trim();
      }
      installBtn.disabled = true; installBtn.textContent = t('connectors.install.installing');
      try { const r = await api.post<{ message: string }>(`/api/mcp-catalog/${encodeURIComponent(item.id)}/install`, { env }); toast(r.message); close(); reload(); }
      catch (err) { toast(err instanceof ApiError ? err.message : t('connectors.error'), true); installBtn.disabled = false; installBtn.textContent = t('connectors.install.btn'); }
    })());
  };

  // Modal 5 — env-var prompt (used by the GitHub-repo installer). Collects the
  // repo's required env vars; the entered values flow into the Vault (encrypted,
  // never echoed). Resolves the entered key→value map (blank vars omitted), or
  // null when dismissed via Skip / close / backdrop / Escape.
  const openEnvPrompt = (keys: string[]): Promise<Record<string, string> | null> => new Promise((resolve) => {
    const inputs = keys.map((key) => ({ key, el: h('input', { type: 'password', placeholder: t('connectors.envPrompt.valuePlaceholder') }) as HTMLInputElement }));
    const backdrop = h('div', { class: 'modal-backdrop' });
    let settled = false;
    const finish = (val: Record<string, string> | null): void => {
      if (settled) return;
      settled = true;
      backdrop.remove(); document.body.classList.remove('modal-open'); document.removeEventListener('keydown', onKey);
      resolve(val);
    };
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') finish(null); };
    document.addEventListener('keydown', onKey);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) finish(null); });
    const saveBtn = h('button', { class: 'primary' }, t('connectors.envPrompt.save')) as HTMLButtonElement;
    saveBtn.addEventListener('click', () => {
      const out: Record<string, string> = {};
      for (const { key, el } of inputs) { const v = el.value.trim(); if (v !== '') out[key] = v; }
      finish(out);
    });
    backdrop.append(h('div', { class: 'modal env-prompt-modal' },
      h('div', { class: 'agent-modal-titlebar' },
        h('h2', null, t('connectors.envPrompt.title')),
        h('button', { class: 'icon-btn', 'aria-label': t('connectors.close'), onclick: () => finish(null) }, '✕')),
      h('div', { class: 'agent-modal-body' },
        h('div', { class: 'field-note' }, t('connectors.envPrompt.note')),
        ...inputs.map(({ key, el }) => h('div', { class: 'field' }, h('label', null, key), el)),
        h('div', { class: 'modal-actions' },
          h('button', { class: 'secondary', onclick: () => finish(null) }, t('connectors.envPrompt.skip')),
          saveBtn,
        ),
      ),
    ));
    document.body.append(backdrop); document.body.classList.add('modal-open');
    setTimeout(() => inputs[0]?.el.focus(), 0);
  });

  // ---------- installed tab ----------
  const statusDot = (s: string): HTMLElement => h('span', { class: `conn-dot dot-${s}` });
  const connectorCard = (c: Connector): HTMLElement => {
    const readOnly = c.source === 'claude.ai';
    const disabled = c.enabled === false;
    const card = h('div', { class: `conn-card${readOnly ? ' read-only' : ''}${disabled ? ' conn-disabled' : ''}`, ...(readOnly ? { title: t('connectors.readOnly') } : { role: 'button' }) },
      h('div', { class: 'conn-card-head' }, statusDot(c.status), h('span', { class: 'conn-name' }, c.name),
        ...(disabled ? [h('span', { class: 'badge muted' }, t('connectors.disabledBadge'))] : []),
        h('span', { class: 'badge muted src-badge' }, SOURCE_LABEL[c.source] ?? c.source)),
      h('div', { class: 'conn-endpoint mono' }, c.endpoint ?? ''),
      h('span', { class: `badge type-badge type-${c.type}` }, c.type),
    );
    if (!readOnly) card.addEventListener('click', () => openDetail(c));
    return card;
  };

  const disclosure = (label: HTMLElement, count: number | null, bodyEl: HTMLElement, open = false): HTMLElement => {
    const tri = h('span', { class: 'tri' }, open ? '▼' : '▶');
    bodyEl.style.display = open ? '' : 'none';
    const head = h('div', { class: 'disclosure-head', role: 'button' }, tri, label, ...(count !== null ? [h('span', { class: 'badge count-badge' }, String(count))] : []));
    head.addEventListener('click', () => { const o = bodyEl.style.display === 'none'; bodyEl.style.display = o ? '' : 'none'; tri.textContent = o ? '▼' : '▶'; });
    return h('div', { class: 'disclosure' }, head, bodyEl);
  };

  const renderInstalled = (): HTMLElement => {
    const wrap = h('div', { class: 'mcp-installed' });
    // stats strip (only when there is something to count)
    const counts = { total: connectors.length, connected: 0, configured: 0, needs_auth: 0, failed: 0 };
    for (const c of connectors) { if (c.status === 'connected') counts.connected++; else if (c.status === 'configured') counts.configured++; else if (c.status === 'needs_auth') counts.needs_auth++; else if (c.status === 'failed') counts.failed++; }
    if (connectors.length > 0) {
      const tile = (key: string, n: number, cls: string): HTMLElement | null => n > 0 || key === 'total' ? h('div', { class: `stat-card ${cls}` }, h('div', { class: 'stat-value' }, String(n)), h('div', { class: 'stat-label' }, t(key))) : null;
      wrap.append(h('div', { class: 'stat-row mcp-stats' }, ...[tile('connectors.stat.total', counts.total, ''), tile('connectors.stat.active', counts.connected, 'ok-stat'), tile('connectors.stat.configured', counts.configured, 'info-stat'), tile('connectors.stat.needsAuth', counts.needs_auth, 'auth-stat'), tile('connectors.stat.failed', counts.failed, 'fail-stat')].filter((x): x is HTMLElement => x !== null)));
    }
    // stale upstream banner
    if (status.cacheError && connectors.some((c) => c.source === 'claude.ai')) {
      wrap.append(h('div', { class: 'stale-banner' }, t('connectors.stale', { error: status.cacheError })));
    }

    const grid = h('div', { class: 'mcp-grid' });
    // Claude global group: built-ins + global connectors
    const globals = connectors.filter((c) => c.scope === 'user' || c.scope === 'plugin');
    const builtinRow = h('div', { class: 'conn-cards' }, ...BUILTINS.map((b) => h('div', { class: 'conn-card builtin-card' },
      h('div', { class: 'conn-card-head' }, h('span', { class: 'conn-dot dot-unknown' }), h('span', { class: 'conn-name' }, b.label)),
      h('div', { class: 'conn-endpoint muted-note' }, t(b.descKey)),
      h('button', { class: 'link-btn', onclick: () => openBuiltin(b) }, t('connectors.builtin.details')),
    )));
    grid.append(h('div', { class: 'mcp-group' }, h('div', { class: 'mcp-group-head' }, t('connectors.group.global')), builtinRow, h('div', { class: 'conn-cards' }, ...globals.map(connectorCard))));

    // Agents group
    const agentScoped = connectors.filter((c) => c.scope === 'agent' && c.agentId);
    if (agentScoped.length > 0) {
      const byAgent = new Map<string, Connector[]>();
      for (const c of agentScoped) { const k = c.agentId!; (byAgent.get(k) ?? byAgent.set(k, []).get(k)!).push(c); }
      const subs = [...byAgent.entries()].map(([agent, list]) => disclosure(h('span', { class: 'disc-label' }, '🤖 ', agent), list.length, h('div', { class: 'conn-cards' }, ...list.map(connectorCard))));
      grid.append(h('div', { class: 'mcp-group' }, h('div', { class: 'mcp-group-head' }, t('connectors.group.agents')), ...subs));
    }
    // Projects group
    const projectScoped = connectors.filter((c) => c.scope === 'project');
    if (projectScoped.length > 0) grid.append(h('div', { class: 'mcp-group' }, h('div', { class: 'mcp-group-head' }, t('connectors.group.projects')), h('div', { class: 'conn-cards' }, ...projectScoped.map(connectorCard))));
    // External projects group
    const externalScoped = connectors.filter((c) => c.scope === 'external');
    if (externalScoped.length > 0) grid.append(h('div', { class: 'mcp-group' }, h('div', { class: 'mcp-group-head' }, t('connectors.group.external')), h('div', { class: 'conn-cards' }, ...externalScoped.map(connectorCard))));

    if (connectors.length === 0 && status.cacheLastRefreshed === null) {
      grid.append(h('div', { class: 'muted-note mcp-warming' }, t('connectors.warming')));
    }
    wrap.append(grid);
    wrap.append(renderTools());
    return wrap;
  };

  // ---------- tools sub-section ----------
  const renderTools = (): HTMLElement => {
    const sec = h('div', { class: 'mcp-tools' }, h('div', { class: 'sec-title tools-title' }, t('connectors.tools.title')));
    // GitHub repos
    const repoBody = h('div', { class: 'tool-body' });
    const repoUrl = h('input', { type: 'text', placeholder: 'https://github.com/user/repo' }) as HTMLInputElement;
    const repoStatus = h('div', { class: 'tool-status' });
    const repoList = h('div', { class: 'tool-list' });
    const loadRepos = (): void => { void api.get<Array<{ name: string; url: string; installedAt: string }>>('/api/connectors/github-repos').then((repos) => {
      mount(repoList, ...repos.map((r) => h('div', { class: 'tool-row' }, h('span', { class: 'tool-row-main' }, r.name), h('span', { class: 'tool-row-sub muted-note' }, new Date(r.installedAt).toLocaleDateString(currentLocale())),
        h('button', { class: 'icon-btn', title: t('connectors.repo.update'), onclick: () => void api.patch(`/api/connectors/github-repos/${encodeURIComponent(r.name)}`).then(() => { toast(t('connectors.toast.repoUpdated')); loadRepos(); }) }, '↻'),
        h('button', { class: 'icon-btn danger', title: t('connectors.btn.delete'), onclick: () => { if (window.confirm(t('connectors.confirm.repoDelete', { name: r.name }))) void api.delete(`/api/connectors/github-repos/${encodeURIComponent(r.name)}`).then(() => loadRepos()); } }, '×'))));
    }).catch(() => undefined); };
    // Install: clone+register, then (if the repo declares required env vars) open
    // the env-var prompt (Modal 5) and persist the entered values to the Vault.
    const installRepo = async (): Promise<void> => {
      try {
        repoStatus.textContent = t('connectors.repo.cloning');
        const res = await api.post<{ name: string; needsEnv: string[] }>('/api/connectors/github-repos', { url: repoUrl.value });
        repoUrl.value = ''; repoStatus.textContent = ''; loadRepos();
        if (Array.isArray(res.needsEnv) && res.needsEnv.length > 0) {
          const values = await openEnvPrompt(res.needsEnv);
          const entries = values ? Object.entries(values) : [];
          if (entries.length > 0) {
            for (const [key, value] of entries) await api.put(`/api/vault/${encodeURIComponent(key)}`, { label: key, value });
            repoStatus.textContent = t('connectors.repo.envSaved', { count: entries.length }); loadVault(); reload();
          }
        }
      } catch (err) { repoStatus.textContent = err instanceof ApiError ? err.message : ''; }
    };
    repoBody.append(repoList, h('div', { class: 'tool-add' }, repoUrl, h('button', { class: 'primary', onclick: () => void installRepo() }, t('connectors.repo.install'))), repoStatus);
    loadRepos();

    // Vault (inline)
    const vaultBody = h('div', { class: 'tool-body' });
    const vKey = h('input', { type: 'text', placeholder: t('connectors.vault.keyPlaceholder') }) as HTMLInputElement;
    const vVal = h('input', { type: 'password', placeholder: t('connectors.vault.valuePlaceholder') }) as HTMLInputElement;
    const vaultList = h('div', { class: 'tool-list' });
    const loadVault = (): void => { void api.get<Array<{ id: string; label: string; updatedAt: string }>>('/api/vault').then((secrets) => {
      mount(vaultList, ...secrets.map((s) => h('div', { class: 'tool-row' }, h('span', { class: 'tool-row-main' }, s.label), h('span', { class: 'tool-row-sub muted-note' }, `${s.id} · ${new Date(s.updatedAt).toLocaleDateString(currentLocale())}`),
        h('button', { class: 'icon-btn danger', title: t('connectors.btn.delete'), onclick: () => { if (window.confirm(t('connectors.confirm.vaultDelete', { name: s.label }))) void api.delete(`/api/vault/${encodeURIComponent(s.id)}`).then(() => loadVault()); } }, '×'))));
    }).catch(() => undefined); };
    vaultBody.append(vaultList, h('div', { class: 'tool-add' }, vKey, vVal, h('button', { class: 'primary', onclick: () => void (async () => { if (vKey.value.trim() === '' || vVal.value === '') return; try { await api.put(`/api/vault/${encodeURIComponent(vKey.value.trim())}`, { label: vKey.value.trim(), value: vVal.value }); vKey.value = ''; vVal.value = ''; loadVault(); } catch (err) { toast(err instanceof ApiError ? err.message : t('connectors.error'), true); } })() }, t('connectors.btn.save'))));
    loadVault();

    // Paths
    const pathBody = h('div', { class: 'tool-body' });
    const pInput = h('input', { type: 'text', placeholder: '/home/...' }) as HTMLInputElement;
    const pathList = h('div', { class: 'tool-list' });
    const loadPaths = (): void => { void api.get<Array<{ path: string }>>('/api/connectors/external-paths').then((paths) => {
      mount(pathList, ...paths.map((p) => h('div', { class: 'tool-row' }, h('span', { class: 'tool-row-main mono' }, p.path),
        h('button', { class: 'icon-btn danger', onclick: () => { if (window.confirm(t('connectors.confirm.pathDelete', { name: p.path }))) void api.delete('/api/connectors/external-paths', { path: p.path }).then(() => loadPaths()).catch(() => undefined); } }, '×'))));
    }).catch(() => undefined); };
    pathBody.append(pathList, h('div', { class: 'tool-add' }, pInput, h('button', { class: 'primary', onclick: () => void (async () => { try { await api.post('/api/connectors/external-paths', { path: pInput.value }); pInput.value = ''; loadPaths(); } catch (err) { toast(err instanceof ApiError ? err.message : t('connectors.error'), true); } })() }, t('connectors.path.add'))));
    loadPaths();

    sec.append(disclosure(h('span', { class: 'disc-label' }, t('connectors.tools.github')), null, repoBody));
    sec.append(disclosure(h('span', { class: 'disc-label' }, t('connectors.tools.vault')), null, vaultBody));
    sec.append(disclosure(h('span', { class: 'disc-label' }, t('connectors.tools.paths')), null, pathBody));
    return sec;
  };

  // ---------- gallery tab ----------
  const renderGallery = (): HTMLElement => {
    const wrap = h('div', { class: 'mcp-gallery' });
    const bar = h('div', { class: 'cat-bar' });
    const grid = h('div', { class: 'catalog-grid' }, h('div', { class: 'empty-block' }, h('div', { class: 'spinner-lg' }), h('div', { class: 'muted-note' }, t('connectors.gallery.loading'))));
    const renderBar = (): void => mount(bar, ...CATEGORIES.map((cat) => h('button', { class: `cat-pill${galleryCategory === cat ? ' active' : ''}`, onclick: () => { galleryCategory = cat; renderBar(); renderCatalog(); } }, t(`connectors.cat.${cat}`))));
    let catalog: CatalogItem[] = [];
    const card = (item: CatalogItem): HTMLElement => {
      const removable = item.installed && item.installedSource !== 'claude.ai' && item.configMatch === false;
      // §4A: a config-/upstream-detected install has no Remove link — its chip
      // tooltip instead directs the operator to manage it on the Installed tab.
      const chipTitle = item.installed && !removable ? t('connectors.gallery.manageElsewhere') : (item.installedSource ? `(${item.installedSource})` : '');
      const footer = item.installed
        ? h('span', { class: 'badge installed-chip', title: chipTitle }, t('connectors.gallery.installed'), item.installedSource ? ` (${item.installedSource})` : '')
        : h('div', { class: 'catalog-footer' }, h('button', { class: 'primary', onclick: () => openCatalogInstall(item) }, t('connectors.install.btn')), ...(item.authType === 'oauth' && item.authNote ? [h('span', { class: 'auth-hint' }, item.authNote)] : []));
      return h('div', { class: 'catalog-card' },
        h('div', { class: 'cat-card-head' }, h('span', { class: 'cat-icon' }, item.icon), h('span', { class: 'cat-name' }, item.name), h('span', { class: `badge type-badge type-${item.type}` }, item.type),
          ...(item.infoUrl ? [h('a', { class: 'doc-link', href: item.infoUrl, target: '_blank', rel: 'noopener', onclick: (e: Event) => e.stopPropagation() }, '↗')] : [])),
        h('div', { class: 'cat-desc' }, item.description),
        footer,
        ...(removable ? [h('button', { class: 'link-btn danger', onclick: () => { if (window.confirm(t('connectors.confirm.uninstall', { name: item.name }))) void api.delete(`/api/mcp-catalog/${encodeURIComponent(item.id)}/uninstall`).then((r) => { toast((r as { message?: string }).message ?? ''); renderCatalog(); reload(); }).catch((err) => toast(err instanceof ApiError ? err.message : t('connectors.error'), true)); } }, t('connectors.gallery.remove'))] : []),
      );
    };
    const renderCatalog = (): void => {
      const filtered = galleryCategory === 'all' ? catalog : catalog.filter((c) => c.category === galleryCategory);
      if (filtered.length === 0) { mount(grid, h('div', { class: 'muted-note center' }, t('connectors.gallery.emptyCat'))); return; }
      mount(grid, ...filtered.map(card));
    };
    void api.get<CatalogItem[]>('/api/mcp-catalog').then((c) => { catalog = c; renderCatalog(); }).catch(() => mount(grid, h('div', { class: 'muted-note err center' }, t('connectors.gallery.loadError'))));
    renderBar();
    wrap.append(bar, grid);
    return wrap;
  };

  // ---------- assemble ----------
  const refreshBtn = h('button', { class: 'secondary', title: t('connectors.refresh.tip') }, icon('refresh', 16), t('connectors.refresh')) as HTMLButtonElement;
  refreshBtn.addEventListener('click', () => void (async () => {
    refreshBtn.disabled = true;
    try { const r = await api.post<{ count: number }>('/api/connectors/refresh'); toast(t('connectors.toast.refreshed', { count: r.count })); reload(); }
    catch (err) { toast(err instanceof ApiError ? err.message : t('connectors.error'), true); refreshBtn.disabled = false; }
  })());

  const tabBar = h('div', { class: 'mcp-tabs' },
    h('button', { class: `tab${activeTab === 'installed' ? ' active' : ''}`, onclick: () => { activeTab = 'installed'; reload(); } }, t('connectors.tab.installed')),
    h('button', { class: `tab${activeTab === 'gallery' ? ' active' : ''}`, onclick: () => { activeTab = 'gallery'; reload(); } }, t('connectors.tab.gallery')),
  );

  mount(host,
    h('div', { class: 'page-header mcp-header' },
      h('div', null, h('h1', null, t('connectors.title')), h('p', { class: 'subtitle' }, t('connectors.subtitle'))),
      h('div', { class: 'mcp-header-actions' }, refreshBtn, h('button', { class: 'primary', onclick: openAdd }, icon('plus', 16), t('connectors.newConnector'))),
    ),
    h('div', { class: 'info-box' }, t('connectors.infoBanner')),
    disclosure(
      h('span', { class: 'disc-label' }, '❓ ', t('connectors.howto.title')),
      null,
      h('div', { class: 'conn-howto' },
        h('p', null, t('connectors.howto.intro')),
        h('ul', null,
          h('li', null, t('connectors.howto.stdio')),
          h('li', null, t('connectors.howto.http')),
          h('li', null, t('connectors.howto.secrets')),
          h('li', null, t('connectors.howto.assign')),
        ),
        h('p', { class: 'field-note' }, t('connectors.howto.examples')),
      ),
    ),
    tabBar,
    activeTab === 'installed' ? renderInstalled() : renderGallery(),
  );
}

defineView('mcp', 'nav.mcp', (host, store) => { void render(host, store); });
