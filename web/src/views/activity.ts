// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * Activity / Log (Aktivitás / Napló) — one view, two viewpoints (#144 merge): "Élő"
 * (the live, 3s-polling fleet board — one card per agent + terminal tail; a running
 * card opens the Terminal modal) and "Napló" (the cross-agent searchable journal,
 * embedded from journal.ts). A segmented toggle switches them. POLL-HYGIENE: the 3s
 * live poll runs ONLY while "Élő" is active — switching to "Napló" stops it, switching
 * back re-arms it. Read-only, no destructive actions.
 */

import { defineView } from './registry.js';
import { renderJournal } from './journal.js';
import { h, mount } from '../dom.js';
import { t, currentLocale } from '../i18n.js';
import { api, ApiError } from '../api.js';
import { icon } from '../icons.js';
import { openTerminal } from '../terminalModal.js';
import type { Store } from '../store.js';
import type { AppState } from '../main.js';

interface Card { name: string; agentId: string; isMain: boolean; running: boolean; state: string; tail: string[]; stuck?: { level: 1 | 2; sinceMs: number } }
const STATES = ['working', 'idle', 'unknown', 'error', 'stopped'];

let pollTimer: number | undefined;
let viewpoint: 'live' | 'log' = 'live';
const VP_KEY = 'nav-activity-viewpoint';

function stopPoll(): void {
  if (pollTimer !== undefined) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
}

/** The "Élő" viewpoint: the live fleet board + its 3s poll, mounted into `sub`. */
function renderLive(sub: HTMLElement): void {
  stopPoll();
  const updated = h('span', { class: 'act-updated muted-note' });
  const grid = h('div', { class: 'act-grid' }, h('div', { class: 'muted-note act-msg' }, t('activity.loading')));

  const card = (c: Card): HTMLElement => {
    const state = STATES.includes(c.state) ? c.state : 'unknown';
    const head = h('div', { class: 'act-card-head' },
      h('div', { class: 'act-name-wrap' }, h('span', { class: 'act-name' }, c.name), ...(c.isMain ? [h('span', { class: 'badge act-main' }, t('activity.badge.main'))] : [])),
      h('div', { class: 'act-badges' },
        ...(c.running ? [h('span', { class: 'act-term-icon', title: t('activity.termIcon.tip') }, icon('terminal', 14))] : []),
        ...(c.stuck ? [h('span', { class: `badge act-stuck act-stuck-l${c.stuck.level}`, title: t('activity.stuck.tip') }, `⚠ ${t('activity.stuck.label')}`)] : []),
        h('span', { class: `badge act-state act-state-${state}`, title: t(`state.${state}.tip`) }, t(`state.${state}.label`)),
      ),
    );
    let body: HTMLElement;
    if (c.tail.length > 0) body = h('pre', { class: 'act-tail mono' }, c.tail.join('\n'));
    else body = h('div', { class: 'act-tail-empty muted-note' }, c.running ? t('activity.noRecentOutput') : t('activity.sessionNotRunning'));
    const el = h('div', { class: `act-card act-card-${state}${c.running ? ' clickable' : ''}` }, head, body);
    if (c.running) el.addEventListener('click', () => openTerminal(c.agentId, c.name));
    return el;
  };

  const load = async (): Promise<void> => {
    try {
      const board = await api.get<Card[]>('/api/agents/activity');
      if (board.length === 0) { mount(grid, h('div', { class: 'muted-note act-msg' }, t('activity.empty'))); }
      else mount(grid, ...board.map(card));
      updated.textContent = t('activity.updated', { time: new Date().toLocaleTimeString(currentLocale(), { hour12: false }) });
    } catch (err) {
      mount(grid, h('div', { class: 'muted-note act-msg err' }, t('activity.fetchError', { error: err instanceof ApiError ? err.message : String(err) })));
    }
  };

  mount(sub, h('div', { class: 'act-live-meta' }, updated), grid);
  void load();
  pollTimer = window.setInterval(() => {
    if (!grid.isConnected) { stopPoll(); return; }
    void load();
  }, 3000);
}

function render(host: HTMLElement, store: Store<AppState>, subpath: string[]): void {
  void store;
  // Deep-link: #activity/log opens the Napló viewpoint; otherwise restore the last one.
  if (subpath[0] === 'log') viewpoint = 'log';
  else if (subpath[0] === 'live') viewpoint = 'live';
  else {
    try { const v = localStorage.getItem(VP_KEY); if (v === 'log' || v === 'live') viewpoint = v; } catch { /* ignore */ }
  }
  stopPoll(); // poll-hygiene: never leave a stale live poll running across a (re)render

  const sub = h('div', { class: 'act-viewpoint' });
  const select = (vp: 'live' | 'log'): void => {
    if (vp === viewpoint) return;
    viewpoint = vp;
    try { localStorage.setItem(VP_KEY, vp); } catch { /* ignore */ }
    render(host, store, []); // rebuild header (toggle state) + sub; stopPoll + re-arm handled inside
    (host.querySelector('.seg-btn.active') as HTMLElement | null)?.focus(); // focus stays on the toggle
  };
  const seg = (vp: 'live' | 'log', labelKey: string): HTMLElement => {
    const btn = h(
      'button',
      {
        type: 'button',
        role: 'radio',
        'aria-checked': String(viewpoint === vp),
        tabindex: viewpoint === vp ? '0' : '-1',
        class: viewpoint === vp ? 'seg-btn active' : 'seg-btn',
        onclick: () => select(vp),
      },
      t(labelKey),
    );
    btn.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); select(vp === 'live' ? 'log' : 'live'); }
    });
    return btn;
  };

  mount(host,
    h('div', { class: 'page-header act-header' },
      h('div', null,
        h('h1', null, t('activity.title')),
        h('p', { class: 'subtitle' }, viewpoint === 'live' ? t('activity.subtitle') : t('journal.subtitle')),
      ),
      h('div', { class: 'seg-group', role: 'radiogroup', 'aria-label': t('activity.viewpoint.label') },
        seg('live', 'activity.viewpoint.live'),
        seg('log', 'activity.viewpoint.log'),
      ),
    ),
    sub,
  );

  if (viewpoint === 'live') renderLive(sub);
  else renderJournal(sub, store); // Napló: no poll (poll-hygiene)
}

defineView('activity', 'nav.item.activityLog', render);
