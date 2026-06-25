// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Router } from '../router.js';
import { sendJson } from '../router.js';
import type { AppContext } from '../../app/context.js';
import type { AgentConfig } from '../../config/types.js';
import { sanitizeId } from '../../trust/sanitize.js';

/**
 * Overview metrics bundle + team graph (the Áttekintés / Overview landing view).
 * Read-only; behind the bearer like every /api/* route. The metrics bundle and
 * the richer team graph are separate endpoints so the constellation matches the
 * (future) Team page exactly rather than the flat roster.
 */

type NodeRole = 'hub' | 'leader' | 'member';

interface RosterNode {
  id: string;
  label: string;
  role: NodeRole;
  running: boolean;
  hasAvatar: boolean;
  avatarUrl: string;
}

interface ActivityItem {
  ts: string;
  kind: 'memory' | 'message';
  text: string;
}

function count(ctx: AppContext, sql: string, ...params: unknown[]): number {
  const row = ctx.db.prepare(sql).get(...(params as never[])) as { c: number } | undefined;
  return row?.c ?? 0;
}

/** Local calendar day (YYYY-MM-DD) of an ISO instant in the given IANA timezone. */
export function localDay(iso: string, timeZone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  // en-CA renders ISO-style YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/**
 * Bucket a list of timestamps into today / yesterday counts for the given IANA
 * timezone, relative to `now`. A NULL / non-string / unparseable timestamp, and
 * any instant that falls outside the two local days, is ignored — so a garbage
 * or stray-historical row can never inflate a bucket (FIX-overview-data §1).
 */
export function bucketTimestamps(
  rows: Array<string | null | undefined>,
  timeZone: string,
  now: Date,
): { today: number; yesterday: number } {
  const todayLocal = localDay(now.toISOString(), timeZone);
  const yesterdayLocal = localDay(new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(), timeZone);
  let today = 0;
  let yesterday = 0;
  for (const ts of rows) {
    if (typeof ts !== 'string') continue;
    const day = localDay(ts, timeZone);
    if (day === '') continue; // unparseable / NaN — never bucket
    if (day === todayLocal) today++;
    else if (day === yesterdayLocal) yesterday++;
  }
  return { today, yesterday };
}

// Leader/member is the agent's STORED team.role, not graph topology (FIX-04 §1):
// a leader with no current reports must still read as leader, and the seed
// 'specialist' role maps to member. Only an explicit stored 'leader' is a leader.
function roleOf(agent: AgentConfig, hubId: string): NodeRole {
  if (sanitizeId(agent.id) === hubId) return 'hub';
  return agent.team.role === 'leader' ? 'leader' : 'member';
}

function truncate(s: string, n: number): string {
  const clean = s.replace(/\s+/g, ' ').trim();
  return clean.length > n ? `${clean.slice(0, n)}…` : clean;
}

/** Count global skill folders + how many were created/modified today (by SKILL.md mtime). */
function skillStats(ctx: AppContext): { count: number; createdToday: number } {
  const dir = ctx.paths.skillsGlobalDir;
  if (!existsSync(dir)) return { count: 0, createdToday: 0 };
  const todayLocal = localDay(new Date().toISOString(), ctx.config.timezone);
  let total = 0;
  let createdToday = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const def = join(dir, entry.name, 'SKILL.md');
    if (!existsSync(def)) continue;
    total++;
    try {
      if (localDay(statSync(def).mtime.toISOString(), ctx.config.timezone) === todayLocal) createdToday++;
    } catch {
      /* stat race: ignore */
    }
  }
  return { count: total, createdToday };
}

async function runningMap(ctx: AppContext, agents: AgentConfig[]): Promise<Map<string, boolean>> {
  // Probe all agents CONCURRENTLY (was a serial await-loop → ~N×0.5s; the real
  // Overview/Team slowness) via statusFast, which is TTL-cached + per-agent
  // timeout-bounded so a hung agent can't stall the sweep (FIX-agents-list-perf).
  const entries = await Promise.all(
    agents.map(async (a) => {
      const id = sanitizeId(a.id);
      try {
        return [id, (await ctx.supervisor.statusFast(id)).running] as const;
      } catch {
        return [id, false] as const;
      }
    }),
  );
  return new Map(entries);
}

function buildRoster(ctx: AppContext, agents: AgentConfig[], hubId: string, running: Map<string, boolean>): RosterNode[] {
  return agents.map((a) => {
    const id = sanitizeId(a.id);
    return {
      id,
      label: a.displayName,
      role: roleOf(a, hubId),
      // the hub is privileged: always counted/shown as running (SPEC §8)
      running: id === hubId ? true : (running.get(id) ?? false),
      hasAvatar: false, // no operator-uploaded avatars yet; nodes use the monogram fallback
      avatarUrl: `/api/agents/avatar/${id}`,
    };
  });
}

