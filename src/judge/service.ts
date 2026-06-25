// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { type Clock, systemClock, isoNow } from '../core/clock.js';
import { createLogger } from '../core/log.js';
import { sanitizeId } from '../trust/sanitize.js';
import { guessLane } from '../kanban/laneRouter.js';
import type { LaneConfig } from '../config/types.js';
import { PanelStore, type CreatePanelSpec, type Panel, type JudgeRole, type PanelSolution, type Decision, type GateStage, type GateStatus, type PanelGate } from './store.js';
import { renderSolverTemplate, renderJudgePlaceholder, renderProbeTemplate, renderOracleTemplate, renderReviewTemplate, type FrozenSolution } from './templates.js';
import { parseVerdicts, type ParseResult } from './verdictParse.js';
import { decideWinner, type DecisionRuleConfig, type RuleInputsSnapshot, type SolutionInputs } from './decisionRule.js';
import { HARD_LOCKED_CATEGORIES } from '../autonomy/ladder.js';

const HARD_LOCKED: ReadonlySet<string> = new Set(HARD_LOCKED_CATEGORIES);
/** Recognized panel action categories: the default safe one + the hard-locked set. An
 *  unknown category is REFUSED at create AND fail-closed (operator hand-off) at apply, so
 *  a typo of a hard-locked label (e.g. 'payments') can never bypass the lock. */
const PANEL_CATEGORIES: ReadonlySet<string> = new Set(['code_change', ...HARD_LOCKED_CATEGORIES]);

const log = createLogger('judge-panel');

/**
 * Judge-panel orchestration (BUILD-judge-panel Phase 1): create + atomic fan-out +
 * dispatch + collect. Panelists are ALWAYS the already-running interactive agents,
 * driven through the existing kanban move→onDispatch→injectInput path (delivery for
 * a running agent) or a durable MessageStore enqueue (a down agent) — NEVER the
 * metered Agent-SDK / background-task path (subscription-billing invariant, SPEC §5).
 */

export const DEFAULT_TEST_COMMAND = 'npm run typecheck && npm test';
export const DEFAULT_SOLVER_TIMEOUT_MS = 30 * 60 * 1000; // ~30 min, aligned with background timeout

export const DEFAULT_RUBRIC = {
  criteria: [
    { id: 'correctness', description: 'Correctly achieves the goal; load-bearing claims hold', type: 'score', weight: 2, fatalIf: 'a load-bearing claim is verified-false' },
    { id: 'robustness', description: 'Handles edge cases + failure modes', type: 'score', weight: 1 },
    { id: 'simplicity', description: 'Minimal; no needless complexity', type: 'score', weight: 1 },
  ],
};
export const DEFAULT_DECISION_RULE = {
  ruleId: 'veto-score-tiebreak-v1',
  vetoOn: ['fatalDefect'],
  weights: { correctness: 2, robustness: 1, majorDefectPenalty: 1 },
  tieBreakChain: ['fewerMajor', 'fewerMinor', 'higherCorrectness', 'lanePriority'],
  lanePriority: [] as string[],
  noWinnerIfAllVetoed: true,
};

const PANEL_AUTHOR = 'nexus'; // the decider/orchestrator identity on the audit trail

/**
 * The git/process seam for the gate (Phase 4). Injected so the gate logic + state
 * machine is unit-testable with stubs; the real implementation shells out to git +
 * the panel's testCommand (NEVER a metered Claude path — this is CI, not panel work).
 */
export interface GateRunner {
  /** Refuse to start if the winner's work is not branch-isolated (no main commits). */
  branchIsolated: (branch: string) => Promise<{ isolated: boolean; evidence: string }>;
  /** Run the panel's testCommand against the branch; evidence = captured pass/fail log. */
  runTests: (branch: string, command: string) => Promise<{ passed: boolean; log: string }>;
  /** Merge/apply the winner's branch (only reached AFTER the hard predicate passes). */
  merge: (branch: string) => Promise<{ merged: boolean; evidence: string }>;
  /** Auto-archive a losing/abandoned branch (keep for forensics, never delete). The
   *  panelId disambiguates the forensic tag so a re-run with the same goal+solver (hence
   *  the same branch name) never overwrites a prior panel's archive pointer. */
  archiveBranch: (branch: string, panelId: number) => Promise<void>;
  /** Provision a solver's OWN worktree at `path` on `branch` (created from the base if
   *  absent) so parallel solvers work + commit in isolation — never the shared checkout. */
  prepareWorktree: (opts: { path: string; branch: string }) => Promise<{ ok: boolean; evidence: string }>;
  /** The tip commit sha of a branch (the solver's produced commit on its branch), or null. */
  branchHead: (branch: string) => Promise<string | null>;
  /** Remove a solver worktree dir on panel terminal (never deletes the branch). */
  removeWorktree: (path: string) => Promise<void>;
}

export interface PanelServiceDeps {
  store: PanelStore;
  /** kanban surface: move (dispatch), comment (audit), update (re-template / approval flag), get. */
  kanban: {
    move: (id: number, to: 'planned' | 'in_progress' | 'waiting' | 'done') => unknown;
    comment: (cardId: number, author: string, body: string) => unknown;
    update: (id: number, fields: { description?: string | null; requiresApproval?: boolean }) => unknown;
    get: (id: number) => { title: string; requiresApproval?: boolean } | undefined;
  };
  /** The gate's git/test/merge seam (Phase 4). */
  gate: GateRunner;
  /** Durable verdict-artifact seam (v1.1): the judge WRITES its verdict JSON to verdictPath
   *  (stated in the template), the panel READS it back on the finish edge — immune to TUI
   *  redraw / 8-line-tail truncation. `key` ∈ {'probe','oracle','review'}. */
  artifacts: {
    verdictPath: (panelId: number, key: string) => string;
    read: (absPath: string) => string | undefined;
    /** Absolute, per-solver worktree path (v1.1 Part B): each solver works in its own. */
    worktreePath: (panelId: number, agentId: string) => string;
  };
  /** Live agent run-state, used to choose dispatch (running) vs durable (down). */
  isRunning: (agentId: string) => Promise<boolean>;
  /** Durable delivery for a DOWN panelist (MessageStore.enqueue → DeliveryService). */
  enqueue: (msg: { sender: string; recipient: string; body: string }) => void;
  /** Direct re-inject into a running pane (supervisor.injectInput, source:'machine',
   *  NOT force) — used to re-prompt a judge ONCE after a malformed verdict. */
  inject: (agentId: string, text: string) => void;
  /** Read a panelist's pane answer (ActivityMonitor.tail). */
  tail: (agentId: string, n?: number) => string[];
  notifyOperator: (text: string) => void;
  /** Valid roster agent ids (config.agents). */
  roster: () => string[];
  lanes: () => LaneConfig[];
  /** Observability: emit a webhook event on every panel state transition (optional). */
  emitEvent?: (kind: 'panel.transition', data: Record<string, unknown>) => void;
  clock?: Clock;
  solverTimeoutMs?: number;
}

