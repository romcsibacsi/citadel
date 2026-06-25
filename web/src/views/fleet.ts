// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * Fleet view (home): agent cards with lifecycle controls, fleet header,
 * collapsible create form. Live data arrives via the app-level store refresh
 * (main.ts polls /api/agents). Since the app no longer re-mounts views on that
 * poll (FIX-00), this view subscribes to the store and repaints ONLY its header
 * + agent grid in place — the collapsible create form (formOpen/draft) is never
 * torn down, so a half-typed new-agent form survives the background refresh.
 */

import { defineView } from './registry.js';
import { renderStatusStrip } from './status.js';
import { h, mount } from '../dom.js';
import { t } from '../i18n.js';
import { api, ApiError } from '../api.js';
import { repaintOnStore } from '../poll.js';
import type { Store } from '../store.js';
import type { AppState, AgentSummary } from '../main.js';

/** /api/agents items carry isSeed/isHub beyond the shell's AgentSummary. */
interface FleetAgent extends AgentSummary {
  isSeed?: boolean;
  isHub?: boolean;
  securityProfile?: string;
}

interface Draft {
  id: string;
  displayName: string;
  role: string;
  securityProfile: string;
  accentColor: string;
}

const SECURITY_PROFILES = ['sandbox', 'draft', 'trusted-build'] as const;

// Form state survives the full re-render cycle (store refresh every few seconds).
let formOpen = false;
let draft: Draft = blankDraft();

function blankDraft(): Draft {
  return { id: '', displayName: '', role: '', securityProfile: 'sandbox', accentColor: '#7c5cff' };
}

function toast(message: string, isError: boolean): void {
  let hostEl = document.querySelector<HTMLDivElement>('.toast-host');
  if (!hostEl) {
    hostEl = h('div', { class: 'toast-host' }) as HTMLDivElement;
    document.body.append(hostEl);
  }
  const node = h('div', { class: isError ? 'toast err' : 'toast' }, message);
  hostEl.append(node);
  setTimeout(() => node.remove(), 6000);
}

function showError(err: unknown): void {
  toast(err instanceof ApiError ? err.message : t('fleet.error'), true);
}

async function refreshAgents(store: Store<AppState>): Promise<void> {
  try {
    const agents = await api.get<FleetAgent[]>('/api/agents');
    store.patch({ agents });
  } catch {
    /* transient: the app-level poll catches up */
  }
}

async function lifecycle(id: string, op: 'start' | 'stop' | 'restart', store: Store<AppState>): Promise<void> {
  try {
    await api.post(`/api/agents/${encodeURIComponent(id)}/${op}`);
    await refreshAgents(store);
  } catch (err) {
    showError(err);
  }
}

async function removeAgent(agent: FleetAgent, store: Store<AppState>): Promise<void> {
  if (!window.confirm(t('fleet.deleteConfirm', { name: agent.displayName }))) return;
  try {
    await api.delete(`/api/agents/${encodeURIComponent(agent.id)}`);
    await refreshAgents(store);
  } catch (err) {
    showError(err);
  }
}

function stateKeyFor(agent: FleetAgent): string {
  return agent.running ? agent.busyState : 'stopped';
}

function dotClassFor(agent: FleetAgent): string {
  if (!agent.running) return 'idle';
  if (agent.busyState === 'ready') return 'ok';
  if (agent.busyState === 'busy') return 'busy';
  return 'warn'; // needs-input | reauth-needed
}

function agentCard(agent: FleetAgent, store: Store<AppState>): HTMLElement {
  return h(
    'div',
    { class: 'agent-card', style: `--agent-accent: ${agent.accentColor}` },
    h('div', { class: 'agent-name' }, agent.displayName),
    h('div', { style: 'color: var(--ink-2); margin-top: 4px' }, agent.role),
    h(
      'div',
      { style: 'margin-top: 8px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap' },
      h('span', null, h('span', { class: `dot ${dotClassFor(agent)}` }), t(`fleet.state.${stateKeyFor(agent)}`)),
      h(
        'span',
        { class: 'badge' },
        t('fleet.desiredLabel'),
        ': ',
        t(agent.desired === 'running' ? 'fleet.desired.running' : 'fleet.desired.stopped'),
      ),
    ),
    h(
      'div',
      { style: 'margin-top: 12px; display: flex; gap: 8px; flex-wrap: wrap' },
      h('button', { disabled: agent.running, onclick: () => void lifecycle(agent.id, 'start', store) }, t('fleet.start')),
      h('button', { disabled: !agent.running, onclick: () => void lifecycle(agent.id, 'stop', store) }, t('fleet.stop')),
      h(
        'button',
        { disabled: !agent.running, onclick: () => void lifecycle(agent.id, 'restart', store) },
        t('fleet.restart'),
      ),
      h('a', { class: 'btn', href: `#agent/${agent.id}` }, t('fleet.watch')),
      agent.isSeed === false
        ? h('button', { class: 'danger', onclick: () => void removeAgent(agent, store) }, t('fleet.delete'))
        : null,
    ),
  );
}

