// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Router } from '../router.js';
import { HttpError, requireOperator, sendJson } from '../router.js';
import type { AppContext } from '../../app/context.js';
import type { AgentConfig, StatePaths } from '../../config/types.js';
import { sanitizeId } from '../../trust/sanitize.js';
import { agentPaths } from '../../app/scaffold.js';
import { createLogger } from '../../core/log.js';

const log = createLogger('agent-config');

/**
 * Agent-configuration surface for the Agents (Ügynökök) view (PROMPT-03): the
 * read-only profiles/models catalogs the wizard + settings dropdowns need, the
 * editable identity docs (persona.md + operating.md at the agent root; the combined
 * workdir/CLAUDE.md is re-rendered on save), deterministic doc generation on create,
 * per-agent auto-restart config, and the auth-mode / channel-binding mutations.
 * Everything here is operator-gated. persona/operating are editable for ALL agents
 * (incl. the hub); only the token-bearing .mcp.json stays hub-read-only (SPEC §8).
 */

function agentOrThrow(ctx: AppContext, rawId: string): AgentConfig {
  const id = sanitizeId(rawId);
  const agent = ctx.config.agents.find((a) => sanitizeId(a.id) === id);
  if (!agent) throw new HttpError(404, `unknown agent: ${id}`);
  return agent;
}

function isHub(ctx: AppContext, agent: AgentConfig): boolean {
  return sanitizeId(agent.id) === sanitizeId(ctx.config.hubId);
}

// --- identity docs ---
// The real, editable identity lives at the agent ROOT (FIX-agent-card-persona):
//   persona.md  (the SOUL) + operating.md (the operating doc).
// .mcp.json stays in the workDir; workdir/CLAUDE.md is the COMBINED doc Claude Code
// loads — re-rendered from persona+operating+tools on save, never hand-edited.
const ROOT_DOCS = { persona: 'persona.md', operating: 'operating.md' } as const;
type RootDocKey = keyof typeof ROOT_DOCS;

function readRootDoc(ctx: AppContext, agent: AgentConfig, key: RootDocKey): string {
  const file = join(agentPaths(ctx.paths, agent.id).root, ROOT_DOCS[key]);
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}
function writeRootDoc(ctx: AppContext, agent: AgentConfig, key: RootDocKey, content: string): void {
  const root = agentPaths(ctx.paths, agent.id).root;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  writeFileSync(join(root, ROOT_DOCS[key]), content, { mode: 0o600 });
}
function readWorkdir(ctx: AppContext, agent: AgentConfig, name: string): string {
  const file = join(agentPaths(ctx.paths, agent.id).workDir, name);
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}
function writeWorkdir(ctx: AppContext, agent: AgentConfig, name: string, content: string): void {
  const workDir = agentPaths(ctx.paths, agent.id).workDir;
  mkdirSync(workDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(workDir, name), content, { mode: 0o600 });
}
/** Re-render workdir/CLAUDE.md from the agent's current persona+operating (+tools). */
function rerenderClaude(ctx: AppContext, agent: AgentConfig): void {
  const persona = readRootDoc(ctx, agent, 'persona');
  const operating = readRootDoc(ctx, agent, 'operating');
  const claude = ctx.composeAgentClaude(agent.id, { persona, ...(operating.trim() !== '' ? { operating } : {}) });
  writeWorkdir(ctx, agent, 'CLAUDE.md', claude);
}

/** Deterministic identity-doc generation seeded from the operator's free-form brief. */
function generateDocs(agent: AgentConfig, description: string): { persona: string; operating: string } {
  const brief = description.trim() || agent.role;
  const persona = [
    `# ${agent.displayName} — persona`,
    '',
    brief,
    '',
    'Voice: concise, helpful, and proactive within your mandate.',
    '',
  ].join('\n');
  const operating = [
    `# ${agent.displayName}`,
    '',
    '## Mission',
    brief,
    '',
    '## Operating notes',
    "- Write operator-facing prose in the operator's language.",
    '- Use the orchestrator tools (agentctl) for memory, messaging, kanban, and ideas.',
    '- Confirm before any irreversible or outward-facing action.',
    '',
  ].join('\n');
  return { persona, operating };
}

// --- auto-restart config (isolated per-agent file: the config loader does not
//     round-trip an autoRestart field, so it lives outside config.json) ---
interface AutoRestartConfig {
  enabled: boolean;
  mode: 'continue' | 'fresh';
  schedule: 'daily' | 'hourly';
  dailyTime: string;
  intervalHours: number;
}
const AUTO_RESTART_DEFAULT: AutoRestartConfig = {
  enabled: false,
  mode: 'continue',
  schedule: 'daily',
  dailyTime: '04:00',
  intervalHours: 6,
};

