// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * Approvals view (SPEC §15/§17): the pending spawn-request queue
 * (approve/deny — the dashboard action IS the human approval) and the kanban
 * cards still gated on requires_approval, with one-click approve.
 */

import { defineView } from './registry.js';
import { h, mount } from '../dom.js';
import { t, currentLocale } from '../i18n.js';
import { api, ApiError } from '../api.js';
import type { Store } from '../store.js';
import type { AppState } from '../main.js';

interface SpawnRequest {
  id: number;
  requester: string;
  agent_id: string;
  display_name: string;
  profile: string;
  created_at: string;
}

const CARD_STATUSES = ['planned', 'in_progress', 'waiting', 'done'] as const;
type CardStatus = (typeof CARD_STATUSES)[number];

interface Card {
  id: number;
  title: string;
  status: CardStatus;
  assignee: string;
  project: string | null;
  requiresApproval: boolean;
}

type BoardData = Record<CardStatus, Card[]>;

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
  toast(err instanceof ApiError ? err.message : t('approvals.error'), true);
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(currentLocale());
}

/** Poll guard: id parked on the host dataset; cleared before re-creating and on detach. */
function startPoll(host: HTMLElement, tick: () => void, ms: number): void {
  const prev = host.dataset.pollId;
  if (prev !== undefined) clearInterval(Number(prev));
  const id = window.setInterval(() => {
    if (!host.isConnected) {
      clearInterval(id);
      return;
    }
    tick();
  }, ms);
  host.dataset.pollId = String(id);
}

async function render(host: HTMLElement, store: Store<AppState>): Promise<void> {
  let spawns: SpawnRequest[] = [];
  let cards: Card[] = [];
  try {
    const [s, board] = await Promise.all([
      api.get<SpawnRequest[]>('/api/spawn-requests'),
      api.get<BoardData>('/api/kanban/board'),
    ]);
    spawns = s;
    // done cards no longer need the gate (mirrors the badge count)
    cards = [...board.planned, ...board.in_progress, ...board.waiting].filter((c) => c.requiresApproval);
  } catch (err) {
    showError(err);
  }

  mount(
    host,
    h('h1', { class: 'page-title' }, t('approvals.title')),
    spawnPanel(spawns, host, store),
    cardsPanel(cards, host, store),
  );
  startPoll(host, () => void render(host, store), 10000);
}

function spawnPanel(spawns: SpawnRequest[], host: HTMLElement, store: Store<AppState>): HTMLElement {
  const decide = (id: number, action: 'approve' | 'deny'): void => {
    void (async () => {
      try {
        await api.post(`/api/spawn-requests/${id}/${action}`);
        toast(t(action === 'approve' ? 'approvals.spawn.approved' : 'approvals.spawn.denied'), false);
        await render(host, store);
      } catch (err) {
        showError(err);
      }
    })();
  };

  return h(
    'div',
    { class: 'panel' },
    h('h3', { style: 'margin-top: 0' }, t('approvals.spawn.title')),
    spawns.length === 0
      ? h('p', { style: 'color: var(--ink-3); margin: 0' }, t('approvals.spawn.empty'))
      : h(
          'table',
          null,
          h(
            'thead',
            null,
            h(
              'tr',
              null,
              h('th', null, t('approvals.spawn.requester')),
              h('th', null, t('approvals.spawn.agent')),
              h('th', null, t('approvals.spawn.profile')),
              h('th', null, t('approvals.spawn.created')),
              h('th', null, ''),
            ),
          ),
          h(
            'tbody',
            null,
            ...spawns.map((req) =>
              h(
                'tr',
                null,
                h('td', null, req.requester),
                h('td', null, req.agent_id),
                h('td', null, h('span', { class: 'badge' }, req.profile)),
                h('td', null, fmtDate(req.created_at)),
                h(
                  'td',
                  { style: 'white-space: nowrap' },
                  h(
                    'button',
                    { class: 'primary', style: 'margin-right: var(--sp-2)', onclick: () => decide(req.id, 'approve') },
                    t('approvals.spawn.approve'),
                  ),
                  h('button', { class: 'danger', onclick: () => decide(req.id, 'deny') }, t('approvals.spawn.deny')),
                ),
              ),
            ),
          ),
        ),
  );
}

function cardsPanel(cards: Card[], host: HTMLElement, store: Store<AppState>): HTMLElement {
  const approve = (id: number): void => {
    void (async () => {
      try {
        await api.post(`/api/kanban/cards/${id}/approve`);
        toast(t('approvals.cards.approved'), false);
        await render(host, store);
      } catch (err) {
        showError(err);
      }
    })();
  };

  return h(
    'div',
    { class: 'panel' },
    h('h3', { style: 'margin-top: 0' }, t('approvals.cards.title')),
    cards.length === 0
      ? h('p', { style: 'color: var(--ink-3); margin: 0' }, t('approvals.cards.empty'))
      : h(
          'div',
          { class: 'card-grid' },
          ...cards.map((card) => {
            const agent = store.get().agents.find((a) => a.id === card.assignee);
            return h(
              'div',
              {
                class: 'kcard',
                style: agent !== undefined ? `--agent-accent: ${agent.accentColor}` : undefined,
              },
              h('div', { style: 'font-weight: 600; margin-bottom: var(--sp-2)' }, card.title),
              h(
                'div',
                { style: 'display: flex; gap: var(--sp-2); align-items: center; flex-wrap: wrap; margin-bottom: var(--sp-3)' },
                h(
                  'span',
                  { class: 'badge' },
                  agent?.displayName ?? (card.assignee === '' ? t('approvals.cards.unassigned') : card.assignee),
                ),
                h('span', { class: 'badge' }, t(`approvals.cards.status.${card.status}`)),
                card.project !== null && card.project !== '' ? h('span', { class: 'badge' }, card.project) : null,
              ),
              h('button', { class: 'primary', onclick: () => approve(card.id) }, t('approvals.cards.approve')),
            );
          }),
        ),
  );
}

defineView('approvals', 'nav.approvals', (host, store) => {
  void render(host, store);
});
