// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * Status (Státusz) — upstream-provider health. Standalone view (#status, kept for
 * deep-link) PLUS renderStatusStrip(): the slim health-strip embedded above the Fleet
 * grid (#144 Fleet/Status merge). The strip is collapsed by default (verdict + provider
 * dots + a Details toggle) and auto-expands to the full board (services + incidents)
 * when any provider is not operational — an incident never hides behind a closed strip.
 * Honest empty/error states. No money anywhere (service health, not billing).
 */

import { defineView } from './registry.js';
import { h, mount } from '../dom.js';
import { t, currentLocale } from '../i18n.js';
import { api } from '../api.js';
import { icon } from '../icons.js';
import type { Store } from '../store.js';
import type { AppState } from '../main.js';

interface Component { name: string; status: string }
interface Incident { title: string; description: string; pubDate: string; link: string; status: string }
interface ProviderStatus { overall: 'operational' | 'degraded' | 'unknown'; components: Component[]; incidents: Incident[]; fetchedAt: string }

const COMP_SHORT: Record<string, string> = {
  operational: 'connectors.noop', degraded_performance: 'status.comp.degraded_performance',
  partial_outage: 'status.comp.partial_outage', major_outage: 'status.comp.major_outage', under_maintenance: 'status.comp.under_maintenance',
};
const INC_LABEL: Record<string, string> = { resolved: 'status.inc.resolved', monitoring: 'status.inc.monitoring', identified: 'status.inc.identified', investigating: 'status.inc.investigating' };