function autoRestartFile(ctx: AppContext, agent: AgentConfig): string {
  return join(agentPaths(ctx.paths, agent.id).root, 'auto-restart.json');
}

/**
 * Per-agent auto-restart opt-in (#80): true ONLY when the operator enabled it for
 * this agent. The stuck-agent watchman gates its level-2 restart on this so it
 * never kills a legitimately long-running agent — restart is opt-in, not default.
 */
export function autoRestartEnabled(paths: StatePaths, agentId: string): boolean {
  const file = join(agentPaths(paths, agentId).root, 'auto-restart.json');
  if (!existsSync(file)) return false;
  try {
    return (JSON.parse(readFileSync(file, 'utf8')) as { enabled?: unknown }).enabled === true;
  } catch {
    return false;
  }
}

function readAutoRestart(ctx: AppContext, agent: AgentConfig): AutoRestartConfig {
  const file = autoRestartFile(ctx, agent);
  if (!existsSync(file)) return { ...AUTO_RESTART_DEFAULT };
  try {
    return normalizeAutoRestart(JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>);
  } catch {
    return { ...AUTO_RESTART_DEFAULT };
  }
}

function normalizeAutoRestart(raw: Record<string, unknown>): AutoRestartConfig {
  const d = AUTO_RESTART_DEFAULT;
  const time = typeof raw.dailyTime === 'string' && /^\d{2}:\d{2}$/.test(raw.dailyTime) ? raw.dailyTime : d.dailyTime;
  const hours = Math.min(168, Math.max(1, Math.round(typeof raw.intervalHours === 'number' ? raw.intervalHours : d.intervalHours)));
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : d.enabled,
    mode: raw.mode === 'fresh' ? 'fresh' : 'continue',
    schedule: raw.schedule === 'hourly' ? 'hourly' : 'daily',
    dailyTime: time,
    intervalHours: hours,
  };
}

