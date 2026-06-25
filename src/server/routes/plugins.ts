// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import type { Router } from '../router.js';
import { HttpError, requireOperator, sendJson } from '../router.js';
import type { AppContext } from '../../app/context.js';
import type { AgentConfig } from '../../config/types.js';
import { sanitizeId } from '../../trust/sanitize.js';
import { agentPaths } from '../../app/scaffold.js';
import { listMarketplaces, addMarketplace, removeMarketplace, readEnabledPlugins, setEnabledPlugin, browseMarketplace } from '../../plugins/ccPlugins.js';
import type { PluginRouteContext, PluginToolPermission } from '../../plugins/types.js';
import { decidePermission, effectivePermissionMode, resolveRulePlaceholders, type PermissionDecision, type PermissionRuleSet } from '../../security/permission.js';

/** Evaluate a plugin tool's required capability against the requesting agent's
 *  security profile (the SAME gate built-in tools answer to). Fail closed when the
 *  profile is missing. The effective defaultMode + ask list honor the global
 *  permission posture so the gate mirrors the agent's settings.json exactly
 *  (FIX-agent-permissions-permissive): deny ALWAYS wins regardless of posture. */
function decideAgentToolPermission(ctx: AppContext, agent: AgentConfig, perm: PluginToolPermission): PermissionDecision {
  const profile = ctx.config.securityProfiles.find((p) => p.id === agent.securityProfile);
  if (profile === undefined) return 'deny';
  const vars = { AGENT_DIR: agentPaths(ctx.paths, sanitizeId(agent.id)).root };
  const posture = ctx.config.defaultPermissionMode ?? 'permissive';
  const effective = effectivePermissionMode(profile, posture);
  const bypass = effective === 'bypassPermissions';
  const rules: PermissionRuleSet = {
    mode: profile.mode,
    ...(effective !== undefined ? { defaultMode: effective } : {}),
    allow: resolveRulePlaceholders(profile.allow, vars),
    ask: bypass ? [] : resolveRulePlaceholders(profile.ask, vars),
    deny: resolveRulePlaceholders(profile.deny, vars),
  };
  return decidePermission(rules, { tool: perm.tool, ...(perm.specifier !== undefined ? { specifier: perm.specifier } : {}) });
}

/**
 * Plugins routes (FIX-plugins). Operator-gated, mirroring Connectors. Part A:
 * per-agent Claude Code plugin management (marketplaces + enabledPlugins over each
 * agent's config-root). Part B: the orchestrator extension host surface (loaded
 * plugins, their views, agent tools). Each loaded plugin's own HTTP route is
 * registered separately (registerPluginExtensionRoutes) so it is host-bearer-gated
 * and only ever sees the restricted PluginRouteContext.
 */
