// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { bootstrapToken, api } from './api.js';
import { onConnectionChange, type ConnectionStatus } from './connection.js';
import { h, mount } from './dom.js';
import { initI18n, setLocale, currentLocale, t, availableLocales } from './i18n.js';
import { Store } from './store.js';
import { icon } from './icons.js';
import { quickThemeToggle, tweaksGearButton } from './tweaks.js';
import { registerViews, renderView, viewNavSections, DEFAULT_VIEW, applyRouteGuards, runBootHooks, runRefreshHooks } from './views/registry.js';

export interface AppState {
  route: string;
  branding: { productName: string };
  localeDefault: string;
  agents: AgentSummary[];
  approvalsBadge: number;
  /**
   * #425: vertical-contributed nav badges, keyed by view id (e.g. { cs: 3 }). A vertical's refresh hook
   * patches these; the core never names a vertical badge. EMPTY on the core shell = no vertical badge.
   */
  navBadges: Record<string, number>;
  updatesBehind: number;
  /**
   * #425: a generic vertical nav-engine marker (null = none/unavailable). A registered vertical
   * boot hook patches it (e.g. the vertical engine, resolved by the vertical); the registered route
   * guard reads it. The CORE shell never names a concrete engine value — default-deny (stays null).
   */
  navEngine: string | null;
}

export interface AgentSummary {
  id: string;
  displayName: string;
  role: string;
  accentColor: string;
  hidden?: boolean;
  running: boolean;
  busyState: string;
  desired: string;
}

// #144 deep-link backward-compat: old top-level routes now live under a merged view
// or the Settings hub. A BARE old route resolves (and canonicalizes) to its new home so
// existing links/bookmarks never break. Only added for routes whose target already
// exists (Settings hub + Activity/Log); #status/#team wait for their merges; #wizard
// stays standalone so the first-run full-page wizard is unaffected.
const ROUTE_REDIRECTS: Record<string, string> = {
  vault: 'settings/integrations',
  autonomy: 'settings/autonomy',
  channels: 'settings/channels',
  updates: 'settings/updates',
  migration: 'settings/migration',
  journal: 'activity/log',
  status: 'fleet/status', // Fleet/Status merge: #status opens the fleet view with the strip expanded
  team: 'agents/team', // Team merged into Agents (#135): #team opens the Team viewpoint
};
function resolveRoute(raw: string): string {
  const head = raw.split('/')[0] ?? '';
  return raw === head && ROUTE_REDIRECTS[head] ? ROUTE_REDIRECTS[head]! : raw;
}

const store = new Store<AppState>({
  route: resolveRoute(location.hash.slice(1) || DEFAULT_VIEW),
  branding: { productName: '' },
  localeDefault: 'hu',
  agents: [],
  approvalsBadge: 0,
  navBadges: {},
  updatesBehind: 0,
  navEngine: null,
});

function navigate(): void {
  const raw = location.hash.slice(1) || DEFAULT_VIEW;
  // #144 static redirects, then #425 registered route-guards (e.g. the #247 engine-aware
  // vertical deep-link guard, registered by the vertical). With no guard registered (core
  // shell) applyRouteGuards returns the route unchanged — default-deny by absence.
  const staticResolved = resolveRoute(raw);
  const resolved = applyRouteGuards(staticResolved, store.get().navEngine, DEFAULT_VIEW);
  // canonicalize the URL bar for an old route (history-replace, no extra entry); the
  // resulting hashchange re-enters navigate with the new route (no further redirect).
  if (resolved !== raw && location.hash.slice(1) !== '') {
    location.replace(`#${resolved}`);
    return;
  }
  store.patch({ route: resolved });
}

/** The route whose view is currently mounted in <main> (so a same-route store
 *  refresh can avoid re-mounting a live view — see render()). */
let mountedRoute: string | null = null;

