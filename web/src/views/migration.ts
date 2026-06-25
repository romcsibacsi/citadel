// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * Migration (Költöztetés) view (PROMPT-17): a three-step wizard that imports a
 * legacy AI-assistant workspace into one of this system's agents. Step 1 picks a
 * source folder + target agent and scans; step 2 lists typed findings + a 4-stat
 * summary; "Start migration" imports everything; step 3 shows per-tier results +
 * a detail log. No modals, no polling. Operator-only.
 */

import { defineView } from './registry.js';
import { h, mount } from '../dom.js';
import { t } from '../i18n.js';
import { api, ApiError } from '../api.js';
import { toast } from '../toast.js';
import type { Store } from '../store.js';
import type { AppState } from '../main.js';

interface Finding { type: string; path: string; name: string; size: number }
interface Summary { personality: number; profile: number; memory: number; heartbeat: number; config: number; dailyLog: number; schedule: number; total: number }
interface ScanResult { sourcePath: string; findings: Finding[]; summary: Summary }
interface RunDetail { kind: string; name?: string; n?: number }
interface RunResult { ok: boolean; imported: number; stats: { hot: number; warm: number; cold: number; shared: number }; details: RunDetail[] }
interface RosterAgent { name: string; label: string }

const TYPE_ICON: Record<string, string> = { personality: '🎭', profile: '👤', memory: '🧠', hot: '🔥', warm: '🌡️', cold: '❄️', heartbeat: '💓', config: '⚙️', 'daily-log': '📋', schedule: '⏰' };
const TYPE_LABEL: Record<string, string> = { personality: 'migration.type.personality', profile: 'migration.type.profile', memory: 'migration.type.memory', hot: 'migration.type.hot', warm: 'migration.type.warm', cold: 'migration.type.cold', heartbeat: 'migration.type.heartbeat', config: 'migration.type.config', 'daily-log': 'migration.type.dailyLog', schedule: 'migration.type.schedule' };

