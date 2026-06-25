// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * Reference AgentRuntimeAdapter: one interactive Claude Code instance per
 * agent, driven inside a tmux session (SPEC §0, §3, §5).
 *
 * Subscription-billing invariant (SPEC §5, §20.11): ANTHROPIC_API_KEY must
 * NEVER reach the agent process — a stray key silently flips even the
 * interactive TUI to metered API billing. start() refuses a spec that carries
 * one AND force-unsets any inherited copy via `env -u` in the launch command.
 * The ONLY base-URL/token carve-out is a local-model (ollama) agent, and only
 * for a host that passes BOTH the sync isPrivateBaseUrl gate AND the async
 * resolve-and-refuse (every resolved A/AAAA non-public) — a name that resolves
 * to any public IP is refused, so the carve-out can never bill Anthropic.
 *
 * All tmux interaction goes through the injected TmuxDriver so unit tests run
 * without tmux. Output streaming works by pipe-pane'ing the session to a log
 * file and tailing it from the last read offset on an injectable interval.
 */

import { existsSync, lstatSync, readFileSync, realpathSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDir, atomicWriteFile } from '../../core/fsx.js';
import { BILLING_ENV_DENYLIST, billingEnvViolations } from '../../core/billing.js';
import { isPrivateBaseUrl, normalizeBaseUrl, assertPrivateResolvedHost } from '../../core/url.js';
import { defaultResolver, type DnsResolver } from '../../tools/ssrf.js';
import { ollamaModels } from '../../studio/brain.js';
import { isoNow, systemClock, type Clock } from '../../core/clock.js';
import { createLogger } from '../../core/log.js';
import type {
  AgentLaunchSpec,
  AgentRuntimeAdapter,
  AgentStatus,
  OutputEvent,
} from '../types.js';
import {
  classifyPaneState,
  footerRegion,
  isAuthError,
  paneStateToBusyState,
  readFooterSignals,
  type PaneState,
} from './paneState.js';
import type { TmuxDriver } from './tmuxDriver.js';

const log = createLogger('runtime.claude');

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Lines captured for the watch/terminal screen snapshot — deep enough for scrollback. */
const STATUS_CAPTURE_LINES = 30;
/** Lines captured for the live watch snapshot (whole TUI screen + a little scrollback). */
const SCREEN_CAPTURE_LINES = 400;
const DEFAULT_POLL_MS = 500;
/** Idle double-sample gap (SPEC §3a): a momentary blank must not read as ready. */
const DEFAULT_IDLE_CONFIRM_MS = 250;
/** Post-respawn grace window: recovery paths must not stack restarts (SPEC §3a). */
const DEFAULT_RESPAWN_GRACE_MS = 30_000;
/** Bounded retries when delivered input doesn't land in the live input box (SPEC §3a). */
const INPUT_DELIVERY_RETRIES = 2;
/** Claude Code stores its per-config-dir state (incl. onboarding) here. */
const CLAUDE_CONFIG_FILE = '.claude.json';

/**
 * Ensure the agent's isolated config dir is marked onboarded BEFORE the first
 * launch, so Claude Code skips its interactive first-run prompts — the theme
 * picker AND the per-folder "do you trust this folder?" dialog — either of
 * which would leave the agent stuck waiting for a keypress. Only missing flags
 * are filled (merge); existing state and operator edits are preserved. Writes
 * happen before the session starts, so there is no race with a live agent.
 */
