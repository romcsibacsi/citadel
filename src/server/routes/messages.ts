// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import type { Router } from '../router.js';
import { HttpError, requireOperator, sendJson } from '../router.js';
import type { AppContext } from '../../app/context.js';
import { isReservedId, sanitizeId, OPERATOR_ID } from '../../trust/sanitize.js';

interface PostMessageBody {
  from?: string;
  to?: string;
  body?: string;
}

export function registerMessageRoutes(router: Router, ctx: AppContext): void {
  router.get('/api/messages/recent', ({ res, url }) => {
    const limit = Number(url.searchParams.get('limit') ?? 50);
    sendJson(res, 200, ctx.messages.recent(Number.isFinite(limit) ? limit : 50));
  });

  router.get('/api/messages/threads/:agentId', (c) => {
    sendJson(c.res, 200, ctx.messages.threads(sanitizeId(c.params.agentId ?? '')));
  });

  /**
   * System-wide: ALL peer-pair threads (incl. agent↔agent), for the operator's
   * Inter-agent / System messages view. Operator-only — an agent token must not get
   * the whole-system traffic list. Per-pair detail reuses /api/messages/conversation.
   */
  router.get('/api/messages/all-threads', (c) => {
    requireOperator(c);
    sendJson(c.res, 200, ctx.messages.allThreads());
  });

  router.get('/api/messages/conversation', ({ res, url }) => {
    const agent = sanitizeId(url.searchParams.get('agent') ?? '');
    const peer = sanitizeId(url.searchParams.get('peer') ?? '');
    if (agent === '' || peer === '') throw new HttpError(400, 'agent and peer required');
    const beforeRaw = url.searchParams.get('beforeId');
    const limitRaw = Number(url.searchParams.get('limit') ?? 50);
    sendJson(
      res,
      200,
      ctx.messages.conversation(agent, peer, {
        ...(beforeRaw !== null ? { beforeId: Number(beforeRaw) } : {}),
        limit: Number.isFinite(limitRaw) ? limitRaw : 50,
      }),
    );
  });

  /**
   * The public write endpoint (SPEC §6). `from` here is self-asserted:
   *  - agent tokens OVERRIDE it with the authenticated agent id;
   *  - reserved-sanitizing ids are rejected 403 BEFORE anything else;
   *  - the operator has their own endpoint below.
   */
  router.post('/api/messages', (c) => {
    const body = (c.body ?? {}) as PostMessageBody;
    if (typeof body.to !== 'string' || typeof body.body !== 'string' || body.body === '') {
      throw new HttpError(400, 'to and body required');
    }
    let from: string;
    if (c.auth.kind === 'agent') {
      // server-side stamping beats self-assertion; defense in depth: even a
      // (config-rejected) reserved agent identity can never pass this branch
      if (isReservedId(c.auth.agentId)) throw new HttpError(403, 'reserved sender id');
      from = c.auth.agentId;
    } else {
      if (typeof body.from !== 'string' || sanitizeId(body.from) === '') throw new HttpError(400, 'from required');
      if (isReservedId(body.from)) throw new HttpError(403, 'reserved sender id'); // the §6 write-guard
      from = body.from;
    }
    const id = ctx.messages.enqueue({ sender: from, recipient: body.to, body: body.body });
    sendJson(c.res, 201, { id });
  });

  /** Separate operator endpoint — stamps from=operator server-side (SPEC §6). */
  router.post('/api/messages/operator', (c) => {
    requireOperator(c);
    const body = (c.body ?? {}) as PostMessageBody;
    if (typeof body.to !== 'string' || typeof body.body !== 'string' || body.body === '') {
      throw new HttpError(400, 'to and body required');
    }
    const id = ctx.messages.enqueue({ sender: OPERATOR_ID, recipient: body.to, body: body.body });
    sendJson(c.res, 201, { id });
  });

  /** Status reporting (agents mark their inbox handled). */
  router.post('/api/messages/:id/status', (c) => {
    const id = Number(c.params.id);
    const body = (c.body ?? {}) as { status?: string; result?: string; error?: string };
    const row = ctx.messages.get(id);
    if (!row) throw new HttpError(404, 'no such message');
    // an agent may only update messages addressed to itself
    if (c.auth.kind === 'agent' && sanitizeId(row.recipient) !== sanitizeId(c.auth.agentId)) {
      throw new HttpError(403, 'not your message');
    }
    if (body.status === 'done') {
      ctx.messages.markDone(id, body.result);
    } else if (body.status === 'failed') {
      ctx.messages.markFailed(id, body.error ?? 'failed');
    } else {
      throw new HttpError(400, 'status must be done or failed');
    }
    sendJson(c.res, 200, { id, status: body.status });
  });
}
