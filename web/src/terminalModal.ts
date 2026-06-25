// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { h } from './dom.js';
import { t } from './i18n.js';
import { api, openStream, ApiError } from './api.js';
import { toast } from './toast.js';
import { wireStreamStatus } from './streamStatus.js';

/**
 * Terminal modal (PROMPT-03 §5D): a live viewport mirroring the agent's running
 * session. TUI adapters push full-snapshot `screen` frames (the viewport repaints
 * on each tick); plain `output` chunks append. Typing posts to the agent's input
 * endpoint (the adapter handles the actual keystrokes/Enter on the live pane).
 * Closing tears down the stream.
 */
/** Map a browser KeyboardEvent to a tmux send-keys name for the allow-listed set (FIX-03 §3); null otherwise. */
function tmuxKey(e: KeyboardEvent): string | null {
  if (e.ctrlKey && !e.altKey && !e.metaKey) {
    const ctrl: Record<string, string> = { c: 'C-c', d: 'C-d', u: 'C-u', l: 'C-l', a: 'C-a', e: 'C-e', k: 'C-k', w: 'C-w' };
    return ctrl[e.key.toLowerCase()] ?? null;
  }
  switch (e.key) {
    case 'Escape': return 'Escape';
    case 'ArrowUp': return 'Up';
    case 'ArrowDown': return 'Down';
    case 'ArrowLeft': return 'Left';
    case 'ArrowRight': return 'Right';
    case 'Tab': return e.shiftKey ? 'BTab' : 'Tab';
    case 'PageUp': return 'PageUp';
    case 'PageDown': return 'PageDown';
    case 'Home': return 'Home';
    case 'End': return 'End';
    case 'Enter': return 'Enter';
    case 'Backspace': return 'BSpace';
    default:
      // single digits forward as discrete send-keys (#69) so a numbered picker
      // ("Do you want to proceed? 1.Yes 2.No") is answerable by pressing the digit.
      return /^[0-9]$/.test(e.key) ? e.key : null;
  }
}

/** Strip OSC-8 hyperlink escape sequences (ESC ]8;...;URI BEL|ST), keeping the visible link text. */
function stripOsc8(text: string): string {
  const ESC = String.fromCharCode(27), BEL = String.fromCharCode(7);
  const re = new RegExp(ESC + '\\]8;[^' + BEL + ESC + ']*(?:' + BEL + '|' + ESC + '\\\\)', 'g');
  return text.replace(re, "");
}

