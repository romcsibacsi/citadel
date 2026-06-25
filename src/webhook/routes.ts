// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import type { Router } from '../server/router.js';
import { HttpError, requireOperator, sendJson } from '../server/router.js';
import type { AppContext } from '../app/context.js';
import { sanitizeId } from '../trust/sanitize.js';
import { agentPaths } from '../app/scaffold.js';
import { isoNow } from '../core/clock.js';
import {
  readHooks, writeHooks, findHook, readTargets, writeTargets,
  readOutboundAllowlist, hookSecret, hookSecretVaultId, targetSecretVaultId,
  isValidWebhookId, WEBHOOK_EVENT_KINDS,
  type WebhookHook, type WebhookTarget, type WebhookMapping, type WebhookEventKind,
} from './config.js';
import { dispatchMapping, type WebhookActions } from './mapping.js';
import { HookRateLimiter, verifySignature, SIGNATURE_HEADER } from './inbound.js';
import { postToTarget } from './events.js';
import { SsrfError } from '../tools/ssrf.js';
import { createLogger } from '../core/log.js';

const log = createLogger('webhook.routes');

/**
 * Generic-webhook HTTP surface (FIX-plugin-webhook).
 *
 *  - INBOUND  POST /api/plugins/webhook/in/:hookId — PUBLIC path (NOT the dashboard
 *    bearer); self-authenticated by a per-hook HMAC over the RAW body (rawBody:true)
 *    + a per-hook rate limit. A bad/missing signature is 401. On success the hook's
 *    declarative mapping runs ONE action; the payload is treated as untrusted data.
 *  - CONFIG   GET/PUT/DELETE /api/plugins/webhook/hooks[/:id] and …/targets[/:name]
 *    + GET/PUT …/allowlist — all operator-gated. Secrets (a hook's HMAC secret, a
 *    target's auth-header secret) are written to the VAULT, never to settings, and
 *    never returned.
 *
 * The integrator must add the inbound prefix to AUTH_POLICY.publicPaths (see the
 * manifest) — the handler self-auths, so the global bearer gate must let it past.
 */

/** Max inbound webhook body — a PUBLIC pre-auth endpoint must not buffer an
 *  unbounded body in memory (DoS). 256 KiB is ample for any mapped payload. */
const MAX_WEBHOOK_BODY = 256 * 1024;
class BodyTooLarge extends Error {}

/** Read the raw request body, BOUNDED (rawBody routes are not pre-parsed/capped). */
async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    const buf = c as Buffer;
    total += buf.length;
    if (total > MAX_WEBHOOK_BODY) { req.destroy(); throw new BodyTooLarge(); }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/** Build the real action sinks from the live AppContext. */
function makeActions(ctx: AppContext): WebhookActions {
  return {
    createKanbanCard: (input) => ctx.kanban.create(input),
    messageAgent: (input) => {
      const recipient = sanitizeId(input.agentId);
      const known = ctx.config.agents.some((a) => sanitizeId(a.id) === recipient);
      if (!known) throw new Error(`unknown agent: ${recipient}`);
      const id = ctx.messages.enqueue({ sender: `webhook-${recipient}`.slice(0, 64), recipient, body: input.body });
      return { id };
    },
    createIdea: (input) => ctx.ideas.create({ title: input.title, ...(input.description !== undefined ? { description: input.description } : {}) }),
    appendDailyLog: (input) => {
      const recipient = sanitizeId(input.agentId);
      const known = ctx.config.agents.some((a) => sanitizeId(a.id) === recipient);
      if (!known) throw new Error(`unknown agent: ${recipient}`);
      const dir = agentPaths(ctx.paths, recipient).workDir;
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, 'daily-log.md'), `\n## ${isoNow()} (webhook)\n${input.line}\n`, { mode: 0o600 });
    },
  };
}

