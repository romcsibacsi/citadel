// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import type { Router } from '../router.js';
import { HttpError, requireOperator, sendJson } from '../router.js';
import { openSseStream } from '../sse.js';
import type { AppContext } from '../../app/context.js';
import type { AgentConfig } from '../../config/types.js';
import { sanitizeId, isReservedId } from '../../trust/sanitize.js';
import { evaluateSpawn } from '../../security/gate.js';
import { isoNow } from '../../core/clock.js';
import { KEY_ALLOW_LIST } from '../../runtime/supervisor.js';
import { ensureSharedSubscriptionAuth, readSharedAuthStatus } from '../../runtime/claude/adapter.js';
import { agentPaths } from '../../app/scaffold.js';
import { stateFromStatus } from '../activitySampler.js';

function profileLevel(ctx: AppContext, profileId: string): 0 | 1 | 2 | 3 {
  const profile = ctx.config.securityProfiles.find((p) => p.id === profileId);
  if (!profile) throw new HttpError(400, `unknown security profile: ${profileId}`);
  return profile.privilegeLevel;
}

function agentOrThrow(ctx: AppContext, rawId: string): AgentConfig {
  const id = sanitizeId(rawId);
  const agent = ctx.config.agents.find((a) => sanitizeId(a.id) === id);
  if (!agent) throw new HttpError(404, `unknown agent: ${id}`);
  return agent;
}

