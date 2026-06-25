// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * Orchestrator extension system (FIX-plugins Part B). A plugin = a manifest + a
 * module that registers through a small, VERSIONED host API. The host is the sole
 * authority: a plugin only ever touches the declared extension points and NEVER
 * gets the raw AppContext, the bearer token, saveConfig, the vault, or billing —
 * those boundaries are what keep a plugin from escalating an agent's privilege,
 * changing the billing mode, or bypassing auth.
 */

/** The host API version a plugin targets; bump on breaking changes. */
export const HOST_API_VERSION = 1;

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  author?: string;
  description?: string;
  /** The host-API version this plugin was written against. */
  apiVersion: number;
  /** Declared extension points / capabilities — nothing runs that isn't declared. */
  capabilities?: Array<'view' | 'route' | 'scheduledTask' | 'agentTool'>;
}

/** A view a plugin adds: a nav item + a SERVER-rendered HTML panel (the bundled SPA
 *  stays static; the host serves the plugin's HTML behind a generic extension page). */
export interface PluginView {
  id: string;
  navLabel: string;
  icon?: string;
  /**
   * Returns the panel-body HTML. This HTML is treated as UNTRUSTED: the dashboard
   * frames it in a fully-sandboxed iframe (no script execution, opaque origin), so
   * a plugin view can NEVER run JS in the operator origin or reach the bearer token.
   * It is therefore a STATIC panel — scripts in the returned HTML will not execute.
   */
  render: () => string | Promise<string>;
}

/** The restricted context a plugin route handler receives — NEVER the raw req/res
 *  or the token. The host has already bearer-gated + CSRF-checked the request. */
export interface PluginRouteContext {
  method: string;
  query: URLSearchParams;
  body: unknown;
  json: (status: number, payload: unknown) => void;
}
export interface PluginRoute {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Path under the plugin's namespace, e.g. '/items' → /api/plugins/ext/<id>/items. */
  path: string;
  handler: (ctx: PluginRouteContext) => void | Promise<void>;
}

export interface PluginScheduledTask {
  name: string;
  /** Cron expression on the existing scheduler. */
  schedule: string;
  run: () => void | Promise<void>;
}

/** The capability a plugin tool needs, expressed in the SAME vocabulary as a
 *  security-profile rule (e.g. tool 'Bash' + specifier 'curl *', or tool 'WebFetch').
 *  Before running the tool for an agent, the host evaluates this against THAT agent's
 *  profile via the permission gate — a profile that denies it refuses the call. A tool
 *  with no requiredPermission is a "pure" tool (no gated capability). */
export interface PluginToolPermission {
  tool: string;
  specifier?: string;
}

/** A tool offered to agents. It runs WITHIN the requesting agent's permission
 *  profile — the host enforces the privilege gate (against requiredPermission)
 *  before invoking it, bounds it with a timeout, and isolates a throwing run. */
export interface PluginAgentTool {
  name: string;
  schema: Record<string, unknown>;
  /** Capability gated against the requesting agent's profile (omit for a pure tool). */
  requiredPermission?: PluginToolPermission;
  run: (args: Record<string, unknown>, ctx: { agentId: string }) => unknown | Promise<unknown>;
}

/** The ONLY surface a plugin module can touch. No saveConfig / vault / billing / token. */
export interface HostApi {
  readonly apiVersion: number;
  readonly pluginId: string;
  registerView: (view: PluginView) => void;
  registerRoute: (route: PluginRoute) => void;
  registerScheduledTask: (task: PluginScheduledTask) => void;
  registerAgentTool: (tool: PluginAgentTool) => void;
  /** Namespaced logger (host-prefixed). */
  log: (message: string) => void;
}

export interface PluginModule {
  manifest: PluginManifest;
  register: (api: HostApi) => void;
}
