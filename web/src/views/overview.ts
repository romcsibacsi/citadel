// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * Overview (Áttekintés) — the application's landing page (PROMPT-02). A passive,
 * read-on-entry command-bridge: a row of four headline stat cards, then a grid of
 * three content cards (the team constellation, the activity feed, and a reserved
 * agent-activity widget). The only interaction is clicking a non-hub team node,
 * which opens that agent's detail modal. Since the app no longer re-mounts views
 * on the 7s fleet poll (FIX-00), this view self-polls and re-runs load(), which
 * updates the stat values + activity + team IN PLACE (textContent / mount into
 * the card bodies) — never re-mounting the view, so no full-view flash.
 */

import { defineView } from './registry.js';
import { h, mount } from '../dom.js';
import { t, currentLocale } from '../i18n.js';
import { api, ApiError } from '../api.js';
import { icon } from '../icons.js';
import { openAgentModal } from '../agentModal.js';
import { renderTeamGraph, type RosterNode, type TeamGraph } from '../teamGraph.js';
import { pollWhileMounted } from '../poll.js';
import type { Store } from '../store.js';
import type { AppState } from '../main.js';

interface ActivityItem {
  ts: string;
  kind: 'memory' | 'message';
  text: string;
}
interface OverviewBundle {
  agents: { running: number; total: number };
  tasks: { today: number; yesterday: number };
  memory: { count: number; categories: number };
  skills: { count: number; createdToday: number };
  hubId: string;
  roster: RosterNode[];
  activity: ActivityItem[];
}

/** Locale-aware integer (HU groups thousands with a space, e.g. 12 480). */
function fmt(n: number): string {
  return n.toLocaleString(currentLocale());
}

/** Compact relative timestamp: most/now, {n}p/m, {n}ó/h, {n}n/d. */
function relTime(ts: string): string {
  const then = new Date(ts).getTime();
  if (Number.isNaN(then)) return '';
  const diffMin = Math.floor((Date.now() - then) / 60_000);
  if (diffMin < 1) return t('overview.time.now');
  if (diffMin < 60) return t('overview.time.min', { n: diffMin });
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return t('overview.time.hour', { n: diffH });
  return t('overview.time.day', { n: Math.floor(diffH / 24) });
}

function statCard(labelKey: string): { card: HTMLElement; value: HTMLElement; sub: HTMLElement } {
  const value = h('div', { class: 'stat-value' }, '—');
  const sub = h('div', { class: 'stat-sub' });
  const card = h('div', { class: 'stat-card' }, h('div', { class: 'stat-label' }, t(labelKey)), value, sub);
  return { card, value, sub };
}

function contentCard(titleKey: string, metaKey?: string): { card: HTMLElement; bodyEl: HTMLElement } {
  const bodyEl = h('div', { class: 'card-body' });
  const card = h(
    'div',
    { class: 'panel ov-card' },
    h(
      'div',
      { class: 'card-header' },
      h('div', { class: 'card-title' }, t(titleKey)),
      metaKey ? h('div', { class: 'card-meta' }, t(metaKey)) : null,
    ),
    bodyEl,
  );
  return { card, bodyEl };
}