/** Extract the OAuth URL a login flow prints, preferring an auth-looking link. */
function extractAuthUrl(screen: string | null): string | null {
  if (screen === null) return null;
  const urls = screen.match(/https?:\/\/[^\s"'<>`]+/g);
  if (urls === null || urls.length === 0) return null;
  const pick = urls.find((u) => /oauth|auth|login|claude|anthropic/i.test(u)) ?? urls[0]!;
  // strip trailing sentence punctuation the greedy class may have swallowed
  return pick.replace(/[.,;:)\]}>'"]+$/, '');
}

interface CreateAgentBody {
  id?: string;
  displayName?: string;
  role?: string;
  securityProfile?: string;
  accentColor?: string;
  model?: string;
  reportsTo?: string;
}

function buildAgentConfig(ctx: AppContext, body: CreateAgentBody): AgentConfig {
  const id = sanitizeId(body.id ?? '');
  if (id === '') throw new HttpError(400, 'agent id required');
  if (isReservedId(id)) throw new HttpError(403, 'reserved id');
  if (ctx.config.agents.some((a) => sanitizeId(a.id) === id)) throw new HttpError(409, 'agent id already exists');
  const securityProfile = body.securityProfile ?? 'sandbox';
  return {
    id,
    displayName: body.displayName?.trim() !== '' && body.displayName !== undefined ? body.displayName : id.toUpperCase(),
    role: body.role ?? 'Specialist',
    securityProfile,
    accentColor: body.accentColor ?? '#888888',
    authMode: 'shared-subscription',
    channel: null,
    ...(body.model !== undefined ? { model: body.model } : {}),
    team: {
      role: 'specialist',
      reportsTo: body.reportsTo ?? ctx.config.hubId,
      delegatesTo: [],
      trustFrom: [ctx.config.hubId],
    },
  };
}

function createAgent(ctx: AppContext, agent: AgentConfig): void {
  ctx.saveConfig((cfg) => {
    cfg.agents.push(agent);
  });
  ctx.scaffoldAgent(agent.id);
  ctx.desired.setDesired(agent.id, 'stopped');
}

async function agentSummary(ctx: AppContext, agent: AgentConfig): Promise<Record<string, unknown>> {
  let running = false;
  let busyState = 'busy';
  let needsReauth = false;
  try {
    // statusFast: TTL-cached + per-agent timeout so one hung agent can't stall the
    // whole 15-agent list, and the fleet/overview polls dedupe probes (FIX-agents-list-perf).
    // A generous TTL here rides the background sampler's warm cache (FIX-activity-sampler):
    // the sampler force-refreshes every ~5s, so the list serves the warm value instantly
    // instead of re-capturing 15 panes per request; start/stop still invalidate for correctness.
    const status = await ctx.supervisor.statusFast(agent.id, { ttlMs: 9000 });
    running = status.running;
    busyState = status.busyState;
    needsReauth = status.needsReauth || status.busyState === 'reauth-needed';
  } catch {
    /* adapter unavailable: report down */
  }
  return {
    id: agent.id,
    displayName: agent.displayName,
    role: agent.role,
    accentColor: agent.accentColor,
    securityProfile: agent.securityProfile,
    model: agent.model ?? null,
    team: agent.team,
    channel: agent.channel ?? null,
    running,
    busyState,
    needsReauth,
    desired: ctx.desired.getDesired(agent.id),
    isHub: sanitizeId(agent.id) === sanitizeId(ctx.config.hubId),
    isSeed: ctx.seedAgentIds.has(sanitizeId(agent.id)),
  };
}

export function registerAgentRoutes(router: Router, ctx: AppContext): void {
  router.get('/api/agents', async ({ res }) => {
    const visible = ctx.config.agents.filter((a) => a.hidden !== true);
    sendJson(res, 200, await Promise.all(visible.map((a) => agentSummary(ctx, a))));
  });

  // Live fleet status board (PROMPT-21): hub first, per-agent state + output tail.
  // Activity board: served from the background sampler's precomputed snapshot (instant) —
  // never a per-request 15-pane capture, which is what spiraled into the 15s client timeout
  // (FIX-activity-sampler). A boot/first-paint request kicks the first sweep (non-blocking)
  // and gets the warm board on its next ~3s poll.
  router.get('/api/agents/activity', async ({ res }) => {
    // first-paint blocks once on the boot sweep (single-flight); every later poll is instant.
    if (ctx.activitySampler.getBoard().sampledAt === 0) await ctx.activitySampler.tick().catch(() => undefined);
    // Serve the cached snapshot (the EXPENSIVE busyState capture), but overlay the cheap, LIVE
    // `running` (has-session) + `tail` (in-memory) so the board is fresh; only an agent whose
    // running flipped since the last sweep (a start/stop) gets a single fresh status capture.
    const board = await Promise.all(
      ctx.activitySampler.getBoard().board.map(async (r) => {
        ctx.activity.watch(r.agentId);
        const running = await ctx.supervisor.isRunning(r.agentId).catch(() => r.running);
        const tail = ctx.activity.tail(r.agentId);
        let state = r.state;
        if (running !== r.running) {
          if (!running) state = 'stopped';
          else {
            try { state = stateFromStatus(await ctx.supervisor.statusFast(r.agentId, { ttlMs: 0 }), tail.length > 0); }
            catch { state = 'unknown'; }
          }
        }
        return { ...r, running, state, tail };
      }),
    );
    sendJson(res, 200, board);
  });

  router.get('/api/agents/:id', async (c) => {
    sendJson(c.res, 200, await agentSummary(ctx, agentOrThrow(ctx, c.params.id ?? '')));
  });

  // Dashboard agent creation — operator approval is implicit, ceiling still absolute.
  router.post('/api/agents', (c) => {
    requireOperator(c);
    const body = (c.body ?? {}) as CreateAgentBody;
    const agent = buildAgentConfig(ctx, body);
    const verdict = evaluateSpawn({
      origin: 'dashboard',
      requesterIsHub: false,
      requestedLevel: profileLevel(ctx, agent.securityProfile),
    });
    if (verdict.verdict !== 'allow') throw new HttpError(403, `spawn denied: ${verdict.reason}`);
    createAgent(ctx, agent);
    sendJson(c.res, 201, { created: agent.id });
  });

  router.patch('/api/agents/:id', (c) => {
    requireOperator(c);
    const agent = agentOrThrow(ctx, c.params.id ?? '');
    const body = (c.body ?? {}) as Partial<AgentConfig> & { securityProfile?: string };
    if (body.securityProfile !== undefined && body.securityProfile !== agent.securityProfile) {
      // privilege rule: the spawn ceiling applies to profile CHANGES too —
      // no API path may raise any agent (seed or not) above level 2; the
      // full-host profile exists only as pre-seeded config (SPEC §15)
      if (profileLevel(ctx, body.securityProfile) > 2) {
        throw new HttpError(403, 'profiles above the spawn ceiling cannot be assigned through the API');
      }
    }
    ctx.saveConfig((cfg) => {
      const target = cfg.agents.find((a) => sanitizeId(a.id) === sanitizeId(agent.id));
      if (!target) return;
      if (typeof body.displayName === 'string' && body.displayName !== '') target.displayName = body.displayName;
      if (typeof body.role === 'string' && body.role !== '') target.role = body.role;
      if (typeof body.accentColor === 'string' && body.accentColor !== '') target.accentColor = body.accentColor;
      if (typeof body.model === 'string') target.model = body.model;
      if (typeof body.securityProfile === 'string') target.securityProfile = body.securityProfile;
      if (body.team !== undefined) target.team = { ...target.team, ...body.team };
      if (typeof body.hidden === 'boolean') target.hidden = body.hidden;
    });
    sendJson(c.res, 200, { updated: agent.id });
  });

  router.delete('/api/agents/:id', async (c) => {
    requireOperator(c);
    const agent = agentOrThrow(ctx, c.params.id ?? '');
    const id = sanitizeId(agent.id);
    if (ctx.seedAgentIds.has(id) || id === sanitizeId(ctx.config.hubId)) {
      throw new HttpError(403, 'base-roster agents cannot be deleted; their names are reserved');
    }
    await ctx.supervisor.stop(agent.id).catch(() => undefined);
    ctx.saveConfig((cfg) => {
      cfg.agents = cfg.agents.filter((a) => sanitizeId(a.id) !== id);
    });
    sendJson(c.res, 200, { deleted: id });
  });

  router.post('/api/agents/:id/start', async (c) => {
    requireOperator(c);
    const agent = agentOrThrow(ctx, c.params.id ?? '');
    ctx.desired.setDesired(agent.id, 'running');
    await ctx.supervisor.start(agent.id, { fresh: false });
    sendJson(c.res, 200, { started: agent.id });
  });

  router.post('/api/agents/:id/stop', async (c) => {
    requireOperator(c);
    const agent = agentOrThrow(ctx, c.params.id ?? '');
    ctx.desired.setDesired(agent.id, 'stopped');
    await ctx.supervisor.stop(agent.id);
    sendJson(c.res, 200, { stopped: agent.id });
  });

  router.post('/api/agents/:id/restart', async (c) => {
    requireOperator(c);
    const agent = agentOrThrow(ctx, c.params.id ?? '');
    const fresh = (c.body as { fresh?: boolean } | undefined)?.fresh === true;
    ctx.desired.setDesired(agent.id, 'running');
    await ctx.supervisor.restart(agent.id, { fresh });
    sendJson(c.res, 200, { restarted: agent.id, fresh });
  });

  // Deliberate re-seed of the per-agent persona/operating/CLAUDE docs AND the
  // Claude Code settings.json onto the real seed (FIX-personas-apply +
  // FIX-agent-permissions-permissive): overwrites unmodified auto-generated stubs,
  // preserves operator edits, then RESTARTS the changed agents so a fresh session
  // re-reads its operating doc + permissions (adoption alone keeps the stale ones —
  // a per-agent restart kills+recreates the session, so claude relaunches and reads
  // both files). The static segment wins over /api/agents/:id. (operator-only)
  router.post('/api/agents/reseed-docs', async (c) => {
    requireOperator(c);
    const docs = ctx.reseedAgentDocs();
    const settings = ctx.reseedAgentSettings();
    const changed = [...new Set([...docs.changed, ...settings.changed])];
    const preserved = [...new Set([...docs.preserved, ...settings.preserved])];
    const restarted: string[] = [];
    for (const id of changed) {
      try {
        ctx.desired.setDesired(id, 'running');
        await ctx.supervisor.restart(id); // resume: re-reads CLAUDE.md + settings.json, keeps context
        restarted.push(id);
      } catch {
        /* a down/not-started agent simply reads the new files on its next start */
      }
    }
    sendJson(c.res, 200, { changed, preserved, restarted, docs, settings });
  });

  router.get('/api/agents/:id/status', async (c) => {
    const agent = agentOrThrow(ctx, c.params.id ?? '');
    // agent tokens may read their own status only — no peer probing
    if (c.auth.kind === 'agent' && sanitizeId(c.auth.agentId) !== sanitizeId(agent.id)) {
      throw new HttpError(403, 'agents may only read their own status');
    }
    sendJson(c.res, 200, await ctx.supervisor.status(agent.id));
  });

  // Live output stream — the primary human view (SPEC §17 watch+type). ?token= allowed.
  router.get('/api/agents/:id/stream', (c) => {
    const agent = agentOrThrow(ctx, c.params.id ?? '');
    // the watch plane belongs to the operator; an agent token cannot
    // eavesdrop on a peer's terminal (it may watch itself, which is harmless)
    if (c.auth.kind === 'agent' && sanitizeId(c.auth.agentId) !== sanitizeId(agent.id)) {
      throw new HttpError(403, 'agents may not watch other agents');
    }
    const sse = openSseStream(c.res);
    const unsubscribe = ctx.supervisor.streamOutput(agent.id, (event) => {
      sse.send(event.kind, event);
    });
    c.res.on('close', unsubscribe);
  });

  // Operator typing into a live agent — serialized, attributed, interruptible.
  // A body of {key} forwards a single allow-listed control/navigation key to the
  // live pane instead of text (FIX-03 §3); the supervisor re-validates the key.
  router.post('/api/agents/:id/input', async (c) => {
    requireOperator(c);
    const agent = agentOrThrow(ctx, c.params.id ?? '');
    const body = (c.body ?? {}) as { text?: string; key?: string; literal?: string; force?: boolean };
    if (typeof body.key === 'string' && body.key !== '') {
      if (!KEY_ALLOW_LIST.has(body.key)) throw new HttpError(400, 'disallowed key');
      try {
        await ctx.supervisor.sendKey(agent.id, body.key);
      } catch (err) {
        throw new HttpError(400, err instanceof Error ? err.message : 'key not delivered');
      }
      sendJson(c.res, 200, { key: body.key, agent: agent.id });
      return;
    }
    // Raw literal keystroke(s) forwarded verbatim (no submit) — capped so it stays
    // a keystroke channel, not a bulk-paste bypass of the audited line input (§6).
    if (typeof body.literal === 'string' && body.literal !== '') {
      if (body.literal.length > 16) throw new HttpError(400, 'literal too long');
      try {
        await ctx.supervisor.sendLiteral(agent.id, body.literal);
      } catch (err) {
        throw new HttpError(400, err instanceof Error ? err.message : 'literal not delivered');
      }
      sendJson(c.res, 200, { literal: true, agent: agent.id });
      return;
    }
    if (typeof body.text !== 'string' || body.text.trim() === '') throw new HttpError(400, 'text or key required');
    await ctx.supervisor.injectInput(agent.id, body.text, {
      source: 'operator',
      ...(body.force === true ? { force: true } : {}),
    });
    sendJson(c.res, 200, { injected: agent.id, forced: body.force === true });
  });

  // Operator-gated 2-phase re-auth helper (FIX-03 §2). NEVER injects credentials
  // — it only observes the agent's auth state; the operator types /login in the
  // live terminal. phase 'start' arms the flow; 'confirm' re-checks completion.
  router.post('/api/agents/:id/login', async (c) => {
    requireOperator(c);
    const agent = agentOrThrow(ctx, c.params.id ?? '');
    const phase = ((c.body ?? {}) as { phase?: string }).phase;
    const status = await ctx.supervisor.status(agent.id);
    if (phase === 'start') {
      if (status.busyState !== 'reauth-needed') throw new HttpError(409, ctx.i18n.t('agents.reauth.notNeeded'));
      sendJson(c.res, 200, { status: 'reauth-ready' });
      return;
    }
    if (phase === 'confirm') {
      // brief re-check window: the operator just completed /login in the pane
      for (let i = 0; i < 8; i++) {
        const s = await ctx.supervisor.status(agent.id);
        if (s.running && s.busyState !== 'reauth-needed') { sendJson(c.res, 200, { status: 'reauth-complete', busyState: s.busyState }); return; }
        await new Promise((r) => setTimeout(r, 250));
      }
      sendJson(c.res, 200, { status: 'reauth-pending' });
      return;
    }
    throw new HttpError(400, 'phase must be start or confirm');
  });

  // Own-team auth (PROMPT-20 §5f/§6): initiate a fresh provider login in the
  // agent's own session and surface the OAuth URL the CLI prints. Operator-driven
  // (it sends `/login`, never a credential). The agent must be running. Best-effort
  // URL capture from the live pane; the operator completes the browser step.
  router.post('/api/agents/:id/auth-login', async (c) => {
    requireOperator(c);
    const agent = agentOrThrow(ctx, c.params.id ?? '');
    // A shared-subscription agent shares the HOST's OAuth via a symlinked credentials
    // file. An in-pane /login makes Claude Code atomic-rename a NEW real file over that
    // symlink → the agent is decoupled from the shared subscription and will keep
    // prompting /login on its own. So refuse per-agent login here: the operator re-auths
    // ONCE on the host (`claude` login on the host shell, which refreshes
    // ~/.claude/.credentials.json) and every shared agent picks it up on its next start.
    if (agent.authMode === 'shared-subscription') throw new HttpError(409, ctx.i18n.t('agents.auth.sharedNoPerAgentLogin'));
    const status = await ctx.supervisor.status(agent.id);
    if (!status.running) throw new HttpError(409, ctx.i18n.t('agents.auth.notRunning'));
    await ctx.supervisor.injectInput(agent.id, '/login', { source: 'operator' });
    // poll the pane briefly for the printed auth URL (the CLI takes a moment)
    let url: string | null = null;
    for (let i = 0; i < 6 && url === null; i++) {
      await new Promise((r) => setTimeout(r, 500));
      url = extractAuthUrl(await ctx.supervisor.captureScreen(agent.id));
    }
    sendJson(c.res, 200, { started: true, url });
  });

  // Shared-subscription auth status: is the HOST token present + valid? Shared agents
  // symlink it; when it's missing/expired the operator re-auths ONCE on the host.
  router.get('/api/agents/shared-auth', (c) => {
    requireOperator(c);
    const shared = ctx.config.agents.filter((a) => a.authMode === 'shared-subscription').map((a) => sanitizeId(a.id));
    sendJson(c.res, 200, { ...readSharedAuthStatus(), sharedAgents: shared });
  });

  // Refresh shared auth across the fleet: re-link EVERY shared-subscription agent's
  // credentials to the host token (repairs any decoupled regular-file) and restart
  // them so they pick up a freshly host-re-authed token. The operator runs `claude`
  // login on the HOST first; this pushes it to all agents (the correct shared model —
  // never a per-agent login). Links are repaired synchronously (fast); the restarts
  // run in the background so the request returns promptly (the fleet poll shows progress).
  router.post('/api/agents/shared-auth/refresh', (c) => {
    requireOperator(c);
    const shared = ctx.config.agents.filter((a) => a.authMode === 'shared-subscription').map((a) => sanitizeId(a.id));
    for (const id of shared) {
      try { ensureSharedSubscriptionAuth(agentPaths(ctx.paths, id).configRoot); } catch { /* best-effort link repair */ }
    }
    void (async () => {
      for (const id of shared) {
        try { ctx.desired.setDesired(id, 'running'); await ctx.supervisor.restart(id); } catch { /* skip a failing agent */ }
      }
    })();
    sendJson(c.res, 200, { ...readSharedAuthStatus(), refreshing: shared, count: shared.length });
  });

  // Public avatar (header-less <img> usage — explicit auth exception, SPEC §17).
  router.get('/api/agents/avatar/:id', (c) => {
    const id = sanitizeId(c.params.id ?? '');
    const agent = ctx.config.agents.find((a) => sanitizeId(a.id) === id);
    const accent = agent?.accentColor ?? '#888888';
    const initials = (agent?.displayName ?? id).slice(0, 2).toUpperCase().replace(/[<>&"']/g, '');
    const safeAccent = /^#[0-9a-fA-F]{3,8}$/.test(accent) ? accent : '#888888';
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
      `<rect width="64" height="64" rx="14" fill="#12121d"/>` +
      `<circle cx="32" cy="32" r="26" fill="none" stroke="${safeAccent}" stroke-width="3"/>` +
      `<text x="32" y="39" font-family="sans-serif" font-size="20" font-weight="700" fill="${safeAccent}" text-anchor="middle">${initials}</text>` +
      `</svg>`;
    c.res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=3600' });
    c.res.end(svg);
  });

  // --- hub identity (read-only) + restart (SPEC §17) ---
  router.get('/api/hub', async ({ res }) => {
    sendJson(res, 200, await agentSummary(ctx, agentOrThrow(ctx, ctx.config.hubId)));
  });

  router.post('/api/hub/restart', async (c) => {
    requireOperator(c);
    const fresh = (c.body as { fresh?: boolean } | undefined)?.fresh === true;
    await ctx.supervisor.restart(ctx.config.hubId, { fresh });
    sendJson(c.res, 200, { restarted: ctx.config.hubId, fresh });
  });

  // --- spawn approval queue (SPEC §15) ---
  router.get('/api/spawn-requests', (c) => {
    requireOperator(c);
    const rows = ctx.db
      .prepare(`SELECT * FROM spawn_requests WHERE status = 'pending' ORDER BY id`)
      .all() as Array<Record<string, unknown>>;
    sendJson(c.res, 200, rows);
  });

  // Programmatic spawn: only the hub, only with its scoped agent token.
  router.post('/api/spawn-requests', (c) => {
    if (c.auth.kind !== 'agent') throw new HttpError(403, 'programmatic spawn requires an agent token');
    const requesterId = sanitizeId(c.auth.agentId);
    const requester = agentOrThrow(ctx, requesterId);
    const body = (c.body ?? {}) as CreateAgentBody;
    const agent = buildAgentConfig(ctx, body);
    const verdict = evaluateSpawn({
      origin: 'programmatic',
      requesterId,
      requesterIsHub: requesterId === sanitizeId(ctx.config.hubId),
      requesterLevel: profileLevel(ctx, requester.securityProfile),
      requestedLevel: profileLevel(ctx, agent.securityProfile),
    });
    if (verdict.verdict === 'deny') throw new HttpError(403, `spawn denied: ${verdict.reason}`);
    if (verdict.verdict === 'allow') {
      createAgent(ctx, agent);
      sendJson(c.res, 201, { created: agent.id, verdict: verdict.reason });
      return;
    }
    // park for human approval
    ctx.db
      .prepare(
        `INSERT INTO spawn_requests (requester, agent_id, display_name, profile, config_json, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(requesterId, agent.id, agent.displayName, agent.securityProfile, JSON.stringify(agent), isoNow());
    void ctx.notifyOperator(
      ctx.i18n.t('channel.spawn_pending', { agent: agent.displayName, profile: agent.securityProfile }),
    );
    sendJson(c.res, 202, { parked: agent.id, verdict: verdict.reason });
  });

  router.post('/api/spawn-requests/:id/approve', (c) => {
    requireOperator(c);
    const row = ctx.db.prepare(`SELECT * FROM spawn_requests WHERE id = ? AND status = 'pending'`).get(
      Number(c.params.id),
    ) as { id: number; config_json: string; profile: string } | undefined;
    if (!row) throw new HttpError(404, 'no such pending spawn request');
    const agent = JSON.parse(row.config_json) as AgentConfig;
    // the dashboard approval IS the human approval; the ceiling stays absolute
    const verdict = evaluateSpawn({
      origin: 'dashboard',
      requesterIsHub: false,
      requestedLevel: profileLevel(ctx, agent.securityProfile),
    });
    if (verdict.verdict !== 'allow') throw new HttpError(403, `approval refused: ${verdict.reason}`);
    createAgent(ctx, agent);
    ctx.db
      .prepare(`UPDATE spawn_requests SET status = 'approved', resolved_at = ? WHERE id = ?`)
      .run(isoNow(), row.id);
    sendJson(c.res, 200, { approved: agent.id });
  });

  router.post('/api/spawn-requests/:id/deny', (c) => {
    requireOperator(c);
    const res = ctx.db
      .prepare(`UPDATE spawn_requests SET status = 'denied', resolved_at = ? WHERE id = ? AND status = 'pending'`)
      .run(isoNow(), Number(c.params.id));
    if (res.changes === 0) throw new HttpError(404, 'no such pending spawn request');
    sendJson(c.res, 200, { denied: Number(c.params.id) });
  });
}