export function ensureClaudeOnboarded(
  configDir: string,
  onboardingVersion: string,
  projectDir?: string,
  opts: { acceptBypassPermissions?: boolean } = {},
): void {
  const file = join(configDir, CLAUDE_CONFIG_FILE);
  let data: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      data = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    } catch {
      data = {};
    }
  }
  let changed = false;
  if (data.hasCompletedOnboarding !== true) {
    data.hasCompletedOnboarding = true;
    data.lastOnboardingVersion = onboardingVersion;
    changed = true;
  }
  // permissive (--dangerously-skip-permissions) profiles otherwise block on a
  // one-time "Bypass Permissions mode" acceptance prompt on first launch
  if (opts.acceptBypassPermissions === true && data.bypassPermissionsModeAccepted !== true) {
    data.bypassPermissionsModeAccepted = true;
    changed = true;
  }
  if (projectDir !== undefined && projectDir !== '') {
    const projects = (typeof data.projects === 'object' && data.projects !== null
      ? (data.projects as Record<string, Record<string, unknown>>)
      : {});
    const project = projects[projectDir] ?? {};
    if (project.hasTrustDialogAccepted !== true || project.hasCompletedProjectOnboarding !== true) {
      project.hasTrustDialogAccepted = true;
      project.hasCompletedProjectOnboarding = true;
      projects[projectDir] = project;
      data.projects = projects;
      changed = true;
    }
  }
  if (!changed) return;
  ensureDir(configDir, 0o700);
  atomicWriteFile(file, JSON.stringify(data, null, 2), 0o600);
}

/**
 * Read the HOST's shared subscription token status (for the operator's
 * "refresh shared auth" surface). Shared-subscription agents symlink this one
 * file; when it is missing/expired the operator must re-auth ONCE on the host
 * (`claude` login) — this reports whether that is needed.
 */
export function readSharedAuthStatus(homeDir = process.env.HOME): { present: boolean; expiresAt: number | null; expired: boolean } {
  if (homeDir === undefined || homeDir === '') return { present: false, expiresAt: null, expired: true };
  const src = join(homeDir, '.claude', '.credentials.json');
  if (!existsSync(src)) return { present: false, expiresAt: null, expired: true };
  try {
    const data = JSON.parse(readFileSync(src, 'utf8')) as { claudeAiOauth?: { expiresAt?: number }; expiresAt?: number };
    const expiresAt = data.claudeAiOauth?.expiresAt ?? data.expiresAt ?? null;
    return { present: true, expiresAt, expired: expiresAt !== null && expiresAt <= Date.now() };
  } catch {
    return { present: true, expiresAt: null, expired: false }; // present but unparseable — treat as usable
  }
}

/**
 * Share the host's subscription OAuth login into the agent's isolated config
 * dir (SPEC §5: "default auth is the host's subscription OAuth login"). Without
 * this the fresh per-agent config dir is unauthenticated and Claude Code falls
 * back to metered API billing — exactly what the subscription invariant forbids.
 * A SYMLINK (not a copy) means every agent shares the one token and a refresh
 * lands in one place; a copy would let agents rotate the token out from under
 * each other. No-op when the host uses keychain auth or isn't logged in (the
 * reauth escalation path then surfaces it to the operator).
 */
export function ensureSharedSubscriptionAuth(configDir: string, homeDir = process.env.HOME): void {
  if (homeDir === undefined || homeDir === '') return;
  const src = join(homeDir, '.claude', '.credentials.json');
  const dst = join(configDir, '.credentials.json');
  if (!existsSync(src)) return; // keychain auth / not logged in — nothing to share
  // REPAIR, don't skip. The old `if (existsSync(dst)) return` could not tell a
  // symlink from a regular file, so when Claude Code performs an in-pane /login it
  // atomic-renames a REAL .credentials.json over the symlink and the agent is
  // PERMANENTLY decoupled from the shared subscription (its standalone token then
  // expires on its own → endless /login). On every start, verify dst is a symlink
  // that still resolves to src; otherwise remove it and re-link, so a decoupled
  // agent self-heals on its next restart.
  try {
    const st = lstatSync(dst); // throws ENOENT when absent (normal first run)
    if (st.isSymbolicLink()) {
      try { if (realpathSync(dst) === realpathSync(src)) return; } catch { /* broken link → re-link */ }
    }
    unlinkSync(dst); // regular file (decoupled) OR wrong-target/broken symlink
    log.info('repaired decoupled shared-subscription credential link', { agentDir: configDir });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') log.warn('could not inspect shared subscription credentials', { agentDir: configDir, error: String(err) });
  }
  try {
    ensureDir(configDir, 0o700);
    symlinkSync(src, dst);
  } catch (err) {
    log.warn('could not link shared subscription credentials', { agentDir: configDir, error: String(err) });
  }
}