export function registerWebhookRoutes(router: Router, ctx: AppContext): void {
  const limiter = new HookRateLimiter();
  const actions = makeActions(ctx);

  // ---------------- INBOUND (public + self-authed) ----------------
  router.register('POST', '/api/plugins/webhook/in/:hookId', async (c) => {
    const hookId = sanitizeId(c.params.hookId ?? '');
    // Rate-limit FIRST, BEFORE the body read + HMAC — a bad actor who guesses the URL
    // must not be a free amplifier (an unsigned flood is throttled cheaply, not after a
    // full body buffer + HMAC compute).
    if (!limiter.allow(hookId)) throw new HttpError(429, 'rate limit exceeded for this hook');
    const hook = hookId === '' ? undefined : findHook(ctx.settings, hookId);
    // do not reveal whether a hook exists before auth: a wrong sig is 401 either way.
    let raw: Buffer;
    try {
      raw = await readRawBody(c.req);
    } catch (err) {
      if (err instanceof BodyTooLarge) throw new HttpError(413, 'webhook body too large');
      throw err;
    }
    const sigHeader = c.req.headers[SIGNATURE_HEADER];
    const presented = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
    const secret = hook === undefined ? undefined : hookSecret(ctx.vault, hookId);
    if (!verifySignature(secret, raw, presented)) {
      throw new HttpError(401, 'invalid or missing webhook signature');
    }
    // hook is defined here (verify failed-closed when secret/hook absent)

    let payload: unknown;
    try {
      payload = raw.length === 0 ? {} : JSON.parse(raw.toString('utf8'));
    } catch {
      throw new HttpError(400, 'invalid JSON body');
    }
    try {
      const result = dispatchMapping(hookId, (hook as WebhookHook).mapping, payload, actions);
      sendJson(c.res, 200, { ok: true, action: result.action, ...(result.ref !== undefined ? { ref: result.ref } : {}) });
    } catch (err) {
      log.warn('inbound webhook mapping failed', { hook: hookId, error: String(err) });
      throw new HttpError(400, err instanceof Error ? err.message : 'mapping failed');
    }
  }, { rawBody: true });

  // ---------------- CONFIG: hooks (operator-gated) ----------------
  // Metadata only — never the secret value.
  router.get('/api/plugins/webhook/hooks', (c) => {
    requireOperator(c);
    const hooks = readHooks(ctx.settings).map((h) => ({
      id: h.id,
      mapping: h.mapping,
      secretConfigured: hookSecret(ctx.vault, h.id) !== undefined,
    }));
    sendJson(c.res, 200, { hooks });
  });

  router.put('/api/plugins/webhook/hooks/:id', (c) => {
    requireOperator(c);
    const id = sanitizeId(c.params.id ?? '');
    if (!isValidWebhookId(id)) throw new HttpError(400, 'invalid hook id (lowercase slug)');
    const body = (c.body ?? {}) as { mapping?: unknown; secret?: string };
    const mapping = body.mapping as WebhookMapping | undefined;
    if (mapping === undefined || typeof mapping !== 'object') throw new HttpError(400, 'mapping required');
    if (!['kanban_card', 'agent_message', 'idea', 'daily_log'].includes(mapping.action)) {
      throw new HttpError(400, `invalid mapping action: ${String(mapping.action)}`);
    }
    const hooks = readHooks(ctx.settings).filter((h) => h.id !== id);
    const next: WebhookHook = { id, mapping };
    hooks.push(next);
    writeHooks(ctx.settings, hooks);
    // a secret, when supplied, is written ENCRYPTED to the vault (never to settings)
    if (typeof body.secret === 'string' && body.secret !== '') {
      ctx.vault.setSecret(hookSecretVaultId(id), `webhook hook ${id} HMAC secret`, body.secret);
    }
    sendJson(c.res, 200, { id, mapping, secretConfigured: hookSecret(ctx.vault, id) !== undefined });
  });

  router.delete('/api/plugins/webhook/hooks/:id', (c) => {
    requireOperator(c);
    const id = sanitizeId(c.params.id ?? '');
    const before = readHooks(ctx.settings);
    const after = before.filter((h) => h.id !== id);
    if (after.length === before.length) throw new HttpError(404, `no such hook: ${id}`);
    writeHooks(ctx.settings, after);
    ctx.vault.deleteSecret(hookSecretVaultId(id));
    sendJson(c.res, 200, { deleted: true });
  });

  // ---------------- CONFIG: targets (operator-gated) ----------------
  router.get('/api/plugins/webhook/targets', (c) => {
    requireOperator(c);
    const targets = readTargets(ctx.settings).map((t) => ({
      name: t.name,
      url: t.url,
      events: t.events,
      ...(t.authHeader !== undefined ? { authHeader: t.authHeader } : {}),
      secretConfigured: ctx.vault.getSecretValue(targetSecretVaultId(t.name)) !== undefined,
    }));
    sendJson(c.res, 200, { targets, eventKinds: WEBHOOK_EVENT_KINDS });
  });

  router.put('/api/plugins/webhook/targets/:name', (c) => {
    requireOperator(c);
    const name = sanitizeId(c.params.name ?? '');
    if (!isValidWebhookId(name)) throw new HttpError(400, 'invalid target name (lowercase slug)');
    const body = (c.body ?? {}) as { url?: string; events?: unknown; authHeader?: string; secret?: string };
    const url = (body.url ?? '').trim();
    if (url === '') throw new HttpError(400, 'url required');
    if (!/^https?:\/\//i.test(url)) throw new HttpError(400, 'url must be http(s)');
    const known = new Set<string>(WEBHOOK_EVENT_KINDS);
    const events = Array.isArray(body.events)
      ? body.events.filter((e): e is WebhookEventKind => typeof e === 'string' && known.has(e))
      : [];
    const target: WebhookTarget = { name, url, events };
    const authHeader = (body.authHeader ?? '').trim();
    if (authHeader !== '') target.authHeader = authHeader.toLowerCase();
    const targets = readTargets(ctx.settings).filter((t) => t.name !== name);
    targets.push(target);
    writeTargets(ctx.settings, targets);
    if (typeof body.secret === 'string' && body.secret !== '') {
      ctx.vault.setSecret(targetSecretVaultId(name), `webhook target ${name} auth secret`, body.secret);
    }
    sendJson(c.res, 200, { name, url, events, ...(target.authHeader !== undefined ? { authHeader: target.authHeader } : {}) });
  });

  router.delete('/api/plugins/webhook/targets/:name', (c) => {
    requireOperator(c);
    const name = sanitizeId(c.params.name ?? '');
    const before = readTargets(ctx.settings);
    const after = before.filter((t) => t.name !== name);
    if (after.length === before.length) throw new HttpError(404, `no such target: ${name}`);
    writeTargets(ctx.settings, after);
    ctx.vault.deleteSecret(targetSecretVaultId(name));
    sendJson(c.res, 200, { deleted: true });
  });

  // Operator test-fire: POST to a named target now (SSRF-guarded), to confirm wiring.
  router.post('/api/plugins/webhook/targets/:name/test', async (c) => {
    requireOperator(c);
    const name = sanitizeId(c.params.name ?? '');
    try {
      const r = await postToTarget(name, { event: 'test', data: { at: isoNow() } }, { settings: ctx.settings, vault: ctx.vault });
      sendJson(c.res, 200, { status: r.status, ok: r.ok });
    } catch (err) {
      if (err instanceof SsrfError) throw new HttpError(400, `blocked by the SSRF guard: ${err.message}`);
      throw new HttpError(502, err instanceof Error ? err.message : 'target POST failed');
    }
  });

  // ---------------- CONFIG: outbound SSRF allowlist (operator-gated) ----------------
  router.get('/api/plugins/webhook/allowlist', (c) => {
    requireOperator(c);
    sendJson(c.res, 200, { allowlist: readOutboundAllowlist(ctx.settings) });
  });
  router.put('/api/plugins/webhook/allowlist', (c) => {
    requireOperator(c);
    const body = (c.body ?? {}) as { allowlist?: string };
    ctx.settings.set('webhook-outbound-allowlist', typeof body.allowlist === 'string' ? body.allowlist : '');
    sendJson(c.res, 200, { allowlist: readOutboundAllowlist(ctx.settings) });
  });
}
