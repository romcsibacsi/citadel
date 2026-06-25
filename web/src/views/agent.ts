// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * Agent watch + type view (SPEC §17 MUST — the flagship): live SSE output
 * stream, direct operator input (serialized server-side, attributed), force
 * interrupt, lifecycle controls with fresh restart, and the per-peer
 * conversation table. Hidden from the nav; reached via #agent/<id>.
 */

import { defineView } from './registry.js';
import { h, mount, clear } from '../dom.js';
import { t, currentLocale } from '../i18n.js';
import { api, openStream, ApiError } from '../api.js';
import { wireStreamStatus } from '../streamStatus.js';
import type { Store } from '../store.js';
import type { AppState } from '../main.js';

interface AgentStatusDto {
  running: boolean;
  since?: string;
  busyState: string;
  needsReauth: boolean;
}

interface StreamPayload {
  text?: string;
  state?: string;
}

interface ThreadDto {
  peer: string;
  lastBody: string;
  lastAt: string;
}

interface StreamLine {
  cls: string;
  text: string;
}

const MAX_LINES = 500;

// Views fully re-render (every store patch): the live resources and the
// scrollback live in module scope so re-renders can close/recreate cleanly.
let activeStream: EventSource | null = null;
let pollTimer: number | null = null;
const scrollback = new Map<string, StreamLine[]>();