export interface CreatePanelInput {
  goal: string;
  context?: string;
  solvers?: Array<{ agentId: string; angle?: string }>;
  judges?: Array<{ role: JudgeRole; agentId: string }>;
  rubric?: unknown;
  decisionRule?: unknown;
  testCommand?: string;
  branchPrefix?: string;
  /** Action category for the apply-boundary autonomy check; defaults to 'code_change'. */
  category?: string;
  /** The principal initiating the panel (operator vs agent id); stamped by the route. */
  initiatedBy?: string;
}

export class PanelError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

/** A flattened view of the gate stages + THE hard apply predicate. `absent` = the
 *  stage has not run yet. `allPassed` = branch+test+review+approve all `passed`. */
export interface GateSummary {
  branch: GateStatus | 'absent';
  test: GateStatus | 'absent';
  review: GateStatus | 'absent';
  approve: GateStatus | 'absent';
  apply: GateStatus | 'absent';
  allPassed: boolean;
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'task';
}

export class PanelService {
  private readonly clock: Clock;
  private readonly solverTimeoutMs: number;

  constructor(private readonly deps: PanelServiceDeps) {
    this.clock = deps.clock ?? systemClock;
    this.solverTimeoutMs = deps.solverTimeoutMs ?? DEFAULT_SOLVER_TIMEOUT_MS;
  }

  /** All panels, newest first. */
  list(): Panel[] {
    return this.deps.store.list();
  }

  /** Transition the panel status AND emit the observability event (structured row +
   *  kanban comment are written by the callers; this adds the webhook edge). */
  private transition(panelId: number, to: Panel['status']): void {
    this.deps.store.setStatus(panelId, to);
    const panel = this.deps.store.getPanel(panelId);
    try {
      this.deps.emitEvent?.('panel.transition', { panelId, status: to, ...(panel ? { category: panel.category } : {}) });
    } catch {
      /* observability is best-effort; never fail a transition on a webhook */
    }
  }

  /** Full replayable state for one panel: goal + solutions + judges + verdicts + decision + gate + summary. */
  getFull(id: number): {
    panel: Panel;
    goal: string;
    solutions: ReturnType<PanelStore['solutions']>;
    judges: ReturnType<PanelStore['judges']>;
    verdicts: ReturnType<PanelStore['verdicts']>;
    decision: ReturnType<PanelStore['decision']>;
    gates: PanelGate[];
    gateSummary: GateSummary;
  } | undefined {
    const panel = this.deps.store.getPanel(id);
    if (panel === undefined) return undefined;
    return {
      panel,
      goal: this.deps.kanban.get(panel.parentCardId)?.title ?? '',
      solutions: this.deps.store.solutions(id),
      judges: this.deps.store.judges(id),
      verdicts: this.deps.store.verdicts(id),
      decision: this.deps.store.decision(id),
      gates: this.deps.store.gates(id),
      gateSummary: this.gateSummary(id),
    };
  }

  /** Lane-auto-pick: every distinct agent whose lane keyword matches the task text. */
  private autoPickSolvers(text: string): string[] {
    const lanes = this.deps.lanes();
    const picked: string[] = [];
    for (const lane of lanes) {
      // guessLane over a single-lane list = "does THIS lane match the text?"
      if (guessLane(text, [lane]) !== null) {
        const id = sanitizeId(lane.agentId);
        if (id !== '' && !picked.includes(id)) picked.push(id);
      }
    }
    return picked;
  }

  /**
   * Create a panel: validate, render templates, atomically create the cards + rows,
   * comment, and dispatch the solvers concurrently. Returns the created panel.
   */
  async createPanel(input: CreatePanelInput): Promise<Panel> {
    if (typeof input.goal !== 'string' || input.goal.trim() === '') {
      throw new PanelError('goal_required', 'a panel goal is required');
    }
    const roster = new Set(this.deps.roster().map((a) => sanitizeId(a)));

    // solvers: explicit or lane-auto-picked from the task text
    const rawSolvers =
      input.solvers !== undefined && input.solvers.length > 0
        ? input.solvers.map((s) => ({ agentId: sanitizeId(s.agentId), angle: s.angle ?? '' }))
        : this.autoPickSolvers(`${input.goal} ${input.context ?? ''}`).map((id) => ({ agentId: id, angle: '' }));
    // de-dup solver ids (a solver can appear once)
    const seen = new Set<string>();
    const solvers = rawSolvers.filter((s) => s.agentId !== '' && !seen.has(s.agentId) && seen.add(s.agentId));
    if (solvers.length < 2) {
      throw new PanelError('too_few_solvers', `a panel needs ≥2 solvers (got ${solvers.length}); specify them explicitly`);
    }

    // judges: fixed PROBE + ORACLE (v1)
    const judges =
      input.judges !== undefined && input.judges.length > 0
        ? input.judges.map((j) => ({ role: j.role, agentId: sanitizeId(j.agentId) }))
        : [{ role: 'probe' as JudgeRole, agentId: 'probe' }, { role: 'oracle' as JudgeRole, agentId: 'oracle' }];
    const roles = judges.map((j) => j.role).sort().join('+');
    if (roles !== 'oracle+probe') {
      throw new PanelError('bad_judges', 'judges must be exactly one PROBE and one ORACLE (v1)');
    }

    // the two judges must be DISTINCT agents — they share a single pane otherwise, so
    // onAgentFinished's find() only ever matches one role and judging stalls until timeout.
    if (judges[0]!.agentId === judges[1]!.agentId) {
      throw new PanelError('judge_overlap', `probe and oracle must be distinct agents (both are ${judges[0]!.agentId})`);
    }
    // role separation: a judge may never also be a solver in the same panel
    const solverIds = new Set(solvers.map((s) => s.agentId));
    for (const j of judges) {
      if (solverIds.has(j.agentId)) throw new PanelError('judge_is_solver', `agent ${j.agentId} cannot be both judge and solver`);
    }
    // roster validation: every panelist must be a known agent
    for (const id of [...solverIds, ...judges.map((j) => j.agentId)]) {
      if (!roster.has(id)) throw new PanelError('unknown_agent', `unknown agent id: ${id}`);
    }

    // CROSS-PANEL EXCLUSIVITY: an agent may be a LIVE panelist in at most one panel at a
    // time. onAgentFinished reads the single per-agent pane tail, so the same agent in two
    // non-terminal panels would silently mis-attribute work (write-once drops the 2nd
    // panel's real output; the judge side spuriously bumps re-inject toward escalation).
    // Refuse here; the operator finishes/rejects the other panel, or uses non-colliding
    // explicit judges/solvers, to run panels concurrently.
    const wanted = new Set<string>([...solverIds, ...judges.map((j) => j.agentId)]);
    for (const p of this.deps.store.list()) {
      if (p.status === 'applied' || p.status === 'rejected') continue; // terminal panels free their agents
      const engaged = [
        ...this.deps.store.solutions(p.id).map((s) => s.solverAgentId),
        ...this.deps.store.judges(p.id).map((j) => j.judgeAgentId),
      ];
      const clash = engaged.find((a) => wanted.has(a));
      if (clash !== undefined) {
        throw new PanelError('agent_engaged', `agent ${clash} is already a live panelist in panel #${p.id} (status=${p.status}); finish/reject it first, or use non-colliding panelists`);
      }
    }

    const branchPrefix = (input.branchPrefix ?? `panel/${slug(input.goal)}`).replace(/\/+$/, '');
    const rubric = input.rubric ?? DEFAULT_RUBRIC;
    const decisionRule = { ...DEFAULT_DECISION_RULE, ...(input.decisionRule as object | undefined), lanePriority: solvers.map((s) => s.agentId) };
    const testCommand = input.testCommand && input.testCommand.trim() !== '' ? input.testCommand : DEFAULT_TEST_COMMAND;

    const category = typeof input.category === 'string' && input.category.trim() !== '' ? input.category.trim() : 'code_change';
    // refuse an unknown category at create (fail-fast, clear operator feedback) — a typo of
    // a hard-locked label must never silently become an auto-appliable category.
    if (!PANEL_CATEGORIES.has(category)) {
      throw new PanelError('unknown_category', `unknown category '${category}'; expected one of ${[...PANEL_CATEGORIES].join(', ')}`);
    }
    const createdBy = typeof input.initiatedBy === 'string' && sanitizeId(input.initiatedBy) !== '' ? sanitizeId(input.initiatedBy) : 'operator';

    const spec: CreatePanelSpec = {
      goal: input.goal,
      ...(input.context !== undefined ? { context: input.context } : {}),
      rubric,
      decisionRule,
      testCommand,
      branchPrefix,
      category,
      createdBy,
      solvers: solvers.map((s) => ({
        agentId: s.agentId,
        angle: s.angle,
        prompt: renderSolverTemplate({ goal: input.goal, context: input.context, rubric, decisionRule, testCommand, branchPrefix, solvers: [], judges: [] }, s),
      })),
      judges: judges.map((j) => ({
        role: j.role,
        agentId: j.agentId,
        prompt: renderJudgePlaceholder(j.role, { goal: input.goal, context: input.context, rubric, decisionRule, testCommand, branchPrefix, solvers: [], judges: [] }),
      })),
    };

    const created = this.deps.store.createPanel(spec);
    this.deps.kanban.comment(
      created.panel.parentCardId,
      PANEL_AUTHOR,
      `Panel #${created.panel.id} created by ${createdBy} — ${solvers.length} solvers (${solvers.map((s) => s.agentId).join(', ')}), judges probe+oracle. status=soliciting. test=\`${testCommand}\`.`,
    );

    try {
      this.deps.emitEvent?.('panel.transition', { panelId: created.panel.id, status: 'soliciting', category });
    } catch {
      /* observability is best-effort */
    }
    await this.dispatchSolvers(created.panel.id);
    return this.deps.store.getPanel(created.panel.id)!;
  }

