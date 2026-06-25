// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { createLogger } from '../core/log.js';
import { systemClock, type Clock } from '../core/clock.js';
import { footerRegion, readFooterSignals } from './claude/paneState.js';
import {
  evaluateFrozenTool,
  evaluateAlertOnly,
  evaluateHubModalRecovery,
  evaluateContextWindow,
  type FrozenToolMemory,
  type FrozenToolConfig,
  type AlertMemory,
  type HubModalMemory,
  type ContextWindowMemory,
  type ContextWindowConfig,
  type ContextWindowSample,
} from './watchers.js';
import { decideReap } from './reaper.js';
import { parentPid, cpuJiffies, procAvailable } from './procInfo.js';
import type { TmuxDriver, PaneInfo } from './claude/tmuxDriver.js';

const log = createLogger('runtime.watchers');

export interface WatcherDeps {
  driver: TmuxDriver;
  /** Live, non-hidden roster agent ids. */
  roster: () => string[];
  sessionName: (agentId: string) => string;
  /** Read the rendered pane for an agent (the live screen). */
  readScreen: (agentId: string) => Promise<string | undefined>;
  /** Respawn just this agent's session in place (never the server). */
  respawn: (agentId: string) => Promise<void>;
  /** Alert the operator (record-first, alert-only conditions). */
  alertOperator: (agentId: string, category: 'stuck-permission' | 'api-error', evidence: string) => void;
  /**
   * Dismiss the non-actionable end-of-session survey on an agent's pane
   * (FIX-agent-permissions-permissive §4) — Escape, the same key the input path
   * uses for modals. Best-effort; the watcher swallows failures.
   */
  dismissSurvey?: (agentId: string) => Promise<void>;
  /**
   * ACCEPT the one-time "Bypass Permissions mode" prompt (Down+Enter) so a bypass
   * agent never wedges on it (FIX-agent-permissions-permissive). Never Escape it —
   * Esc = cancel = exit. Best-effort; failures are swallowed.
   */
  acceptBypassPrompt?: (agentId: string) => Promise<void>;
  /**
   * Recover an agent from a blocking interactive question/choice picker
   * (FIX-telegram-hub-reply + #233 runtime-net): Escape it, then nudge the agent. No
   * agent has a human at its TTY — the hub is reached only through a channel (a picker
   * deadlocks it AND gates the operator's inbound messages), and a sub-agent has no
   * operator at all — so the wiring sends the hub a re-ask-on-channel nudge and a
   * sub-agent an escalate-via-agentctl nudge. Fleet-wide (#233): fires for ANY agent
   * that wedges on a picker, the symmetric counterpart to dismissSurvey/acceptBypass.
   * Best-effort; failures are swallowed. NEVER picks an option (Escape = decline, not
   * a silent default). Name kept historical (recoverHubModal) to keep the diff narrow.
   */
  recoverHubModal?: (agentId: string) => Promise<void>;
  /** Inject /compact into an agent (readiness-gated) — auto-compact (#296). Resolves true when the /compact was
   *  CONFIRMED delivered to an idle pane, false when it was dropped (pane busy past the readiness wait -> the
   *  caller must NOT arm the anti-thrash floor, so the next tick retries — #336). */
  injectCompact?: (agentId: string) => Promise<boolean>;
  /** Live context tokens for an agent's session, or null if unreadable — auto-compact (#296). */
  readContextTokens?: (agentId: string) => number | null;
  /** The agent's model context window in tokens — auto-compact (#296). */
  contextWindow?: (agentId: string) => number;
  /** Context-window auto-compact tuning (#296). Wired callbacks + enabled!==false turn it on. */
  autoCompact?: { enabled?: boolean; thresholdFraction?: number; minIntervalMs?: number };
  config?: Partial<FrozenToolConfig>;
  clock?: Clock;
}

const DEFAULT_FROZEN: FrozenToolConfig = {
  stagnationMs: 120_000, // 2 min of an unchanging screen
  cpuIdleBelow: 0.02,
  respawnGraceMs: 60_000,
};

