// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * Shared channel-management panel (FIX-channels). Mounted in BOTH Settings →
 * Channels and the agent-detail Channel tab — one implementation, two scopes:
 *
 *  - scope 'install' manages the hub agent's channel (the install-level bot).
 *  - scope 'agent' manages one agent's channel.
 *
 * Connected: bot identity + bound chats (remove) + invite + pending pairings
 * (approve/deny) + footer actions. Not-connected: provider-specific setup
 * instructions + token form. Providers come from the backend capability map, so
 * an unwired provider (Discord/Slack) shows honestly rather than faking a link.
 * Polls ~4s for live pending/bound updates, but never while an input has focus.
 */

import { h, mount } from '../dom.js';
import { t } from '../i18n.js';
import { api, ApiError } from '../api.js';
import { icon } from '../icons.js';
import { toast } from '../toast.js';
import { pollWhileMounted } from '../poll.js';

interface ProviderInfo { id: string; implemented: boolean; supportsInvite: boolean }
interface BoundChat { id: number; chatId: string; label: string; kind: 'dm' | 'group' }
interface Pending { id: number; chatId: string; user: string; code: string }
interface Invite { id: number; chatId: string; link: string; name: string; status: 'active' | 'expired' | 'revoked' }
interface ChannelState {
  provider: string; implemented: boolean; supportsInvite: boolean; connected: boolean;
  listening?: boolean; allowlistMode?: string;
  identity: { username: string; name: string } | null; agentId: string;
  boundChats: BoundChat[]; pending: Pending[]; invites?: Invite[];
}

export interface ChannelPanelOpts {
  scope: 'install' | 'agent';
  agentId?: string;
  /** Called after a mutation so a host (e.g. the agent modal) can refresh itself. */
  onChange?: () => void;
}

/** Per-mount state (each mount picks its own provider — no cross-panel leak). */
interface PanelState { provider: string }

function fieldRow(labelKey: string, control: HTMLElement, note?: string): HTMLElement {
  return h('div', { class: 'field' }, h('label', null, t(labelKey)), control, note ? h('div', { class: 'field-note' }, note) : null);
}

function setupSteps(provider: string): HTMLElement {
  const raw = t(`channels.setup.${provider}`);
  const steps = raw.split('\n').filter((s) => s.trim() !== '');
  return h('ol', { class: 'chan-setup' }, ...steps.map((s) => h('li', null, s)));
}

export function mountChannelPanel(host: HTMLElement, opts: ChannelPanelOpts): void {
  const state: PanelState = { provider: 'telegram' };
  void renderPanel(host, opts, state);
  // ~4s live refresh, but never tear down while the operator is typing in the panel.
  pollWhileMounted(host, () => { if (!host.contains(document.activeElement)) void renderPanel(host, opts, state); }, 4000);
}

async function renderPanel(host: HTMLElement, opts: ChannelPanelOpts, state: PanelState): Promise<void> {
  let providers: ProviderInfo[] = [];
  try { providers = (await api.get<{ providers: ProviderInfo[] }>('/api/channels/providers')).providers; } catch { /* */ }
  if (providers.length > 0 && !providers.some((p) => p.id === state.provider)) state.provider = providers[0]!.id;

  const qs = opts.scope === 'agent' && opts.agentId ? `?agentId=${encodeURIComponent(opts.agentId)}` : '';
  let st: ChannelState | null = null;
  try { st = await api.get<ChannelState>(`/api/channels/${state.provider}/state${qs}`); } catch { /* */ }

  const provSel = h('select', {
    'aria-label': t('channels.provider.label'),
    onchange: (e: Event) => { state.provider = (e.target as HTMLSelectElement).value; void renderPanel(host, opts, state); },
  }, ...providers.map((p) => h('option', { value: p.id, selected: p.id === state.provider }, t(`channels.provider.${p.id}`)))) as HTMLSelectElement;

  const reload = (): void => { void renderPanel(host, opts, state); opts.onChange?.(); };
  const body = st !== null && st.connected ? connectedView(st, opts, reload) : notConnectedView(state.provider, providers, opts, reload);

  mount(host, h('div', { class: 'channel-panel' }, fieldRow('channels.provider.label', provSel), body));
}