  /** Dispatch every pending solver concurrently: running → move→onDispatch delivers
   *  the template (card description); down → claim dispatch + durable enqueue. */
  async dispatchSolvers(panelId: number): Promise<void> {
    const deadline = new Date(this.clock.now().getTime() + this.solverTimeoutMs).toISOString();
    const solutions = this.deps.store.solutions(panelId).filter((s) => s.status === 'pending');
    const spec = this.specOf(this.deps.store.getPanel(panelId)!);
    await Promise.all(
      solutions.map(async (sol) => {
        this.deps.store.setSolutionDeadline(sol.id, deadline);
        // provision the solver's OWN worktree so parallel solvers never share a working
        // tree (the live-run bug: spark's uncommitted draft was clobbered → commit null).
        const wt = this.deps.artifacts.worktreePath(panelId, sol.solverAgentId);
        let wtOk = false;
        try {
          const r = await this.deps.gate.prepareWorktree({ path: wt, branch: sol.branch });
          wtOk = r.ok;
          if (!r.ok) log.warn('panel solver worktree prepare failed', { panelId, branch: sol.branch, evidence: r.evidence });
        } catch (err) {
          log.warn('panel solver worktree error', { panelId, branch: sol.branch, error: String(err) });
        }
        // (re-)render the solver template now the worktree path is known, set it as the card
        // description so move→onDispatch delivers the exact "work in THIS worktree" instruction.
        const tmpl = renderSolverTemplate(spec, { agentId: sol.solverAgentId, angle: sol.angle }, wtOk ? wt : undefined);
        this.deps.kanban.update(sol.childCardId, { description: tmpl });
        let running = false;
        try {
          running = await this.deps.isRunning(sol.solverAgentId);
        } catch {
          running = false;
        }
        if (!running) {
          // durable path for a down panelist (guaranteed busy-wait / down-retry).
          this.deps.enqueue({ sender: PANEL_AUTHOR, recipient: sol.solverAgentId, body: this.solverBody(sol.childCardId, sol.solverAgentId) });
        }
        // move to in_progress: claims dispatch-once + fires onDispatch (delivers the
        // card description = the solver template to a running agent; no-op when down).
        try {
          this.deps.kanban.move(sol.childCardId, 'in_progress');
        } catch (err) {
          log.warn('panel solver dispatch move failed', { panelId, solutionId: sol.id, error: String(err) });
        }
        this.deps.kanban.comment(sol.childCardId, PANEL_AUTHOR, `Dispatched to ${sol.solverAgentId} (${running ? 'live' : 'durable — agent down'}); worktree ${wtOk ? wt : '(shared — provision failed)'}; deadline ${deadline}.`);
      }),
    );
  }

  private solverBody(childCardId: number, agentId: string): string {
    // The durable message mirrors what onDispatch would inject (the card carries the
    // template in its description); here we point the agent at its child card.
    return `Panel solver task (card #${childCardId}) for ${agentId}: read the card description for the full feladat-spec + audit-kritérium + döntési-szabály, then commit on your branch and summarize.`;
  }

  /**
   * Collection trigger: a panel-member agent finished its turn (wired to the
   * `agent.finished` webhook / refreshRunStates edge). For a SOLVER in a soliciting
   * panel, records the produced solution (and advances to judging on quorum); for a
   * JUDGE in a judging panel, parses + records its verdicts (re-injecting ONCE on a
   * malformed output, then escalating). Returns the affected panel ids.
   */
  async onAgentFinished(agentId: string): Promise<number[]> {
    const id = sanitizeId(agentId);
    const affected: number[] = [];
    for (const panel of this.deps.store.list()) {
      if (panel.status === 'soliciting') {
        const sol = this.deps.store.solutions(panel.id).find((s) => s.solverAgentId === id && s.status === 'pending');
        if (sol === undefined) continue;
        await this.recordSolverFinish(panel.id, sol, id);
        affected.push(panel.id);
        void this.maybeAdvanceToJudging(panel.id).catch((err) => log.warn('panel maybeAdvanceToJudging failed', { panelId: panel.id, error: String(err) }));
      } else if (panel.status === 'judging') {
        const judge = this.deps.store.judges(panel.id).find((j) => j.judgeAgentId === id && (j.status === 'dispatched' || j.status === 'pending'));
        if (judge === undefined) continue;
        this.handleJudgeFinish(panel.id, judge.id);
        affected.push(panel.id);
      } else if (panel.status === 'gated_review') {
        // the REVIEW round: PROBE re-refuting the winner finished its turn.
        if (this.deps.store.gate(panel.id, 'review')?.status !== 'pending') continue;
        const probe = this.deps.store.judges(panel.id).find((j) => j.role === 'probe');
        if (probe === undefined || probe.judgeAgentId !== id) continue;
        this.handleReviewFinish(panel.id);
        affected.push(panel.id);
      }
    }
    return affected;
  }