/**
 * Record-first substrate watchers wired to the real runtime (SPEC §19a). Each
 * tick: detect frozen tool-calls (wall-clock stagnation + low CPU -> respawn in
 * place) and alert-only conditions (stuck permission / API error). Before any
 * spawn, orphan reaping is offered via reapOrphans() with the fail-safe refusal.
 */
export class WatcherService {
  private readonly clock: Clock;
  private readonly frozenCfg: FrozenToolConfig;
  private readonly frozenMem = new Map<string, FrozenToolMemory>();
  private readonly permMem = new Map<string, AlertMemory>();
  private readonly apiMem = new Map<string, AlertMemory>();
  private readonly hubModalMem = new Map<string, HubModalMemory>();
  private readonly cpuPrev = new Map<string, { jiffies: number; ms: number }>();
  private readonly compactMem = new Map<string, ContextWindowMemory>();
  private readonly compactCfg: ContextWindowConfig;
  private readonly compactEnabled: boolean;

  constructor(private readonly deps: WatcherDeps) {
    this.clock = deps.clock ?? systemClock;
    this.frozenCfg = { ...DEFAULT_FROZEN, ...deps.config };
    this.compactCfg = {
      thresholdFraction: deps.autoCompact?.thresholdFraction ?? 0.75,
      minIntervalMs: deps.autoCompact?.minIntervalMs ?? 10 * 60_000,
    };
    // DEFAULT-ON (#373): a recurring fleet-wide 100%-context wedge kept requiring a manual /compact (operator
    // escalation, operator), so auto-compact is now ON by default for EVERY wired agent — opt-OUT only
    // (autoCompact.enabled === false disables it). It still requires the runtime to have wired the I/O callbacks,
    // so a build/host without them stays inert (the watcher never injects blind). This reverses the #296 opt-in
    // default deliberately: "no agent should wedge" is now the standing policy, applied to running instances on
    // the next restart (no per-instance config.json edit needed — the seed entry is for fresh installs).
    this.compactEnabled =
      deps.autoCompact?.enabled !== false &&
      deps.injectCompact !== undefined &&
      deps.readContextTokens !== undefined &&
      deps.contextWindow !== undefined;
  }

  /** One watcher pass over the roster. */
  async tick(): Promise<void> {
    const panes = await this.safeListPanes();
    const nowMs = this.clock.now().getTime();
    for (const agentId of this.deps.roster()) {
      try {
        await this.evaluateAgent(agentId, panes, nowMs);
      } catch (err) {
        log.warn('watcher evaluation failed', { agentId, error: String(err) });
      }
    }
  }

