// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * Settings (Beállítások) view (PROMPT-20 + FIX-channels). Two tabs:
 *   - Overview: the read-only orientation hub — install-fixed identity/system
 *     info + sign-posts to the three real config surfaces (Appearance, System
 *     integrations, Per-agent). It edits nothing on its own.
 *   - Channels: the SHARED channel-management panel in install scope (manages the
 *     hub agent's bot binding, bound chats, invites, pending pairings).
 * The standalone "Channels" nav page was folded in here (spec: no separate nav).
 */

import { defineView, renderView } from './registry.js';
import { h, mount } from '../dom.js';
import { t } from '../i18n.js';
import { api, ApiError } from '../api.js';
import { icon } from '../icons.js';
import { toast } from '../toast.js';
import { toggleTweaks } from '../tweaks.js';
import { mountChannelPanel } from '../components/channelPanel.js';
import type { Store } from '../store.js';
import type { AppState } from '../main.js';

interface Status {
  productName: string; version: string; localeDefault: string;
  agentProseLocale: string; timezone: string; hubId: string; adapter: string;
}

/** The "General" hub panel: system info + billing + shared-auth + an Appearance toggle. */
function renderGeneral(content: HTMLElement): void {
  const infoGrid = h('div', { class: 'set-info-grid' });
  const row = (labelKey: string, value: string): HTMLElement =>
    h('div', { class: 'set-info-row' }, h('span', { class: 'set-info-k' }, t(labelKey)), h('span', { class: 'set-info-v' }, value || '—'));
  const surfaceCard = (titleKey: string, descKey: string, iconName: string, btnKey: string, onclick: () => void): HTMLElement =>
    h('div', { class: 'panel set-surface' },
      h('div', { class: 'set-surface-head' }, icon(iconName, 20), h('div', { class: 'panel-title' }, t(titleKey))),
      h('p', { class: 'field-note' }, t(descKey)),
      h('button', { class: 'secondary', onclick }, t(btnKey)),
    );

  const billingCard = h('div', { class: 'panel set-billing' });
  const sharedAuthCard = h('div', { class: 'panel set-billing' });
  mount(content,
    h('div', { class: 'info-box' }, t('settings.splitNote')),
    h('div', { class: 'panel set-info-card' },
      h('div', { class: 'panel-title' }, t('settings.system')),
      h('p', { class: 'field-note' }, t('settings.systemNote')),
      infoGrid,
    ),
    h('div', { class: 'set-surfaces' },
      surfaceCard('settings.appearance', 'settings.appearanceDesc', 'gear', 'settings.openAppearance', () => toggleTweaks()),
      surfaceCard('settings.integrations', 'settings.integrationsDesc', 'plug', 'settings.openIntegrations', () => { window.location.hash = '#vault'; }),
      surfaceCard('settings.perAgent', 'settings.perAgentDesc', 'people', 'settings.openAgents', () => { window.location.hash = '#agents'; }),
    ),
    billingCard,
    sharedAuthCard,
  );
  renderBilling(billingCard);
  renderSharedAuth(sharedAuthCard);
  void api.get<Status>('/api/status').then((s) => {
    mount(infoGrid,
      row('settings.field.product', s.productName),
      row('settings.field.version', s.version),
      row('settings.field.localeDefault', s.localeDefault.toUpperCase()),
      row('settings.field.agentProse', s.agentProseLocale.toUpperCase()),
      row('settings.field.timezone', s.timezone),
      row('settings.field.hub', s.hubId),
    );
  }).catch(() => mount(infoGrid, h('div', { class: 'muted-note err' }, t('settings.error'))));
}

/** Billing mode control (FIX-billing-api-optin): default subscription; API is an
 *  explicit, confirmed opt-in that requires a vault key. */
function renderBilling(card: HTMLElement): void {
  void api.get<{ mode: string; hasApiKey: boolean }>('/api/billing').then((b) => {
    let current = b.mode;
    const sel = h('select', null,
      h('option', { value: 'subscription', selected: b.mode === 'subscription' }, t('settings.billing.subscription')),
      h('option', { value: 'api', selected: b.mode === 'api' }, t('settings.billing.api')),
    ) as HTMLSelectElement;
    const status = h('div', { class: 'field-note' });
    const apply = async (): Promise<void> => {
      const mode = sel.value;
      if (mode === current) return;
      if (mode === 'api') {
        if (!b.hasApiKey) { status.className = 'field-note err'; status.textContent = t('settings.billing.needKey'); sel.value = current; return; }
        if (!window.confirm(t('settings.billing.confirm'))) { sel.value = current; return; }
      }
      try {
        const r = await api.put<{ mode: string }>('/api/billing', { mode });
        current = r.mode;
        status.className = 'field-note';
        toast(t('settings.billing.saved', { mode: t(`settings.billing.${r.mode}`) }));
      } catch (e) {
        status.className = 'field-note err';
        status.textContent = e instanceof ApiError ? e.message : t('settings.error');
        sel.value = current;
      }
    };
    sel.addEventListener('change', () => void apply());
    mount(card,
      h('div', { class: 'panel-title' }, t('settings.billing.title')),
      h('p', { class: 'field-note' }, t('settings.billing.desc')),
      h('div', { class: `info-box${b.mode === 'api' ? ' warn' : ''}` }, t('settings.billing.warn')),
      h('div', { class: 'field' }, h('label', null, t('settings.billing.current')), sel),
      ...(!b.hasApiKey ? [h('p', { class: 'field-note' }, t('settings.billing.keyHint'))] : []),
      status,
    );
  }).catch(() => mount(card, h('div', { class: 'muted-note err' }, t('settings.error'))));
}

/** Shared-subscription auth control (FIX-shared-auth-refresh): the correct re-auth
 *  for shared-subscription is ONCE on the host, then pushed to every agent. This card
 *  shows the host token status and a one-click "refresh on all agents" (re-link +
 *  restart) so the operator never logs in per-agent. */
interface SharedAuth { present: boolean; expiresAt: number | null; expired: boolean; sharedAgents: string[] }
function renderSharedAuth(card: HTMLElement): void {
  void api.get<SharedAuth>('/api/agents/shared-auth').then((s) => {
    const statusLine = (): HTMLElement => {
      if (!s.present) return h('div', { class: 'info-box warn' }, t('settings.sharedAuth.missing'));
      if (s.expired) return h('div', { class: 'info-box warn' }, t('settings.sharedAuth.expired'));
      const when = s.expiresAt ? new Date(s.expiresAt).toLocaleString() : '';
      return h('div', { class: 'field-note' }, t('settings.sharedAuth.valid', { when }));
    };
    const btn = h('button', { class: 'secondary' }, icon('sync', 16), t('settings.sharedAuth.refresh')) as HTMLButtonElement;
    btn.addEventListener('click', () => void (async () => {
      if (!window.confirm(t('settings.sharedAuth.confirm', { count: String(s.sharedAgents.length) }))) return;
      btn.disabled = true;
      try {
        const r = await api.post<{ count: number }>('/api/agents/shared-auth/refresh', {});
        toast(t('settings.sharedAuth.refreshing', { count: String(r.count) }));
      } catch (e) {
        toast(e instanceof ApiError ? e.message : t('settings.error'), true);
      } finally {
        btn.disabled = false;
      }
    })());
    mount(card,
      h('div', { class: 'panel-title' }, t('settings.sharedAuth.title')),
      h('p', { class: 'field-note' }, t('settings.sharedAuth.desc')),
      h('div', { class: 'info-box' }, t('settings.sharedAuth.hostHint')),
      statusLine(),
      h('div', { class: 'field' }, btn),
    );
  }).catch(() => mount(card, h('div', { class: 'muted-note err' }, t('settings.error'))));
}

/**
 * The Settings HUB (#144): a left sub-nav rail + the active sub-panel on the right.
 * Sub-pages are ROUTABLE (#settings/<key>) so they deep-link AND the old top-level
 * routes (#vault, #autonomy, …) redirect here (main.ts). General + Channels are
 * custom panels; the rest EMBED the existing registered view via renderView (reuse,
 * not rewrite). Migration sits at the bottom as a quieter admin entry.
 */
interface HubEntry { key: string; labelKey: string; icon: string; view?: string; admin?: boolean }
const HUB: HubEntry[] = [
  { key: 'general', labelKey: 'settings.hub.general', icon: 'gear' },
  { key: 'integrations', labelKey: 'settings.hub.integrations', icon: 'plug', view: 'vault' },
  { key: 'per-agent', labelKey: 'settings.hub.perAgent', icon: 'people', view: 'agents' },
  { key: 'autonomy', labelKey: 'settings.hub.autonomy', icon: 'shield', view: 'autonomy' },
  { key: 'channels', labelKey: 'settings.hub.channels', icon: 'channels' },
  { key: 'updates', labelKey: 'settings.hub.updates', icon: 'sync', view: 'updates' },
  { key: 'setup', labelKey: 'settings.hub.setup', icon: 'gear', view: 'wizard' },
  { key: 'migration', labelKey: 'settings.hub.migration', icon: 'import', view: 'migration', admin: true },
];

function render(host: HTMLElement, store: Store<AppState>, subpath: string[]): void {
  const active = HUB.some((e) => e.key === subpath[0]) ? subpath[0]! : 'general';
  const panel = h('div', { class: 'set-panel' });

  const railLink = (e: HubEntry): HTMLElement =>
    h(
      'a',
      {
        href: `#settings/${e.key}`,
        class: `set-subnav-item${e.key === active ? ' active' : ''}${e.admin ? ' set-subnav-admin' : ''}`,
        ...(e.key === active ? { 'aria-current': 'page' } : {}),
      },
      icon(e.icon, 16),
      h('span', null, t(e.labelKey)),
    );

  mount(host,
    h('div', { class: 'page-header' }, h('h1', null, t('settings.title')), h('p', { class: 'subtitle' }, t('settings.subtitle'))),
    h('div', { class: 'set-hub' },
      h('nav', { class: 'set-subnav', 'aria-label': t('settings.title') }, ...HUB.map(railLink)),
      panel,
    ),
  );

  // Paint the active sub-panel: custom (general / channels) or an embedded view.
  if (active === 'general') renderGeneral(panel);
  else if (active === 'channels') mountChannelPanel(panel, { scope: 'install' });
  else {
    const entry = HUB.find((e) => e.key === active);
    if (entry?.view) renderView(entry.view, panel, store);
  }
}

defineView('settings', 'nav.settings', render);