  /** Record a produced solution: capture the REAL commit from the solver's OWN worktree
   *  branch tip (non-null per solver, not a regex guess from a shared tail), persist it, and
   *  reconcile the child card OUT of in_progress so a produced solver never dangles. */
  private async recordSolverFinish(panelId: number, sol: PanelSolution, id: string): Promise<void> {
    const tailLines = this.deps.tail(id, 12);
    const tailSummary = tailLines.join('\n').slice(0, 4000);
    let commitSha: string | null = null;
    try {
      commitSha = await this.deps.gate.branchHead(sol.branch);
    } catch {
      commitSha = null;
    }
    if (commitSha === null) commitSha = (/\b([0-9a-f]{7,40})\b/.exec(tailLines.join(' ')) ?? [])[1] ?? null; // fallback
    this.deps.store.recordSolution(sol.id, { tailSummary, commitSha });
    this.deps.kanban.comment(sol.childCardId, PANEL_AUTHOR, `Solution produced by ${id}${commitSha ? ` (commit ${commitSha})` : ''}.`);
    // reconcile: a produced solver's child card must not stay stuck in_progress.
    try {
      this.deps.kanban.move(sol.childCardId, 'done');
    } catch (err) {
      log.warn('panel solver card reconcile failed', { panelId, solutionId: sol.id, error: String(err) });
    }
  }

  /** Produced solutions frozen for the judges. */
  private frozen(panelId: number): FrozenSolution[] {
    return this.deps.store
      .solutions(panelId)
      .filter((s) => s.status === 'produced')
      .map((s) => ({ solutionId: s.id, solverAgentId: s.solverAgentId, branch: s.branch, tailSummary: s.tailSummary }));
  }

  /** Once quorum is met, freeze the solutions and dispatch PROBE + ORACLE in parallel
   *  with templates that contain ONLY the solutions — never each other's verdicts. */
  async maybeAdvanceToJudging(panelId: number): Promise<void> {
    const panel = this.deps.store.getPanel(panelId);
    if (panel === undefined || panel.status !== 'soliciting' || !this.deps.store.hasQuorum(panelId)) return;
    this.transition(panelId, 'judging');
    const solutions = this.frozen(panelId);
    const spec = this.specOf(panel);
    const deadline = new Date(this.clock.now().getTime() + this.solverTimeoutMs).toISOString();
    this.deps.kanban.comment(panel.parentCardId, PANEL_AUTHOR, `Quorum reached (${solutions.length} solutions). status=judging — dispatching probe + oracle.`);
    await Promise.all(
      this.deps.store.judges(panelId).map(async (j) => {
        const vpath = this.deps.artifacts.verdictPath(panelId, j.role);
        const tmpl = j.role === 'probe' ? renderProbeTemplate(spec, solutions, vpath) : renderOracleTemplate(spec, solutions, vpath);
        this.deps.kanban.update(j.childCardId, { description: tmpl });
        this.deps.store.setJudgeDeadline(j.id, deadline);
        let running = false;
        try {
          running = await this.deps.isRunning(j.judgeAgentId);
        } catch {
          running = false;
        }
        if (!running) this.deps.enqueue({ sender: PANEL_AUTHOR, recipient: j.judgeAgentId, body: `Panel judge task (card #${j.childCardId}): read the card description for the frozen solutions + required verdict format.` });
        try {
          this.deps.kanban.move(j.childCardId, 'in_progress');
        } catch (err) {
          log.warn('panel judge dispatch move failed', { panelId, judgeId: j.id, error: String(err) });
        }
        this.deps.store.setJudgeStatus(j.id, 'dispatched');
        this.deps.kanban.comment(j.childCardId, PANEL_AUTHOR, `Dispatched ${j.role} (${j.judgeAgentId}) over ${solutions.length} frozen solutions; deadline ${deadline}.`);
      }),
    );
  }

  /**
   * Read a judge's verdict: the DURABLE ARTIFACT FILE first (the source of truth, written by
   * the judge per the template — immune to TUI redraw / tail-truncation), then a LARGER pane
   * capture (200 lines, not the 8-line default that loses long multi-line verdicts) as a
   * fallback. Only if BOTH fail is it declared malformed.
   */
  private captureVerdict(panelId: number, key: string, role: JudgeRole, agentId: string, expected: number[], expectedRound?: string): ParseResult {
    const opts = expectedRound !== undefined ? { expectedRound } : undefined;
    const fileText = this.deps.artifacts.read(this.deps.artifacts.verdictPath(panelId, key));
    if (fileText !== undefined) {
      // The durable file is per-panel + per-key and is written ONLY for THIS verdict (the review
      // verdict goes solely to verdictPath(_, 'review'); a stale judging block lives in a different
      // file), so the file is structurally fresh — do NOT require the cosmetic `round` nonce echo
      // here, or a faithful judge that omitted it is wrongly bounced (v1.3: PROBE wrote a valid
      // review ACCEPT to its file but without `round`, so the panel fell through to the pane and
      // failed with "not valid JSON"). The round-freshness guard is kept on the PANE fallback
      // below, where a prior round's block can linger in scrollback.
      const fromFile = parseVerdicts(fileText, role, expected);
      if (fromFile.ok) return fromFile;
    }
    const tailText = this.deps.tail(agentId, 200).join('\n');
    return parseVerdicts(tailText, role, expected, opts);
  }