  private async evaluateAgent(agentId: string, panes: PaneInfo[] | undefined, nowMs: number): Promise<void> {
    const screen = await this.deps.readScreen(agentId);
    if (screen === undefined) return; // not running / not capturable
    const footer = footerRegion(screen);
    const signals = readFooterSignals(footer);

    // "Bypass Permissions mode" acceptance prompt: ACCEPT it (a fresh bypass session
    // shows it and the flag does not auto-accept; Esc would EXIT). Handled before the
    // stuck-permission alert so it never escalates as a wedge (FIX-agent-permissions-permissive).
    if (signals.bypassPrompt && this.deps.acceptBypassPrompt !== undefined) {
      try {
        await this.deps.acceptBypassPrompt(agentId);
      } catch (err) {
        log.warn('bypass-prompt acceptance failed', { agentId, error: String(err) });
      }
      return; // re-evaluate next tick once accepted
    }

    // Non-actionable end-of-session survey: auto-dismiss so an unattended agent
    // can't wedge waiting for input nobody will type (FIX-agent-permissions-permissive
    // §4). Scoped to the survey signal specifically — never a generic modal, which
    // could be a real choice the operator must answer.
    if (signals.survey && this.deps.dismissSurvey !== undefined) {
      try {
        await this.deps.dismissSurvey(agentId);
      } catch (err) {
        log.warn('survey dismissal failed', { agentId, error: String(err) });
      }
      return; // re-evaluate next tick once the survey is cleared
    }

    // Alert-only: stuck permission prompt + auth/API error (never auto-act).
    const permAction = evaluateAlertOnly(
      agentId,
      'stuck-permission',
      signals.modal,
      'a permission/choice prompt is waiting',
      this.memOf(this.permMem, agentId),
    );
    if (permAction.kind === 'alert-operator') {
      this.deps.alertOperator(agentId, permAction.category, permAction.evidence);
    }
    const apiAction = evaluateAlertOnly(
      agentId,
      'api-error',
      signals.authError,
      'an auth/API error is on screen',
      this.memOf(this.apiMem, agentId),
    );
    if (apiAction.kind === 'alert-operator') {
      this.deps.alertOperator(agentId, apiAction.category, apiAction.evidence);
    }

    // Interactive-picker recovery (FIX-telegram-hub-reply + #233 runtime-net). No agent
    // has a human at its TTY: the hub is reached only through a channel, and a sub-agent
    // has no operator at all — so a blocking AskUserQuestion picker can never be answered
    // locally and wedges the agent terminally (for the hub it also gates the operator's
    // inbound messages). After a short grace, Escape it (DECLINE, never select) + nudge
    // the agent (the wiring sends the hub a re-ask-on-channel nudge and a sub-agent an
    // escalate-via-agentctl nudge). FLEET-WIDE (#233): no longer isHub-gated, so any agent
    // that falls onto a picker is auto-recovered — defense-in-depth beside the seed-doc
    // contract. Scoped NARROWLY to the picker signal — NOT signals.modal: a real
    // tool-permission / trust-folder prompt must stay strictly alert-only (handled above)
    // and must never be auto-Escaped (Esc there denies a tool or exits the session). Also
    // gated on !activeTurn / !idlePrompt so a working or idle agent is never touched (a
    // live picker is neither). The hub-vs-sub-agent nudge difference lives in the wiring.
    if (this.deps.recoverHubModal !== undefined) {
      const pickerPresent = signals.picker && !signals.activeTurn && !signals.idlePrompt;
      const action = evaluateHubModalRecovery(agentId, pickerPresent, nowMs, this.hubMemOf(agentId));
      if (action.kind === 'recover-hub-modal') {
        try {
          await this.deps.recoverHubModal(agentId);
        } catch (err) {
          log.warn('picker recovery failed', { agentId, error: String(err) });
        }
        return; // re-evaluate next tick; retry is cooldown-gated if it persists
      }
    }

    // Context-window auto-compact (#296): inject /compact into a heavy session BEFORE it fills its window
    // and wedges ("No response from API · Retrying") -- a wedged hub halts dispatch and stalls the fleet.
    // Window-RELATIVE threshold (works across the mixed 1M/200k fleet) + record-first anti-thrash (a fresh
    // memory after a restart never suppresses an already-over-threshold session). The inject is readiness-
    // gated (injectInput waits for the pane to be idle) + task-state-preserving (/compact), and fire-and-
    // forget so a slow readiness wait never stalls the tick.
    if (this.compactEnabled) {
      const sample: ContextWindowSample = {
        agentId,
        contextTokens: this.deps.readContextTokens?.(agentId) ?? null,
        windowTokens: this.deps.contextWindow?.(agentId) ?? 200_000,
        nowMs,
      };
      const mem = this.compactMemOf(agentId);
      const action = evaluateContextWindow(sample, mem, this.compactCfg);
      if (action.kind === 'inject-compact') {
        log.warn('auto-compact: context near window, injecting /compact to prevent a wedge', {
          agentId,
          contextTokens: sample.contextTokens,
          windowTokens: sample.windowTokens,
          fraction: this.compactCfg.thresholdFraction,
        });
        // Arm the anti-thrash floor ONLY on a CONFIRMED injection (#336). A dropped /compact (pane busy past
        // injectInput's readiness wait -> the promise resolves false / rejects) must leave the floor un-armed
        // so the NEXT tick retries, instead of a 10min unprotected window letting the session reach 100% (the
        // #296 named residual). Non-blocking (no await) so a slow readiness wait never stalls the tick.
        void Promise.resolve(this.deps.injectCompact?.(agentId)).then((delivered) => {
          if (delivered === true) mem.lastCompactMs = nowMs;
        }, () => undefined);
      }
    }

    // Frozen tool-call applies ONLY during an ACTIVE turn. An IDLE agent (at its
    // prompt) naturally has an unchanging screen + ~0 CPU — that is normal, NOT a
    // frozen tool-call. Without this gate the watcher respawns every idle agent
    // every stagnationMs, thrashing the whole fleet (SPEC §3a turn-scoped busy /
    // §19a). A genuinely frozen tool-call still shows the spinner/interrupt hint
    // (activeTurn) stuck, so we lose no real detection.
    if (!signals.activeTurn) return;

    // Frozen tool-call: stagnant screen + low CPU -> respawn in place. Only
    // meaningful with /proc CPU sampling; on a non-Linux host it never fires.
    const cpu = this.sampleCpu(agentId, panes, nowMs);
    if (cpu === undefined) return;
    const frozen = evaluateFrozenTool(
      { agentId, screen, cpu, nowMs },
      this.memOf(this.frozenMem, agentId),
      this.frozenCfg,
    );
    if (frozen.kind === 'respawn-in-place') {
      log.warn('frozen tool-call: respawning in place', { agentId, evidence: frozen.evidence });
      await this.deps.respawn(agentId);
    }
  }