/** Read the host's onboarding version so seeded agents match the live CLI. */
function hostOnboardingVersion(): string {
  try {
    const home = process.env.HOME;
    if (home === undefined) return 'orchestrator';
    const host = JSON.parse(readFileSync(join(home, CLAUDE_CONFIG_FILE), 'utf8')) as {
      lastOnboardingVersion?: string;
    };
    return host.lastOnboardingVersion ?? 'orchestrator';
  } catch {
    return 'orchestrator';
  }
}

/** Schedule fn every ms; returns a cancel function. Injectable for tests. */
export type ScheduleInterval = (fn: () => void, ms: number) => () => void;

const defaultScheduleInterval: ScheduleInterval = (fn, ms) => {
  const timer = setInterval(fn, ms);
  timer.unref?.();
  return () => clearInterval(timer);
};

export interface ClaudeCodeAdapterOptions {
  driver: TmuxDriver;
  /** tmux session prefix; session name = <sessionPrefix>-<agentId>. */
  sessionPrefix: string;
  /** Directory for the per-agent pipe-pane logs (<logDir>/<agentId>.log). */
  logDir: string;
  pollMs?: number;
  /** Gap between the two idle samples (SPEC §3a double-sample). */
  idleConfirmMs?: number;
  /** Grace window after a (re)spawn during which recovery won't restart again. */
  respawnGraceMs?: number;
  clock?: Clock;
  scheduleInterval?: ScheduleInterval;
  /** Injectable sleep for deterministic double-sample tests. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Billing resolver (FIX-billing-api-optin), read per-launch. When it returns
   * mode='api' with an apiKey, the adapter DELIBERATELY injects ANTHROPIC_API_KEY
   * into the agent env (the single sanctioned exception to the billing strip) and
   * skips the shared-subscription OAuth link. Absent / 'subscription' → today's
   * behavior exactly (no key ever injected).
   */
  billing?: () => { mode: 'subscription' | 'api'; apiKey?: string };
  /**
   * Local-model endpoint resolver (FIX-local-model-agents), read per-launch. For an
   * agent whose spec carries `localModel`, the adapter points Claude Code at THIS
   * ollama base URL (ANTHROPIC_BASE_URL + a dummy ANTHROPIC_AUTH_TOKEN) instead of
   * Anthropic — but ONLY when the URL passes BOTH the sync isPrivateBaseUrl gate AND
   * the async assertPrivateResolvedHost resolve-gate (every A/AAAA non-public). A
   * public/Anthropic URL, an unset one, or any host that resolves public is refused,
   * never billed (subscription-billing invariant, SPEC §5).
   */
  localOllamaUrl?: () => string | undefined;
  /** Injectable fetch for the local-model reachability/model preflight (default: global fetch). */
  fetchImpl?: typeof fetch;
  /**
   * Injectable DNS resolver for the local-model billing resolve-gate (FIX-hardening
   * Part A; default = ssrf.ts defaultResolver). Lets the public/private resolution
   * check be unit-tested offline.
   */
  resolveHost?: DnsResolver;
}

interface TailState {
  file: string;
  offset: number;
  cancel: () => void;
}

export class ClaudeCodeAdapter implements AgentRuntimeAdapter {
  private readonly driver: TmuxDriver;
  private readonly sessionPrefix: string;
  private readonly logDir: string;
  private readonly pollMs: number;
  private readonly idleConfirmMs: number;
  private readonly respawnGraceMs: number;
  private readonly clock: Clock;
  private readonly scheduleInterval: ScheduleInterval;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly billing?: () => { mode: 'subscription' | 'api'; apiKey?: string };
  private readonly localOllamaUrl?: () => string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly resolveHost: DnsResolver;