  /** Parse a finished judge's verdict (file → larger-tail fallback); re-inject ONCE on
   *  malformed, then escalate. */
  private handleJudgeFinish(panelId: number, judgeId: number): void {
    const judge = this.deps.store.judge(judgeId);
    if (judge === undefined) return;
    const expected = this.frozen(panelId).map((s) => s.solutionId);
    const parsed = this.captureVerdict(panelId, judge.role, judge.role, judge.judgeAgentId, expected);
    if (parsed.ok) {
      for (const v of parsed.verdicts) this.deps.store.addVerdict(panelId, v);
      this.deps.store.setJudgeStatus(judgeId, 'verdicts_in');
      this.deps.kanban.comment(judge.childCardId, PANEL_AUTHOR, `${judge.role} verdicts recorded for ${parsed.verdicts.length} solutions.`);
      this.maybeAdvanceToDeciding(panelId);
      return;
    }
    // malformed → re-inject ONCE, then escalate (judging never closes with a gap).
    const count = this.deps.store.bumpJudgeReinjects(judgeId);
    if (count >= 2) {
      this.deps.store.setJudgeStatus(judgeId, 'failed');
      this.deps.kanban.comment(judge.childCardId, PANEL_AUTHOR, `${judge.role} verdict still malformed after a re-inject (${parsed.reason}); escalating to operator.`);
      this.deps.notifyOperator(`Panel #${panelId}: judge ${judge.role} (${judge.judgeAgentId}) produced a malformed verdict twice — operator intervention needed.`);
      return;
    }
    const spec = this.specOf(this.deps.store.getPanel(panelId)!);
    const vpath = this.deps.artifacts.verdictPath(panelId, judge.role);
    const tmpl = judge.role === 'probe' ? renderProbeTemplate(spec, this.frozen(panelId), vpath) : renderOracleTemplate(spec, this.frozen(panelId), vpath);
    this.deps.inject(judge.judgeAgentId, `A korábbi verdict hibás volt (${parsed.reason}). Írd a verdictet a fenti fájlba, ÉS add vissza a panel-verdict blokkot is.\n\n${tmpl}`);
    this.deps.kanban.comment(judge.childCardId, PANEL_AUTHOR, `${judge.role} verdict malformed (${parsed.reason}); re-injected once.`);
  }

  /** When every produced solution has both a probe and an oracle verdict → deciding,
   *  then immediately run the deterministic decision rule. */
  private maybeAdvanceToDeciding(panelId: number): void {
    const panel = this.deps.store.getPanel(panelId);
    if (panel === undefined || panel.status !== 'judging' || !this.deps.store.hasAllVerdicts(panelId)) return;
    this.transition(panelId, 'deciding');
    this.deps.kanban.comment(panel.parentCardId, PANEL_AUTHOR, `All verdicts in. status=deciding.`);
    this.decide(panelId);
  }

  /**
   * Run the deterministic decision rule over a FROZEN inputs snapshot, persist the
   * IMMUTABLE decision (write-once), comment the ranked trace, and transition:
   * a winner → gated_review (enters the Phase 4 gate); no winner (all vetoed) →
   * rejected + notify operator (v1: no revise round). NEXUS has NO discretion to
   * override the computed winner. Idempotent: a recorded decision is never re-run.
   */
  decide(panelId: number): Decision | undefined {
    const panel = this.deps.store.getPanel(panelId);
    if (panel === undefined || panel.status !== 'deciding') return undefined;
    const existing = this.deps.store.decision(panelId);
    if (existing !== undefined) return existing; // immutable: never re-decide

    const snapshot = this.buildSnapshot(panel);
    const output = decideWinner(snapshot);
    const decision = this.deps.store.recordDecision(panelId, {
      winningSolutionId: output.winningSolutionId,
      decidedBy: output.decidedBy,
      ruleOutput: output,
      snapshot,
    });

    const head =
      output.winningSolutionId === null
        ? 'Decision: NO WINNER (all solutions vetoed by a fatal defect)'
        : `Decision: winner is solution #${output.winningSolutionId}`;
    this.deps.kanban.comment(panel.parentCardId, PANEL_AUTHOR, `${head} — decided by \`${output.decidedBy}\`.\n${output.trace.join('\n')}`);

    if (output.winningSolutionId === null) {
      // forensics: archive the produced (now-abandoned) branches + remove worktrees like every
      // other reject path — fire-and-forget so decide() stays synchronous-returning.
      void this.archiveProducedBranches(panelId)
        .then(() => this.cleanupWorktrees(panelId))
        .catch((err) => log.warn('panel all-vetoed cleanup failed', { panelId, error: String(err) }));
      this.transition(panelId, 'rejected');
      this.deps.notifyOperator(`Panel #${panelId}: every solution was vetoed (fatal defect) — no winner picked (never "least-bad"). Panel rejected; operator intervention needed.`);
    } else {
      this.transition(panelId, 'gated_review');
      this.deps.kanban.comment(panel.parentCardId, PANEL_AUTHOR, `status=gated_review — winner solution #${output.winningSolutionId} enters the branch→test→review→approve gate.`);
      // kick off branch + test, then dispatch the review (fire-and-forget; a gate
      // failure escalates inside runGate and must never crash the collect path).
      void this.runGate(panelId).catch((err) => log.warn('panel runGate failed', { panelId, error: String(err) }));
    }
    return decision;
  }

  /** Aggregate the stored verdicts + solutions + decisionRuleConfig into the FROZEN
   *  rule inputs. The aggregation is integer-only and deterministic; lanePriorityIndex
   *  is unique per solution so the rule's total order is input-order-independent. */
  private buildSnapshot(panel: Panel): RuleInputsSnapshot {
    const config = this.decisionConfigOf(panel);
    const lanePriority = this.lanePriorityOf(panel);
    const produced = this.deps.store.solutions(panel.id).filter((s) => s.status === 'produced');
    const verdicts = this.deps.store.verdicts(panel.id);
    const solutions: SolutionInputs[] = produced.map((s) => {
      const vs = verdicts.filter((v) => v.solutionId === s.id);
      const oracle = vs.find((v) => v.judge === 'oracle');
      const refs = vs.flatMap((v) => v.refutations);
      const idx = lanePriority.indexOf(s.solverAgentId);
      return {
        solutionId: s.id,
        // a solver always in lanePriority (set at create); the fallback keeps the
        // index unique-by-id (offset past the lane list) so the order stays total.
        lanePriorityIndex: idx === -1 ? lanePriority.length + s.id : idx,
        correctness: vs.reduce((sum, v) => sum + Math.trunc(v.scores.correctness ?? 0), 0),
        oracleCorrectness: Math.trunc(oracle?.scores.correctness ?? 0),
        majorDefects: refs.filter((r) => r.severity === 'major').length,
        minorDefects: refs.filter((r) => r.severity === 'minor').length,
        fatal: vs.some((v) => v.fatalDefect) || refs.some((r) => r.severity === 'fatal'),
      };
    });
    return { solutions, config };
  }

  private decisionConfigOf(panel: Panel): DecisionRuleConfig {
    const raw = (panel.decisionRule ?? {}) as Record<string, unknown>;
    const w = (raw.weights ?? {}) as Record<string, unknown>;
    const int = (v: unknown, dflt: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : dflt);
    return {
      weights: {
        correctness: int(w.correctness, DEFAULT_DECISION_RULE.weights.correctness),
        robustness: int(w.robustness, DEFAULT_DECISION_RULE.weights.robustness),
        majorDefectPenalty: int(w.majorDefectPenalty, DEFAULT_DECISION_RULE.weights.majorDefectPenalty),
      },
      // v1 confirmed default true; only an explicit `false` opts into least-bad.
      noWinnerIfAllVetoed: raw.noWinnerIfAllVetoed !== false,
    };
  }