function render(host: HTMLElement, store: Store<AppState>): void {
  const accentOf = (id: string): string =>
    store.get().agents.find((a) => a.id === id)?.accentColor ?? 'var(--accent)';

  // --- shell (paints immediately; values fill in once the bundle resolves) ---
  const aActive = statCard('overview.stat.activeAgents');
  const aTasks = statCard('overview.stat.tasksToday');
  const aMemory = statCard('overview.stat.memory');
  const aSkills = statCard('overview.stat.skills');
  const statRow = h('div', { class: 'stat-row' }, aActive.card, aTasks.card, aMemory.card, aSkills.card);

  const team = contentCard('overview.card.team', 'overview.card.team.meta');
  const activity = contentCard('overview.card.activity');
  const widget = contentCard('overview.card.agentActivity', 'overview.card.agentActivity.meta');
  mount(team.bodyEl, h('div', { class: 'muted-note' }, t('overview.loading')));
  // the agent-activity widget is a reserved, empty container in the reference build
  mount(widget.bodyEl, h('div', { class: 'widget-body' }));

  mount(
    host,
    h(
      'div',
      { class: 'page-header' },
      h('h1', null, t('overview.title')),
      h('p', { class: 'subtitle' }, t('overview.subtitle')),
    ),
    statRow,
    h('div', { class: 'overview-grid' }, team.card, activity.card, widget.card),
  );

  // --- stat cards + activity feed (from the metrics bundle) ---
  const fillStats = (b: OverviewBundle): void => {
    aActive.value.textContent = fmt(b.agents.running);
    aActive.sub.textContent = t('overview.stat.activeAgents.sub', { total: fmt(b.agents.total) });

    aTasks.value.textContent = fmt(b.tasks.today);
    const delta = b.tasks.today - b.tasks.yesterday;
    aTasks.sub.textContent =
      delta === 0
        ? t('overview.stat.tasks.same')
        : delta > 0
          ? t('overview.stat.tasks.up', { n: delta })
          : t('overview.stat.tasks.down', { n: delta });

    aMemory.value.textContent = fmt(b.memory.count);
    aMemory.sub.textContent = t('overview.stat.memory.sub', { categories: fmt(b.memory.categories) });

    aSkills.value.textContent = fmt(b.skills.count);
    aSkills.sub.textContent = b.skills.createdToday > 0 ? t('overview.stat.skills.sub', { n: b.skills.createdToday }) : '';
  };

  const renderActivity = (items: ActivityItem[]): void => {
    if (items.length === 0) {
      mount(activity.bodyEl, h('div', { class: 'muted-note' }, t('overview.activityEmpty')));
      return;
    }
    mount(
      activity.bodyEl,
      h(
        'div',
        { class: 'activity-feed' },
        ...items.map((it) =>
          h(
            'div',
            { class: 'activity-row' },
            h('span', { class: `act-icon ${it.kind}` }, icon(it.kind === 'memory' ? 'brain' : 'arrow', 16)),
            h(
              'div',
              { class: 'act-main' },
              h('div', { class: 'act-text' }, it.text),
              h('div', { class: 'act-time' }, relTime(it.ts)),
            ),
          ),
        ),
      ),
    );
  };

  // --- team constellation (shared renderer; identical to the Team page) ---
  const renderTeam = (graph: TeamGraph): void => {
    renderTeamGraph(team.bodyEl, graph, {
      accentOf,
      onNodeClick: (id) => void openAgentModal(id, () => void load()),
    });
  };

  // --- load (once per entry; the two endpoints are independent) ---
  const load = async (): Promise<void> => {
    try {
      const b = await api.get<OverviewBundle>('/api/overview');
      fillStats(b);
      renderActivity(b.activity);
    } catch (err) {
      mount(
        activity.bodyEl,
        h('div', { class: 'muted-note err' }, t('overview.error', { message: err instanceof ApiError ? err.message : String(err) })),
      );
    }
    try {
      const graph = await api.get<TeamGraph>('/api/team');
      renderTeam(graph);
    } catch (err) {
      mount(
        team.bodyEl,
        h('div', { class: 'muted-note err' }, t('overview.error', { message: err instanceof ApiError ? err.message : String(err) })),
      );
    }
  };
  void load();

  // Live refresh in place (FIX-00): re-run load() on the same ~7s cadence as the
  // fleet poll. load() only rewrites the stat values + the card bodies, so the
  // page shell (header, stat-row, grid) is never re-mounted — no flash. The poll
  // self-clears once this host detaches (a real navigation).
  pollWhileMounted(host, () => void load(), 7000);
}

defineView('overview', 'nav.overview', render);