function buildActivity(ctx: AppContext): ActivityItem[] {
  const items: ActivityItem[] = [];

  const memories = ctx.db
    .prepare(`SELECT agent_id, content, created_at FROM memories WHERE archived_at IS NULL ORDER BY id DESC LIMIT 8`)
    .all() as Array<{ agent_id: string; content: string; created_at: string }>;
  for (const m of memories) {
    items.push({ ts: m.created_at, kind: 'memory', text: `${sanitizeId(m.agent_id)}: ${truncate(m.content, 80)}` });
  }

  const messages = ctx.db
    .prepare(`SELECT sender, recipient, body, created_at FROM messages ORDER BY id DESC LIMIT 8`)
    .all() as Array<{ sender: string; recipient: string; body: string; created_at: string }>;
  for (const m of messages) {
    items.push({ ts: m.created_at, kind: 'message', text: `${m.sender} → ${m.recipient}: ${truncate(m.body, 60)}` });
  }

  items.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  return items.slice(0, 8);
}

export function registerOverviewRoutes(router: Router, ctx: AppContext): void {
  // --- metrics bundle (SPEC §6 step 1) ---
  router.get('/api/overview', async ({ res }) => {
    const hubId = sanitizeId(ctx.config.hubId);
    const agents = ctx.config.agents.filter((a) => a.hidden !== true);
    const running = await runningMap(ctx, agents);

    const total = agents.length;
    const activeAgents = agents.filter((a) => sanitizeId(a.id) === hubId || running.get(sanitizeId(a.id))).length;

    const tz = ctx.config.timezone;
    const now = new Date();
    const since = new Date(now.getTime() - 50 * 60 * 60 * 1000).toISOString();

    // "tasks run today" = DISTINCT scheduled-task fires today + genuine operator
    // turns today (operator-stamped messages; tool/system events are never
    // sender=operator). A single cron fire writes ONE task_runs row PER agent it
    // dispatches to (e.g. "heartbeat-consolidate" → one row per roster member), so
    // counting raw rows multiplied the figure by the roster size and produced an
    // implausible delta on an otherwise-quiet system. We count distinct (task_id,
    // fired_at) fires instead (FIX-overview-data §1).
    const fires = ctx.db
      .prepare(`SELECT DISTINCT task_id, fired_at FROM task_runs WHERE fired_at >= ?`)
      .all(since) as Array<{ task_id: string; fired_at: string }>;
    const recentOps = ctx.db
      .prepare(`SELECT created_at FROM messages WHERE sender = 'operator' AND created_at >= ?`)
      .all(since) as Array<{ created_at: string }>;
    const runsB = bucketTimestamps(fires.map((r) => r.fired_at), tz, now);
    const opsB = bucketTimestamps(recentOps.map((r) => r.created_at), tz, now);
    const tasks = { today: runsB.today + opsB.today, yesterday: runsB.yesterday + opsB.yesterday };

    const memory = {
      count: count(ctx, `SELECT COUNT(*) c FROM memories WHERE archived_at IS NULL`),
      categories: count(ctx, `SELECT COUNT(DISTINCT category) c FROM memories WHERE archived_at IS NULL`),
    };

    const skills = skillStats(ctx);

    sendJson(res, 200, {
      agents: { running: activeAgents, total },
      tasks,
      memory,
      skills,
      hubId,
      roster: buildRoster(ctx, agents, hubId, running),
      activity: buildActivity(ctx),
    });
  });

  // --- team hierarchy graph (SPEC §6 step 2) ---
  router.get('/api/team', async ({ res }) => {
    const hubId = sanitizeId(ctx.config.hubId);
    const agents = ctx.config.agents.filter((a) => a.hidden !== true);
    const running = await runningMap(ctx, agents);
    const nodeIds = new Set(agents.map((a) => sanitizeId(a.id)));

    const nodes = buildRoster(ctx, agents, hubId, running);
    const edges: Array<{ from: string; to: string }> = [];
    for (const a of agents) {
      const id = sanitizeId(a.id);
      if (id === hubId) continue;
      const parent = sanitizeId(a.team.reportsTo ?? '');
      // a valid reports-to edge points at a known node; otherwise the agent is
      // an orphan and the client drops it into a trailing level
      if (parent !== '' && nodeIds.has(parent)) edges.push({ from: id, to: parent });
    }
    sendJson(res, 200, { hubId, nodes, edges });
  });
}