  private lanePriorityOf(panel: Panel): string[] {
    const raw = (panel.decisionRule ?? {}) as Record<string, unknown>;
    const lp = raw.lanePriority;
    return Array.isArray(lp) ? lp.filter((x): x is string => typeof x === 'string') : [];
  }

  // --- gate (Phase 4): branch → test → review → approve → apply ---

  /** The winning solution (the gate operates over ITS branch only — never main). */
  private winnerSolution(panelId: number): PanelSolution | undefined {
    const d = this.deps.store.decision(panelId);
    if (d?.winningSolutionId == null) return undefined;
    return this.deps.store.solutions(panelId).find((s) => s.id === d.winningSolutionId);
  }

  /**
   * Run the evidence-backed gate over the WINNER's branch: BRANCH (isolated?) → TEST
   * (the panel's testCommand; UNWAIVABLE) → dispatch REVIEW (PROBE re-refutes). APPROVE
   * + APPLY are operator-driven (routes). A failing branch/test stops the gate and
   * escalates — the panel never advances to apply on a bad stage.
   */
  async runGate(panelId: number): Promise<void> {
    const panel = this.deps.store.getPanel(panelId);
    if (panel === undefined || panel.status !== 'gated_review') return;
    const winner = this.winnerSolution(panelId);
    if (winner === undefined) return;

    // BRANCH — refuse to start if the winner's work is not branch-isolated.
    let branch: { isolated: boolean; evidence: string };
    try {
      branch = await this.deps.gate.branchIsolated(winner.branch);
    } catch (err) {
      branch = { isolated: false, evidence: `branch check error: ${String(err)}` };
    }
    this.deps.store.setGate(panelId, 'branch', branch.isolated ? 'passed' : 'failed', branch.evidence);
    this.deps.kanban.comment(panel.parentCardId, PANEL_AUTHOR, `Gate BRANCH ${branch.isolated ? 'passed' : 'FAILED'} for ${winner.branch}: ${branch.evidence}`);
    if (!branch.isolated) {
      this.deps.notifyOperator(`Panel #${panelId}: winner branch ${winner.branch} is not branch-isolated — gate blocked; operator intervention needed.`);
      return;
    }

    // TEST — UNWAIVABLE: a failing/absent result blocks. No "force" path exists.
    let test: { passed: boolean; log: string };
    try {
      test = await this.deps.gate.runTests(winner.branch, panel.testCommand);
    } catch (err) {
      test = { passed: false, log: `test run error: ${String(err)}` };
    }
    this.deps.store.setGate(panelId, 'test', test.passed ? 'passed' : 'failed', test.log.slice(0, 4000));
    this.deps.kanban.comment(panel.parentCardId, PANEL_AUTHOR, `Gate TEST ${test.passed ? 'passed' : 'FAILED'} (\`${panel.testCommand}\`) on ${winner.branch}.`);
    if (!test.passed) {
      this.deps.notifyOperator(`Panel #${panelId}: winner branch ${winner.branch} FAILED the test gate (unwaivable) — gate blocked; operator intervention needed.`);
      return;
    }

    // REVIEW — PROBE re-refutes the winner post-test.
    await this.dispatchReview(panelId, winner, test.log);
  }

  /** Dispatch PROBE to re-refute the winner (the same move→onDispatch / durable path). */
  private async dispatchReview(panelId: number, winner: PanelSolution, testLog: string): Promise<void> {
    const panel = this.deps.store.getPanel(panelId)!;
    const probe = this.deps.store.judges(panelId).find((j) => j.role === 'probe');
    if (probe === undefined) {
      this.deps.notifyOperator(`Panel #${panelId}: no PROBE judge available to run the review gate — operator intervention needed.`);
      return;
    }
    this.deps.store.setGate(panelId, 'review', 'pending', null);
    const round = this.reviewRound(panelId, winner.id);
    const frozen: FrozenSolution = { solutionId: winner.id, solverAgentId: winner.solverAgentId, branch: winner.branch, tailSummary: winner.tailSummary };
    const tmpl = renderReviewTemplate(this.specOf(panel), frozen, testLog, round, this.deps.artifacts.verdictPath(panelId, 'review'));
    this.deps.kanban.update(probe.childCardId, { description: tmpl });
    const deadline = new Date(this.clock.now().getTime() + this.solverTimeoutMs).toISOString();
    this.deps.store.setJudgeDeadline(probe.id, deadline);
    let running = false;
    try {
      running = await this.deps.isRunning(probe.judgeAgentId);
    } catch {
      running = false;
    }
    // The probe's child card was ALREADY dispatched during judging, so a second
    // move()→in_progress is a dispatch-once NO-OP and would never wake the pane. Inject
    // the review prompt straight into a RUNNING probe; durable-enqueue a DOWN one.
    if (running) {
      this.deps.inject(probe.judgeAgentId, tmpl);
    } else {
      this.deps.enqueue({ sender: PANEL_AUTHOR, recipient: probe.judgeAgentId, body: `Panel REVIEW (card #${probe.childCardId}): re-refute the winning solution post-test; read the card for the required verdict format.` });
    }
    try {
      this.deps.kanban.move(probe.childCardId, 'in_progress'); // board state only (already dispatched)
    } catch (err) {
      log.warn('panel review dispatch move failed', { panelId, error: String(err) });
    }
    this.deps.store.setJudgeStatus(probe.id, 'dispatched');
    this.deps.kanban.comment(probe.childCardId, PANEL_AUTHOR, `Review dispatched — PROBE re-refutes winner solution #${winner.id} (${winner.branch}); deadline ${deadline}.`);
  }

  /** Deterministic per-round nonce the REVIEW verdict block must echo — a stale judging
   *  block (which carries no `round`) can therefore never satisfy the review parse. */
  private reviewRound(panelId: number, winnerId: number): string {
    return `review-${panelId}-${winnerId}`;
  }

