// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * Agent runtime abstraction (SPEC §0, §3). Everything above this interface is
 * transport-agnostic: the reference adapter drives an interactive Claude Code
 * TUI in tmux (subscription billing, SPEC §5), the fake adapter is in-memory
 * for tests/dev. ALL transport fragility lives behind this seam.
 */

/** Readiness of an agent's input surface, runtime-agnostic (SPEC §3). */
export type AgentBusyState = 'ready' | 'busy' | 'needs-input' | 'reauth-needed';

export interface AgentStatus {
  running: boolean;
  /** ISO timestamp of the last start, when known. */
  since?: string;
  busyState: AgentBusyState;
  /** True when the agent process is alive but its auth has expired (SPEC §3). */
  needsReauth: boolean;
  /** A transient API/network error banner is on the live footer (#86 hub-recovery). */
  apiTransientError?: boolean;
}

/** One item on the read-only live output stream (multicast by the supervisor). */
export interface OutputEvent {
  agentId: string;
  /** ISO timestamp. */
  ts: string;
  /**
   * - `output`: an appended raw text chunk (managed-process / fake adapters).
   * - `screen`: a full RENDERED pane snapshot that REPLACES the view — used by
   *   TUI adapters whose raw byte stream is full of cursor-positioning escapes
   *   and is unreadable when appended (SPEC §3 watch projection).
   * - `state`: a busy-state transition.
   */
  kind: 'output' | 'screen' | 'state';
  /** Text chunk (kind 'output') or full rendered snapshot (kind 'screen'). */
  text?: string;
  /** New busy state when kind === 'state'. */
  state?: AgentBusyState;
}

/** Fully-resolved launch parameters, produced by the roster/config layer. */
export interface AgentLaunchSpec {
  id: string;
  command: string;
  args: string[];
  cwd: string;
  /** Extra environment for the agent process. MUST NEVER contain ANTHROPIC_API_KEY (SPEC §5). */
  env: Record<string, string>;
  /** True = resume the prior conversation (--continue style); false = fresh context. */
  resume: boolean;
  /**
   * Pre-accept Claude Code's one-time "Bypass Permissions mode" prompt in the
   * isolated config dir (FIX-agent-permissions-permissive). Set for permissive-mode
   * profiles AND for strict profiles whose effective settings.json defaultMode is
   * bypassPermissions — otherwise such an agent wedges on the first-run accept.
   */
  acceptBypassPermissions?: boolean;
  /**
   * Set for a LOCAL-model (ollama) agent (FIX-local-model-agents). Carries the
   * resolved model so the adapter can preflight it against the operator's ollama
   * and point Claude Code at the local endpoint (ANTHROPIC_BASE_URL + dummy token)
   * instead of Anthropic. Absent for normal Claude agents (the default path).
   */
  localModel?: { model: string };
}

/**
 * The pluggable runtime adapter. Only the AgentSupervisor talks to it:
 * everything else goes through the supervisor's serialized injectInput /
 * multicast streamOutput (single-owner/single-serializer, SPEC §3).
 */
export interface AgentRuntimeAdapter {
  start(spec: AgentLaunchSpec): Promise<void>;
  stop(id: string): Promise<void>;
  isRunning(id: string): Promise<boolean>;
  status(id: string): Promise<AgentStatus>;
  writeInput(id: string, text: string): Promise<void>;
  /** Forward a single key (tmux send-keys name) to the live pane. Optional. */
  sendKey?(id: string, key: string): Promise<void>;
  /** Forward literal text to the live pane WITHOUT submitting (raw keystrokes). Optional. */
  writeLiteral?(id: string, text: string): Promise<void>;
  interrupt(id: string): Promise<void>;
  /** Subscribe to raw runtime output; returns an unsubscribe function. */
  subscribeOutput(id: string, cb: (e: OutputEvent) => void): () => void;
  /**
   * One-shot current-screen snapshot for a brand-new subscriber when the fan has
   * nothing cached yet (FIX-terminal-ux): returns the current `screen` frame, or
   * null when none is available. Optional — adapters without a screen omit it.
   */
  captureScreen?(id: string): Promise<OutputEvent | null>;
}
