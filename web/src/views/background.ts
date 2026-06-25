// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * Background tasks (Háttér) view (PROMPT-12): a detached one-shot agent runner.
 * A control bar (agent picker + prompt + Launch + "include finished") over a
 * vertical stack of task cards. The control bar is built once and persists; a
 * silent 10s poll re-renders only the list region so running tasks advance to a
 * terminal status without wiping the operator's half-typed prompt or selection.
 */

import { defineView } from './registry.js';
import { h, mount } from '../dom.js';
import { t } from '../i18n.js';
import { api, ApiError } from '../api.js';
import { icon } from '../icons.js';
import { toast } from '../toast.js';
import type { Store } from '../store.js';
import type { AppState } from '../main.js';

type BgStatus = 'running' | 'done' | 'failed' | 'timeout';
interface Task {
  id: string;
  agent_id: string;
  prompt: string;
  status: BgStatus;
  started_at: string;
  finished_at: string | null;
  output: string | null;
  started_label: string | null;
  finished_label: string | null;
}
interface RosterAgent { name: string; label: string }

const KNOWN_STATUS: BgStatus[] = ['running', 'done', 'failed', 'timeout'];

// Selection + filter survive the view's own re-render cycle.
let selectedAgent = '';
let includeFinished = false;
let roster: RosterAgent[] | null = null;
let pollTimer: number | undefined;

function statusLabel(s: BgStatus): string {
  return t(`background.status.${s}`);
}