  /** Start timestamps (epoch ms) for sessions started/adopted by this process. */
  private readonly startedAtMs = new Map<string, number>();
  private readonly startedAtIso = new Map<string, string>();
  /**
   * Turn-scoped busy flag (SPEC §3a): set when input is submitted, cleared when
   * idle is confirmed. While set, the agent is "typing" (busy) regardless of
   * spinner-word matching — the runtime counter, not the words, decides.
   */
  private readonly turnActive = new Map<string, boolean>();
  private readonly tails = new Map<string, TailState>();
  private readonly subs = new Map<string, Set<(e: OutputEvent) => void>>();
  /**
   * Last non-blank rendered screen per agent — replayed to a new subscriber so a
   * freshly-opened watch view shows the current state immediately, instead of a
   * blank panel until the agent's next change (SPEC §17).
   */
  private readonly lastScreen = new Map<string, string>();

  constructor(opts: ClaudeCodeAdapterOptions) {
    this.driver = opts.driver;
    this.sessionPrefix = opts.sessionPrefix;
    this.logDir = opts.logDir;
    this.pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
    this.idleConfirmMs = opts.idleConfirmMs ?? DEFAULT_IDLE_CONFIRM_MS;
    this.respawnGraceMs = opts.respawnGraceMs ?? DEFAULT_RESPAWN_GRACE_MS;
    this.clock = opts.clock ?? systemClock;
    this.scheduleInterval = opts.scheduleInterval ?? defaultScheduleInterval;
    this.sleep = opts.sleep ?? delay;
    this.billing = opts.billing;
    this.localOllamaUrl = opts.localOllamaUrl;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.resolveHost = opts.resolveHost ?? defaultResolver;
  }

  private sessionName(id: string): string {
    return `${this.sessionPrefix}-${id}`;
  }

  private nowMs(): number {
    return this.clock.now().getTime();
  }