function cleanup(): void {
  if (activeStream) {
    activeStream.close();
    activeStream = null;
  }
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// Navigating to another view never calls this renderer again — release the
// EventSource and the status poll the moment the route leaves #agent/...
window.addEventListener('hashchange', () => {
  if (location.hash.slice(1).split('/')[0] !== 'agent') cleanup();
});

function toastErr(message: string): void {
  let hostEl = document.querySelector<HTMLDivElement>('.toast-host');
  if (!hostEl) {
    hostEl = h('div', { class: 'toast-host' }) as HTMLDivElement;
    document.body.append(hostEl);
  }
  const node = h('div', { class: 'toast err' }, message);
  hostEl.append(node);
  setTimeout(() => node.remove(), 6000);
}

function showError(err: unknown): void {
  toastErr(err instanceof ApiError ? err.message : t('agent.error'));
}

function dotClass(st: AgentStatusDto): string {
  if (!st.running) return 'idle';
  if (st.busyState === 'ready') return 'ok';
  if (st.busyState === 'busy') return 'busy';
  return 'warn'; // needs-input | reauth-needed
}

function stateLabel(st: AgentStatusDto): string {
  return t(`agent.state.${st.running ? st.busyState : 'stopped'}`);
}

function lineNode(line: StreamLine): HTMLElement {
  return h('div', line.cls !== '' ? { class: line.cls } : null, line.text);
}

function render(host: HTMLElement, store: Store<AppState>, subpath: string[]): void {
  cleanup();

  const agentId = subpath[0] ?? '';
  if (agentId === '') {
    mount(
      host,
      h('h1', { class: 'page-title' }, t('agent.title')),
      h('div', { class: 'panel' }, t('agent.noAgent'), ' ', h('a', { href: '#fleet' }, t('agent.backToFleet'))),
    );
    return;
  }

  const summary = store.get().agents.find((a) => a.id === agentId);
  const accent = summary?.accentColor ?? 'var(--accent)';

  // --- header: name + live status + lifecycle controls ---
  const dot = h('span', { class: 'dot idle' });
  const statusText = h('span', null, t('agent.state.stopped'));
  const sinceBadge = h('span', { class: 'badge', style: 'display: none' });
  const freshCheckbox = h('input', { type: 'checkbox', style: 'width: auto; margin: 0' }) as HTMLInputElement;

  const refreshStatus = async (): Promise<void> => {
    try {
      const st = await api.get<AgentStatusDto>(`/api/agents/${encodeURIComponent(agentId)}/status`);
      dot.className = `dot ${dotClass(st)}`;
      statusText.textContent = stateLabel(st);
      if (st.running && st.since !== undefined) {
        sinceBadge.style.display = '';
        sinceBadge.textContent = t('agent.since', { ts: new Date(st.since).toLocaleString(currentLocale()) });
      } else {
        sinceBadge.style.display = 'none';
      }
    } catch {
      /* transient poll failure: keep the last known status */
    }
  };

  const lifecycle = async (op: 'start' | 'stop' | 'restart'): Promise<void> => {
    try {
      const body = op === 'restart' ? { fresh: freshCheckbox.checked } : undefined;
      await api.post(`/api/agents/${encodeURIComponent(agentId)}/${op}`, body);
      await refreshStatus();
    } catch (err) {
      showError(err);
    }
  };

  const header = h(
    'div',
    { class: 'panel', style: 'display: flex; gap: 16px; align-items: center; flex-wrap: wrap' },
    h('span', null, dot, statusText),
    sinceBadge,
    h(
      'span',
      { style: 'display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-left: auto' },
      h('button', { onclick: () => void lifecycle('start') }, t('agent.start')),
      h('button', { onclick: () => void lifecycle('stop') }, t('agent.stop')),
      h('button', { onclick: () => void lifecycle('restart') }, t('agent.restart')),
      h('label', { style: 'display: flex; gap: 6px; align-items: center; margin: 0' }, freshCheckbox, t('agent.fresh')),
    ),
  );

  // --- live stream ---
  const streamEl = h('div', { class: 'stream' });
  let pinned = true; // autoscroll unless the operator scrolled up
  streamEl.addEventListener('scroll', () => {
    pinned = streamEl.scrollTop + streamEl.clientHeight >= streamEl.scrollHeight - 30;
  });

  const buffer = scrollback.get(agentId) ?? [];
  scrollback.set(agentId, buffer);
  for (const line of buffer) streamEl.append(lineNode(line));

  // TUI adapters (Claude Code) push full rendered screen snapshots: the live
  // view IS the current terminal screen, replaced on each tick. A small status
  // line above it carries reconnect/state notices.
  const screenEl = h('pre', { class: 'stream', style: 'display:none; white-space: pre; overflow-x: auto; margin: 0' });
  let screenMode = false;

  const appendLine = (line: StreamLine): void => {
    buffer.push(line);
    if (buffer.length > MAX_LINES) buffer.splice(0, buffer.length - MAX_LINES);
    streamEl.append(lineNode(line));
    while (streamEl.childNodes.length > MAX_LINES) streamEl.firstChild?.remove();
    if (pinned) streamEl.scrollTop = streamEl.scrollHeight;
  };

  const showScreen = (text: string): void => {
    if (text.trim() === '') return; // never blank a good view with an empty snapshot (SPEC §17)
    if (!screenMode) {
      screenMode = true;
      streamEl.style.display = 'none';
      screenEl.style.display = '';
    }
    screenEl.textContent = text;
    if (pinned) screenEl.scrollTop = screenEl.scrollHeight;
  };

  // connected/disconnected status indicator in the stream header (FIX-terminal-ux)
  const streamStatusText = h('span', { class: 'term-status-text' }, t('agents.terminal.connecting'));
  const streamStatus = h('span', { class: 'term-status connecting' }, h('span', { class: 'term-status-dot' }), streamStatusText);
  const setStreamStatus = (state: 'connecting' | 'connected' | 'reconnecting'): void => {
    streamStatus.className = `term-status ${state}`;
    streamStatusText.textContent = t(`agents.terminal.${state}`);
  };

  const es = openStream(`/api/agents/${encodeURIComponent(agentId)}/stream`);
  activeStream = es;
  let reconnectNoticed = false;
  // status state machine (connected on open/frame, reconnecting only after a prior
  // connect); the inline reconnect notice rides the same error edge.
  const { markFrame } = wireStreamStatus(es, setStreamStatus, () => {
    if (!reconnectNoticed) {
      reconnectNoticed = true;
      if (!screenMode) appendLine({ cls: 'op-injected', text: t('agent.reconnecting') });
    }
  });
  const onStreamEvent = (ev: Event): void => {
    reconnectNoticed = false;
    markFrame();
    const raw = (ev as MessageEvent<string>).data;
    let payload: StreamPayload;
    try {
      payload = JSON.parse(raw) as StreamPayload;
    } catch {
      payload = { text: raw };
    }
    if (ev.type === 'screen') {
      showScreen(payload.text ?? '');
    } else if (ev.type === 'output') {
      if (payload.text !== undefined && payload.text !== '') appendLine({ cls: '', text: payload.text });
    } else {
      const state = payload.state ?? 'busy';
      appendLine({ cls: 'op-injected', text: t('agent.stateChange', { state: t(`agent.state.${state}`) }) });
    }
  };
  es.addEventListener('screen', onStreamEvent);
  es.addEventListener('output', onStreamEvent);
  es.addEventListener('state', onStreamEvent);

  // --- operator input row (serialized + attributed server-side, SPEC §17) ---
  const input = h('input', { type: 'text', placeholder: t('agent.inputPlaceholder') }) as HTMLInputElement;

  const send = async (): Promise<void> => {
    const text = input.value.trim();
    if (text === '') return;
    try {
      await api.post(`/api/agents/${encodeURIComponent(agentId)}/input`, { text });
      input.value = '';
    } catch (err) {
      showError(err);
    }
  };

  const interrupt = async (): Promise<void> => {
    try {
      await api.post(`/api/agents/${encodeURIComponent(agentId)}/input`, {
        text: t('agent.interruptPrompt'),
        force: true,
      });
    } catch (err) {
      showError(err);
    }
  };

  const inputRow = h(
    'form',
    {
      style: 'display: flex; gap: 8px; margin-top: 12px',
      onsubmit: (e: Event) => {
        e.preventDefault();
        void send();
      },
    },
    input,
    h('button', { class: 'primary', type: 'submit' }, t('agent.send')),
    h('button', { class: 'danger', type: 'button', onclick: () => void interrupt() }, t('agent.interrupt')),
  );

  const streamPanel = h(
    'div',
    { class: 'panel', style: `--agent-accent: ${accent}` },
    h('div', { style: 'display: flex; align-items: center; justify-content: space-between; margin: 0 0 12px' },
      h('h2', { style: 'margin: 0; font-size: var(--fs-l)' }, t('agent.streamTitle')),
      streamStatus,
    ),
    streamEl,
    screenEl,
    inputRow,
  );

  // --- conversations (per-peer threads) ---
  const threadsBody = h('tbody');
  const threadsPanel = h(
    'div',
    { class: 'panel' },
    h('h2', { style: 'margin: 0 0 12px; font-size: var(--fs-l)' }, t('agent.threads.title')),
    h(
      'table',
      null,
      h(
        'thead',
        null,
        h(
          'tr',
          null,
          h('th', null, t('agent.threads.peer')),
          h('th', null, t('agent.threads.last')),
          h('th', null, t('agent.threads.when')),
        ),
      ),
      threadsBody,
    ),
  );

  const loadThreads = async (): Promise<void> => {
    try {
      const rows = await api.get<ThreadDto[]>(`/api/messages/threads/${encodeURIComponent(agentId)}`);
      clear(threadsBody);
      if (rows.length === 0) {
        threadsBody.append(h('tr', null, h('td', { colspan: 3, style: 'color: var(--ink-3)' }, t('agent.threads.empty'))));
        return;
      }
      for (const row of rows) {
        const preview = row.lastBody.length > 140 ? `${row.lastBody.slice(0, 140)}…` : row.lastBody;
        threadsBody.append(
          h(
            'tr',
            null,
            h('td', null, row.peer),
            h('td', null, preview),
            h('td', null, new Date(row.lastAt).toLocaleString(currentLocale())),
          ),
        );
      }
    } catch (err) {
      showError(err);
    }
  };

  mount(
    host,
    h(
      'h1',
      { class: 'page-title', style: `--agent-accent: ${accent}; color: var(--agent-accent)` },
      summary?.displayName ?? agentId,
      summary !== undefined ? h('span', { class: 'badge', style: 'margin-left: 12px' }, summary.role) : null,
    ),
    header,
    streamPanel,
    threadsPanel,
  );

  void refreshStatus();
  void loadThreads();
  pollTimer = window.setInterval(() => void refreshStatus(), 3000);
  host.dataset.agentPoll = String(pollTimer);
}

defineView('agent', 'agent.title', render, { hidden: true });