function connectedView(st: ChannelState, opts: ChannelPanelOpts, reload: () => void): HTMLElement {
  const provider = st.provider;
  // --- bot identity + run-state detail (§5) ---
  const identity = h('div', { class: 'chan-identity' },
    h('span', { class: 'badge on' }, t('channels.connected')),
    st.identity?.username ? h('span', { class: 'mono chan-bot' }, `@${st.identity.username}`) : h('span', { class: 'muted-note' }, t('channels.identity.unknown')),
    h('span', { class: `badge ${st.listening ? 'on' : 'muted'}` }, t(st.listening ? 'channels.identity.listening' : 'channels.identity.notListening')),
    st.allowlistMode === 'allowlist' ? h('span', { class: 'badge muted', title: t('channels.identity.allowlistNote') }, t('channels.identity.allowlist')) : null,
  );

  // --- bound chats ---
  const removeChat = async (id: number): Promise<void> => {
    if (!window.confirm(t('channels.boundChats.removeConfirm'))) return;
    try { await api.delete(`/api/channels/${provider}/bindings/${id}`); toast(t('channels.boundChats.removed')); reload(); }
    catch (err) { toast(err instanceof ApiError ? err.message : String(err), true); }
  };
  const boundList = st.boundChats.length === 0
    ? h('div', { class: 'muted-note' }, t('channels.boundChats.empty'))
    : h('div', { class: 'chan-list' }, ...st.boundChats.map((b) => h('div', { class: 'chan-row' },
        h('span', { class: `badge ${b.kind === 'group' ? 'chan-kind-group' : 'chan-kind-dm'}` }, t(b.kind === 'group' ? 'channels.kind.group' : 'channels.kind.dm')),
        h('span', { class: 'mono chan-chatid' }, b.chatId),
        b.label ? h('span', { class: 'chan-label' }, b.label) : null,
        h('button', { class: 'icon-btn danger', title: t('channels.boundChats.remove'), onclick: () => void removeChat(b.id) }, '✕'),
      )));

  // --- invite (supportsInvite only) ---
  // an invite link must target a REAL bound chat/group id (not the agent id),
  // so the operator picks which bound chat to mint a link for. The bot deep link
  // (from getIdentity) is shown as the DM-invite path when the username is known.
  const inviteWrap = h('div', { class: 'chan-invite-result' });
  const chatSel = h('select', { class: 'chan-invite-chat' }, ...st.boundChats.map((b) => h('option', { value: b.chatId }, b.label ? `${b.chatId} · ${b.label}` : b.chatId))) as HTMLSelectElement;
  const genInvite = async (): Promise<void> => {
    if (chatSel.value === '') { toast(t('channels.invite.needChat'), true); return; }
    try {
      const r = await api.post<{ inviteLink: string }>(`/api/channels/${provider}/invite`, { chatId: chatSel.value, agentId: opts.scope === 'agent' ? opts.agentId : undefined });
      const linkEl = h('input', { type: 'text', value: r.inviteLink, readonly: true, class: 'mono' }) as HTMLInputElement;
      mount(inviteWrap, linkEl, h('button', { class: 'btn-mini', onclick: () => { linkEl.select(); void navigator.clipboard?.writeText(r.inviteLink); toast(t('channels.invite.copied')); } }, t('channels.invite.copy')));
    } catch (err) { toast(err instanceof ApiError ? err.message : String(err), true); }
  };
  // existing invite links with lifecycle status + per-item revoke (§1)
  const revokeInvite = async (id: number): Promise<void> => {
    if (!window.confirm(t('channels.invite.revokeConfirm'))) return;
    try { await api.post(`/api/channels/${provider}/invites/${id}/revoke`, {}); toast(t('channels.invite.revoked')); reload(); }
    catch (err) { toast(err instanceof ApiError ? err.message : String(err), true); }
  };
  const invites = st.invites ?? [];
  const inviteList = invites.length === 0
    ? h('div', { class: 'muted-note' }, t('channels.invite.none'))
    : h('div', { class: 'chan-list chan-invite-list' }, ...invites.map((iv) => h('div', { class: 'chan-row' },
        h('span', { class: `badge invite-${iv.status}` }, t(`channels.invite.status.${iv.status}`)),
        h('span', { class: 'mono chan-chatid' }, iv.chatId),
        h('span', { class: 'chan-invite-link mono', title: iv.link }, iv.link.replace(/^https?:\/\//, '').slice(0, 28)),
        h('button', { class: 'btn-mini', title: t('channels.invite.copy'), onclick: () => { void navigator.clipboard?.writeText(iv.link); toast(t('channels.invite.copied')); } }, t('channels.invite.copy')),
        iv.status === 'active' ? h('button', { class: 'icon-btn danger', title: t('channels.invite.revoke'), onclick: () => void revokeInvite(iv.id) }, '✕') : null,
      )));
  const inviteSection = st.supportsInvite
    ? h('div', { class: 'chan-section chan-invite' },
        h('div', { class: 'sec-title' }, t('channels.invite.title'), h('button', { class: 'btn-mini chan-refresh', title: t('channels.invite.refresh'), onclick: () => reload() }, '↻')),
        st.identity?.username ? h('div', { class: 'field-note' }, t('channels.invite.deepLink'), ' ', h('span', { class: 'mono' }, `https://t.me/${st.identity.username}`)) : null,
        st.boundChats.length > 0
          ? h('div', { class: 'chan-invite-gen' }, chatSel, h('button', { class: 'btn-mini', onclick: () => void genInvite() }, t('channels.invite.generate')))
          : h('div', { class: 'muted-note' }, t('channels.invite.needChat')),
        inviteWrap,
        h('div', { class: 'chan-subtitle muted-note' }, t('channels.invite.list')),
        inviteList)
    : null;

  // --- pending pairings ---
  const approve = async (id: number): Promise<void> => {
    try { await api.post(`/api/channels/${provider}/pairing/${id}/approve`, { agentId: opts.scope === 'agent' ? opts.agentId : undefined }); toast(t('channels.pending.approved')); reload(); }
    catch (err) { toast(err instanceof ApiError ? err.message : String(err), true); }
  };
  const deny = async (id: number): Promise<void> => {
    try { await api.post(`/api/channels/${provider}/pairing/${id}/deny`, {}); toast(t('channels.pending.denied')); reload(); }
    catch (err) { toast(err instanceof ApiError ? err.message : String(err), true); }
  };
  const pendingList = st.pending.length === 0
    ? h('div', { class: 'muted-note' }, t('channels.pending.empty'))
    : h('div', { class: 'chan-list chan-pending' }, ...st.pending.map((p) => h('div', { class: 'chan-row' },
        p.code ? h('span', { class: 'badge mono chan-code' }, p.code) : null,
        h('span', { class: 'mono chan-chatid' }, p.chatId),
        p.user ? h('span', { class: 'chan-label' }, p.user) : null,
        h('button', { class: 'btn-mini primary', onclick: () => void approve(p.id) }, t('channels.pending.approve')),
        h('button', { class: 'btn-mini danger', onclick: () => void deny(p.id) }, t('channels.pending.deny')),
      )));
  // approve a pairing by the code the user was given (§2)
  const codeEl = h('input', { type: 'text', class: 'chan-code-input', autocomplete: 'off', placeholder: t('channels.pending.codePlaceholder') }) as HTMLInputElement;
  const approveByCode = async (): Promise<void> => {
    const code = codeEl.value.trim();
    if (code === '') { codeEl.focus(); return; }
    try { await api.post(`/api/channels/${provider}/pairing/approve-by-code`, { code, agentId: opts.scope === 'agent' ? opts.agentId : undefined }); toast(t('channels.pending.approved')); reload(); }
    catch (err) { toast(err instanceof ApiError ? err.message : String(err), true); }
  };
  const byCodeRow = h('div', { class: 'chan-bycode' }, codeEl, h('button', { class: 'btn-mini primary', onclick: () => void approveByCode() }, t('channels.pending.approveByCode')));

  // --- footer ---
  const testConn = async (): Promise<void> => {
    try { const r = await api.post<{ ok: boolean }>(`/api/channels/${provider}/test`, {}); toast(r.ok ? t('channels.test.ok') : t('channels.test.fail'), !r.ok); }
    catch (err) { toast(err instanceof ApiError ? err.message : String(err), true); }
  };
  const disconnect = async (): Promise<void> => {
    if (!window.confirm(t('channels.disconnectConfirm'))) return;
    try {
      if (opts.scope === 'agent' && opts.agentId) await api.delete(`/api/agents/${encodeURIComponent(opts.agentId)}/channel`);
      else await api.post('/api/channels/telegram', { enabled: false });
      toast(t('channels.disconnected')); reload();
    } catch (err) { toast(err instanceof ApiError ? err.message : String(err), true); }
  };
  // restart a degraded channel connection (§3) — distinct from Test/Disconnect
  const reconnect = async (): Promise<void> => {
    try { await api.post(`/api/channels/${provider}/reconnect`, {}); toast(t('channels.reconnected')); reload(); }
    catch (err) { toast(err instanceof ApiError ? err.message : String(err), true); }
  };

  return h('div', { class: 'chan-connected' },
    identity,
    h('div', { class: 'chan-section' },
      h('div', { class: 'sec-title' }, t('channels.boundChats'), h('button', { class: 'btn-mini chan-refresh', title: t('channels.boundChats.refresh'), onclick: () => reload() }, '↻')),
      boundList),
    inviteSection,
    h('div', { class: 'chan-section chan-pairing' },
      h('div', { class: 'sec-title' }, t('channels.pending.title'), h('button', { class: 'btn-mini chan-refresh', title: t('channels.pending.refresh'), onclick: () => reload() }, '↻')),
      h('div', { class: 'field-note' }, t('channels.pending.help')),
      pendingList,
      h('div', { class: 'chan-subtitle muted-note' }, t('channels.pending.byCode')),
      byCodeRow),
    h('div', { class: 'modal-actions chan-footer' },
      h('button', { onclick: () => void testConn() }, t('channels.test')),
      provider === 'telegram' ? h('button', { onclick: () => void reconnect() }, t('channels.reconnect')) : null,
      h('button', { class: 'danger', onclick: () => void disconnect() }, t('channels.disconnect')),
    ),
  );
}

function notConnectedView(provider: string, providers: ProviderInfo[], opts: ChannelPanelOpts, reload: () => void): HTMLElement {
  const info = providers.find((p) => p.id === provider);
  const tokenEl = h('input', { type: 'password', autocomplete: 'off', placeholder: t(`channels.token.placeholder.${provider}`) }) as HTMLInputElement;
  const chatEl = h('input', { type: 'text', autocomplete: 'off', placeholder: provider === 'discord' ? '123456789012345678' : t('channels.chatId.placeholder') }) as HTMLInputElement;

  const connect = async (e: Event): Promise<void> => {
    const btn = e.currentTarget as HTMLButtonElement;
    btn.disabled = true; btn.textContent = t('channels.connecting');
    try {
      if (opts.scope === 'install' && (provider === 'telegram' || provider === 'slack' || provider === 'discord')) {
        // Slack/Discord now have a real runtime (FIX-plugin-channels-slack-discord); their tokens
        // go to the vault server-side. Telegram uses `token`; slack/discord use `botToken`.
        const path = `/api/channels/${provider}`;
        if (provider === 'telegram') {
          await api.post(path, { enabled: true, token: tokenEl.value, ...(chatEl.value ? { operatorChatId: chatEl.value } : {}) });
        } else {
          await api.post(path, { enabled: true, botToken: tokenEl.value, ...(chatEl.value ? { operatorChatId: chatEl.value } : {}) });
        }
      } else {
        if (!opts.agentId) throw new Error('no agent');
        await api.put(`/api/agents/${encodeURIComponent(opts.agentId)}/channel`, { provider, ...(chatEl.value ? { chatId: chatEl.value } : {}), ...(tokenEl.value ? { token: tokenEl.value } : {}) });
      }
      toast(t('channels.connected')); reload();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : String(err), true);
      btn.disabled = false; btn.textContent = t('channels.connect');
    }
  };

  // a provider with no runtime in this build is shown honestly (setup + a notice),
  // and connect is still offered per-agent for Discord (config binding exists).
  // Slack inbound is NOT wired (implemented:false) → no Connect, the notImplemented
  // notice shows instead of silently no-op'ing inbound (FIX-release-gaps).
  const canConnect = info?.implemented === true || (provider === 'discord' && opts.scope === 'agent');
  return h('div', { class: 'chan-notconnected' },
    h('div', { class: 'chan-section chan-setup-wrap' },
      h('div', { class: 'sec-title' }, t(`channels.setup.title.${provider}`)),
      setupSteps(provider)),
    info?.implemented === false ? h('div', { class: 'notice warn chan-notimpl' }, t('channels.notImplemented', { provider })) : null,
    fieldRow(`channels.token.label.${provider}`, tokenEl),
    opts.scope === 'install'
      ? fieldRow('channels.operatorChatId', chatEl, t('channels.operatorChatId.note'))
      : (provider === 'discord' ? fieldRow('channels.channelId', chatEl) : fieldRow('channels.chatId', chatEl, t('channels.chatId.note'))),
    h('div', { class: 'modal-actions' },
      h('button', { class: 'primary', disabled: !canConnect, onclick: (e: Event) => void connect(e) }, icon('plug', 14), t('channels.connect')),
    ),
  );
}
