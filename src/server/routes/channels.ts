// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import type { Router } from '../router.js';
import { HttpError, requireOperator, sendJson } from '../router.js';
import type { AppContext } from '../../app/context.js';
import { sanitizeId } from '../../trust/sanitize.js';
import { CHANNEL_PROVIDERS, channelProvider } from '../../channels/registry.js';

export function registerChannelRoutes(router: Router, ctx: AppContext): void {
  router.get('/api/channels/status', (c) => {
    requireOperator(c);
    const tg = ctx.config.channels.telegram;
    const dc = ctx.config.channels.discord;
    const sl = ctx.config.channels.slack;
    const tokenSet = (ref: string | undefined): boolean =>
      ref !== undefined && ref !== '' && ctx.vault.resolveRef(ref) !== undefined;
    sendJson(c.res, 200, {
      telegram: tg
        ? {
            enabled: tg.enabled,
            connected: ctx.telegram !== undefined,
            listening: ctx.telegram?.isListening() ?? false,
            tokenConfigured: tokenSet(tg.tokenRef),
            operatorChatId: tg.operatorChatId ?? '',
          }
        : null,
      discord: dc
        ? {
            enabled: dc.enabled,
            connected: ctx.discord !== undefined,
            listening: ctx.discord?.isListening() ?? false,
            tokenConfigured: tokenSet(dc.botTokenRef),
            operatorChatId: dc.operatorChatId ?? '',
          }
        : null,
      slack: sl
        ? {
            enabled: sl.enabled,
            connected: ctx.slack !== undefined,
            listening: ctx.slack?.isListening() ?? false,
            tokenConfigured: tokenSet(sl.botTokenRef) && tokenSet(sl.appTokenRef),
            operatorChatId: sl.operatorChatId ?? '',
          }
        : null,
    });
  });

  /**
   * Bind/update the Telegram channel. A raw token is stored INTO THE VAULT and
   * only the vault ref lands in config (SPEC §16 — never plaintext on disk).
   * Enabling/disabling takes effect at the next supervisor start (documented).
   */
  router.post('/api/channels/telegram', (c) => {
    requireOperator(c);
    const body = (c.body ?? {}) as { enabled?: boolean; token?: string; operatorChatId?: string };
    if (typeof body.token === 'string' && body.token !== '') {
      ctx.vault.setSecret('telegram-bot-token', 'Telegram bot token', body.token);
    }
    ctx.saveConfig((cfg) => {
      const existing = cfg.channels.telegram ?? { enabled: false, tokenRef: 'vault:telegram-bot-token' };
      cfg.channels.telegram = {
        ...existing,
        enabled: body.enabled ?? existing.enabled,
        tokenRef: existing.tokenRef !== '' ? existing.tokenRef : 'vault:telegram-bot-token',
        ...(body.operatorChatId !== undefined ? { operatorChatId: body.operatorChatId } : {}),
      };
    });
    sendJson(c.res, 200, { saved: true, restartRequired: true });
  });

  router.post('/api/channels/telegram/test', async (c) => {
    requireOperator(c);
    if (!ctx.telegram) throw new HttpError(409, 'telegram channel is not active in this run');
    sendJson(c.res, 200, { ok: await ctx.telegram.validateToken() });
  });

  // Install-scope save for Slack/Discord (FIX-plugin-channels-slack-discord): tokens go
  // INTO THE VAULT, only vault refs land in config (SPEC §16). Takes effect on restart.
  router.post('/api/channels/slack', (c) => {
    requireOperator(c);
    const body = (c.body ?? {}) as { enabled?: boolean; botToken?: string; appToken?: string; teamId?: string; operatorChatId?: string };
    if (typeof body.botToken === 'string' && body.botToken !== '') ctx.vault.setSecret('slack-bot-token', 'Slack bot token', body.botToken);
    if (typeof body.appToken === 'string' && body.appToken !== '') ctx.vault.setSecret('slack-app-token', 'Slack app-level token', body.appToken);
    ctx.saveConfig((cfg) => {
      const existing = cfg.channels.slack ?? { enabled: false, botTokenRef: 'vault:slack-bot-token', appTokenRef: 'vault:slack-app-token' };
      cfg.channels.slack = {
        ...existing,
        enabled: body.enabled ?? existing.enabled,
        botTokenRef: existing.botTokenRef !== '' ? existing.botTokenRef : 'vault:slack-bot-token',
        appTokenRef: existing.appTokenRef !== '' ? existing.appTokenRef : 'vault:slack-app-token',
        ...(body.teamId !== undefined ? { teamId: body.teamId } : {}),
        ...(body.operatorChatId !== undefined ? { operatorChatId: body.operatorChatId } : {}),
      };
    });
    sendJson(c.res, 200, { saved: true, restartRequired: true });
  });

  router.post('/api/channels/discord', (c) => {
    requireOperator(c);
    const body = (c.body ?? {}) as { enabled?: boolean; botToken?: string; applicationId?: string; operatorChatId?: string };
    if (typeof body.botToken === 'string' && body.botToken !== '') ctx.vault.setSecret('discord-bot-token', 'Discord bot token', body.botToken);
    ctx.saveConfig((cfg) => {
      const existing = cfg.channels.discord ?? { enabled: false, botTokenRef: 'vault:discord-bot-token' };
      cfg.channels.discord = {
        ...existing,
        enabled: body.enabled ?? existing.enabled,
        botTokenRef: existing.botTokenRef !== '' ? existing.botTokenRef : 'vault:discord-bot-token',
        ...(body.applicationId !== undefined ? { applicationId: body.applicationId } : {}),
        ...(body.operatorChatId !== undefined ? { operatorChatId: body.operatorChatId } : {}),
      };
    });
    sendJson(c.res, 200, { saved: true, restartRequired: true });
  });

  // --- shared channel-management surface (FIX-channels) ---

  // The install-scope panel manages the HUB agent's channel; agent-scope passes its id.
  const effectiveAgent = (agentId: string | null): string => sanitizeId(agentId !== null && agentId !== '' ? agentId : ctx.config.hubId);
  const providerOrThrow = (raw: string): { id: string; implemented: boolean; supportsInvite: boolean } => {
    const info = channelProvider(sanitizeId(raw));
    if (info === undefined) throw new HttpError(404, 'unknown channel provider');
    return info;
  };
  // Live client for a runtime-backed provider (telegram/slack/discord), or undefined.
  const liveClient = (id: string): { validateToken(): Promise<boolean>; getIdentity?(): Promise<{ username: string; name: string } | null>; isListening?(): boolean; start(): void; stop(): Promise<void> } | undefined => {
    if (id === 'telegram') return ctx.telegram;
    if (id === 'slack') return ctx.slack;
    if (id === 'discord') return ctx.discord;
    return undefined;
  };
  const cfgEnabled = (p: string): boolean => {
    if (p === 'telegram') return ctx.config.channels.telegram?.enabled === true;
    if (p === 'slack') return ctx.config.channels.slack?.enabled === true;
    if (p === 'discord') return ctx.config.channels.discord?.enabled === true;
    return false;
  };

  // Provider capability map — drives the UI's provider dropdown + feature gating.
  router.get('/api/channels/providers', (c) => {
    requireOperator(c);
    sendJson(c.res, 200, { providers: CHANNEL_PROVIDERS });
  });

  // Full channel state for one provider (+ optional agent scope): connection,
  // bot identity, the bound-chats list, and pending pairings.
  router.get('/api/channels/:provider/state', async (c) => {
    requireOperator(c);
    const info = providerOrThrow(c.params.provider ?? '');
    const rawAgentId = c.url.searchParams.get('agentId');
    const installScope = rawAgentId === null;
    const agentId = effectiveAgent(rawAgentId);
    // "connected" = this provider is CONFIGURED for this scope (config-driven, so
    // it is meaningful without a live network probe). Identity is a best-effort
    // live lookup that may be null when the long-poll/credentials are unavailable.
    let identity: { username: string; name: string } | null = null;
    const client = liveClient(info.id);
    const connected = installScope
      ? cfgEnabled(info.id) || client !== undefined
      : ctx.config.agents.find((a) => sanitizeId(a.id) === agentId)?.channel?.provider === info.id;
    if (client?.getIdentity !== undefined) identity = await client.getIdentity().catch(() => null);
    const listening = client?.isListening?.() ?? false;
    sendJson(c.res, 200, {
      provider: info.id,
      implemented: info.implemented,
      supportsInvite: info.supportsInvite,
      connected,
      // run-state detail (FIX-channels-2 §5): is the long-poll loop live, and the
      // inbound is always dynamic-allowlist (default-deny → operator-approved chats)
      listening,
      allowlistMode: 'allowlist',
      identity,
      agentId,
      boundChats: ctx.channelBindings.listForAgent(agentId, info.id),
      pending: ctx.channelBindings.listPending(info.id),
      invites: ctx.channelBindings.listInvites(info.id),
    });
  });

  // Provider-aware connection test (the shared component always calls this; the
  // literal telegram/test route above wins for telegram, others 501 here).
  router.post('/api/channels/:provider/test', async (c) => {
    requireOperator(c);
    const info = providerOrThrow(c.params.provider ?? '');
    const client = liveClient(info.id);
    if (client === undefined) throw new HttpError(409, ctx.i18n.t('channels.error.notImplemented', { provider: info.id }));
    sendJson(c.res, 200, { ok: await client.validateToken() });
  });

  // Mint an invite link (Telegram only) AND persist it so the panel can list +
  // revoke it (FIX-channels-2 §1). 24h expiry; expired/revoked are surfaced as tags.
  router.post('/api/channels/:provider/invite', async (c) => {
    requireOperator(c);
    const info = providerOrThrow(c.params.provider ?? '');
    const body = (c.body ?? {}) as { chatId?: string; name?: string };
    if (!info.supportsInvite || ctx.telegram === undefined || ctx.telegram.createInviteLink === undefined) {
      throw new HttpError(501, ctx.i18n.t('channels.error.notImplemented', { provider: info.id }));
    }
    const chatId = (body.chatId ?? '').trim();
    if (chatId === '') throw new HttpError(400, 'chatId required');
    try {
      const expireSeconds = 86_400;
      const inviteLink = await ctx.telegram.createInviteLink(chatId, { expireSeconds });
      const expiresAt = new Date(Date.now() + expireSeconds * 1000).toISOString();
      const invite = ctx.channelBindings.recordInvite(info.id, chatId, inviteLink, { name: (body.name ?? '').trim(), expiresAt });
      sendJson(c.res, 200, { inviteLink, invite });
    } catch (err) {
      throw new HttpError(502, err instanceof Error ? err.message : 'invite link failed');
    }
  });

  // List minted invite links with their lifecycle status (FIX-channels-2 §1).
  router.get('/api/channels/:provider/invites', (c) => {
    requireOperator(c);
    const info = providerOrThrow(c.params.provider ?? '');
    sendJson(c.res, 200, { invites: ctx.channelBindings.listInvites(info.id) });
  });

  // Revoke one invite: revoke it on the provider (best-effort), then mark it locally.
  router.post('/api/channels/:provider/invites/:id/revoke', async (c) => {
    requireOperator(c);
    providerOrThrow(c.params.provider ?? '');
    const invite = ctx.channelBindings.getInvite(Number(c.params.id));
    if (invite === undefined) throw new HttpError(404, 'no such invite');
    if (ctx.telegram?.revokeInviteLink !== undefined) {
      try { await ctx.telegram.revokeInviteLink(invite.chatId, invite.link); } catch { /* mark revoked locally regardless */ }
    }
    ctx.channelBindings.revokeInvite(invite.id);
    sendJson(c.res, 200, { revoked: true });
  });

  // Reconnect a degraded channel (FIX-channels-2 §3): restart the long-poll loop.
  router.post('/api/channels/:provider/reconnect', async (c) => {
    requireOperator(c);
    const info = providerOrThrow(c.params.provider ?? '');
    const client = liveClient(info.id);
    if (client === undefined) throw new HttpError(409, `${info.id} channel is not active in this run`);
    await client.stop();
    client.start();
    sendJson(c.res, 200, { reconnected: true, listening: client.isListening?.() ?? false });
  });

  // Pending pairings for a provider (unknown chats that messaged the bot).
  router.get('/api/channels/:provider/pending', (c) => {
    requireOperator(c);
    const info = providerOrThrow(c.params.provider ?? '');
    sendJson(c.res, 200, { pending: ctx.channelBindings.listPending(info.id) });
  });

  // Approve a pending pairing by the operator-typed CODE (FIX-channels-2 §2). The
  // static 'approve-by-code' segment wins over the :id route below.
  router.post('/api/channels/:provider/pairing/approve-by-code', (c) => {
    requireOperator(c);
    providerOrThrow(c.params.provider ?? '');
    const body = (c.body ?? {}) as { code?: string; agentId?: string };
    const agentId = effectiveAgent(body.agentId ?? null);
    const bound = ctx.channelBindings.approvePairingByCode(body.code ?? '', agentId);
    if (bound === null) throw new HttpError(404, 'no pending pairing for that code');
    sendJson(c.res, 200, { approved: true, binding: bound });
  });

  // Approve a pending pairing -> promotes it to a bound chat for the (effective) agent.
  router.post('/api/channels/:provider/pairing/:id/approve', (c) => {
    requireOperator(c);
    providerOrThrow(c.params.provider ?? '');
    const body = (c.body ?? {}) as { agentId?: string };
    const agentId = effectiveAgent(body.agentId ?? null);
    const bound = ctx.channelBindings.approvePairing(Number(c.params.id), agentId);
    if (bound === null) throw new HttpError(404, 'no such pairing');
    sendJson(c.res, 200, { approved: true, binding: bound });
  });

  // Deny a pending pairing.
  router.post('/api/channels/:provider/pairing/:id/deny', (c) => {
    requireOperator(c);
    providerOrThrow(c.params.provider ?? '');
    if (!ctx.channelBindings.denyPairing(Number(c.params.id))) throw new HttpError(404, 'no such pending pairing');
    sendJson(c.res, 200, { denied: true });
  });

  // Remove one bound chat (refreshes the live inbound allowlist immediately).
  router.delete('/api/channels/:provider/bindings/:id', (c) => {
    requireOperator(c);
    providerOrThrow(c.params.provider ?? '');
    if (!ctx.channelBindings.removeBinding(Number(c.params.id))) throw new HttpError(404, 'no such binding');
    sendJson(c.res, 200, { removed: true });
  });
}
