// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createLogger } from '../core/log.js';
import {
  HOST_API_VERSION,
  type PluginModule,
  type PluginManifest,
  type HostApi,
  type PluginView,
  type PluginRoute,
  type PluginScheduledTask,
  type PluginAgentTool,
  type PluginToolPermission,
  type PluginRouteContext,
} from './types.js';

/**
 * The orchestrator extension host (FIX-plugins Part B). It loads enabled plugins,
 * hands each a RESTRICTED {@link HostApi}, and owns every registration so the host
 * stays the sole authority. Hard boundaries that hold by construction:
 *  - a plugin only ever gets the HostApi (register* + log) — never saveConfig, the
 *    vault, the billing mode, the bearer token, or agent spawning, so it cannot
 *    escalate privilege, change billing, or bypass auth;
 *  - a plugin route is invoked ONLY through the host's bearer-gated dispatcher;
 *  - a plugin that throws on load/register is isolated (logged + marked failed) and
 *    never crashes the supervisor or the other plugins.
 */

const log = createLogger('plugins');

/** A plugin id becomes a path segment in `/api/plugins/ext/<id>/...`, so it must be a
 *  single safe slug — no '/', no '..', no '%'. This is what stops a crafted manifest
 *  id from escaping its own route namespace. */
const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/i;
/** A plugin route path must be one or more safe, dot-free segments under a leading '/'
 *  (so no traversal, no extra ':' params, no namespace escape). */
const PLUGIN_ROUTE_PATH_RE = /^(?:\/[a-z0-9][a-z0-9_-]*)+$/i;
/** First path segments the host reserves for its own ext routes — a plugin route may
 *  not start with these (it would shadow the core view/enable routes for its id). */
const RESERVED_FIRST_SEGMENTS = new Set(['view', 'enabled']);

/** Default wall-clock ceiling for one plugin agent-tool invocation (ms). */
const DEFAULT_TOOL_TIMEOUT_MS = 20_000;

export interface PluginState {
  manifest: PluginManifest;
  status: 'active' | 'failed' | 'disabled';
  error?: string;
  views: string[];
  routes: string[];
  tasks: string[];
  tools: string[];
}

export class PluginHost {
  private readonly views = new Map<string, { pluginId: string; view: PluginView }>();
  private readonly routes = new Map<string, { pluginId: string; route: PluginRoute }>();
  private readonly tasks: Array<{ pluginId: string; task: PluginScheduledTask }> = [];
  private readonly tools = new Map<string, { pluginId: string; tool: PluginAgentTool }>();
  private readonly states = new Map<string, PluginState>();
  private readonly toolTimeoutMs: number;

  constructor(opts: { toolTimeoutMs?: number } = {}) {
    this.toolTimeoutMs = opts.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  }

  /** Activate one plugin module in isolation. Returns true iff it registered cleanly. */
  activate(mod: PluginModule, opts: { enabled?: boolean } = {}): boolean {
    const m = mod.manifest;
    if (m === undefined || typeof m.id !== 'string' || m.id === '') {
      log.warn('plugin has no valid manifest id — skipped');
      return false;
    }
    const state: PluginState = { manifest: m, status: 'active', views: [], routes: [], tasks: [], tools: [] };
    this.states.set(m.id, state);
    if (!PLUGIN_ID_RE.test(m.id)) {
      state.status = 'failed';
      state.error = `invalid plugin id (must match ${PLUGIN_ID_RE.source})`;
      log.warn('plugin id rejected — would escape its route namespace', { plugin: m.id });
      return false;
    }
    if (opts.enabled === false) { state.status = 'disabled'; return false; }
    if (m.apiVersion !== HOST_API_VERSION) {
      state.status = 'failed';
      state.error = `targets host API v${m.apiVersion}; host is v${HOST_API_VERSION}`;
      log.warn('plugin API version mismatch', { plugin: m.id, want: m.apiVersion, have: HOST_API_VERSION });
      return false;
    }
    try {
      mod.register(this.makeApi(m, state));
      log.info('plugin activated', { plugin: m.id, views: state.views.length, routes: state.routes.length, tasks: state.tasks.length, tools: state.tools.length });
      return true;
    } catch (err) {
      state.status = 'failed';
      state.error = err instanceof Error ? err.message : String(err);
      this.drop(m.id); // a partial registration is rolled back so it can't half-run
      log.error('plugin register() threw — isolated', { plugin: m.id, error: state.error });
      return false;
    }
  }