export function registerPluginRoutes(router: Router, ctx: AppContext): void {
  const cfgRoot = (id: string): string => agentPaths(ctx.paths, sanitizeId(id)).configRoot;
  const agentOrThrow = (rawId: string): AgentConfig => {
    const a = ctx.config.agents.find((x) => sanitizeId(x.id) === sanitizeId(rawId));
    if (a === undefined) throw new HttpError(404, `unknown agent: ${sanitizeId(rawId)}`);
    return a;
  };

  // ---------------- Part A: Claude Code per-agent plugin management ----------------
  router.get('/api/plugins/agent/:id', (c) => {
    requireOperator(c);
    const a = agentOrThrow(c.params.id ?? '');
    const root = cfgRoot(a.id);
    sendJson(c.res, 200, { agentId: sanitizeId(a.id), marketplaces: listMarketplaces(root), enabledPlugins: readEnabledPlugins(root) });
  });

  router.post('/api/plugins/agent/:id/marketplaces', (c) => {
    requireOperator(c);
    const a = agentOrThrow(c.params.id ?? '');
    const body = (c.body ?? {}) as { name?: string; source?: string };
    try {
      sendJson(c.res, 201, { marketplaces: addMarketplace(cfgRoot(a.id), { name: body.name ?? '', source: body.source ?? '' }) });
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : 'invalid marketplace');
    }
  });

  router.delete('/api/plugins/agent/:id/marketplaces/:name', (c) => {
    requireOperator(c);
    const a = agentOrThrow(c.params.id ?? '');
    sendJson(c.res, 200, { marketplaces: removeMarketplace(cfgRoot(a.id), decodeURIComponent(c.params.name ?? '')) });
  });

  // browse a marketplace's offered plugins — returns { browsable, plugins } so the
  // UI can distinguish "no marketplace" from "git/remote can't be enumerated here"
  // (FIX-hardening C). Local source → browsable when its marketplace.json is readable.
  router.get('/api/plugins/agent/:id/browse', (c) => {
    requireOperator(c);
    agentOrThrow(c.params.id ?? '');
    sendJson(c.res, 200, browseMarketplace(c.url.searchParams.get('source') ?? ''));
  });

  // enable/disable a plugin for one agent, or (allAgents) every agent's config-root.
  router.put('/api/plugins/agent/:id/enabled', (c) => {
    requireOperator(c);
    const a = agentOrThrow(c.params.id ?? '');
    const body = (c.body ?? {}) as { plugin?: string; enabled?: boolean; allAgents?: boolean };
    const plugin = (body.plugin ?? '').trim();
    if (plugin === '') throw new HttpError(400, 'plugin name required');
    const on = body.enabled === true;
    if (body.allAgents === true) {
      for (const ag of ctx.config.agents) setEnabledPlugin(cfgRoot(ag.id), plugin, on);
      sendJson(c.res, 200, { plugin, enabled: on, appliedTo: ctx.config.agents.length, restartRequired: true });
      return;
    }
    sendJson(c.res, 200, { enabledPlugins: setEnabledPlugin(cfgRoot(a.id), plugin, on), restartRequired: true });
  });

  // apply: restart the agent so Claude Code reloads its plugins (only if running).
  router.post('/api/plugins/agent/:id/apply', async (c) => {
    requireOperator(c);
    const a = agentOrThrow(c.params.id ?? '');
    const id = sanitizeId(a.id);
    let restarted = false;
    if (await ctx.supervisor.isRunning(id).catch(() => false)) {
      await ctx.supervisor.restart(id).catch(() => undefined);
      restarted = true;
    }
    sendJson(c.res, 200, { restarted });
  });

  // ---------------- Agent tool dispatch (FIX-plugins-toolcall) ----------------
  // The wired path by which an agent actually CALLS a plugin-registered tool by name.
  // Callable by an agent (gated against ITS profile) or by the operator on behalf of a
  // named agent. Only ENABLED plugins' tools resolve; the privilege gate is enforced
  // before running; the run is bounded + isolated (a throw/timeout → 502, host stays up).
  router.post('/api/agent-tools/:tool', async (c) => {
    const agentId = c.auth.kind === 'agent'
      ? sanitizeId(c.auth.agentId)
      : sanitizeId(((c.body ?? {}) as { agentId?: string }).agentId ?? '');
    if (agentId === '') throw new HttpError(400, 'agentId required (operator must name the requesting agent)');
    const agent = ctx.config.agents.find((a) => sanitizeId(a.id) === agentId);
    if (agent === undefined) throw new HttpError(404, `unknown agent: ${agentId}`);
    const toolName = c.params.tool ?? '';
    const args = ((c.body ?? {}) as { args?: Record<string, unknown> }).args ?? {};
    // FIRST: the host-owned CORE tool registry (browse / render_chart+render_diagram /
    // transcribe). Same privilege gate as plugin tools, then run with the rich context
    // (Files/settings/runner/vault) the host supplies — bounded by a timeout, isolated on throw.
    const core = ctx.coreTools.byName(toolName);
    if (core !== undefined) {
      if (core.requiredPermission !== undefined) {
        const decision = decideAgentToolPermission(ctx, agent, core.requiredPermission);
        if (decision !== 'allow') {
          const p = core.requiredPermission;
          const spec = p.specifier !== undefined ? `${p.tool}(${p.specifier})` : p.tool;
          throw new HttpError(403, `agent ${agentId} is not permitted to use '${toolName}' — ${spec} is ${decision} by its security profile`);
        }
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          Promise.resolve(core.run(args, ctx.buildCoreToolContext(agentId))),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`core tool ${toolName} timed out`)), 120_000); }),
        ]);
        sendJson(c.res, 200, { tool: core.name, plugin: 'core', result });
      } catch (err) {
        throw new HttpError(502, `agent tool '${toolName}' failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      return;
    }
    const found = ctx.pluginHost.agentToolByName(toolName);
    if (found === undefined) throw new HttpError(404, `no such enabled agent tool: ${toolName}`);
    // THE GATE: a declared capability the agent's profile does not ALLOW (deny or ask)
    // is refused — never silently run. A pure tool (no requiredPermission) skips the gate.
    if (found.requiredPermission !== undefined) {
      const decision = decideAgentToolPermission(ctx, agent, found.requiredPermission);
      if (decision !== 'allow') {
        const p = found.requiredPermission;
        const spec = p.specifier !== undefined ? `${p.tool}(${p.specifier})` : p.tool;
        throw new HttpError(403, `agent ${agentId} is not permitted to use '${toolName}' — ${spec} is ${decision} by its security profile`);
      }
    }
    try {
      const result = await ctx.pluginHost.invokeTool(found.pluginId, found.name, args, agentId);
      sendJson(c.res, 200, { tool: found.name, plugin: found.pluginId, result });
    } catch (err) {
      throw new HttpError(502, `plugin tool '${toolName}' failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // Cost dashboard: operator-editable price table + soft budget (FIX-plugin-cost-dashboard).
  // The view is framed in a no-JS sandboxed iframe, so the inputs persist via this route.
  // Stores non-secrets in settings (never the vault); NEVER writes config.billing.
  router.post('/api/plugins/cost/settings', (c) => {
    requireOperator(c);
    const body = (c.body ?? {}) as { prices?: Record<string, { inputPerM: number; outputPerM: number }>; budget?: { monthlyTokens?: number; monthlyUsd?: number } };
    if (body.prices !== undefined) ctx.settings.set('cost_prices', JSON.stringify(body.prices));
    if (body.budget !== undefined) ctx.settings.set('cost_budget', JSON.stringify(body.budget));
    sendJson(c.res, 200, { ok: true });
  });

  // ---------------- Part B: orchestrator extension host ----------------
  router.get('/api/plugins/extensions', (c) => {
    requireOperator(c);
    sendJson(c.res, 200, {
      plugins: ctx.pluginHost.list(),
      views: ctx.pluginHost.navViews(),
      tools: ctx.pluginHost.agentTools(),
    });
  });

  router.get('/api/plugins/ext/:pluginId/view/:viewId', async (c) => {
    requireOperator(c);
    const html = await ctx.pluginHost.renderView(c.params.pluginId ?? '', c.params.viewId ?? '');
    if (html === null) throw new HttpError(404, 'no such plugin view');
    sendJson(c.res, 200, { html });
  });

  // Enable/disable an extension plugin. This is the DELIBERATE operator action that
  // gates whether a plugin activates at all (see main.ts: enabled = config.plugins
  // ∪ this settings key). It takes effect on the next boot, hence restartRequired.
  router.put('/api/plugins/ext/:pluginId/enabled', (c) => {
    requireOperator(c);
    const pluginId = (c.params.pluginId ?? '').trim();
    if (pluginId === '') throw new HttpError(400, 'plugin id required');
    const on = ((c.body ?? {}) as { enabled?: boolean }).enabled === true;
    let ids: string[] = [];
    try { ids = (JSON.parse(ctx.settings.get('plugin-extensions-enabled') ?? '[]') as unknown[]).filter((x): x is string => typeof x === 'string'); } catch { ids = []; }
    const set = new Set(ids);
    if (on) set.add(pluginId); else set.delete(pluginId);
    ctx.settings.set('plugin-extensions-enabled', JSON.stringify([...set]));
    sendJson(c.res, 200, { pluginId, enabled: on, restartRequired: true });
  });
}

/**
 * Register each LOADED plugin's HTTP route on the main router. The host wrapper
 * bearer-gates it (requireOperator) and hands the plugin handler ONLY the
 * restricted PluginRouteContext — never the raw req/res, the token, or the ctx.
 * Call AFTER the plugin host has loaded (so routesForRouting is populated).
 */
export function registerPluginExtensionRoutes(router: Router, ctx: AppContext): void {
  for (const r of ctx.pluginHost.routesForRouting()) {
    router.register(r.method, `/api/plugins/ext/${r.pluginId}${r.path}`, async (c) => {
      requireOperator(c);
      const pctx: PluginRouteContext = {
        method: r.method,
        query: c.url.searchParams,
        body: c.body,
        json: (status, payload) => sendJson(c.res, status, payload),
      };
      const handled = await ctx.pluginHost.invokeRoute(r.pluginId, r.method, r.path, pctx);
      if (!handled) throw new HttpError(404, 'plugin route not found');
    });
  }
}