// --- the Claude model catalog (subscription-only deployment: no DeepSeek/Ollama
//     discovery, so those groups come back empty and the UI hides them) ---
const CLAUDE_MODELS: Array<{ id: string; label: string }> = [
  { id: 'claude-fable-5', label: 'Fable 5 — flagship' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8 — most capable' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6 — fast & smart' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5 — fastest' },
];

export function registerAgentConfigRoutes(router: Router, ctx: AppContext): void {
  // --- catalogs ---
  router.get('/api/profiles', (c) => {
    requireOperator(c);
    sendJson(c.res, 200, {
      profiles: ctx.config.securityProfiles.map((p) => ({
        id: p.id,
        label: p.label,
        strict: p.mode === 'strict',
        privilegeLevel: p.privilegeLevel,
        allow: p.allow.length,
        ask: p.ask.length,
        deny: p.deny.length,
      })),
    });
  });

  router.get('/api/models', (c) => {
    requireOperator(c);
    // DeepSeek + Ollama are intentionally empty (no provider key/daemon on a
    // subscription-only host); the client hides empty groups.
    sendJson(c.res, 200, { claude: CLAUDE_MODELS, deepseek: [], ollama: [], aliases: ctx.config.modelAliases });
  });

  // --- identity docs (the editable persona.md + operating.md at the agent root) ---
  router.get('/api/agents/:id/docs', (c) => {
    requireOperator(c);
    const agent = agentOrThrow(ctx, c.params.id ?? '');
    sendJson(c.res, 200, {
      persona: readRootDoc(ctx, agent, 'persona'),
      operating: readRootDoc(ctx, agent, 'operating'),
      effectiveClaude: readWorkdir(ctx, agent, 'CLAUDE.md'), // read-only preview of the combined doc
      mcpJson: readWorkdir(ctx, agent, '.mcp.json'),
      mcpReadOnly: isHub(ctx, agent), // the hub's MCP config can carry secrets (SPEC §8)
      hasApiKey: false, // subscription-only deployment never stores an API key
    });
  });

  router.put('/api/agents/:id/docs', async (c) => {
    requireOperator(c);
    const agent = agentOrThrow(ctx, c.params.id ?? '');
    const body = (c.body ?? {}) as { persona?: string; operating?: string; mcpJson?: string };
    const written: string[] = [];
    // persona + operating are editable for ALL agents incl. the hub — they carry no
    // tokens, so the SPEC §8 read-only caution applies only to .mcp.json (below).
    if (typeof body.persona === 'string') { writeRootDoc(ctx, agent, 'persona', body.persona); written.push('persona'); }
    if (typeof body.operating === 'string') { writeRootDoc(ctx, agent, 'operating', body.operating); written.push('operating'); }
    if (typeof body.mcpJson === 'string') {
      if (isHub(ctx, agent)) throw new HttpError(403, 'the hub MCP config is read-only (token-leak risk, SPEC §8)');
      if (body.mcpJson.trim() !== '') {
        try { JSON.parse(body.mcpJson); } catch { throw new HttpError(400, '.mcp.json must be valid JSON'); }
      }
      writeWorkdir(ctx, agent, '.mcp.json', body.mcpJson); written.push('mcpJson');
    }
    // an identity edit re-renders the combined CLAUDE.md and reloads the live session
    // so the running agent picks up its new persona/operating (FIX-agent-card-persona §2).
    let restarted = false;
    if (written.includes('persona') || written.includes('operating')) {
      rerenderClaude(ctx, agent);
      if (await ctx.supervisor.isRunning(agent.id).catch(() => false)) {
        try {
          await ctx.supervisor.restart(agent.id);
          restarted = true;
        } catch (err) {
          // the docs are saved + CLAUDE.md re-rendered; surface a failed reload but don't fail the save
          log.warn('identity edit: agent restart failed (docs saved, CLAUDE.md re-rendered)', { agentId: sanitizeId(agent.id), error: String(err) });
        }
      }
    }
    sendJson(c.res, 200, { saved: written, restarted });
  });

  // generation on create: write persona.md + operating.md at the agent root from the
  // brief, then render workdir/CLAUDE.md — the SAME scheme as the seeded roster.
  router.post('/api/agents/:id/generate', (c) => {
    requireOperator(c);
    const agent = agentOrThrow(ctx, c.params.id ?? '');
    const description = String((c.body as { description?: string } | undefined)?.description ?? '');
    const docs = generateDocs(agent, description);
    writeRootDoc(ctx, agent, 'persona', docs.persona);
    writeRootDoc(ctx, agent, 'operating', docs.operating);
    rerenderClaude(ctx, agent);
    sendJson(c.res, 200, { generated: agent.id });
  });

  // --- auto-restart (persisted; scheduling enforcement deferred) ---
  router.get('/api/agents/:id/auto-restart', (c) => {
    requireOperator(c);
    const agent = agentOrThrow(ctx, c.params.id ?? '');
    sendJson(c.res, 200, readAutoRestart(ctx, agent));
  });

  router.put('/api/agents/:id/auto-restart', (c) => {
    requireOperator(c);
    const agent = agentOrThrow(ctx, c.params.id ?? '');
    const cfg = normalizeAutoRestart((c.body ?? {}) as Record<string, unknown>);
    mkdirSync(agentPaths(ctx.paths, agent.id).root, { recursive: true, mode: 0o700 });
    writeFileSync(autoRestartFile(ctx, agent), JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
    sendJson(c.res, 200, cfg);
  });

  // --- auth mode (subscription-only: the api-key mode is refused) ---
  router.put('/api/agents/:id/auth-mode', (c) => {
    requireOperator(c);
    const agent = agentOrThrow(ctx, c.params.id ?? '');
    const mode = String((c.body as { authMode?: string } | undefined)?.authMode ?? '');
    if (mode === 'api-key') {
      throw new HttpError(403, 'this deployment is subscription-only; per-agent API keys are not permitted');
    }
    if (mode !== 'shared-subscription' && mode !== 'own-credentials') {
      throw new HttpError(400, `unknown auth mode: ${mode}`);
    }
    ctx.saveConfig((cfg) => {
      const target = cfg.agents.find((a) => sanitizeId(a.id) === sanitizeId(agent.id));
      if (target) target.authMode = mode;
    });
    sendJson(c.res, 200, { authMode: mode, restartRequired: true });
  });

  // --- channel binding (per-agent provider+chat; token stashed in the vault) ---
  // Read the agent's binding + its approved chats (FIX-channels: lets the shared
  // panel render without a full agent reload). Metadata only — no token value.
  router.get('/api/agents/:id/channel', (c) => {
    requireOperator(c);
    const agent = agentOrThrow(ctx, c.params.id ?? '');
    const id = sanitizeId(agent.id);
    const channel = ctx.config.agents.find((a) => sanitizeId(a.id) === id)?.channel ?? null;
    const provider = channel?.provider ?? 'telegram';
    sendJson(c.res, 200, {
      provider,
      chatId: channel?.chatId ?? null,
      tokenConfigured: ctx.vault.getSecretValue(`channel-${id}-${provider}`) !== undefined,
      boundChats: ctx.channelBindings.listForAgent(id, provider),
    });
  });

  router.put('/api/agents/:id/channel', (c) => {
    requireOperator(c);
    const agent = agentOrThrow(ctx, c.params.id ?? '');
    const body = (c.body ?? {}) as { provider?: string; chatId?: string; token?: string };
    const provider = String(body.provider ?? '').trim().toLowerCase();
    if (provider !== 'telegram' && provider !== 'discord') {
      throw new HttpError(400, `unsupported channel provider: ${provider || '(none)'}`);
    }
    if (provider === 'discord' && (body.chatId ?? '').trim() === '') {
      throw new HttpError(400, 'Discord requires a channel id');
    }
    let tokenConfigured = false;
    if (typeof body.token === 'string' && body.token.trim() !== '') {
      try {
        ctx.vault.setSecret(`channel-${sanitizeId(agent.id)}-${provider}`, `${provider} bot token (${agent.id})`, body.token.trim());
        tokenConfigured = true;
      } catch {
        /* vault unavailable: keep the binding, report token not stored */
      }
    }
    ctx.saveConfig((cfg) => {
      const target = cfg.agents.find((a) => sanitizeId(a.id) === sanitizeId(agent.id));
      if (target) target.channel = { provider, ...(body.chatId ? { chatId: String(body.chatId) } : {}) };
    });
    sendJson(c.res, 200, { connected: true, provider, chatId: body.chatId ?? null, tokenConfigured });
  });

  router.delete('/api/agents/:id/channel', (c) => {
    requireOperator(c);
    const agent = agentOrThrow(ctx, c.params.id ?? '');
    ctx.saveConfig((cfg) => {
      const target = cfg.agents.find((a) => sanitizeId(a.id) === sanitizeId(agent.id));
      if (target) target.channel = null;
    });
    sendJson(c.res, 200, { connected: false });
  });

  // --- team config (the Team tab editor; PROMPT-04). Sanitizes self-references
  //     + unknown ids and returns a warnings summary. The hub is the fixed root. ---
  router.put('/api/agents/:id/team', (c) => {
    requireOperator(c);
    const agent = agentOrThrow(ctx, c.params.id ?? '');
    if (isHub(ctx, agent)) throw new HttpError(403, 'the main agent is the fixed root; its team config is not editable');
    const body = (c.body ?? {}) as {
      role?: string;
      reportsTo?: string | null;
      delegatesTo?: unknown;
      autoDelegation?: boolean;
      trustFrom?: unknown;
    };
    const self = sanitizeId(agent.id);
    const known = new Set(ctx.config.agents.map((a) => sanitizeId(a.id)));
    const selfRefs = new Set<string>();
    const unknown = new Set<string>();

    const cleanList = (raw: unknown): string[] => {
      const out: string[] = [];
      if (!Array.isArray(raw)) return out;
      for (const v of raw) {
        if (typeof v !== 'string') continue;
        const id = sanitizeId(v);
        if (id === '') continue;
        if (id === self) { selfRefs.add(id); continue; }
        if (!known.has(id)) { unknown.add(v); continue; }
        if (!out.includes(id)) out.push(id);
      }
      return out;
    };

    const role = body.role === 'leader' ? 'leader' : 'member';

    let reportsTo: string | undefined;
    const wantParent = typeof body.reportsTo === 'string' ? sanitizeId(body.reportsTo) : '';
    if (wantParent !== '') {
      if (wantParent === self) selfRefs.add(self);
      else if (!known.has(wantParent)) unknown.add(String(body.reportsTo));
      else reportsTo = wantParent;
    }

    const delegatesTo = role === 'leader' ? cleanList(body.delegatesTo) : [];
    const trustFrom = cleanList(body.trustFrom);
    const autoDelegation = role === 'leader' ? body.autoDelegation === true : false;

    ctx.saveConfig((cfg) => {
      const target = cfg.agents.find((a) => sanitizeId(a.id) === self);
      if (!target) return;
      target.team = { ...target.team, role, delegatesTo, trustFrom, autoDelegation };
      if (reportsTo) target.team.reportsTo = reportsTo;
      else delete target.team.reportsTo;
    });

    sendJson(c.res, 200, {
      saved: self,
      team: { role, reportsTo: reportsTo ?? null, delegatesTo, trustFrom, autoDelegation },
      warnings: { selfReferences: [...selfRefs], unknownNames: [...unknown] },
    });
  });
}