  /** First-party view mount (FIX-plugin-cost-dashboard): the SAME registry the SPA
   *  extension page reads. For trusted in-tree features that need a richer closure than
   *  the restricted HostApi exposes (the integrator supplies it). */
  registerFirstPartyView(v: PluginView): void {
    this.views.set(`cost-dashboard:${v.id}`, { pluginId: 'cost-dashboard', view: v });
    const st = this.states.get('cost-dashboard') ?? { manifest: { id: 'cost-dashboard', name: 'Cost dashboard', version: '1', apiVersion: HOST_API_VERSION }, status: 'active' as const, views: [], routes: [], tasks: [], tools: [] };
    st.views.push(v.id); this.states.set('cost-dashboard', st);
  }
  /** First-party scheduled task (picked up by the existing scheduledTasks() loop). */
  registerFirstPartyTask(task: PluginScheduledTask): void {
    this.tasks.push({ pluginId: 'cost-dashboard', task });
    const st = this.states.get('cost-dashboard') ?? { manifest: { id: 'cost-dashboard', name: 'Cost dashboard', version: '1', apiVersion: HOST_API_VERSION }, status: 'active' as const, views: [], routes: [], tasks: [], tools: [] };
    st.tasks.push(task.name); this.states.set('cost-dashboard', st);
  }

  /** The ONLY surface a plugin sees — no ctx, no token, no saveConfig/vault/billing/spawn. */
  private makeApi(m: PluginManifest, state: PluginState): HostApi {
    return {
      apiVersion: HOST_API_VERSION,
      pluginId: m.id,
      registerView: (v: PluginView) => { this.views.set(`${m.id}:${v.id}`, { pluginId: m.id, view: v }); state.views.push(v.id); },
      registerRoute: (r: PluginRoute) => {
        // Validate the path BEFORE registering: this throws inside register(), which
        // activate() catches + rolls back, so a malformed route fails the plugin
        // closed rather than minting a pattern outside its /api/plugins/ext/<id>/ subtree.
        if (typeof r.path !== 'string' || !PLUGIN_ROUTE_PATH_RE.test(r.path)) throw new Error(`invalid plugin route path: ${String(r.path)}`);
        if (RESERVED_FIRST_SEGMENTS.has(r.path.split('/')[1] ?? '')) throw new Error(`plugin route path may not start with a reserved segment: ${r.path}`);
        this.routes.set(`${m.id}:${r.method} ${r.path}`, { pluginId: m.id, route: r });
        state.routes.push(`${r.method} ${r.path}`);
      },
      registerScheduledTask: (t: PluginScheduledTask) => { this.tasks.push({ pluginId: m.id, task: t }); state.tasks.push(t.name); },
      registerAgentTool: (t: PluginAgentTool) => { this.tools.set(`${m.id}:${t.name}`, { pluginId: m.id, tool: t }); state.tools.push(t.name); },
      log: (msg: string) => log.info(`[plugin ${m.id}] ${msg}`),
    };
  }

  private drop(pluginId: string): void {
    for (const [k, v] of this.views) if (v.pluginId === pluginId) this.views.delete(k);
    for (const [k, v] of this.routes) if (v.pluginId === pluginId) this.routes.delete(k);
    for (const [k, v] of this.tools) if (v.pluginId === pluginId) this.tools.delete(k);
    for (let i = this.tasks.length - 1; i >= 0; i--) if (this.tasks[i]!.pluginId === pluginId) this.tasks.splice(i, 1);
  }

  list(): PluginState[] {
    return [...this.states.values()];
  }

  /** Nav metadata for the SPA's generic extension page. */
  navViews(): Array<{ pluginId: string; viewId: string; navLabel: string; icon?: string }> {
    return [...this.views.values()].map((v) => ({ pluginId: v.pluginId, viewId: v.view.id, navLabel: v.view.navLabel, ...(v.view.icon !== undefined ? { icon: v.view.icon } : {}) }));
  }

  /** Render a plugin view's HTML (isolated; a throwing render returns null). */
  async renderView(pluginId: string, viewId: string): Promise<string | null> {
    const entry = this.views.get(`${pluginId}:${viewId}`);
    if (entry === undefined) return null;
    try {
      return await entry.view.render();
    } catch (err) {
      log.warn('plugin view render threw', { plugin: pluginId, view: viewId, error: String(err) });
      return null;
    }
  }