// --- grouped nav collapse state (#144) -----------------------------------------
// Per-section collapsed state persists in localStorage; default = all expanded.
const NAV_COLLAPSE_KEY = 'nav-collapsed-sections';
function collapsedSections(): Set<string> {
  try {
    const raw = localStorage.getItem(NAV_COLLAPSE_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}
function persistCollapsed(s: Set<string>): void {
  try {
    localStorage.setItem(NAV_COLLAPSE_KEY, JSON.stringify([...s]));
  } catch {
    /* storage unavailable (private mode) — collapse just won't persist */
  }
}
/** The section key that owns a given view id (for active-protection), or undefined. */
function sectionKeyForView(viewId: string, engine: string | null): string | undefined {
  return viewNavSections(engine).find((sec) => sec.items.some(([id]) => id === viewId))?.key;
}

function render(state: AppState): void {
  const root = document.getElementById('app');
  if (!root) return;

  const fullRerender = (): void => {
    mountedRoute = null;
    render(store.get());
  };

  // #144 grouped nav: ACTIVE-PROTECTION — if the active view's section is collapsed,
  // expand it (and persist) so the active item is never hidden behind a closed section.
  const activeId = state.route.split('/')[0] ?? '';
  const collapsed = collapsedSections();
  const activeSec = sectionKeyForView(activeId, state.navEngine);
  if (activeSec !== undefined && collapsed.has(activeSec)) {
    collapsed.delete(activeSec);
    persistCollapsed(collapsed);
  }
  // Badge placement after the restructure: the awaiting-approval pill rides the dedicated
  // Approvals item; the updates-behind pill rides Settings (Updates now lives in the hub).
  // #425: approvals + settings(updates) are CORE badges; any other id reads a vertical-contributed
  // badge from state.navBadges (e.g. cs) — so the core has no per-vertical badge knowledge.
  const navBadge = (id: string): HTMLElement | null => {
    const count = id === 'approvals' ? state.approvalsBadge
      : id === 'settings' ? state.updatesBehind
        : state.navBadges[id] ?? 0;
    return count > 0 ? h('span', { class: 'badge', style: 'margin-left:auto' }, String(count)) : null;
  };
  const navItem = ([id, labelKey, iconName]: [string, string, string]): HTMLElement =>
    h(
      'a',
      { href: `#${id}`, class: activeId === id ? 'active' : '', ...(activeId === id ? { 'aria-current': 'page' } : {}) },
      icon(iconName),
      h('span', null, t(labelKey)),
      navBadge(id),
    );
  const toggleSection = (key: string): void => {
    const c = collapsedSections();
    if (c.has(key)) c.delete(key);
    else c.add(key);
    persistCollapsed(c);
    render(store.get()); // same-route -> refreshes the nav only, keeping <main> intact
  };

  const nav = h(
    'nav',
    { class: 'nav' },
    h(
      'div',
      { class: 'brand' },
      h('div', { class: 'brand-name' }, state.branding.productName || '—'),
      h('div', { class: 'brand-status' }, t('nav.online')),
    ),
    h(
      'div',
      { class: 'nav-items' },
      // #144: grouped sections. Overview (empty section label) renders ungrouped at the
      // top; every other section gets a collapsible header + an items wrapper.
      ...viewNavSections(state.navEngine).flatMap((sec): HTMLElement[] => {
        if (sec.labelKey === '') return sec.items.map(navItem);
        const isCollapsed = collapsed.has(sec.key);
        const secId = `navsec-${sec.key}`;
        return [
          h(
            'button',
            {
              type: 'button',
              class: 'nav-section-header',
              'aria-expanded': String(!isCollapsed),
              'aria-controls': secId,
              onclick: () => toggleSection(sec.key),
            },
            h('span', null, t(sec.labelKey)),
            h('span', { class: 'nav-section-chevron', 'aria-hidden': 'true' }, isCollapsed ? '▸' : '▾'),
          ),
          h(
            'div',
            { class: isCollapsed ? 'nav-section-items collapsed' : 'nav-section-items', id: secId },
            ...sec.items.map(navItem),
          ),
        ];
      }),
    ),
    h(
      'div',
      { class: 'nav-footer' },
      h(
        'select',
        {
          'aria-label': t('nav.language'),
          onchange: (e: Event) => {
            void setLocale((e.target as HTMLSelectElement).value).then(() => {
              fullRerender(); // a locale switch must fully re-render (re-localize the view)
            });
          },
        },
        ...availableLocales().map((loc) =>
          h('option', { value: loc, selected: loc === currentLocale() }, loc.toUpperCase()),
        ),
      ),
      quickThemeToggle(fullRerender),
      tweaksGearButton(),
    ),
  );

  // INVERTED RULE (FIX-00): the 7-second background fleet poll patches the store,
  // which fires this render(). It must NEVER tear down the active view — doing so
  // erased half-typed input, closed open modals, interrupted drags and reset
  // scroll on every non-allowlisted view. So the DEFAULT for EVERY route is: on a
  // same-route store patch (route unchanged AND <main> already mounted), keep
  // <main> intact and refresh ONLY the nav (so the approvals/updates badges and
  // the active link stay current), then return. The two dashboards that must
  // reflect live fleet data (Overview, Fleet) refresh their own data region in
  // place (see overview.ts / fleet.ts). A real route change or a deliberate
  // locale/theme switch resets mountedRoute and falls through to a full re-render.
  // Preserve the sidebar scroll across EVERY nav rebuild — both the 7s background
  // refresh (#78) AND a route change from a nav click (#85). The scrollable
  // .nav-items is rebuilt on each render; capture its offset BEFORE the swap and
  // carry it onto the fresh nav so the menu never jumps to the top (and items below
  // the clicked one stay reachable).
  const prevNavScroll = root.querySelector('.nav-items')?.scrollTop ?? 0;
  const restoreNavScroll = (): void => {
    const items = nav.querySelector('.nav-items');
    if (items) items.scrollTop = prevNavScroll;
  };

  const existingMain = root.querySelector('main');
  if (state.route === mountedRoute && existingMain) {
    const oldNav = root.querySelector('nav');
    if (oldNav) {
      oldNav.replaceWith(nav);
      restoreNavScroll();
    }
    return;
  }

  const main = h('main', { class: 'main' });
  mount(root, nav, main);
  restoreNavScroll();
  renderView(state.route, main, store);
  mountedRoute = state.route;
}

async function boot(): Promise<void> {
  bootstrapToken();
  let status: { productName: string; localeDefault: string; authOk: boolean };
  try {
    status = await api.get('/api/status');
  } catch {
    // unauthorized: show the minimal token hint screen in the install-default language
    const probe = await fetch('/api/auth/status').then(
      (r) => r.json() as Promise<{ product?: string; localeDefault?: string }>,
    );
    await initI18n(probe.localeDefault ?? 'hu');
    const root = document.getElementById('app');
    if (root) {
      mount(
        root,
        h(
          'main',
          { class: 'main' },
          h('h1', { class: 'page-title' }, probe.product ?? ''),
          h('div', { class: 'panel' }, t('auth.need_token')),
        ),
      );
    }
    return;
  }
  await initI18n(status.localeDefault);
  store.patch({ branding: { productName: status.productName }, localeDefault: status.localeDefault });
  document.title = status.productName;

  await registerViews(); // every view registered before first paint (see registry.ts)

  // #425: run registered vertical boot hooks (e.g. the vertical hook resolves the engine
  // once via its own endpoint and patches navEngine, so the the vertical module nav section renders on the
  // first paint). EMPTY on the core shell => no-op => navEngine stays null (section absent).
  await runBootHooks(store);

  // #425: an INITIAL deep-link the now-resolved engine hides is redirected here BEFORE the
  // first paint (so it never flashes an empty render). With no guard registered the route is
  // returned unchanged. (navigate() applies the same guards for later hash changes; the initial
  // route was resolved at store-construction time, before the boot hooks ran.)
  const guarded = applyRouteGuards(store.get().route, store.get().navEngine, DEFAULT_VIEW);
  if (guarded !== store.get().route) {
    store.patch({ route: guarded });
    if (location.hash.slice(1) !== '') location.replace(`#${guarded}`);
  }

  // First-run: auto-open the setup wizard when the URL names no view and onboarding
  // isn't completed/dismissed yet (BUILD-onboarding-wizard). Non-fatal on error.
  if (location.hash === '' || location.hash === '#') {
    try {
      const ob = await api.get<{ completed: boolean; dismissed: boolean }>('/api/onboarding/status');
      if (!ob.completed && !ob.dismissed) {
        location.hash = 'wizard';
        store.patch({ route: 'wizard' });
      }
    } catch {
      /* status unavailable → fall through to the default view */
    }
  }

  window.addEventListener('hashchange', navigate);
  store.subscribe(render);
  render(store.get());

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  }

  // background refresh of shared fleet state
  const refresh = async (): Promise<void> => {
    try {
      const [agents, badge, upd] = await Promise.all([
        api.get<AgentSummary[]>('/api/agents'),
        api.get<{ count: number }>('/api/kanban/approvals/badge'),
        api.get<{ behind?: number; error?: string | null } | null>('/api/updates/status').catch(() => null),
      ]);
      store.patch({ agents, approvalsBadge: badge.count, updatesBehind: upd && !upd.error ? upd.behind ?? 0 : 0 });
      // #425: vertical badges (e.g. the CS owner-attention count) are polled by registered refresh hooks
      // — the core never fetches a vertical endpoint. EMPTY on the core shell => no vertical badge.
      await runRefreshHooks(store);
    } catch {
      /* transient */
    }
  };
  await refresh();

  // Connection-health banner + AUTO-RECOVERY (no manual Ctrl+Shift+R). When several
  // requests fail in a row the tracker flips to 'reconnecting' and a banner appears;
  // the moment a request succeeds again we hide it AND re-mount the active view so its
  // stale "Loading…" regions refill on their own. The banner lives on <body> (outside
  // #app) so a re-render never removes it.
  const recover = (): void => {
    mountedRoute = null; // force a real re-mount (re-fetch + re-open the view's stream)
    render(store.get());
    void refresh();
  };
  const banner = h('div', { class: 'conn-banner', role: 'status', style: 'display:none' });
  let wasDegraded = false;
  const paintBanner = (s: ConnectionStatus): void => {
    if (s === 'reconnecting') {
      wasDegraded = true;
      mount(
        banner,
        h('span', { class: 'conn-banner-dot' }),
        h('span', null, t('connection.reconnecting')),
        h('button', { class: 'conn-banner-btn', onclick: recover }, t('connection.retry')),
      );
      banner.style.display = '';
    } else {
      banner.style.display = 'none';
      if (wasDegraded) { wasDegraded = false; recover(); } // back online → refill automatically
    }
  };
  onConnectionChange(paintBanner);
  document.body.appendChild(banner);

  setInterval(() => void refresh(), 7000);
}

void boot();