  async start(spec: AgentLaunchSpec): Promise<void> {
    const offending = billingEnvViolations(spec.env);
    if (offending.length > 0) {
      throw new Error(
        `refusing to start agent ${spec.id}: ${offending.join(', ')} present in launch env ` +
          '(subscription-billing invariant, SPEC §5 — such variables flip the TUI to metered/external billing)',
      );
    }
    const name = this.sessionName(spec.id);

    // IDEMPOTENT / ADOPT (SPEC §3a): the session is owned by the dedicated tmux
    // SERVER, not by this process — a supervisor restart finds it already alive.
    // Never recreate it (that drops the operator's attach + the agent's state);
    // just re-wire the watch stream and return.
    if (await this.driver.hasSession(name)) {
      this.attach(spec.id, name);
      log.info('adopted existing agent session', { agentId: spec.id, session: name });
      return;
    }

    // The agent receives ONLY this allowlist (driver uses env -i); the billing
    // denylist is stripped here too as defense in depth.
    const env = { ...spec.env };
    for (const billing of BILLING_ENV_DENYLIST) delete env[billing];

    // Local-model (ollama) agent (FIX-local-model-agents): the SECOND sanctioned
    // exception to the strip — point Claude Code at the operator's LOCAL ollama
    // (free, local — bills nobody) instead of Anthropic. Deliberately set the dummy
    // token + base URL, but ONLY for a PRIVATE/local endpoint. TWO gates back the
    // subscription-billing invariant (SPEC §5, FIX-hardening Part A): (1) the cheap
    // SYNC isPrivateBaseUrl (rejects literal public IPs + cloud FQDNs) and (2) an
    // async resolve-and-refuse — assertPrivateResolvedHost RESOLVES the host and
    // refuses unless EVERY A/AAAA is non-public, so a split-horizon / search-domain
    // NAME that maps to a public IP can never be billed. A public URL / unset URL /
    // any-public-resolution is REFUSED with NO tmux session created (never a bare
    // token, never a cloud base URL). Then the honest reachability/model preflight.
    const localModel = spec.localModel;
    if (localModel !== undefined) {
      const ollamaUrl = this.localOllamaUrl?.();
      if (ollamaUrl === undefined || ollamaUrl.trim() === '' || !isPrivateBaseUrl(ollamaUrl)) {
        throw new Error(
          `refusing to start local-model agent ${spec.id}: ollama base URL "${ollamaUrl ?? '(unset)'}" is not a ` +
            'configured PRIVATE/local endpoint (subscription-billing invariant, SPEC §5 — the dummy-token carve-out ' +
            'never points at a public IP or api.anthropic.com). Set ollama_url to your local/LAN ollama.',
        );
      }
      // Resolve-and-refuse: a NAME that resolves to any public IP is refused here,
      // BEFORE any env injection or session creation (SPEC §5).
      await assertPrivateResolvedHost(ollamaUrl, { resolver: this.resolveHost });
      const models = await ollamaModels(ollamaUrl, this.fetchImpl);
      if (models === null) throw new Error(`local-model agent ${spec.id}: ollama unreachable at ${ollamaUrl}`);
      if (!models.includes(localModel.model)) {
        throw new Error(
          `local-model agent ${spec.id}: model ${localModel.model} not found on ollama at ${ollamaUrl} ` +
            `(available: ${models.slice(0, 8).join(', ') || 'none'})`,
        );
      }
      env.ANTHROPIC_BASE_URL = normalizeBaseUrl(ollamaUrl);
      env.ANTHROPIC_AUTH_TOKEN = 'ollama'; // dummy: local ollama ignores it; satisfies the CLI
    }

    // API billing mode (FIX-billing-api-optin): the ONE sanctioned exception to the
    // strip. ONLY when the operator has DELIBERATELY set mode='api' AND provided a
    // vault key do we inject it (agents bill pay-as-you-go). subscription mode (the
    // default) NEVER injects a key — even if one sits in the vault. The strip above
    // already removed any accidental key from spec.env; this re-adds ONLY the
    // deliberate vault key, never an inherited ambient one. Mutually exclusive with
    // the local-model path (a local agent talks to ollama, not Anthropic).
    const billing = this.billing?.();
    const apiMode = localModel === undefined && billing?.mode === 'api' && billing.apiKey !== undefined && billing.apiKey !== '';
    if (apiMode) env.ANTHROPIC_API_KEY = billing!.apiKey!;

    // Skip Claude Code's interactive first-run flow in the agent's isolated
    // config dir — otherwise the session blocks on the theme/trust/bypass prompt.
    // The bypass-accept is needed for permissive-mode profiles (--dangerously-skip-
    // permissions) AND for strict profiles whose settings.json defaultMode is
    // bypassPermissions (FIX-agent-permissions-permissive) — the spec flags the latter.
    const acceptBypass = spec.acceptBypassPermissions === true || spec.args.includes('--dangerously-skip-permissions');
    const configDir = env.CLAUDE_CONFIG_DIR;
    if (configDir !== undefined && configDir !== '') {
      ensureClaudeOnboarded(configDir, hostOnboardingVersion(), spec.cwd, { acceptBypassPermissions: acceptBypass });
      // subscription creds only in subscription mode — in api/local-model mode the
      // injected key/dummy-token takes precedence over the shared-subscription link.
      if (!apiMode && localModel === undefined) ensureSharedSubscriptionAuth(configDir);
    }

    // The ADAPTER owns the resume flag (SPEC §3a): --continue ONLY for an agent
    // with prior state; a brand-new agent must NOT resume (nothing to continue).
    // specFactory MUST NOT also add it — that double-flag was a real launch bug.
    const args = spec.resume ? [...spec.args, '--continue'] : [...spec.args];
    await this.driver.newSession({ name, cwd: spec.cwd, env, command: spec.command, args });

    // `new-session -d` returns before the pane registers, and an immediately
    // exiting command vanishes the session — confirm liveness before wiring up.
    let alive = false;
    for (let attempt = 0; attempt < 15; attempt++) {
      if (await this.driver.hasSession(name)) {
        alive = true;
        break;
      }
      await this.sleep(100);
    }
    if (!alive) {
      throw new Error(
        `agent ${spec.id} exited immediately after launch (tmux session ${name} not found; ` +
          `check the command: ${spec.command} ${args.join(' ')})`,
      );
    }

    this.attach(spec.id, name);
    log.info('claude session started', { agentId: spec.id, session: name, resume: spec.resume });

    // Bypass agents: auto-accept the one-time "Bypass Permissions mode" prompt that a
    // fresh session shows on launch (FIX-agent-permissions-permissive). Bounded poll so
    // an unattended agent never wedges on it; deny stays enforced via settings.json.
    if (spec.acceptBypassPermissions === true) {
      void this.settleBypassPrompt(spec.id, name);
    }
  }