  /** Dispatch a (host-bearer-gated) request to a plugin route. Returns false if unmatched. */
  async invokeRoute(pluginId: string, method: string, path: string, ctx: PluginRouteContext): Promise<boolean> {
    const entry = this.routes.get(`${pluginId}:${method} ${path}`);
    if (entry === undefined) return false;
    await entry.route.handler(ctx);
    return true;
  }

  /** Route metadata so the host can register each on the main (bearer-gated) router. */
  routesForRouting(): Array<{ pluginId: string; method: PluginRoute['method']; path: string }> {
    return [...this.routes.values()].map((r) => ({ pluginId: r.pluginId, method: r.route.method, path: r.route.path }));
  }

  /** The cron tasks plugins registered (the scheduler wraps each in isolation). */
  scheduledTasks(): Array<{ pluginId: string; task: PluginScheduledTask }> {
    return [...this.tasks];
  }

  agentTools(): Array<{ pluginId: string; name: string; schema: Record<string, unknown>; requiredPermission?: PluginToolPermission }> {
    return [...this.tools.values()].map((t) => ({ pluginId: t.pluginId, name: t.tool.name, schema: t.tool.schema, ...(t.tool.requiredPermission !== undefined ? { requiredPermission: t.tool.requiredPermission } : {}) }));
  }

  /** Resolve a bare tool name to its (enabled) owning plugin + declared permission.
   *  Only registered tools of activated plugins are in the map, so a disabled/removed
   *  plugin's tool is not found — the honest "only enabled tools are callable" surface.
   *  First registration wins on a name collision (deterministic). */
  agentToolByName(name: string): { pluginId: string; name: string; requiredPermission?: PluginToolPermission } | undefined {
    for (const t of this.tools.values()) {
      if (t.tool.name === name) return { pluginId: t.pluginId, name: t.tool.name, ...(t.tool.requiredPermission !== undefined ? { requiredPermission: t.tool.requiredPermission } : {}) };
    }
    return undefined;
  }

  /** Run a plugin agent-tool on behalf of an agent. The privilege gate (caller side,
   *  which has the agent's profile) stays authoritative; here the tool gets ONLY the
   *  agent id (no spawn/escalation, no billing/vault/saveConfig) and is BOUNDED by a
   *  timeout so a hanging tool can't wedge the caller. A throwing run rejects (the
   *  caller isolates it — the host + other plugins stay up). */
  async invokeTool(pluginId: string, name: string, args: Record<string, unknown>, agentId: string): Promise<unknown> {
    const entry = this.tools.get(`${pluginId}:${name}`);
    if (entry === undefined) throw new Error(`no such plugin tool: ${pluginId}/${name}`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve(entry.tool.run(args, { agentId })),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`plugin tool ${pluginId}/${name} timed out after ${this.toolTimeoutMs}ms`)), this.toolTimeoutMs); }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Load plugins from a directory: each subfolder is `<id>/manifest.json` +
   * `<id>/index.js` default-exporting `{ manifest, register }`. A load failure for
   * one plugin is isolated. `enabled` (if given) gates which ids activate.
   */
  async loadDir(dir: string, enabled?: Set<string>): Promise<void> {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const id = entry.name;
      try {
        const manifestPath = join(dir, id, 'manifest.json');
        const indexPath = join(dir, id, 'index.js');
        if (!existsSync(manifestPath) || !existsSync(indexPath)) { log.warn('plugin dir missing manifest/index', { plugin: id }); continue; }
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PluginManifest;
        const imported = (await import(pathToFileURL(indexPath).href)) as { default?: Partial<PluginModule>; register?: PluginModule['register'] };
        const register = imported.default?.register ?? imported.register;
        if (typeof register !== 'function') { log.warn('plugin has no register()', { plugin: id }); this.states.set(id, { manifest, status: 'failed', error: 'no register() export', views: [], routes: [], tasks: [], tools: [] }); continue; }
        this.activate({ manifest, register }, { enabled: enabled === undefined ? true : enabled.has(manifest.id) });
      } catch (err) {
        // ISOLATION at load time too — a broken plugin never takes the host down.
        log.error('plugin failed to load — isolated', { plugin: id, error: String(err) });
        this.states.set(id, { manifest: { id, name: id, version: '0', apiVersion: 0 }, status: 'failed', error: String(err), views: [], routes: [], tasks: [], tools: [] });
      }
    }
  }
}
