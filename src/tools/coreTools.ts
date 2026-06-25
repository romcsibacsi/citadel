// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { CoreToolRegistry, defaultCommandRunner, type CoreTool, type CoreToolContext, type CommandRunner } from './registry.js';
import { makeBrowseTool, type BrowseDeps } from './browse.js';
import { makeRenderChartTool, makeRenderDiagramTool } from './charts.js';
import { makeTranscribeTool } from './transcribe.js';
import { makeWebhookPostTool } from '../webhook/outbound.js';

/**
 * CORE agent-tool wiring (FIX-plugin-agent-tools). Assembles the three FIRST-PARTY
 * capability tools into a host-owned {@link CoreToolRegistry} the /api/agent-tools
 * route consults alongside the plugin host (SAME privilege gate). The tools need
 * Files/settings/runner/vault — which a third-party plugin's `{ agentId }`-only
 * context deliberately cannot reach — so they live here, behind the host, not in
 * the open plugin host.
 *
 * `deps.browse` lets the integrator inject the headless-browser launcher (the real
 * Playwright launcher is the default); everything else is deterministic / config-
 * driven, so no other injection is needed.
 */

export interface BuiltinToolsDeps {
  /** Optional browser/DNS injection for `browse` (tests; defaults to real Playwright). */
  browse?: BrowseDeps;
}

/** Build a registry holding the three built-in core tools. */
export function registerBuiltinTools(deps: BuiltinToolsDeps = {}): CoreToolRegistry {
  const registry = new CoreToolRegistry();
  registry.register(makeBrowseTool(deps.browse ?? {}));
  registry.register(makeRenderChartTool());
  registry.register(makeRenderDiagramTool());
  registry.register(makeTranscribeTool());
  registry.register(makeWebhookPostTool()); // outbound webhook (FIX-plugin-webhook), SSRF-guarded
  return registry;
}

export { CoreToolRegistry, defaultCommandRunner };
export type { CoreTool, CoreToolContext, CommandRunner };