  /** Watch a freshly-launched bypass agent for the acceptance prompt and accept it. */
  private async settleBypassPrompt(id: string, name: string): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt++) {
      await this.sleep(300);
      try {
        if (!(await this.driver.hasSession(name))) return; // gone
        const signals = readFooterSignals(footerRegion(await this.driver.capturePane(name, STATUS_CAPTURE_LINES)));
        if (signals.bypassPrompt) {
          await this.acceptBypassPrompt(name);
          log.info('accepted bypass-permissions prompt on launch', { agentId: id });
          return;
        }
        if (signals.idlePrompt || signals.activeTurn) return; // booted past it (or resumed clean)
      } catch (err) {
        log.debug('bypass-prompt settle probe failed', { agentId: id, error: String(err) });
      }
    }
  }

  /** Wire the on-disk log + live screen poll + start bookkeeping for a session. */
  private attach(id: string, name: string): void {
    ensureDir(this.logDir);
    const logFile = join(this.logDir, `${id}.log`);
    void this.driver.pipeToFile(name, logFile).catch((err: unknown) =>
      log.warn('pipe-pane wiring failed', { agentId: id, error: String(err) }),
    );
    this.startedAtMs.set(id, this.nowMs());
    this.startedAtIso.set(id, isoNow(this.clock));
    this.turnActive.set(id, false);
    this.startScreenPoll(id);
  }

  async stop(id: string): Promise<void> {
    this.stopTail(id);
    await this.driver.killSession(this.sessionName(id)); // tolerant of absence
    this.startedAtMs.delete(id);
    this.startedAtIso.delete(id);
    this.turnActive.delete(id);
    this.lastScreen.delete(id); // a stopped session's screen must not replay on restart
    log.info('claude session stopped', { agentId: id, session: this.sessionName(id) });
  }

  /**
   * Recovery = respawn-in-place (SPEC §3a): replace ONLY this agent's session,
   * never the tmux server. Honors a post-respawn grace window so stacked
   * recovery paths don't restart the same agent repeatedly. Returns true if it
   * respawned, false if it deferred to the grace window.
   */
  async respawn(spec: AgentLaunchSpec): Promise<boolean> {
    const startedAt = this.startedAtMs.get(spec.id);
    if (startedAt !== undefined && this.nowMs() - startedAt < this.respawnGraceMs) {
      log.info('respawn deferred: inside grace window', { agentId: spec.id });
      return false;
    }
    await this.stop(spec.id);
    await this.start(spec);
    return true;
  }

  async isRunning(id: string): Promise<boolean> {
    return this.driver.hasSession(this.sessionName(id));
  }

  async status(id: string): Promise<AgentStatus> {
    const name = this.sessionName(id);
    if (!(await this.driver.hasSession(name))) {
      // busyState 'busy' is the safe non-injectable answer for a down agent.
      return { running: false, busyState: 'busy', needsReauth: false };
    }
    const state = await this.sampleState(id, name);
    const footer = footerRegion(await this.driver.capturePane(name, STATUS_CAPTURE_LINES));
    const signals = readFooterSignals(footer);
    const busyState = paneStateToBusyState(state, signals.authError);
    if (state === 'idle') this.turnActive.set(id, false); // confirmed idle ends the turn
    const since = this.startedAtIso.get(id);
    return {
      running: true,
      ...(since !== undefined ? { since } : {}),
      busyState,
      needsReauth: busyState === 'reauth-needed',
      ...(signals.apiTransientError ? { apiTransientError: true } : {}),
    };
  }

  /**
   * One discrete-state read (SPEC §3a). An apparent 'idle' is confirmed with a
   * second sample ~idleConfirmMs later (a momentary blank between turns must not
   * be read as ready); any non-idle second sample keeps it busy/typing.
   */
  private async sampleState(id: string, name: string): Promise<PaneState> {
    const turn = this.turnActive.get(id) ?? false;
    const first = classifyPaneState(footerRegion(await this.driver.capturePane(name, STATUS_CAPTURE_LINES)), turn);
    if (first !== 'idle') return first;
    await this.sleep(this.idleConfirmMs);
    if (!(await this.driver.hasSession(name))) return 'unknown';
    return classifyPaneState(footerRegion(await this.driver.capturePane(name, STATUS_CAPTURE_LINES)), turn);
  }

  /**
   * Deliver input on the real path (SPEC §3a): dismiss any modal first, mark a
   * turn as started (turn-scoped busy), deliver literal chunks + separate submit
   * via the driver, then a bounded retry if the live input box still shows the
   * text un-submitted. All of this sits behind the supervisor's single
   * serializer, so machine and operator input never interleave.
   */
  async writeInput(id: string, text: string): Promise<void> {
    const name = this.sessionName(id);
    await this.dismissModal(id, name);
    this.turnActive.set(id, true);
    await this.driver.sendText(name, text);

    // Bounded retry: if the footer still looks like an un-submitted input box
    // carrying our text (delivery didn't land), re-submit, scoped to this agent.
    for (let attempt = 0; attempt < INPUT_DELIVERY_RETRIES; attempt++) {
      await this.sleep(this.idleConfirmMs);
      let footer: string;
      try {
        footer = footerRegion(await this.driver.capturePane(name, STATUS_CAPTURE_LINES));
      } catch {
        return; // session gone — nothing to retry against
      }
      const signals = readFooterSignals(footer);
      if (signals.activeTurn || !signals.idlePrompt) return; // accepted: a turn is running
      // still an idle box -> the submit may not have landed; press Enter again
      await this.driver.sendKey(name, 'Enter');
    }
  }

  /** Clear a blocking modal before delivering input: ACCEPT the bypass-mode prompt
   *  (Esc would EXIT the agent), else Escape a survey/resume/trust/choice modal. */
  private async dismissModal(id: string, name: string): Promise<void> {
    try {
      const signals = readFooterSignals(footerRegion(await this.driver.capturePane(name, STATUS_CAPTURE_LINES)));
      if (signals.bypassPrompt) {
        await this.acceptBypassPrompt(name);
      } else if (signals.modal) {
        await this.driver.sendKey(name, 'Escape');
        await this.sleep(this.idleConfirmMs);
      }
    } catch (err) {
      log.debug('modal dismissal probe failed', { agentId: id, error: String(err) });
    }
  }

  /**
   * Accept the one-time "Bypass Permissions mode" prompt: move to "Yes, I accept"
   * (Down) and confirm (Enter). Current Claude Code shows it on every fresh bypass
   * session and does NOT auto-accept via the flag/.claude.json, so an unattended
   * agent would wedge here forever (FIX-agent-permissions-permissive). deny rules in
   * settings.json are still enforced after acceptance.
   */
  private async acceptBypassPrompt(name: string): Promise<void> {
    await this.driver.sendKey(name, 'Down');
    await this.sleep(this.idleConfirmMs);
    await this.driver.sendKey(name, 'Enter');
    await this.sleep(this.idleConfirmMs);
  }

  async sendKey(id: string, key: string): Promise<void> {
    await this.driver.sendKey(this.sessionName(id), key);
  }

  /** Type literal text into the live pane without submitting (raw keystrokes, §6). */
  async writeLiteral(id: string, text: string): Promise<void> {
    await this.driver.sendLiteral(this.sessionName(id), text);
  }

  async interrupt(id: string): Promise<void> {
    await this.driver.sendKey(this.sessionName(id), 'Escape');
  }

  subscribeOutput(id: string, cb: (e: OutputEvent) => void): () => void {
    let set = this.subs.get(id);
    if (!set) {
      set = new Set();
      this.subs.set(id, set);
    }
    set.add(cb);
    // Ensure the live screen poll is running for this agent. An ADOPTED session
    // (already alive at supervisor boot, so start()/attach() never ran for it)
    // would otherwise never produce a snapshot — the watch view would stay blank.
    // Idempotent: a freshly-started/attached agent already has a poll, so skip.
    if (!this.tails.has(id)) this.startScreenPoll(id);
    // Replay the current screen so a freshly-opened watch view shows state NOW,
    // not a blank panel until the agent's next change (SPEC §17). Deferred one
    // tick: a caller (the supervisor fan) registers its real subscriber
    // synchronously *after* subscribeOutput returns, so replaying inline would
    // fan out to an empty set and be lost.
    queueMicrotask(() => {
      if (!set.has(cb)) return;
      const snapshot = this.lastScreen.get(id);
      if (snapshot === undefined || snapshot.trim() === '') return;
      try {
        cb({ agentId: id, ts: isoNow(this.clock), kind: 'screen', text: snapshot });
      } catch (err) {
        log.warn('initial screen replay threw', { agentId: id, error: String(err) });
      }
    });
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      set.delete(cb);
    };
  }

  /**
   * One-shot current screen for a brand-new subscriber (FIX-terminal-ux): the
   * cached snapshot if the poll has produced one, otherwise a live capturePane so
   * even a just-opened terminal on an idle agent shows the screen immediately.
   */
  async captureScreen(id: string): Promise<OutputEvent | null> {
    const cached = this.lastScreen.get(id);
    if (cached !== undefined && cached.trim() !== '') {
      return { agentId: id, ts: isoNow(this.clock), kind: 'screen', text: cached };
    }
    const name = this.sessionName(id);
    try {
      if (!(await this.driver.hasSession(name))) return null;
      const screen = await this.driver.capturePane(name, SCREEN_CAPTURE_LINES);
      if (screen.trim() === '') return null;
      this.lastScreen.set(id, screen);
      return { agentId: id, ts: isoNow(this.clock), kind: 'screen', text: screen };
    } catch (err) {
      log.warn('one-shot screen capture failed', { agentId: id, error: String(err) });
      return null;
    }
  }

  // ---- live screen snapshots ----------------------------------------------

  private startScreenPoll(id: string): void {
    this.stopTail(id);
    let last = '';
    const cancel = this.scheduleInterval(() => {
      void this.pollScreen(id, () => last, (s) => {
        last = s;
      });
    }, this.pollMs);
    this.tails.set(id, { file: '', offset: 0, cancel });
  }

  private stopTail(id: string): void {
    const tail = this.tails.get(id);
    if (!tail) return;
    tail.cancel();
    this.tails.delete(id);
  }

  /**
   * One watch tick: capture the RENDERED pane (no cursor-positioning escapes)
   * and emit a full-screen snapshot when it changed. The dashboard replaces the
   * view with each snapshot — a true "watch this terminal" projection.
   */
  private async pollScreen(id: string, getLast: () => string, setLast: (s: string) => void): Promise<void> {
    const name = this.sessionName(id);
    try {
      if (!(await this.driver.hasSession(name))) return;
      const screen = await this.driver.capturePane(name, SCREEN_CAPTURE_LINES);
      // A momentary blank capture (alt-screen mid-redraw) must NOT wipe a good
      // snapshot — treat whitespace-only output as "no update" (SPEC §3a/§17).
      if (screen.trim() === '') return;
      this.lastScreen.set(id, screen); // cache latest good screen for new-subscriber replay
      if (screen === getLast()) return;
      setLast(screen);
      this.emit(id, { agentId: id, ts: isoNow(this.clock), kind: 'screen', text: screen });
    } catch (err) {
      log.warn('screen capture failed', { agentId: id, error: String(err) });
    }
  }

  private emit(id: string, event: OutputEvent): void {
    for (const cb of [...(this.subs.get(id) ?? [])]) {
      try {
        cb(event);
      } catch (err) {
        log.warn('output subscriber threw', { agentId: id, error: String(err) });
      }
    }
  }
}
