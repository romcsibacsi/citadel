// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import type { Store } from '../store.js';
import type { AppState } from '../main.js';

/**
 * View registry: each dashboard page registers under a route id; the shell
 * renders nav + the active view. Views re-render fully on store changes.
 *
 * #425 web seam-inversion (the web twin of the #386 ModuleRegistry / #416 migrations slot):
 * the core web-shell knows ONLY core views. A vertical (bookkeeping + CS) registers its
 * views (defineView), nav (registerNavSection/registerNavItem), icons (registerViewIcons),
 * a deep-link route-guard (registerRouteGuard) and a boot hook (registerBootHook) at RUNTIME.
 * The core compiles + boots with EMPTY slots = default-deny by absence (no vertical view,
 * no bookkeeping nav, no engine guard). The composed KKV entry (web/src/kkv-main.ts) registers
 * the vertical, reproducing the pre-separation UI + routing exactly.
 */

export type ViewRenderer = (host: HTMLElement, store: Store<AppState>, subpath: string[]) => void;

const views = new Map<string, { labelKey: string; render: ViewRenderer; hidden?: boolean }>();

/** Nav icon per view id (see icons.ts). */
const ICON_BY_VIEW: Record<string, string> = {
  wizard: 'gear',
  overview: 'overview',
  agents: 'people',
  team: 'team',
  activity: 'signal',
  messages: 'messages',
  fleet: 'fleet',
  kanban: 'kanban',
  panels: 'shield',
  ideas: 'ideas',
  memories: 'memories',
  journal: 'history',
  background: 'screen',
  status: 'pulse',
  tokenmon: 'gauge',
  schedules: 'schedules',
  skills: 'skills',
  vault: 'vault',
  channels: 'channels',
  mcp: 'plug',
  plugins: 'plug',
  webhooks: 'plug',
  autonomy: 'shield',
  migration: 'import',
  updates: 'sync',
  studio: 'aperture',
  files: 'folder',
  approvals: 'approvals',
  settings: 'settings',
};

/** #425: a vertical contributes its own view->icon entries (cs + bk-* live here at runtime, not in core). */
export function registerViewIcons(map: Record<string, string>): void {
  Object.assign(ICON_BY_VIEW, map);
}

/**
 * Grouped nav (#144 menu-restructure, PRISM IA-audit #135 — operator-approved): the
 * flat ~27-item list becomes ~6 sections. A section item may override the view's own
 * label (the merged views show a combined label). Views NOT listed in any section are
 * no longer top-level nav items, but stay REGISTERED so their hash routes / Settings-hub
 * sub-routes still resolve (no function removal — deep-links keep working):
 *  - team -> folded into Agents; status -> Fleet/Status; journal -> Activity/Log
 *  - channels/autonomy/migration/vault/updates/wizard -> the Settings hub sub-nav
 *  - messages -> the inter-agent messages view (registered, defineView 'messages'); it sits in
 *    FLOTTA & MEGFIGYELÉS next to Activity/Log (#265 — it had been wrongly dropped as "stale").
 * AMBIGUITY (flagged to NEXUS, sensible default here): MCP/Plugins/Webhooks live in the
 * INTEGRÁCIÓK section (not also duplicated in the hub); `background` sits under FLOTTA &
 * MEGFIGYELÉS (the card lists neither placement explicitly).
 */
