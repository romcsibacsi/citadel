// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * Updates (Frissítések) view (PROMPT-18): the operator's self-update surface. A
 * dominant status banner (loading / up-to-date / behind / error), a changelog of
 * incoming commits, and a guarded apply flow (confirm → optional dirty-tree
 * auto-stash confirm → detached background updater → reload in ~30s). Apply is
 * operator-only and never auto-fired.
 */

import { defineView } from './registry.js';
import { h, mount } from '../dom.js';
import { t } from '../i18n.js';
import { api, getToken } from '../api.js';
import { icon } from '../icons.js';
import { toast } from '../toast.js';
import type { Store } from '../store.js';
import type { AppState } from '../main.js';

interface Commit { id: string; shortId: string; subject: string; author: string; date: string }
interface UpdateStatus { current: string; currentShort: string; branch: string; repo: string | null; latest: string | null; latestShort: string | null; behind: number; commits: Commit[]; lastChecked: string; error: string | null; errorKey: string | null }
interface DivergenceStatus { diverged: boolean; aheadCount: number; commits: { sha: string; author: string; subject: string }[]; branch: string; error: string | null }

const ERR_KEY: Record<string, string> = { 'no-repo': 'updates.err.noRepo', 'no-host': 'updates.err.noHost', detached: 'updates.err.detached', 'no-branch-on-repo': 'updates.err.noBranchOnRepo', 'head-not-on-repo': 'updates.err.headNotOnRepo' };

/** Setup states (no source / no Gitea host) are NOT failures — render them as an
 *  accent-soft prompt with a CTA to the integrations panel, never the red error. */
function isSetupState(s: UpdateStatus): boolean {
  return s.repo === null || s.errorKey === 'no-repo' || s.errorKey === 'no-host';
}