  /** Parse PROBE's review verdict for the winner: accept → review passed → request
   *  operator approval; reject/revise/malformed → review FAILED → panel rejected. */
  private handleReviewFinish(panelId: number): void {
    const panel = this.deps.store.getPanel(panelId);
    const winner = this.winnerSolution(panelId);
    const probe = this.deps.store.judges(panelId).find((j) => j.role === 'probe');
    if (panel === undefined || winner === undefined || probe === undefined) return;
    const parsed = this.captureVerdict(panelId, 'review', 'probe', probe.judgeAgentId, [winner.id], this.reviewRound(panelId, winner.id));
    if (!parsed.ok) {
      // a final adversarial check that won't parse → fail closed (never silently pass).
      this.deps.store.setGate(panelId, 'review', 'failed', `malformed review verdict: ${parsed.reason}`);
      this.deps.kanban.comment(probe.childCardId, PANEL_AUTHOR, `Review verdict malformed (${parsed.reason}); review FAILED — operator intervention needed.`);
      this.deps.notifyOperator(`Panel #${panelId}: PROBE review verdict was malformed (${parsed.reason}) — review failed; operator intervention needed.`);
      return;
    }
    const v = parsed.verdicts[0]!;
    this.deps.store.setJudgeStatus(probe.id, 'verdicts_in');
    const accepted = v.recommendation === 'accept' && !v.fatalDefect;
    if (!accepted) {
      this.deps.store.setGate(panelId, 'review', 'failed', `PROBE re-refute: ${v.recommendation}${v.fatalDefect ? ' + fatal' : ''}`);
      this.deps.kanban.comment(panel.parentCardId, PANEL_AUTHOR, `Gate REVIEW FAILED — PROBE re-refute returned \`${v.recommendation}\`. Bouncing the panel.`);
      void this.rejectPanel(panelId, `review failed (PROBE ${v.recommendation})`).catch((err) => log.warn('panel reject (review) failed', { panelId, error: String(err) }));
      return;
    }
    this.deps.store.setGate(panelId, 'review', 'passed', `PROBE re-refute accepted winner #${winner.id}`);
    this.deps.kanban.comment(panel.parentCardId, PANEL_AUTHOR, `Gate REVIEW passed — PROBE accepted winner solution #${winner.id}. Requesting operator approval.`);
    this.requestApproval(panelId);
  }

  /** APPROVE stage: flag the parent card for operator sign-off + notify. The operator
   *  approves via the EXISTING kanban approve route (which clears requiresApproval). */
  private requestApproval(panelId: number): void {
    const panel = this.deps.store.getPanel(panelId);
    if (panel === undefined) return;
    this.deps.store.setGate(panelId, 'approve', 'pending', null);
    this.deps.kanban.update(panel.parentCardId, { requiresApproval: true });
    this.deps.notifyOperator(`Panel #${panelId}: branch+test+review gates passed — operator APPROVAL required before apply (card #${panel.parentCardId}).`);
  }

  /** Flattened gate view + THE hard apply predicate. APPROVE passes when it was
   *  requested AND the operator cleared the parent card's requiresApproval (existing route). */
  gateSummary(panelId: number): GateSummary {
    const st = (stage: GateStage): GateStatus | 'absent' => this.deps.store.gate(panelId, stage)?.status ?? 'absent';
    const branch = st('branch');
    const test = st('test');
    const review = st('review');
    let approve = st('approve');
    if (approve === 'pending') {
      const panel = this.deps.store.getPanel(panelId);
      const card = panel ? this.deps.kanban.get(panel.parentCardId) : undefined;
      if (card !== undefined && card.requiresApproval === false) approve = 'passed';
    }
    const apply = st('apply');
    const allPassed = branch === 'passed' && test === 'passed' && review === 'passed' && approve === 'passed';
    return { branch, test, review, approve, apply, allPassed };
  }

  /**
   * Apply the winner — THE HARD GATE. The predicate (branch+test+review+approve all
   * passed) is enforced HERE and in the apply ROUTE handler BEFORE any merge — never
   * in a swallowed onDispatch/onCardDone hook. test=passed is UNWAIVABLE. A HARD_LOCKED
   * category NEVER self-applies (operator hand-off) even on a unanimous approve. Throws
   * a PanelError on any block, so the route returns 4xx and NO merge happens.
   */
  async apply(panelId: number): Promise<{ panel: Panel; handoff?: boolean }> {
    const panel = this.deps.store.getPanel(panelId);
    if (panel === undefined) throw new PanelError('no_such_panel', `no such panel: ${panelId}`);
    if (panel.status === 'applied') return { panel }; // idempotent
    if (panel.status !== 'gated_review') throw new PanelError('not_gated', `panel #${panelId} is not in gated_review (status=${panel.status})`);

    // HARD PREDICATE (defense-in-depth; the route handler checks it too).
    const summary = this.gateSummary(panelId);
    if (!summary.allPassed) {
      throw new PanelError('gate_not_satisfied', `gate not satisfied (branch=${summary.branch}, test=${summary.test}, review=${summary.review}, approve=${summary.approve})`);
    }
    const winner = this.winnerSolution(panelId);
    if (winner === undefined) throw new PanelError('no_winner', `panel #${panelId} has no winning solution`);

    // The predicate held → the operator HAS approved (gateSummary derives approve from the
    // cleared requiresApproval). Promote the persisted approve row so the audit DB matches
    // runtime instead of forever reading 'pending'. Idempotent per (panel, stage).
    this.deps.store.setGate(panelId, 'approve', 'passed', 'operator approval (parent card requiresApproval cleared)');

    // HARD_LOCKED autonomy boundary, FAIL-CLOSED: a hard-locked OR unrecognized category
    // can NEVER self-apply — it stops at operator hand-off even after a unanimous approve.
    // Treating unknown-as-locked means a typo'd/tampered category degrades to a safe
    // hand-off, never an inadvertent auto-merge. NO merge is attempted.
    if (HARD_LOCKED.has(panel.category) || !PANEL_CATEGORIES.has(panel.category)) {
      const why = HARD_LOCKED.has(panel.category) ? `HARD_LOCKED category '${panel.category}'` : `unrecognized category '${panel.category}' (fail-closed)`;
      this.deps.store.setGate(panelId, 'apply', 'handoff', `${why} — operator must apply manually`);
      this.deps.kanban.comment(panel.parentCardId, PANEL_AUTHOR, `Apply BLOCKED — ${why}; merge handed off to the operator (never self-applied).`);
      this.deps.notifyOperator(`Panel #${panelId}: winner is a ${why} — it will NOT self-apply even after approve. Operator must apply ${winner.branch} manually.`);
      throw new PanelError('hard_locked_handoff', `${why} — operator hand-off required (no self-apply)`);
    }

    // MERGE — only reached after the predicate + autonomy boundary pass.
    let merged: { merged: boolean; evidence: string };
    try {
      merged = await this.deps.gate.merge(winner.branch);
    } catch (err) {
      merged = { merged: false, evidence: `merge error: ${String(err)}` };
    }
    if (!merged.merged) {
      this.deps.store.setGate(panelId, 'apply', 'failed', merged.evidence);
      this.deps.kanban.comment(panel.parentCardId, PANEL_AUTHOR, `Apply FAILED to merge ${winner.branch}: ${merged.evidence}`);
      throw new PanelError('merge_failed', `merge of ${winner.branch} failed: ${merged.evidence}`);
    }

    // applied: stamp + move parent done + archive losing branches.
    const appliedAt = isoNow(this.clock);
    this.deps.store.setGate(panelId, 'apply', 'passed', merged.evidence);
    this.deps.store.setApplied(panelId, appliedAt);
    this.transition(panelId, 'applied');
    try {
      this.deps.kanban.move(panel.parentCardId, 'done');
    } catch (err) {
      log.warn('panel apply parent move failed', { panelId, error: String(err) });
    }
    this.deps.kanban.comment(panel.parentCardId, PANEL_AUTHOR, `Applied — merged winner solution #${winner.id} (${winner.branch}). status=applied at ${appliedAt}.`);
    await this.archiveLosingBranches(panelId, winner.id);
    await this.cleanupWorktrees(panelId);
    return { panel: this.deps.store.getPanel(panelId)! };
  }

