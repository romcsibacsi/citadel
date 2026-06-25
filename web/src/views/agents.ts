// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * Agents (Ügynökök) view (PROMPT-03): the roster + management surface. A grid of
 * agent cards (orchestrator first, then the roster, then a "New agent" tile),
 * each with live status indicators, a Terminal button, and a whole-card click
 * into the five-tab detail panel. The creation wizard, detail panel, terminal,
 * and skill editor are shared modals. Page title reads "Csapat" / "Team" while
 * the nav item reads "Ügynökök" / "Agents" (per spec §1).
 */

import { defineView } from './registry.js';
import { renderTeamBody } from './team.js';
import { h, mount } from '../dom.js';
import { t } from '../i18n.js';
import { api } from '../api.js';
import { icon } from '../icons.js';
import { framedAvatar } from '../framedAvatar.js';
import { openAgentModal } from '../agentModal.js';
import { openAgentWizard } from '../agentWizard.js';
import { openTerminal } from '../terminalModal.js';
import { pollWhileMounted, modalOpen } from '../poll.js';
import type { Store } from '../store.js';
import type { AppState } from '../main.js';

interface AgentSummary {
  id: string;
  displayName: string;
  role: string;
  accentColor: string;
  model: string | null;
  channel: { provider: string; chatId?: string } | null;
  running: boolean;
  busyState: string;
  isHub: boolean;
}

function dotClass(a: AgentSummary): string {
  if (!a.running) return 'idle';
  if (a.busyState === 'ready') return 'ok';
  if (a.busyState === 'busy') return 'busy';
  return 'warn';
}

// Agents/Team merge (#144): the roster view gains a viewpoint toggle — "Agents" (the
// management grid) | "Team" (the reports-to constellation, embedded from team.ts).
let agentsViewpoint: 'agents' | 'team' = 'agents';
const AVP_KEY = 'nav-agents-viewpoint';

/** The "Agents" viewpoint: the management grid + its 7s self-refresh, into `sub`. */
function renderAgentsList(sub: HTMLElement, store: Store<AppState>): void {
  const grid = h('div', { class: 'card-grid agents-grid' });

  const card = (a: AgentSummary, reload: () => void): HTMLElement => {
    const open = (): void => void openAgentModal(a.id, reload);
    const termBtn = h('button', { class: 'card-term', 'aria-label': 'Terminal', onclick: (e: Event) => { e.stopPropagation(); openTerminal(a.id, a.displayName); } }, icon('terminal', 16), 'Terminal');

    const reauth = a.busyState === 'reauth-needed'
      ? h('div', { class: 'reauth-banner' }, h('span', null, t('agents.reauth')), h('button', { class: 'danger', onclick: (e: Event) => { e.stopPropagation(); openTerminal(a.id, a.displayName); } }, t('agents.login')))
      : null;

    const channelOn = a.channel !== null;
    return h(
      'div',
      { class: `agent-card${a.isHub ? ' hub-card' : ''}`, style: `--agent-accent: ${a.accentColor}`, role: 'button', tabindex: '0', onclick: open },
      h(
        'div',
        { class: 'agent-head' },
        framedAvatar(a.displayName, a.accentColor, 52),
        h(
          'div',
          { class: 'agent-id' },
          h('div', { class: 'agent-name' }, a.displayName, a.isHub ? h('span', { class: 'badge main-badge' }, t('agents.mainBadge')) : null),
          h('div', { class: 'agent-desc' }, a.role),
        ),
      ),
      reauth,
      h(
        'div',
        { class: 'agent-foot' },
        h('span', { class: 'badge muted model-badge' }, a.model ?? t('agents.model.inherit')),
        h('span', { class: 'ind' }, h('span', { class: `dot ${a.isHub ? 'ok' : dotClass(a)}` }), a.isHub || a.running ? t('agents.run.running') : t('agents.run.stopped')),
        h('span', { class: 'ind' }, h('span', { class: `dot ${a.isHub || channelOn ? 'ok' : 'idle'}` }), a.isHub || channelOn ? t('agents.online') : t('agents.offline')),
      ),
      h('div', { class: 'agent-actions' }, termBtn),
    );
  };

  const load = async (): Promise<void> => {
    try {
      const agents = await api.get<AgentSummary[]>('/api/agents');
      agents.sort((a, b) => (a.isHub ? -1 : b.isHub ? 1 : 0)); // orchestrator first
      const tile = h('button', { class: 'add-card', onclick: () => openAgentWizard((id) => { void load(); void openAgentModal(id, () => void load(), { tab: 'channel' }); }) }, h('span', { class: 'plus' }, icon('plus', 28)), h('span', null, t('agents.newAgent')));
      mount(grid, ...agents.map((a) => card(a, () => void load())), tile);
    } catch {
      /* leave the grid as-is on a transient fetch failure */
    }
  };

  mount(sub, grid);
  void load();
  void store; // roster data is fetched directly; the store is unused here

  // Live refresh in place (FIX-00): self-poll load() (re-fetch + repaint the grid),
  // skipping while a modal is open. POLL-HYGIENE for the merge: pollWhileMounted is
  // bound to `sub`, so switching to the Team viewpoint (which re-mounts sub) detaches
  // the grid and auto-clears this poll — the constellation never polls the roster.
  pollWhileMounted(sub, () => void load(), 7000, modalOpen);
}

function render(host: HTMLElement, store: Store<AppState>, subpath: string[]): void {
  // Deep-link: #agents/team (and the redirected #team) opens the Team viewpoint.
  if (subpath[0] === 'team') agentsViewpoint = 'team';
  else if (subpath[0] === 'agents' || subpath[0] === 'list') agentsViewpoint = 'agents';
  else { try { const v = localStorage.getItem(AVP_KEY); if (v === 'team' || v === 'agents') agentsViewpoint = v; } catch { /* ignore */ } }

  const sub = h('div', { class: 'agents-viewpoint' });
  const select = (vp: 'agents' | 'team'): void => {
    if (vp === agentsViewpoint) return;
    agentsViewpoint = vp;
    try { localStorage.setItem(AVP_KEY, vp); } catch { /* ignore */ }
    render(host, store, []);
    (host.querySelector('.seg-btn.active') as HTMLElement | null)?.focus();
  };
  const seg = (vp: 'agents' | 'team', labelKey: string): HTMLElement => {
    const btn = h('button', {
      type: 'button', role: 'radio', 'aria-checked': String(agentsViewpoint === vp),
      tabindex: agentsViewpoint === vp ? '0' : '-1',
      class: agentsViewpoint === vp ? 'seg-btn active' : 'seg-btn',
      onclick: () => select(vp),
    }, t(labelKey));
    btn.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); select(vp === 'agents' ? 'team' : 'agents'); }
    });
    return btn;
  };

  mount(host,
    h('div', { class: 'page-header' },
      h('div', null,
        h('h1', null, t('agents.pageTitle')),
        h('p', { class: 'subtitle' }, agentsViewpoint === 'agents' ? t('agents.subtitle') : t('team.subtitle')),
      ),
      h('div', { class: 'seg-group', role: 'radiogroup', 'aria-label': t('agents.viewpoint.label') },
        seg('agents', 'agents.viewpoint.agents'),
        seg('team', 'agents.viewpoint.team'),
      ),
    ),
    sub,
  );

  if (agentsViewpoint === 'agents') renderAgentsList(sub, store);
  else renderTeamBody(sub, store);
}

defineView('agents', 'nav.agents', render);