export interface NavItemSpec { id: string; labelKey?: string; engine?: string }
export interface NavSection {
  key: string;
  labelKey: string;
  items: Array<string | NavItemSpec>;
  /** #243: a section that only exists once a (vertical) engine is known (null = absent). */
  requiresEngine?: boolean;
}
// #425: CORE sections only. The vertical (bookkeeping + CS) injects its own section + item at
// runtime via registerNavSection/registerNavItem — so the core nav has no bookkeeping/cs knowledge.
const NAV_SECTIONS: NavSection[] = [
  // Overview is ungrouped (empty labelKey -> rendered with no section header, at the top).
  { key: 'overview', labelKey: '', items: ['overview'] },
  { key: 'work', labelKey: 'nav.section.work', items: ['kanban', 'ideas', 'approvals', 'schedules'] },
  {
    key: 'fleet', labelKey: 'nav.section.fleet',
    items: [
      'agents',
      { id: 'fleet', labelKey: 'nav.item.fleetStatus' }, // Fleet / Status (merged view, Part C)
      { id: 'activity', labelKey: 'nav.item.activityLog' }, // Activity / Log (merged view, Part C)
      'messages', // inter-agent messages (#265): the view was registered but fell out of the nav
      'tokenmon',
      'panels',
      'background',
    ],
  },
  { key: 'knowledge', labelKey: 'nav.section.knowledge', items: ['memories', 'files', 'studio', 'skills'] },
  { key: 'integrations', labelKey: 'nav.section.integrations', items: ['mcp', 'plugins', 'webhooks'] },
  { key: 'settings', labelKey: 'nav.section.settings', items: ['settings'] },
];

/**
 * #425 nav-section slot: a vertical inserts a whole section (e.g. bookkeeping). Inserted BEFORE
 * `beforeKey` to preserve the established nav order; appended if the anchor is absent. Idempotent
 * on key (a re-register replaces).
 */
export function registerNavSection(section: NavSection, beforeKey?: string): void {
  const without = NAV_SECTIONS.filter((s) => s.key !== section.key);
  NAV_SECTIONS.length = 0;
  NAV_SECTIONS.push(...without);
  const at = beforeKey ? NAV_SECTIONS.findIndex((s) => s.key === beforeKey) : -1;
  if (at === -1) NAV_SECTIONS.push(section);
  else NAV_SECTIONS.splice(at, 0, section);
}

/**
 * #425 nav-item slot: a vertical injects an item into an EXISTING core section (e.g. 'cs' into
 * 'work'). Inserted AFTER `afterId` to preserve order; appended if the anchor is absent.
 */
export function registerNavItem(sectionKey: string, item: string | NavItemSpec, afterId?: string): void {
  const sec = NAV_SECTIONS.find((s) => s.key === sectionKey);
  if (!sec) return; // default-deny: unknown core section -> no-op
  const idOf = (e: string | NavItemSpec): string => (typeof e === 'string' ? e : e.id);
  const at = afterId ? sec.items.findIndex((e) => idOf(e) === afterId) : -1;
  if (at === -1) sec.items.push(item);
  else sec.items.splice(at + 1, 0, item);
}

export const DEFAULT_VIEW = 'overview';

export function defineView(id: string, labelKey: string, render: ViewRenderer, opts?: { hidden?: boolean }): void {
  views.set(id, { labelKey, render, hidden: opts?.hidden });
}

// #425 route-guard + boot-hook slots — EMPTY on the core = default-deny (no redirect, no extra boot work).
type RouteGuard = (route: string, engine: string | null, defaultView: string) => string | null;
type BootHook = (store: Store<AppState>) => void | Promise<void>;
const routeGuards: RouteGuard[] = [];
const bootHooks: BootHook[] = [];

/** A vertical registers a deep-link guard (e.g. the bookkeeping engine-aware redirect). */
export function registerRouteGuard(fn: RouteGuard): void {
  routeGuards.push(fn);
}

/** Apply every registered guard in order; the first redirect wins. EMPTY => the route is returned unchanged. */
export function applyRouteGuards(route: string, engine: string | null, defaultView: string): string {
  for (const g of routeGuards) {
    const r = g(route, engine, defaultView);
    if (r !== null) return r;
  }
  return route;
}

/** A vertical registers a boot hook (e.g. fetch its engine from its own endpoint and patch it into the store). */
export function registerBootHook(fn: BootHook): void {
  bootHooks.push(fn);
}

/** Run every registered boot hook (awaited). EMPTY (core) => no-op. */
export async function runBootHooks(store: Store<AppState>): Promise<void> {
  for (const h of bootHooks) await h(store);
}