function render(host: HTMLElement, store: Store<AppState>): void {
  void store;
  let findings: Finding[] = [];
  let summary: Summary | null = null;
  let roster: RosterAgent[] = [];

  const step1 = h('div', { class: 'mig-step' });
  const step2 = h('div', { class: 'mig-step', style: 'display:none' });
  const step3 = h('div', { class: 'mig-step', style: 'display:none' });
  const show = (n: 1 | 2 | 3): void => { step1.style.display = n === 1 ? '' : 'none'; step2.style.display = n === 2 ? '' : 'none'; step3.style.display = n === 3 ? '' : 'none'; };

  // ---------- step 1 ----------
  const pathEl = h('input', { type: 'text', placeholder: t('migration.pathPh') }) as HTMLInputElement;
  const agentSel = h('select', null) as HTMLSelectElement;
  const scanBtn = h('button', { class: 'primary' }, t('migration.scan')) as HTMLButtonElement;
  const scan = async (): Promise<void> => {
    if (pathEl.value.trim() === '') { pathEl.focus(); return; }
    scanBtn.disabled = true; scanBtn.textContent = t('migration.scanning');
    try {
      const r = await api.post<ScanResult>('/api/migration/scan', { path: pathEl.value.trim() });
      findings = r.findings; summary = r.summary; renderFindings(); show(2);
    } catch (err) { toast(t('migration.error.generic', { message: err instanceof ApiError ? err.message : String(err) }), true); }
    scanBtn.disabled = false; scanBtn.textContent = t('migration.scan');
  };
  scanBtn.addEventListener('click', () => void scan());
  mount(step1,
    h('h2', { class: 'mig-heading' }, t('migration.step1')),
    h('div', { class: 'field' }, h('label', null, t('migration.pathLabel')), pathEl),
    h('div', { class: 'field' }, h('label', null, t('migration.agentLabel')), agentSel),
    h('div', { class: 'modal-actions' }, scanBtn),
  );

  // ---------- step 2 ----------
  const list = h('div', { class: 'mig-findings' });
  const summaryRow = h('div', { class: 'stat-row mig-summary' });
  const startBtn = h('button', { class: 'primary' }, t('migration.start')) as HTMLButtonElement;
  const renderFindings = (): void => {
    if (findings.length === 0) mount(list, h('div', { class: 'muted-note center mig-empty' }, t('migration.empty')));
    else mount(list, ...findings.map((f) => h('div', { class: 'mig-finding' },
      h('span', { class: 'mig-ficon' }, TYPE_ICON[f.type] ?? '📄'),
      h('div', { class: 'mig-finfo' }, h('div', { class: 'mig-fname' }, f.name), h('div', { class: 'mig-ftype muted-note' }, TYPE_LABEL[f.type] ? t(TYPE_LABEL[f.type]!) : f.type)),
      h('div', { class: 'mig-fsize' }, `${(f.size / 1024).toFixed(1)} ${t('migration.unit')}`),
    )));
    const s = summary ?? { total: 0, memory: 0, personality: 0, profile: 0, config: 0, heartbeat: 0 } as Summary;
    mount(summaryRow,
      tile(String(s.total), 'migration.sum.total'),
      tile(String(s.memory), 'migration.sum.memory'),
      tile(String(s.personality + s.profile), 'migration.sum.profile'),
      tile(String(s.config + s.heartbeat), 'migration.sum.config'),
    );
    startBtn.disabled = findings.length === 0;
  };
  const start = async (): Promise<void> => {
    startBtn.disabled = true; startBtn.textContent = t('migration.starting');
    try {
      const r = await api.post<RunResult>('/api/migration/run', { findings, agent: agentSel.value });
      renderResult(r); show(3);
    } catch (err) { toast(t('migration.error.generic', { message: err instanceof ApiError ? err.message : String(err) }), true); }
    startBtn.disabled = false; startBtn.textContent = t('migration.start');
  };
  startBtn.addEventListener('click', () => void start());
  mount(step2,
    h('h2', { class: 'mig-heading' }, t('migration.step2')),
    list, summaryRow,
    h('div', { class: 'modal-actions' },
      h('button', { class: 'secondary', onclick: () => show(1) }, t('migration.back')),
      startBtn,
    ),
  );

  // ---------- step 3 ----------
  const resultBlock = h('div', { class: 'mig-result' });
  const renderResult = (r: RunResult): void => {
    const detailLines = r.details.map((d) => d.kind === 'chunks' ? t('migration.detail.chunks', { n: d.n ?? 0 }) : t(`migration.detail.${d.kind}`, { name: d.name ?? '' }));
    mount(resultBlock,
      h('div', { class: 'mig-success' }, '✅ ', t('migration.success')),
      h('div', { class: 'stat-row mig-result-tiles' },
        tile(String(r.imported), 'migration.tile.imported'),
        tile(String(r.stats.hot), 'migration.tile.hot', 'hot-tile'),
        tile(String(r.stats.warm), 'migration.tile.warm', 'warm-tile'),
        tile(String(r.stats.cold), 'migration.tile.cold', 'cold-tile'),
        tile(String(r.stats.shared), 'migration.tile.shared', 'shared-tile'),
      ),
      ...(detailLines.length > 0 ? [h('div', { class: 'mig-detail-log' }, ...detailLines.map((l) => h('div', { class: 'mig-detail-line' }, l)))] : []),
      h('div', { class: 'modal-actions' }, h('button', { class: 'secondary', onclick: () => { show(1); } }, t('migration.new'))),
    );
  };
  mount(step3, h('h2', { class: 'mig-heading' }, t('migration.step3')), resultBlock);

  function tile(value: string, captionKey: string, cls = ''): HTMLElement {
    return h('div', { class: `stat-card mig-tile ${cls}` }, h('div', { class: 'stat-value' }, value), h('div', { class: 'stat-label' }, t(captionKey)));
  }

  mount(host,
    h('div', { class: 'page-header' }, h('h1', null, t('migration.title')), h('p', { class: 'subtitle' }, t('migration.subtitle'))),
    h('div', { class: 'mig-wizard' }, step1, step2, step3),
  );

  // populate roster on open
  void api.get<RosterAgent[]>('/api/schedules/agents').then((r) => { roster = r; mount(agentSel, ...roster.map((a) => h('option', { value: a.name }, a.label || a.name))); }).catch(() => undefined);
  show(1);
}

defineView('migration', 'nav.migration', render);