  /**
   * Reap orphaned processes before a spawn (SPEC §19a). PURE attribution via the
   * live pane pids + the process tree; FAIL SAFE if panes are undeterminable.
   * `candidates` are pids the caller suspects (e.g. from a pidfile/env scan).
   */
  async reapOrphans(candidates: number[], kill: (pid: number) => void): Promise<void> {
    const panes = await this.safeListPanes();
    const livePanePids = panes === undefined ? undefined : new Set(panes.map((p) => p.pid));
    for (const pid of candidates) {
      const decision = decideReap({ pid, livePanePids, parentOf: (p) => parentPid(p) });
      if (decision.reap) {
        log.warn('reaping orphan process', { pid });
        try {
          kill(pid);
        } catch (err) {
          log.warn('reap kill failed', { pid, error: String(err) });
        }
      } else if (decision.reason === 'panes-undeterminable') {
        log.warn('refusing to reap: live panes undeterminable (fail-safe)', { pid });
      }
    }
  }

  /** Returns undefined when the pane set genuinely can't be determined (server down/error). */
  private async safeListPanes(): Promise<PaneInfo[] | undefined> {
    try {
      if (!(await this.deps.driver.serverRunning())) return [];
      return await this.deps.driver.listPanes();
    } catch {
      return undefined; // can't determine -> fail-safe everywhere downstream
    }
  }

  /** CPU fraction since the last sample for the agent's pane pid. */
  private sampleCpu(agentId: string, panes: PaneInfo[] | undefined, nowMs: number): number | undefined {
    if (!procAvailable() || panes === undefined) return undefined;
    const session = this.deps.sessionName(agentId);
    const pane = panes.find((p) => p.session === session);
    if (pane === undefined) return undefined;
    const jiffies = cpuJiffies(pane.pid);
    if (jiffies === undefined) return undefined;
    const prev = this.cpuPrev.get(agentId);
    this.cpuPrev.set(agentId, { jiffies, ms: nowMs });
    if (prev === undefined || nowMs <= prev.ms) return undefined;
    // jiffies are 1/HZ s (HZ typically 100). fraction = Δjiffies / (Δs * HZ).
    const elapsedS = (nowMs - prev.ms) / 1000;
    const HZ = 100;
    return Math.max(0, (jiffies - prev.jiffies) / (elapsedS * HZ));
  }

  private memOf<T>(map: Map<string, T>, agentId: string): T {
    let m = map.get(agentId);
    if (m === undefined) {
      m = (map === (this.frozenMem as unknown) ? {} : { alerted: false }) as T;
      map.set(agentId, m);
    }
    return m;
  }

  private compactMemOf(agentId: string): ContextWindowMemory {
    let m = this.compactMem.get(agentId);
    if (m === undefined) {
      m = {};
      this.compactMem.set(agentId, m);
    }
    return m;
  }

  private hubMemOf(agentId: string): HubModalMemory {
    let m = this.hubModalMem.get(agentId);
    if (m === undefined) {
      m = {};
      this.hubModalMem.set(agentId, m);
    }
    return m;
  }
}