export function openTerminal(agentId: string, displayName: string): void {
  const screen = h('pre', { class: 'term-screen', tabindex: '0' }, t('agents.terminal.connecting')) as HTMLPreElement;
  let screenMode = false;
  const appendBuffer: string[] = [];

  // status indicator (FIX-terminal-ux): connecting → connected (first frame/open)
  // → reconnecting (on error). The status dot lives in the titlebar.
  const statusDot = h('span', { class: 'term-status-dot' });
  const statusText = h('span', { class: 'term-status-text' }, t('agents.terminal.connecting'));
  const statusEl = h('span', { class: 'term-status connecting' }, statusDot, statusText);
  const streamNotice = h('div', { class: 'term-stream-notice', style: 'display:none' }, t('terminal.streamError'));
  const setStatus = (state: 'connecting' | 'connected' | 'reconnecting'): void => {
    statusEl.className = `term-status ${state}`;
    statusText.textContent = t(`agents.terminal.${state}`);
    streamNotice.style.display = state === 'reconnecting' ? '' : 'none';
  };

  // only auto-scroll to the bottom when the operator is already pinned there; if
  // they scrolled up to read history, a new frame must NOT yank them back down.
  let pinned = true;
  screen.addEventListener('scroll', () => {
    pinned = screen.scrollTop + screen.clientHeight >= screen.scrollHeight - 30;
  });
  const stickToBottom = (): void => { if (pinned) screen.scrollTop = screen.scrollHeight; };

  const input = h('input', { type: 'text', placeholder: t('agents.terminal.inputPlaceholder') }) as HTMLInputElement;

  const es = openStream(`/api/agents/${encodeURIComponent(agentId)}/stream`);
  // connected on open / each frame; reconnecting only after a prior connect (helper)
  const { markFrame } = wireStreamStatus(es, setStatus);
  const onEvent = (ev: Event): void => {
    const raw = (ev as MessageEvent<string>).data;
    let payload: { text?: string };
    try {
      payload = JSON.parse(raw) as { text?: string };
    } catch {
      payload = { text: raw };
    }
    if (ev.type === 'screen') {
      if ((payload.text ?? '').trim() === '') return; // never blank a good view
      markFrame();
      screenMode = true;
      screen.textContent = stripOsc8(payload.text ?? '');
      stickToBottom();
    } else if (ev.type === 'output' && !screenMode) {
      if (payload.text) {
        markFrame();
        appendBuffer.push(stripOsc8(payload.text));
        screen.textContent = appendBuffer.join('');
        stickToBottom();
      }
    }
  };
  es.addEventListener('screen', onEvent);
  es.addEventListener('output', onEvent);
  // §6: surface the inline stream-error notice on SSE error/stop (a never-connected
  // error too — wireStreamStatus only flips to reconnecting after a first connect).
  es.addEventListener('error', () => { streamNotice.style.display = ''; });

  const backdrop = h('div', { class: 'modal-backdrop' });
  const close = (): void => {
    es.close();
    resizeObserver?.disconnect();
    window.clearTimeout(refitTimer);
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    document.body.classList.remove('modal-open');
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close();
  };
  document.addEventListener('keydown', onKey);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });

  const send = async (): Promise<void> => {
    const text = input.value;
    if (text.trim() === '') return;
    try {
      await api.post(`/api/agents/${encodeURIComponent(agentId)}/input`, { text });
      input.value = '';
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t('agents.error'), true);
    }
  };

  // forward allow-listed special/control keys straight to the live pane (FIX-03
  // §3); Enter/Backspace stay LOCAL while the box has text (type + edit + submit).
  const sendKey = async (key: string): Promise<void> => {
    try {
      await api.post(`/api/agents/${encodeURIComponent(agentId)}/input`, { key });
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t('agents.error'), true);
    }
  };
  input.addEventListener('keydown', (e: KeyboardEvent) => {
    const name = tmuxKey(e);
    if (name === null) return;
    // Enter/BSpace stay local while composing; a digit also composes into a
    // non-empty line (so "cd dir5" still types) but forwards as a keystroke when
    // the box is empty, so an empty box answers a numbered picker (#69).
    if ((name === 'Enter' || name === 'BSpace' || /^[0-9]$/.test(name)) && input.value !== '') return;
    e.preventDefault();
    void sendKey(name);
  });

  // forward a literal printable character verbatim (no submit) — raw keystrokes (§6)
  const sendLiteral = async (literal: string): Promise<void> => {
    try {
      await api.post(`/api/agents/${encodeURIComponent(agentId)}/input`, { literal });
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t('agents.error'), true);
    }
  };
  // the screen itself is a focusable keystroke surface: a real terminal where every
  // keypress forwards to the live pane — named special/control keys as tokens, a
  // single printable char as a literal. (The input box stays for line composing.)
  screen.addEventListener('keydown', (e: KeyboardEvent) => {
    const name = tmuxKey(e);
    // stopPropagation so a forwarded Escape reaches the pane instead of also
    // tripping the modal's global Escape-to-close (✕ / backdrop still close).
    if (name !== null) { e.preventDefault(); e.stopPropagation(); void sendKey(name); return; }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); e.stopPropagation(); void sendLiteral(e.key); }
  });

  // §6: debounced refit — keep the view pinned to the bottom as the modal resizes.
  let refitTimer = 0;
  const refit = (): void => { window.clearTimeout(refitTimer); refitTimer = window.setTimeout(() => stickToBottom(), 120); };
  const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => refit()) : null;
  resizeObserver?.observe(screen);

  backdrop.append(
    h(
      'div',
      { class: 'modal terminal-modal' },
      h(
        'div',
        { class: 'agent-modal-titlebar' },
        h('h2', null, `${displayName} ${t('terminal.titleSuffix')}`),
        statusEl,
        h('button', { class: 'icon-btn', 'aria-label': t('terminal.close'), onclick: close }, '✕'),
      ),
      screen,
      streamNotice,
      h(
        'form',
        {
          class: 'term-input',
          onsubmit: (e: Event) => {
            e.preventDefault();
            void send();
          },
        },
        input,
        h('button', { class: 'primary', type: 'submit' }, t('agents.terminal.send')),
      ),
    ),
  );
  document.body.append(backdrop);
  document.body.classList.add('modal-open');
  input.focus();
}
