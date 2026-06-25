// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { execFile } from 'node:child_process';
import type { PluginToolPermission } from '../plugins/types.js';
import type { FilesService } from '../files/service.js';
import type { SettingsStore } from '../settings/store.js';
import type { VaultStore } from '../vault/store.js';

/**
 * CORE agent-tool registry (FIX-plugin-agent-tools). The plugin-host's agent
 * tools only ever get `{ agentId }` by construction (the boundary that keeps a
 * third-party plugin from touching Files/settings/vault). The three FIRST-PARTY
 * capability tools (browse / render_chart+render_diagram / transcribe) DO need
 * those, so they live in a separate, host-owned core registry whose richer
 * {@link CoreToolContext} the orchestrator supplies. The /api/agent-tools/:tool
 * route consults THIS registry alongside the plugin host, applying the SAME
 * privilege gate (decidePermission against the requesting agent's profile) before
 * running. A core tool is still bounded + isolated by the caller.
 */

/** A bounded external-command runner (diagram renderer / whisper_cmd), injectable for tests. */
export type CommandRunner = (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>;

/**
 * Default command runner — argv array, NEVER a shell (so a template token can't be
 * interpreted as a shell metacharacter), bounded output buffer. Mirrors the studio
 * runner. The integrator passes this (or the studio runner) into the core context.
 */
export const defaultCommandRunner: CommandRunner = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, timeout: 180_000 }, (err, stdout, stderr) => {
      resolve({
        stdout: stdout ?? '',
        stderr: stderr ?? '',
        code: err && typeof (err as { code?: number }).code === 'number' ? (err as { code: number }).code : err ? 1 : 0,
      });
    });
  });

/** The rich context a CORE tool receives — strictly more than a plugin tool's `{ agentId }`,
 *  but still NEVER saveConfig, the billing mode, the bearer token, or agent spawning. */
export interface CoreToolContext {
  agentId: string;
  files: FilesService;
  /** Absolute path of the Files IMAGES root — where tool artifacts (screenshots, charts) are saved. */
  imagesDir: string;
  settings: SettingsStore;
  runner: CommandRunner;
  vault: VaultStore;
  fetchImpl: typeof fetch;
}

/** A core tool definition. `run` gets validated args + the rich context. */
export interface CoreTool {
  name: string;
  schema: Record<string, unknown>;
  /** Capability gated against the requesting agent's profile (omit for a pure tool). */
  requiredPermission?: PluginToolPermission;
  run: (args: Record<string, unknown>, ctx: CoreToolContext) => unknown | Promise<unknown>;
}

/**
 * The host-owned core-tool registry. First registration wins on a name collision
 * (deterministic), mirroring the plugin host. The route looks a tool up by name,
 * gates it, then runs it with the supplied context.
 */
export class CoreToolRegistry {
  private readonly tools = new Map<string, CoreTool>();

  register(tool: CoreTool): void {
    if (!this.tools.has(tool.name)) this.tools.set(tool.name, tool);
  }

  byName(name: string): CoreTool | undefined {
    return this.tools.get(name);
  }

  /** List surface (name + schema + declared permission) — no run fn leaks out. */
  list(): Array<{ name: string; schema: Record<string, unknown>; requiredPermission?: PluginToolPermission }> {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      schema: t.schema,
      ...(t.requiredPermission !== undefined ? { requiredPermission: t.requiredPermission } : {}),
    }));
  }
}