// #425 refresh-hook slot: the background fleet-refresh loop calls these so a vertical can keep its own
// nav badge current (e.g. the CS owner-attention count) WITHOUT the core fetching a vertical endpoint.
const refreshHooks: BootHook[] = [];
export function registerRefreshHook(fn: BootHook): void {
  refreshHooks.push(fn);
}
/** Run every registered refresh hook (awaited). EMPTY (core) => no-op => no vertical badge polled. */
export async function runRefreshHooks(store: Store<AppState>): Promise<void> {
  for (const h of refreshHooks) await h(store);
}

/** One nav section: a (possibly empty) header label + its resolved items. */
export interface NavSectionEntry { key: string; labelKey: string; items: Array<[string, string, string]> }

/**
 * Grouped nav (#144): the sections with their [id, labelKey, iconName] items, in order.
 * Only REGISTERED, non-hidden views surface; a section item may override the view's own
 * label (the merged views). A section with no resolvable item is omitted. The flat
 * fallback (a view registered but listed in no section) is intentionally NOT shown as a
 * top-level item — it stays reachable by its hash route.
 */
export function viewNavSections(engine?: string | null): NavSectionEntry[] {
  const out: NavSectionEntry[] = [];
  for (const sec of NAV_SECTIONS) {
    // #243: a bookkeeping-style section is absent entirely until its engine is known.
    if (sec.requiresEngine && (engine === undefined || engine === null)) continue;
    const items: Array<[string, string, string]> = [];
    for (const entry of sec.items) {
      const spec: NavItemSpec = typeof entry === 'string' ? { id: entry } : entry;
      // #243: an engine-scoped item only surfaces for the matching engine.
      if (spec.engine !== undefined && spec.engine !== engine) continue;
      const v = views.get(spec.id);
      if (!v || v.hidden) continue; // not registered / hidden detail view -> skip (no nav item)
      items.push([spec.id, spec.labelKey ?? v.labelKey, ICON_BY_VIEW[spec.id] ?? 'overview']);
    }
    if (items.length > 0) out.push({ key: sec.key, labelKey: sec.labelKey, items });
  }
  return out;
}


/** Set of view ids that ARE top-level nav items (used to validate the grouping). */
export function navItemIds(): Set<string> {
  return new Set(NAV_SECTIONS.flatMap((s) => s.items.map((e) => (typeof e === 'string' ? e : e.id))));
}

export function renderView(route: string, host: HTMLElement, store: Store<AppState>): void {
  const [id = DEFAULT_VIEW, ...subpath] = route.split('/');
  const view = views.get(id) ?? views.get(DEFAULT_VIEW) ?? views.get('fleet');
  view?.render(host, store, subpath);
}

/**
 * Views self-register on import; the import list is the single composition point.
 * AWAITED so callers can guarantee every view is registered before the first
 * render — otherwise a view whose dynamic import is still in flight at first
 * paint would mount an empty <main>, and (since FIX-00) a same-route background
 * patch would keep that empty <main> instead of re-rendering it.
 */
export async function registerViews(): Promise<void> {
  await Promise.all([
    import('./wizard.js'),
    import('./overview.js'),
    import('./agents.js'),
    import('./team.js'),
    import('./activity.js'),
    import('./messages.js'),
    import('./fleet.js'),
    import('./agent.js'),
    import('./kanban.js'),
    import('./panels.js'),
    import('./ideas.js'),
    import('./memories.js'),
    import('./journal.js'),
    import('./background.js'),
    import('./status.js'),
    import('./tokenmon.js'),
    import('./schedules.js'),
    import('./skills.js'),
    import('./connectors.js'),
    import('./plugins.js'),
    import('./webhooks.js'),
    import('./autonomy.js'),
    import('./migration.js'),
    import('./updates.js'),
    import('./studio.js'),
    import('./files.js'),
    import('./vault.js'),
    import('./channels.js'),
    import('./approvals.js'),
    import('./settings.js'),
    // #425: the vertical views (cs, bookkeeping/*) are registered by the composed entry
    // (web/src/kkv-main.ts -> verticalWeb.ts), NOT here — the core shell stays vertical-free.
  ]);
}