function render(host: HTMLElement, store: Store<AppState>): void {
  const banner = h('div', { class: 'upd-banner loading', 'aria-live': 'polite' }, t('updates.status.loading'));
  // deploy-checkout divergence warning (#88) — non-blocking; shown only when the local
  // main carries commits not on origin/main (e.g. a direct operator commit).
  const divBanner = h('div', { class: 'upd-banner diverged', style: 'display:none', role: 'status' });
  const renderDivergence = (d: DivergenceStatus | null): void => {
    if (d === null || !d.diverged) { divBanner.style.display = 'none'; mount(divBanner); return; }
    divBanner.style.display = '';
    mount(divBanner,
      h('div', null, h('b', null, `⚠ ${t('updates.divergence.lead', { N: d.aheadCount, branch: d.branch })}`)),
      h('div', { class: 'muted-note' }, t('updates.divergence.hint')),
      ...d.commits.map((c) => h('div', { class: 'upd-commit' }, h('span', { class: 'mono' }, `${c.sha} · ${c.author}`), ' ', h('span', { class: 'upd-subject' }, c.subject))),
    );
  };
  const changes = h('div', { class: 'upd-changes' });
  const checkBtn = h('button', { class: 'secondary' }, icon('sync', 16), t('updates.btn.check')) as HTMLButtonElement;
  const applyBtn = h('button', { class: 'primary upd-apply', style: 'display:none' }, t('updates.btn.apply')) as HTMLButtonElement;

  const renderStatus = (s: UpdateStatus | null): void => {
    applyBtn.style.display = 'none'; applyBtn.disabled = false; applyBtn.textContent = t('updates.btn.apply');
    mount(changes);
    if (s === null) { banner.className = 'upd-banner loading'; banner.textContent = t('updates.status.loading'); return; }
    const cur = s.currentShort || '—';
    if (isSetupState(s)) {
      // setup, not failure: accent-soft prompt + CTA to the integrations panel
      banner.className = 'upd-banner norepo';
      const msg = s.errorKey && ERR_KEY[s.errorKey] ? t(ERR_KEY[s.errorKey]!) : t('updates.err.noRepo');
      const cta = h('button', { class: 'primary' }, t('updates.norepo.cta')) as HTMLButtonElement;
      cta.addEventListener('click', () => { window.location.hash = '#vault'; });
      mount(banner, h('div', null, icon('plug', 16), ' ', h('b', null, msg)), h('div', { class: 'upd-norepo-cta' }, cta));
      return;
    }
    if (s.error) {
      banner.className = 'upd-banner error';
      const msg = s.errorKey && ERR_KEY[s.errorKey] ? t(ERR_KEY[s.errorKey]!) : s.error;
      mount(banner, h('div', null, h('b', null, t('updates.status.error.lead')), ' ', msg), h('div', { class: 'mono' }, t('updates.status.error.current', { cur })));
      return;
    }
    if (s.behind > 0) {
      banner.className = 'upd-banner behind';
      mount(banner,
        h('div', null, h('b', null, t('updates.status.behind.lead', { N: s.behind })), s.repo ? h('span', null, ' · ', t('updates.status.behind.repo', { repo: s.repo })) : null),
        h('div', { class: 'mono upd-delta' }, t('updates.status.behind.deltaCur', { cur }), ' → ', t('updates.status.behind.deltaLat', { lat: s.latestShort ?? '—' })),
      );
      applyBtn.style.display = '';
      mount(changes, h('h2', { class: 'sec-title' }, t('updates.changes.heading')), ...s.commits.map((c) => h('div', { class: 'upd-commit' },
        h('div', { class: 'upd-commit-head' }, h('span', { class: 'mono' }, `${c.shortId} · ${c.author}`), h('span', { class: 'upd-date muted-note' }, c.date)),
        h('div', { class: 'upd-subject' }, c.subject),
      )));
      return;
    }
    banner.className = 'upd-banner uptodate';
    mount(banner, h('div', null, h('b', null, t('updates.status.uptodate.lead')), ' ', h('span', { class: 'mono' }, cur), ' — ', t('updates.status.uptodate.tail')));
    mount(changes, h('h2', { class: 'sec-title' }, t('updates.changes.heading')), h('div', { class: 'muted-note' }, t('updates.changes.none')));
  };

  const load = async (): Promise<void> => {
    let s = await api.get<UpdateStatus | null>('/api/updates/status').catch(() => null);
    if (s === null) s = await api.post<UpdateStatus>('/api/updates/check').catch(() => null);
    renderStatus(s);
    if (typeof s?.behind === 'number') store.patch({ updatesBehind: s.error ? 0 : s.behind });
    renderDivergence(await api.get<DivergenceStatus | null>('/api/deploy/divergence').catch(() => null));
  };

  const check = async (): Promise<void> => {
    checkBtn.disabled = true;
    banner.className = 'upd-banner loading'; banner.textContent = t('updates.status.loading'); mount(changes);
    try { renderStatus(await api.post<UpdateStatus>('/api/updates/check')); } catch (err) { toast(t('updates.toast.error', { message: String(err) }), true); await load(); }
    checkBtn.disabled = false;
  };

  const apply = async (autoStash: boolean): Promise<void> => {
    if (!autoStash && !window.confirm(t('updates.confirm.apply'))) return;
    applyBtn.disabled = true; applyBtn.textContent = '…';
    let res: Response;
    try { res = await fetch('/api/updates/apply', { method: 'POST', headers: { authorization: `Bearer ${getToken()}`, 'content-type': 'application/json' }, body: JSON.stringify({ autoStash }) }); }
    catch (err) { toast(t('updates.toast.error', { message: String(err) }), true); applyBtn.disabled = false; applyBtn.textContent = t('updates.btn.apply'); return; }
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; reason?: string; message?: string };
    if (res.ok && body.ok) {
      toast(t('updates.toast.started'));
      window.setTimeout(() => window.location.reload(), 30_000);
      return; // keep the button busy until the reload
    }
    applyBtn.disabled = false; applyBtn.textContent = t('updates.btn.apply');
    if (body.reason === 'dirty-tree' && !autoStash) {
      if (window.confirm(t('updates.confirm.autostash'))) await apply(true);
      return;
    }
    toast(t('updates.toast.refused', { reason: body.message ?? `HTTP ${res.status}` }), true);
  };

  checkBtn.addEventListener('click', () => void check());
  applyBtn.addEventListener('click', () => void apply(false));

  mount(host,
    h('div', { class: 'page-header upd-header' },
      h('div', null, h('h1', null, t('updates.title')), h('p', { class: 'subtitle' }, t('updates.subtitle', { product: store.get().branding.productName || 'Orchestrator' }))),
      h('div', { class: 'upd-actions' }, checkBtn, applyBtn),
    ),
    divBanner,
    banner,
    changes,
  );
  void load();
}

defineView('updates', 'nav.updates', render);
