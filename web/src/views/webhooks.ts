// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * Generic Webhooks settings view (FIX-plugin-webhook). The operator's surface for
 * the webhook plugin: manage INBOUND hooks (id, HMAC secret, declarative mapping
 * to one action) and OUTBOUND targets (name, URL, subscribed events, optional
 * auth-header secret) + the outbound SSRF allowlist. Secrets are write-only here
 * (never returned by the API); a "secretConfigured" flag is shown instead.
 */

import { defineView } from './registry.js';
import { h, mount } from '../dom.js';
import { t } from '../i18n.js';
import { api, ApiError } from '../api.js';
import { toast } from '../toast.js';
import type { Store } from '../store.js';
import type { AppState } from '../main.js';

type ActionKind = 'kanban_card' | 'agent_message' | 'idea' | 'daily_log';
interface Mapping { action: ActionKind; fields: Record<string, string>; agentId?: string }
interface Hook { id: string; mapping: Mapping; secretConfigured: boolean }
interface Target { name: string; url: string; events: string[]; authHeader?: string; secretConfigured: boolean }

const ACTIONS: ActionKind[] = ['kanban_card', 'agent_message', 'idea', 'daily_log'];

function closer(backdrop: HTMLElement): () => void {
  return () => { backdrop.remove(); document.body.classList.remove('modal-open'); };
}
function modal(title: string, body: HTMLElement): { backdrop: HTMLElement; close: () => void } {
  const backdrop = h('div', { class: 'modal-backdrop' });
  const close = closer(backdrop);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  backdrop.append(h('div', { class: 'modal' },
    h('div', { class: 'agent-modal-titlebar' }, h('h2', null, title), h('button', { class: 'icon-btn', onclick: close }, '✕')),
    body));
  document.body.append(backdrop); document.body.classList.add('modal-open');
  return { backdrop, close };
}