async function render(host: HTMLElement, store: Store<AppState>): Promise<void> {
  void store;
  if (pollTimer !== undefined) { clearInterval(pollTimer); pollTimer = undefined; }

  const listEl = h('div', { class: 'bg-list' });

  // ---- output modal (running tasks only) ----
  const openOutput = (task: Task): void => {
    const body = h('pre', { class: 'bg-output-modal-body' }, t('background.modal.loading'));
    const backdrop = h('div', { class: 'modal-backdrop' });
    const close = (): void => { backdrop.remove(); document.body.classList.remove('modal-open'); document.removeEventListener('keydown', onKey); };
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    backdrop.append(h('div', { class: 'modal bg-output-modal' },
      h('div', { class: 'agent-modal-titlebar' },
        h('h2', null, `${t('background.modal.titlePrefix')} ${task.id}`),
        h('button', { class: 'icon-btn', 'aria-label': t('background.modal.close'), onclick: close }, '✕'),
      ),
      body,
    ));
    document.body.append(backdrop); document.body.classList.add('modal-open');
    void api.get<Task>(`/api/background-tasks/${encodeURIComponent(task.id)}`)
      .then((detail) => { body.textContent = detail.output && detail.output !== '' ? detail.output : t('background.modal.noOutput'); })
      .catch(() => { toast(t('background.toast.loadDetailFailed'), true); close(); });
  };

  const stopTask = async (task: Task): Promise<void> => {
    if (!window.confirm(t('background.confirm.stop'))) return;
    try {
      await api.delete(`/api/background-tasks/${encodeURIComponent(task.id)}`);
      toast(t('background.toast.stopped'));
      void loadList();
    } catch { toast(t('background.toast.stopFailed'), true); }
  };

  // ---- one task card ----
  const card = (task: Task): HTMLElement => {
    const status: BgStatus = KNOWN_STATUS.includes(task.status) ? task.status : 'failed';
    const left = h('div', { class: 'bg-card-left' },
      h('span', { class: 'bg-id' }, task.id),
      h('span', { class: `badge bg-pill bg-pill-${status}` }, KNOWN_STATUS.includes(task.status) ? statusLabel(status) : task.status),
      h('span', { class: 'badge bg-agent-pill' }, task.agent_id),
    );
    const right = h('div', { class: 'bg-card-right' });
    if (task.started_label) right.append(h('span', { class: 'bg-time' }, task.started_label));
    if (task.status === 'running') {
      right.append(
        h('button', { class: 'btn-mini', onclick: () => openOutput(task) }, t('background.card.btn.output')),
        h('button', { class: 'btn-mini danger', onclick: () => void stopTask(task) }, t('background.card.btn.stop')),
      );
    }
    const body = h('div', { class: 'bg-card-body' }, h('div', { class: 'bg-prompt' }, task.prompt));
    if (task.finished_label) body.append(h('div', { class: 'bg-finished' }, `${t('background.card.finishedPrefix')} ${task.finished_label}`));
    if (task.output && task.output !== '') body.append(h('pre', { class: 'bg-output-preview' }, task.output.slice(-2000)));
    return h('div', { class: `bg-card bg-edge-${status}` },
      h('div', { class: 'bg-card-top' }, left, right),
      body,
    );
  };

  // ---- list load (silent refresh) ----
  const loadList = async (): Promise<void> => {
    try {
      const params = new URLSearchParams();
      if (selectedAgent !== '') params.set('agent', selectedAgent);
      if (includeFinished) params.set('all', 'true');
      const tasks = await api.get<Task[]>(`/api/background-tasks?${params.toString()}`);
      if (tasks.length === 0) { mount(listEl, h('div', { class: 'bg-empty muted-note' }, t('background.list.empty'))); return; }
      mount(listEl, ...tasks.map(card));
    } catch (err) {
      mount(listEl, h('div', { class: 'bg-error' }, t(err instanceof ApiError ? 'background.list.errorHttp' : 'background.list.errorNetwork')));
    }
  };

  // ---- control bar ----
  const agentSelect = h('select', { class: 'bg-agent-select', 'aria-label': t('background.picker.placeholder') }) as HTMLSelectElement;
  const promptInput = h('input', { type: 'text', class: 'bg-prompt-input', placeholder: t('background.prompt.placeholder') }) as HTMLInputElement;
  const launchBtn = h('button', { class: 'primary bg-launch-btn' }, t('background.btn.launch')) as HTMLButtonElement;
  const finishedCb = h('input', { type: 'checkbox' }) as HTMLInputElement;
  finishedCb.checked = includeFinished;

  const populateAgents = (): void => {
    mount(agentSelect, h('option', { value: '' }, t('background.picker.placeholder')),
      ...(roster ?? []).map((a) => h('option', { value: a.name, selected: a.name === selectedAgent }, a.label)));
  };
  agentSelect.addEventListener('change', () => { selectedAgent = agentSelect.value; void loadList(); });
  finishedCb.addEventListener('change', () => { includeFinished = finishedCb.checked; void loadList(); });

  const launch = async (): Promise<void> => {
    if (selectedAgent === '') { toast(t('background.toast.chooseAgent'), true); return; }
    const prompt = promptInput.value.trim();
    if (prompt === '') { toast(t('background.toast.enterTask'), true); return; }
    launchBtn.disabled = true;
    try {
      await api.post('/api/background-tasks', { agent_id: selectedAgent, prompt });
      promptInput.value = '';
      toast(t('background.toast.started'));
      void loadList();
    } catch (err) {
      // 429 (cap) / 400 carry a server message; show it verbatim
      if (err instanceof ApiError) toast(err.message || t('background.toast.startFailedGeneric'), true);
      else toast(t('background.toast.startFailedNetwork'), true);
    } finally {
      launchBtn.disabled = false;
    }
  };
  launchBtn.addEventListener('click', () => void launch());
  promptInput.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); void launch(); } });

  mount(host,
    h('div', { class: 'page-header' },
      h('h1', null, t('background.page.title')),
      h('p', { class: 'subtitle' }, t('background.page.subtitle')),
    ),
    h('div', { class: 'bg-controls' },
      agentSelect,
      promptInput,
      launchBtn,
      h('label', { class: 'inline-check bg-finished-toggle' }, finishedCb, t('background.toggle.includeFinished')),
    ),
    listEl,
  );

  // roster is fetched once and cached; auto-select a lone agent
  if (roster === null) {
    try {
      roster = await api.get<RosterAgent[]>('/api/schedules/agents');
      if (roster.length === 1 && selectedAgent === '') selectedAgent = roster[0]!.name;
    } catch { roster = []; }
  }
  populateAgents();
  await loadList();
  pollTimer = window.setInterval(() => {
    if (!listEl.isConnected) { if (pollTimer !== undefined) clearInterval(pollTimer); pollTimer = undefined; return; }
    void loadList();
  }, 10_000);
}

defineView('background', 'nav.background', (host, store) => {
  void render(host, store);
});