function stripMarkup(s: string): string {
  return s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

/** True when the overall verdict OR any component is not fully operational. */
function isDegraded(s: ProviderStatus): boolean {
  return s.overall !== 'operational' || s.components.some((c) => c.status !== 'operational');
}

/** The services grid + incidents list (shared by the standalone view and the strip panel). */
function renderBody(servicesGrid: HTMLElement, incidentsList: HTMLElement, s: ProviderStatus): void {
  if (s.components.length === 0) {
    mount(servicesGrid, h('div', { class: 'muted-note services-empty' }, t('status.services.empty')));
  } else {
    mount(servicesGrid, ...s.components.map((c) => {
      const ok = c.status === 'operational';
      const shortKey = COMP_SHORT[c.status];
      return h('div', { class: 'service-tile' },
        h('span', { class: `conn-dot ${ok ? 'dot-connected' : 'dot-needs_auth'}` }),
        h('span', { class: 'service-name' }, c.name),
        ...(ok ? [] : [h('span', { class: 'service-state' }, shortKey && shortKey !== 'connectors.noop' ? t(shortKey) : c.status)]),
      );
    }));
  }
  if (s.incidents.length === 0) {
    mount(incidentsList, h('div', { class: 'muted-note' }, t('status.incidents.empty')));
  } else {
    mount(incidentsList, ...s.incidents.slice(0, 15).map((inc) => h('div', { class: 'incident-card' },
      h('div', { class: 'incident-head' },
        inc.link ? h('a', { class: 'incident-title', href: inc.link, target: '_blank', rel: 'noopener' }, inc.title) : h('span', { class: 'incident-title' }, inc.title),
        h('span', { class: `badge inc-badge inc-${inc.status}` }, INC_LABEL[inc.status] ? t(INC_LABEL[inc.status]!) : inc.status),
      ),
      h('div', { class: 'incident-desc' }, stripMarkup(inc.description).slice(0, 300)),
      h('div', { class: 'incident-date muted-note' }, new Date(inc.pubDate).toLocaleString(currentLocale())),
    )));
  }
}

const verdictText = (overall: ProviderStatus['overall']): string =>
  overall === 'operational' ? t('status.overall.operational') : overall === 'degraded' ? t('status.overall.degraded') : t('status.overall.unknown');

/** Standalone Status view (#status deep-link). */
export function renderStatus(host: HTMLElement, store: Store<AppState>): void {
  void store;
  const banner = h('div', { class: 'status-banner unknown' }, t('status.loading'));
  const servicesGrid = h('div', { class: 'services-grid' });
  const incidentsList = h('div', { class: 'incidents-list' });
  const load = async (): Promise<void> => {
    banner.className = 'status-banner unknown';
    banner.textContent = t('status.loading');
    mount(servicesGrid); mount(incidentsList);
    let s: ProviderStatus;
    try { s = await api.get<ProviderStatus>('/api/provider-status'); }
    catch { banner.className = 'status-banner degraded'; banner.textContent = t('status.overall.loadError'); return; }
    banner.className = `status-banner ${s.overall}`;
    banner.textContent = verdictText(s.overall);
    renderBody(servicesGrid, incidentsList, s);
  };
  const refreshBtn = h('button', { class: 'secondary', onclick: () => void load() }, icon('refresh', 16), t('status.refresh'));
  mount(host,
    h('div', { class: 'page-header status-header' },
      h('div', null, h('h1', null, t('status.title')), h('p', { class: 'subtitle' }, t('status.subtitle'))),
      refreshBtn,
    ),
    banner,
    h('h2', { class: 'sec-title' }, t('status.services.heading')),
    servicesGrid,
    h('h2', { class: 'sec-title' }, t('status.incidents.heading')),
    incidentsList,
  );
  void load();
}

/**
 * The provider-health STRIP for the Fleet/Status merge (#144). Collapsed: verdict +
 * per-provider dots + a Details toggle. Expanded: the full services + incidents board.
 * Auto-expands (and never persists a closed state) when degraded. `startExpanded` opens
 * it on a #status deep-link.
 */
export function renderStatusStrip(host: HTMLElement, opts: { startExpanded?: boolean } = {}): void {
  const STRIP_KEY = 'nav-status-strip-expanded';
  let userPref: boolean | null = null;
  try { const v = localStorage.getItem(STRIP_KEY); if (v === '1' || v === '0') userPref = v === '1'; } catch { /* ignore */ }
  if (opts.startExpanded) userPref = true;

  const bar = h('div', { class: 'status-strip-bar' });
  const panel = h('div', { class: 'status-strip-panel' });
  mount(host, h('div', { class: 'status-strip panel' }, bar, panel));

  const paint = (s: ProviderStatus | null): void => {
    if (s === null) {
      mount(bar, h('span', { class: 'conn-dot dot-needs_auth' }), h('span', { class: 'status-strip-verdict' }, t('status.overall.loadError')));
      panel.style.display = 'none';
      return;
    }
    const degraded = isDegraded(s);
    const expanded = userPref !== null ? userPref : degraded; // auto-open on degraded
    bar.className = `status-strip-bar${degraded ? ' strip-danger' : ''}`;
    const dots = s.components.slice(0, 8).map((c) =>
      h('span', { class: `conn-dot ${c.status === 'operational' ? 'dot-connected' : 'dot-needs_auth'}`, title: c.name }),
    );
    const toggle = h(
      'button',
      { type: 'button', class: 'status-strip-toggle', 'aria-expanded': String(expanded), 'aria-controls': 'status-strip-panel', onclick: () => { userPref = !expanded; try { localStorage.setItem(STRIP_KEY, userPref ? '1' : '0'); } catch { /* ignore */ } paint(s); } },
      t(expanded ? 'status.strip.hide' : 'status.strip.details'),
      h('span', { 'aria-hidden': 'true' }, expanded ? ' ▾' : ' ▸'),
    );
    mount(bar,
      h('span', { class: `conn-dot ${s.overall === 'operational' ? 'dot-connected' : 'dot-needs_auth'}` }),
      h('span', { class: 'status-strip-verdict' }, verdictText(s.overall)),
      h('span', { class: 'status-strip-dots' }, ...dots),
      toggle,
    );
    panel.id = 'status-strip-panel';
    if (expanded) {
      panel.style.display = '';
      const servicesGrid = h('div', { class: 'services-grid' });
      const incidentsList = h('div', { class: 'incidents-list' });
      mount(panel,
        h('h2', { class: 'sec-title' }, t('status.services.heading')), servicesGrid,
        h('h2', { class: 'sec-title' }, t('status.incidents.heading')), incidentsList,
      );
      renderBody(servicesGrid, incidentsList, s);
    } else {
      panel.style.display = 'none';
      mount(panel);
    }
  };

  void (async (): Promise<void> => {
    try { paint(await api.get<ProviderStatus>('/api/provider-status')); }
    catch { paint(null); }
  })();
}

defineView('status', 'nav.status', renderStatus);