async function render(host: HTMLElement, store: Store<AppState>): Promise<void> {
  void store;
  const reload = (): void => void render(host, store);

  let hooks: Hook[] = [];
  let targets: Target[] = [];
  let eventKinds: string[] = [];
  let allowlist = '';
  try {
    const [hr, tr, al] = await Promise.all([
      api.get<{ hooks: Hook[] }>('/api/plugins/webhook/hooks'),
      api.get<{ targets: Target[]; eventKinds: string[] }>('/api/plugins/webhook/targets'),
      api.get<{ allowlist: string }>('/api/plugins/webhook/allowlist'),
    ]);
    hooks = hr.hooks; targets = tr.targets; eventKinds = tr.eventKinds; allowlist = al.allowlist;
  } catch { /* keep chrome, show empties */ }

  // ---- inbound hook editor ----
  const openHook = (existing?: Hook): void => {
    const idEl = h('input', { type: 'text', placeholder: 'github-issues', value: existing?.id ?? '', ...(existing ? { disabled: true } : {}) }) as HTMLInputElement;
    const secretEl = h('input', { type: 'password', placeholder: existing?.secretConfigured ? t('webhooks.secretSet') : t('webhooks.secretPlaceholder') }) as HTMLInputElement;
    const actionSel = h('select', null, ...ACTIONS.map((a) => h('option', { value: a, selected: a === (existing?.mapping.action ?? 'kanban_card') }, t(`webhooks.action.${a}`)))) as HTMLSelectElement;
    const agentEl = h('input', { type: 'text', placeholder: 'forge', value: existing?.mapping.agentId ?? '' }) as HTMLInputElement;
    const fieldsEl = h('textarea', { rows: '5', placeholder: 'title=$.issue.title\ndescription=$.issue.body' }) as HTMLTextAreaElement;
    if (existing) fieldsEl.value = Object.entries(existing.mapping.fields).map(([k, v]) => `${k}=${v}`).join('\n');
    const save = h('button', { class: 'primary' }, t('webhooks.save')) as HTMLButtonElement;
    const body = h('div', { class: 'agent-modal-body' },
      h('div', { class: 'field' }, h('label', null, t('webhooks.hookId')), idEl),
      h('div', { class: 'field' }, h('label', null, t('webhooks.hmacSecret')), secretEl, h('div', { class: 'field-note' }, t('webhooks.hmacNote'))),
      h('div', { class: 'field' }, h('label', null, t('webhooks.action.label')), actionSel),
      h('div', { class: 'field' }, h('label', null, t('webhooks.agentId')), agentEl),
      h('div', { class: 'field' }, h('label', null, t('webhooks.fields')), fieldsEl, h('div', { class: 'field-note' }, t('webhooks.fieldsNote'))),
      h('div', { class: 'modal-actions' }, save),
    );
    const { close } = modal(existing ? t('webhooks.editHook') : t('webhooks.newHook'), body);
    save.addEventListener('click', () => void (async () => {
      const fields: Record<string, string> = {};
      for (const line of fieldsEl.value.split('\n')) {
        const i = line.indexOf('='); if (i <= 0) continue;
        fields[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      }
      const mapping: Mapping = { action: actionSel.value as ActionKind, fields };
      if (agentEl.value.trim() !== '') mapping.agentId = agentEl.value.trim();
      try {
        await api.put(`/api/plugins/webhook/hooks/${encodeURIComponent(idEl.value.trim())}`, { mapping, ...(secretEl.value !== '' ? { secret: secretEl.value } : {}) });
        toast(t('webhooks.saved')); close(); reload();
      } catch (err) { toast(err instanceof ApiError ? err.message : t('webhooks.error'), true); }
    })());
  };

  // ---- outbound target editor ----
  const openTarget = (existing?: Target): void => {
    const nameEl = h('input', { type: 'text', placeholder: 'my-stack', value: existing?.name ?? '', ...(existing ? { disabled: true } : {}) }) as HTMLInputElement;
    const urlEl = h('input', { type: 'text', placeholder: 'https://example.com/hook', value: existing?.url ?? '' }) as HTMLInputElement;
    const hdrEl = h('input', { type: 'text', placeholder: 'authorization', value: existing?.authHeader ?? '' }) as HTMLInputElement;
    const secretEl = h('input', { type: 'password', placeholder: existing?.secretConfigured ? t('webhooks.secretSet') : t('webhooks.secretPlaceholder') }) as HTMLInputElement;
    const evChecks = eventKinds.map((ev) => {
      const cb = h('input', { type: 'checkbox', value: ev }) as HTMLInputElement;
      if (existing?.events.includes(ev)) cb.checked = true;
      return { ev, cb };
    });
    const save = h('button', { class: 'primary' }, t('webhooks.save')) as HTMLButtonElement;
    const body = h('div', { class: 'agent-modal-body' },
      h('div', { class: 'field' }, h('label', null, t('webhooks.targetName')), nameEl),
      h('div', { class: 'field' }, h('label', null, t('webhooks.targetUrl')), urlEl),
      h('div', { class: 'field' }, h('label', null, t('webhooks.events')),
        h('div', { class: 'check-list' }, ...evChecks.map(({ ev, cb }) => h('label', { class: 'inline-check' }, cb, ev)))),
      h('div', { class: 'field' }, h('label', null, t('webhooks.authHeader')), hdrEl),
      h('div', { class: 'field' }, h('label', null, t('webhooks.authSecret')), secretEl),
      h('div', { class: 'modal-actions' }, save),
    );
    const { close } = modal(existing ? t('webhooks.editTarget') : t('webhooks.newTarget'), body);
    save.addEventListener('click', () => void (async () => {
      const events = evChecks.filter((x) => x.cb.checked).map((x) => x.ev);
      try {
        await api.put(`/api/plugins/webhook/targets/${encodeURIComponent(nameEl.value.trim())}`, {
          url: urlEl.value.trim(), events,
          ...(hdrEl.value.trim() !== '' ? { authHeader: hdrEl.value.trim() } : {}),
          ...(secretEl.value !== '' ? { secret: secretEl.value } : {}),
        });
        toast(t('webhooks.saved')); close(); reload();
      } catch (err) { toast(err instanceof ApiError ? err.message : t('webhooks.error'), true); }
    })());
  };

  // ---- rows ----
  const hookRow = (hk: Hook): HTMLElement => h('div', { class: 'tool-row' },
    h('span', { class: 'tool-row-main mono' }, hk.id),
    h('span', { class: 'tool-row-sub muted-note' }, t(`webhooks.action.${hk.mapping.action}`), hk.secretConfigured ? '' : ' ⚠'),
    h('button', { class: 'icon-btn', title: t('webhooks.edit'), onclick: () => openHook(hk) }, '✎'),
    h('button', { class: 'icon-btn danger', title: t('webhooks.delete'), onclick: () => { if (window.confirm(t('webhooks.confirmDelete', { name: hk.id }))) void api.delete(`/api/plugins/webhook/hooks/${encodeURIComponent(hk.id)}`).then(reload); } }, '×'),
  );
  const targetRow = (tg: Target): HTMLElement => h('div', { class: 'tool-row' },
    h('span', { class: 'tool-row-main mono' }, tg.name),
    h('span', { class: 'tool-row-sub muted-note' }, tg.url, ' — ', tg.events.join(', ') || t('webhooks.manualOnly')),
    h('button', { class: 'icon-btn', title: t('webhooks.test'), onclick: () => void api.post(`/api/plugins/webhook/targets/${encodeURIComponent(tg.name)}/test`, {}).then((r) => toast(t('webhooks.testResult', { status: (r as { status: number }).status }))).catch((e) => toast(e instanceof ApiError ? e.message : t('webhooks.error'), true)) }, '↗'),
    h('button', { class: 'icon-btn', title: t('webhooks.edit'), onclick: () => openTarget(tg) }, '✎'),
    h('button', { class: 'icon-btn danger', title: t('webhooks.delete'), onclick: () => { if (window.confirm(t('webhooks.confirmDelete', { name: tg.name }))) void api.delete(`/api/plugins/webhook/targets/${encodeURIComponent(tg.name)}`).then(reload); } }, '×'),
  );

  const allowEl = h('textarea', { rows: '3', placeholder: 'internal.example.com' }) as HTMLTextAreaElement;
  allowEl.value = allowlist;

  mount(host,
    h('div', { class: 'page-header' },
      h('div', null, h('h1', null, t('webhooks.title')), h('p', { class: 'subtitle' }, t('webhooks.subtitle'))),
    ),
    h('div', { class: 'info-box' }, t('webhooks.infoBanner')),
    h('div', { class: 'sec-title' }, t('webhooks.inboundTitle'), h('button', { class: 'primary', style: 'float:right', onclick: () => openHook() }, t('webhooks.newHook'))),
    h('div', { class: 'tool-list' }, ...(hooks.length > 0 ? hooks.map(hookRow) : [h('div', { class: 'muted-note' }, t('webhooks.noHooks'))])),
    h('div', { class: 'sec-title' }, t('webhooks.outboundTitle'), h('button', { class: 'primary', style: 'float:right', onclick: () => openTarget() }, t('webhooks.newTarget'))),
    h('div', { class: 'tool-list' }, ...(targets.length > 0 ? targets.map(targetRow) : [h('div', { class: 'muted-note' }, t('webhooks.noTargets'))])),
    h('div', { class: 'sec-title' }, t('webhooks.allowlistTitle')),
    h('div', { class: 'field' }, allowEl, h('div', { class: 'field-note' }, t('webhooks.allowlistNote')),
      h('button', { class: 'primary', onclick: () => void api.put('/api/plugins/webhook/allowlist', { allowlist: allowEl.value }).then(() => toast(t('webhooks.saved'))).catch((e) => toast(e instanceof ApiError ? e.message : t('webhooks.error'), true)) }, t('webhooks.save'))),
  );
}

defineView('webhooks', 'nav.webhooks', (host, store) => { void render(host, store); });
