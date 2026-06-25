// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OrchestratorConfig, StatePaths } from '../config/types.js';
import type { AgentLaunchSpec } from '../runtime/types.js';
import { sanitizeId } from '../trust/sanitize.js';
import { agentPaths, loadAgentToken, repoRoot } from './scaffold.js';
import { effectivePermissionMode } from '../security/permission.js';
import { agentWorktreePath } from '../runtime/gitWorktree.js';

/**
 * Builds the per-agent launch spec for the Claude Code adapter (SPEC §3, §5).
 * Env reaches the agent only through the adapter; ANTHROPIC_API_KEY is never
 * present (the adapter additionally refuses + unsets — §20.11).
 */
export function buildSpecFactory(deps: {
  config: () => OrchestratorConfig;
  paths: StatePaths;
  serverUrl: string;
}): (agentId: string, opts: { fresh: boolean }) => AgentLaunchSpec {
  return (agentId, { fresh }) => {
    const config = deps.config();
    const id = sanitizeId(agentId);
    const agent = config.agents.find((a) => sanitizeId(a.id) === id);
    if (!agent) throw new Error(`no such agent in roster: ${agentId}`);
    const ap = agentPaths(deps.paths, id);
    if (loadAgentToken(deps.paths, id) === undefined) {
      throw new Error(`agent token missing for ${id}; run scaffolding first`);
    }

    const profile = config.securityProfiles.find((p) => p.id === agent.securityProfile);
    const args: string[] = [];

    // resume only when the agent has prior state (a session marker exists) and
    // a fresh restart wasn't requested. The ADAPTER translates spec.resume into
    // the single --continue flag — specFactory MUST NOT add it (double-flag bug).
    const resume = !fresh && existsSync(ap.sessionMarker);
    if (!existsSync(ap.sessionMarker)) writeFileSync(ap.sessionMarker, new Date().toISOString(), { mode: 0o600 });

    const model = agent.model !== undefined ? (config.modelAliases[agent.model] ?? agent.model) : undefined;
    // single-quote-safe: the model id reaches tmux through escapeShellArg (§3a).
    if (model !== undefined) args.push('--model', model);
    // Bypass-mode agents launch with --dangerously-skip-permissions. This is the
    // ONLY thing that auto-accepts Claude Code's one-time "Bypass Permissions mode"
    // warning prompt (a settings.json defaultMode:bypassPermissions still shows that
    // modal and would wedge an unattended agent — bypassPermissionsModeAccepted in
    // .claude.json does NOT suppress it). It is BOTH the permissive-mode profiles
    // (full-host/trusted-build) AND strict profiles relaxed to bypassPermissions by
    // the permissive posture (FIX-agent-permissions-permissive). The flag skips the
    // PROMPT, never the deny list: Claude always enforces permissions.deny (the
    // strict profiles ship a settings.json carrying deny), so sudo/etc stay blocked.
    const posture = config.defaultPermissionMode ?? 'permissive';
    const strictBypass = profile?.mode === 'strict' && effectivePermissionMode(profile, posture) === 'bypassPermissions';
    const bypass = profile?.mode === 'permissive' || strictBypass;
    if (bypass) args.push('--dangerously-skip-permissions');
    const acceptBypassPermissions = bypass;

    const env: Record<string, string> = {
      HOME: process.env.HOME ?? '/root',
      PATH: `${join(repoRoot(), 'scripts')}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      LANG: process.env.LANG ?? 'C.UTF-8',
      CLAUDE_CONFIG_DIR: ap.configRoot,
      AGENT_ID: id,
      // the agent's OWN isolated git worktree (#44): it must do ALL git work here,
      // never in the shared canonical checkout (parallel agents share it). The
      // supervisor provisions this path before start; the instruction in CLAUDE.md
      // tells the agent to `cd "$AGENT_REPO"` for git.
      AGENT_REPO: agentWorktreePath(deps.paths.agentsDir, id),
      // the token VALUE never enters argv/launch strings — agentctl reads the
      // 0600 file path instead (secrets-in-argv hardening, SPEC §16/§20.6)
      AGENT_TOKEN_FILE: ap.tokenFile,
      ORCHESTRATOR_URL: deps.serverUrl,
      // Disable Claude Code's end-of-session feedback survey + telemetry pings: an
      // unattended sub-agent has no human to answer the survey, and it can wedge an
      // agent waiting for input (FIX-agent-permissions-permissive §4).
      DISABLE_TELEMETRY: '1',
    };

    // Local-model (ollama) agent marker (FIX-local-model-agents): the adapter reads
    // this to point Claude Code at the operator's private ollama instead of Anthropic.
    // Carries the resolved model for the adapter's reachability/model preflight.
    const localModel = agent.runtime === 'ollama' && model !== undefined ? { model } : undefined;

    return {
      id,
      command: config.runtime.claude.command,
      args,
      cwd: ap.workDir,
      env,
      resume,
      acceptBypassPermissions,
      ...(localModel !== undefined ? { localModel } : {}),
    };
  };
}