function headerPanel(state: AppState): HTMLElement {
  const running = state.agents.filter((a) => a.running).length;
  return h(
    'div',
    { class: 'panel', style: 'display: flex; gap: 16px; align-items: center; flex-wrap: wrap' },
    h('span', null, t('fleet.total', { count: state.agents.length })),
    h('span', null, h('span', { class: 'dot ok' }), t('fleet.running', { count: running })),
    state.approvalsBadge > 0
      ? h('a', { class: 'btn', href: '#approvals' }, t('fleet.approvalsLink', { count: state.approvalsBadge }))
      : null,
  );
}

function textField(key: 'id' | 'displayName' | 'role', labelKey: string, required: boolean): HTMLElement {
  const input = h('input', {
    type: 'text',
    value: draft[key],
    required,
    oninput: (e: Event) => {
      draft[key] = (e.target as HTMLInputElement).value;
    },
  });
  return h('div', null, h('label', null, t(labelKey)), input);
}

function createPanel(store: Store<AppState>): HTMLElement {
  const profileSelect = h(
    'select',
    {
      onchange: (e: Event) => {
        draft.securityProfile = (e.target as HTMLSelectElement).value;
      },
    },
    ...SECURITY_PROFILES.map((p) => h('option', { value: p, selected: draft.securityProfile === p }, t(`fleet.profile.${p}`))),
  );
  const colorInput = h('input', {
    type: 'color',
    value: draft.accentColor,
    oninput: (e: Event) => {
      draft.accentColor = (e.target as HTMLInputElement).value;
    },
  });

  const form = h(
    'form',
    {
      style:
        'display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-top: 12px; align-items: end',
      onsubmit: (e: Event) => {
        e.preventDefault();
        void submitCreate(store);
      },
    },
    textField('id', 'fleet.create.id', true),
    textField('displayName', 'fleet.create.displayName', false),
    textField('role', 'fleet.create.role', false),
    h('div', null, h('label', null, t('fleet.create.profile')), profileSelect),
    h('div', null, h('label', null, t('fleet.create.accent')), colorInput),
    h('div', null, h('button', { class: 'primary', type: 'submit' }, t('fleet.create.submit'))),
  );

  const details = h(
    'details',
    formOpen ? { open: true } : null,
    h('summary', { style: 'cursor: pointer' }, t('fleet.create.title')),
    form,
  ) as HTMLDetailsElement;
  details.addEventListener('toggle', () => {
    formOpen = details.open;
  });
  return h('div', { class: 'panel' }, details);
}

async function submitCreate(store: Store<AppState>): Promise<void> {
  const id = draft.id.trim();
  if (id === '') return;
  const body: Record<string, string> = {
    id,
    securityProfile: draft.securityProfile,
    accentColor: draft.accentColor,
  };
  if (draft.displayName.trim() !== '') body.displayName = draft.displayName.trim();
  if (draft.role.trim() !== '') body.role = draft.role.trim();
  try {
    const res = await api.post<{ created: string }>('/api/agents', body);
    draft = blankDraft();
    formOpen = false;
    toast(t('fleet.create.created', { id: res.created }), false);
    await refreshAgents(store);
  } catch (err) {
    // 403 (spawn denied / reserved id) and every other ApiError land here
    showError(err);
  }
}

function render(host: HTMLElement, store: Store<AppState>, subpath: string[]): void {
  // Stable shell built once: the header + grid live in their own slots so the
  // live refresh can repaint just those, leaving the create form (createPanel,
  // which holds module-level formOpen/draft) untouched across fleet polls.
  const headerSlot = h('div', { class: 'fleet-header-slot' });
  const gridSlot = h('div', { class: 'panel' });
  // Fleet/Status merge (#144): the provider-health strip sits above the fleet grid.
  // It self-refreshes independently of the fleet poll; #status deep-links open it.
  const stripSlot = h('div', { class: 'fleet-status-strip-slot' });

  const paint = (): void => {
    const state = store.get();
    const agents = state.agents as FleetAgent[];
    mount(headerSlot, headerPanel(state));
    mount(gridSlot, h('div', { class: 'card-grid' }, ...agents.map((a) => agentCard(a, store))));
  };

  mount(
    host,
    h('h1', { class: 'page-title' }, t('fleet.title')),
    stripSlot,
    headerSlot,
    gridSlot,
    createPanel(store),
  );
  renderStatusStrip(stripSlot, { startExpanded: subpath[0] === 'status' });
  paint();

  // In-place live refresh (FIX-00): repaint the header + grid on every store
  // change (the app's 7s /api/agents poll patches the store). Zero extra
  // requests — it piggybacks on the existing poll. Auto-unsubscribes on detach.
  repaintOnStore(host, store, paint);
}

defineView('fleet', 'nav.fleet', render);
