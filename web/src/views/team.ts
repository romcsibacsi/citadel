// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * Team (Csapat) view (PROMPT-04): the dedicated org-map page. A top-down
 * constellation of the reports-to hierarchy rooted at the hub, rendered by the
 * shared team-graph component (identical to the Overview's team card). Read-only
 * here — clicking a non-hub tile opens that agent's detail panel on its Team tab,
 * which is the editing surface. A Refresh button re-fetches the graph.
 */

import { defineView } from './registry.js';
import { h, mount } from '../dom.js';
import { t } from '../i18n.js';
import { api, ApiError } from '../api.js';
import { icon } from '../icons.js';
import { openAgentModal } from '../agentModal.js';
import { renderTeamGraph, type TeamGraph } from '../teamGraph.js';
import type { Store } from '../store.js';
import type { AppState } from '../main.js';

/**
 * The team constellation BODY (graph + refresh + footer), WITHOUT a page-header.
 * Exported so the merged Agents/Team view (#144) embeds the Team viewpoint under its
 * own toggle header (no duplicate h1). The standalone #team view wraps it with a header.
 */
export function renderTeamBody(host: HTMLElement, store: Store<AppState>): void {
  const accentOf = (id: string): string =>
    store.get().agents.find((a) => a.id === id)?.accentColor ?? 'var(--accent)';

  // a11y (#144 merge, PRISM): the graph is a visual region; its accessible equivalent is
  // the Agents LIST viewpoint — the aria-label says so, so a screen-reader user isn't
  // stranded in an unlabelled canvas (the toggle + the list carry the same roster data).
  const graphEl = h('div', { class: 'team-graph', role: 'region', 'aria-label': t('team.graphAria') });

  const load = async (): Promise<void> => {
    mount(graphEl, h('div', { class: 'muted-note center' }, t('team.loading')));
    try {
      const graph = await api.get<TeamGraph>('/api/team');
      renderTeamGraph(graphEl, graph, {
        accentOf,
        onNodeClick: (id) => void openAgentModal(id, () => void load(), { tab: 'team' }),
      });
    } catch (err) {
      mount(
        graphEl,
        h('div', { class: 'muted-note err center' }, t('team.error', { message: err instanceof ApiError ? err.message : String(err) })),
      );
    }
  };

  const refreshBtn = h('button', { class: 'refresh-btn', onclick: () => void load() }, icon('refresh', 16), t('team.refresh'));

  mount(host,
    h('div', { class: 'team-toolbar' }, refreshBtn),
    graphEl,
    h('div', { class: 'team-foot muted-note' }, t('team.footerHint')),
  );
  void load();
}

function render(host: HTMLElement, store: Store<AppState>): void {
  const body = h('div');
  mount(host,
    h('div', { class: 'page-header team-header' },
      h('div', null, h('h1', null, t('team.title')), h('p', { class: 'subtitle' }, t('team.subtitle'))),
    ),
    body,
  );
  renderTeamBody(body, store);
}

defineView('team', 'nav.team', render);