  /** Archive EVERY produced branch (forensics, never deleted) — the shared invariant
   *  for all reject paths: review-failure, operator reject, AND the all-vetoed decision. */
  private async archiveProducedBranches(panelId: number): Promise<void> {
    for (const s of this.deps.store.solutions(panelId).filter((x) => x.status === 'produced')) {
      try {
        await this.deps.gate.archiveBranch(s.branch, panelId);
      } catch (err) {
        log.warn('panel archive produced branch failed', { panelId, branch: s.branch, error: String(err) });
      }
    }
  }

  /** Remove every solver worktree on panel terminal — the throwaway working dirs go; the
   *  branches (and their archive tags) are kept for forensics. */
  private async cleanupWorktrees(panelId: number): Promise<void> {
    for (const s of this.deps.store.solutions(panelId)) {
      try {
        await this.deps.gate.removeWorktree(this.deps.artifacts.worktreePath(panelId, s.solverAgentId));
      } catch (err) {
        log.warn('panel worktree cleanup failed', { panelId, agent: s.solverAgentId, error: String(err) });
      }
    }
  }

  /** Losing solver branches: auto-ARCHIVE (kept for forensics, never deleted). */
  private async archiveLosingBranches(panelId: number, winnerId: number): Promise<void> {
    const losers = this.deps.store.solutions(panelId).filter((s) => s.id !== winnerId && s.status === 'produced');
    for (const s of losers) {
      try {
        await this.deps.gate.archiveBranch(s.branch, panelId);
      } catch (err) {
        log.warn('panel archive losing branch failed', { panelId, branch: s.branch, error: String(err) });
      }
      this.deps.kanban.comment(s.childCardId, PANEL_AUTHOR, `Losing solution #${s.id} branch ${s.branch} archived (kept for forensics).`);
    }
  }

  /** Reject the panel: signal the winning solver to STOP, archive every produced
   *  branch (forensics), panel → rejected. */
  async rejectPanel(panelId: number, reason: string): Promise<Panel> {
    const panel = this.deps.store.getPanel(panelId);
    if (panel === undefined) throw new PanelError('no_such_panel', `no such panel: ${panelId}`);
    if (panel.status === 'applied') throw new PanelError('already_applied', `panel #${panelId} is already applied — cannot reject`);
    if (panel.status === 'rejected') return panel;
    const winner = this.winnerSolution(panelId);
    if (winner !== undefined) {
      this.deps.enqueue({ sender: PANEL_AUTHOR, recipient: winner.solverAgentId, body: `Panel #${panelId}: a megoldásod ELUTASÍTVA (${reason}). Állj le ezzel a feladattal.` });
    }
    await this.archiveProducedBranches(panelId);
    await this.cleanupWorktrees(panelId);
    this.transition(panelId, 'rejected');
    this.deps.kanban.comment(panel.parentCardId, PANEL_AUTHOR, `Panel rejected — ${reason}. Produced branches archived; worktrees removed; winning solver signalled to stop.`);
    this.deps.notifyOperator(`Panel #${panelId} rejected: ${reason}.`);
    return this.deps.store.getPanel(panelId)!;
  }

  /** Reconstruct a CreatePanelSpec view of a stored panel (for template rendering). */
  private specOf(panel: Panel): CreatePanelSpec {
    const goal = this.deps.kanban.get(panel.parentCardId)?.title ?? '';
    return { goal, rubric: panel.rubric, decisionRule: panel.decisionRule, testCommand: panel.testCommand, branchPrefix: panel.branchPrefix, solvers: [], judges: [] };
  }

  /**
   * Sweep per-solver timeouts. A pending solution whose deadline has passed →
   * timeout (excluded if quorum still holds). Returns panel ids that changed.
   */
  sweepTimeouts(): number[] {
    const nowMs = this.clock.now().getTime();
    const changed = new Set<number>();
    for (const panel of this.deps.store.list()) {
      if (panel.status === 'soliciting') {
        for (const sol of this.deps.store.solutions(panel.id)) {
          if (sol.status !== 'pending' || sol.deadlineAt === null) continue;
          if (Date.parse(sol.deadlineAt) <= nowMs) {
            this.deps.store.markSolutionTimeout(sol.id);
            this.deps.kanban.comment(sol.childCardId, PANEL_AUTHOR, `Solver ${sol.solverAgentId} timed out (deadline ${sol.deadlineAt}).`);
            changed.add(panel.id);
          }
        }
        if (changed.has(panel.id)) {
          // quorum still holds → proceed without the late solver; otherwise, if no
          // solver can still produce, escalate (never hang).
          if (this.deps.store.hasQuorum(panel.id)) {
            void this.maybeAdvanceToJudging(panel.id).catch((err) => log.warn('panel maybeAdvanceToJudging failed', { panelId: panel.id, error: String(err) }));
          } else if (!this.deps.store.solutions(panel.id).some((s) => s.status === 'pending')) {
            this.deps.notifyOperator(`Panel #${panel.id}: solvers finished/timed out without quorum (≥2 produced) — operator intervention needed.`);
          }
        }
      } else if (panel.status === 'judging') {
        for (const j of this.deps.store.judges(panel.id)) {
          if (j.status === 'verdicts_in' || j.status === 'failed' || j.deadlineAt === null) continue;
          if (Date.parse(j.deadlineAt) <= nowMs) {
            this.deps.store.setJudgeStatus(j.id, 'failed');
            this.deps.kanban.comment(j.childCardId, PANEL_AUTHOR, `Judge ${j.role} (${j.judgeAgentId}) timed out (deadline ${j.deadlineAt}); escalating.`);
            this.deps.notifyOperator(`Panel #${panel.id}: judge ${j.role} timed out — judging never waits unbounded; operator intervention needed.`);
            changed.add(panel.id);
          }
        }
      } else if (panel.status === 'gated_review') {
        // a wedged PROBE in the REVIEW round must never wait unbounded either.
        const reviewGate = this.deps.store.gate(panel.id, 'review');
        if (reviewGate?.status !== 'pending') continue;
        const probe = this.deps.store.judges(panel.id).find((j) => j.role === 'probe');
        if (probe === undefined || probe.deadlineAt === null) continue;
        if (Date.parse(probe.deadlineAt) <= nowMs) {
          this.deps.store.setGate(panel.id, 'review', 'failed', `review timed out (deadline ${probe.deadlineAt})`);
          this.deps.store.setJudgeStatus(probe.id, 'failed');
          this.deps.kanban.comment(panel.parentCardId, PANEL_AUTHOR, `Gate REVIEW timed out (deadline ${probe.deadlineAt}); review FAILED — operator intervention needed.`);
          this.deps.notifyOperator(`Panel #${panel.id}: PROBE review timed out — review failed; operator intervention needed.`);
          changed.add(panel.id);
        }
      }
    }
    return [...changed];
  }
}
