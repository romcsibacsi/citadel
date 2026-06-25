// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { type Clock, systemClock, isoNow } from '../core/clock.js';

/**
 * Judge-panel store (BUILD-judge-panel). Holds the structured panel state the
 * kanban comment trail can't query: the panel state machine, per-solver solutions,
 * and the judge roster. The kanban cards stay the unit of dispatch + the board.
 *
 * Invariants enforced here:
 *  - createPanel is ATOMIC: the parent card, the solver + judge child cards, the
 *    panel row, and the solution/judge skeleton rows are written in ONE
 *    BEGIN IMMEDIATE — a failure leaves NO partial panel (no orphan cards).
 *  - status transitions go through setStatus, which permits only declared edges
 *    (the `debating` edge is reserved for v2 — open, not built).
 *  - a solution/judge terminal status (produced/timeout/failed; verdicts_in/failed)
 *    is write-once-ish via guarded updates; the decision/gate immutability lives in
 *    their own phase tables.
 *
 * The kanban_cards INSERT is replicated here (not KanbanStore.breakdown) ON PURPOSE:
 * SQLite has no nested transactions, so the only way to create the cards AND the
 * panel rows in a SINGLE atomic unit is one transaction owning both. The created
 * rows are ordinary kanban cards (same table) — dispatch still goes through
 * KanbanStore.move()/onDispatch.
 */

export const PANEL_STATUSES = [
  'soliciting',
  'debating',
  'judging',
  'deciding',
  'gated_review',
  'applied',
  'rejected',
] as const;
export type PanelStatus = (typeof PANEL_STATUSES)[number];

/** Allowed state-machine edges (v1; `debating` reserved for v2 — leave the node open). */
const ALLOWED_EDGES: Record<PanelStatus, PanelStatus[]> = {
  soliciting: ['judging', 'rejected', 'debating'],
  debating: ['judging', 'rejected'],
  judging: ['deciding', 'rejected'],
  deciding: ['gated_review', 'soliciting', 'rejected'],
  gated_review: ['applied', 'rejected'],
  applied: [],
  rejected: [],
};

export type SolutionStatus = 'pending' | 'produced' | 'timeout' | 'failed';
export type JudgeRole = 'probe' | 'oracle';
export type JudgeStatus = 'pending' | 'dispatched' | 'verdicts_in' | 'failed';

export interface Panel {
  id: number;
  parentCardId: number;
  status: PanelStatus;
  rubric: unknown;
  decisionRule: unknown;
  testCommand: string;
  branchPrefix: string;
  /** Action category for the apply-boundary autonomy check (HARD_LOCKED never self-applies). */
  category: string;
  /** The principal that initiated the panel — 'operator' or an agent id (audit trail). */
  createdBy: string;
  appliedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PanelSolution {
  id: number;
  panelId: number;
  solverAgentId: string;
  childCardId: number;
  branch: string;
  angle: string;
  commitSha: string | null;
  tailSummary: string | null;
  status: SolutionStatus;
  deadlineAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PanelJudge {
  id: number;
  panelId: number;
  role: JudgeRole;
  judgeAgentId: string;
  childCardId: number;
  status: JudgeStatus;
  deadlineAt: string | null;
  reinjects: number;
  createdAt: string;
  updatedAt: string;
}

export type Severity = 'fatal' | 'major' | 'minor';
export type Recommendation = 'accept' | 'reject' | 'revise';
export interface Refutation {
  claim: string;
  severity: Severity;
  evidenceRef?: string;
}
export interface Verdict {
  id: number;
  panelId: number;
  solutionId: number;
  judge: JudgeRole;
  scores: Record<string, number>;
  refutations: Refutation[];
  recommendation: Recommendation;
  fatalDefect: boolean;
  createdAt: string;
}
export interface AddVerdictInput {
  solutionId: number;
  judge: JudgeRole;
  scores: Record<string, number>;
  refutations: Refutation[];
  recommendation: Recommendation;
  fatalDefect: boolean;
}

/** The IMMUTABLE panel decision (Phase 3). One per panel; write-once. */
export interface Decision {
  id: number;
  panelId: number;
  winningSolutionId: number | null;
  decidedBy: string;
  /** Full deterministic rule output (ranked entries + which step + trace). */
  ruleOutput: unknown;
  /** Frozen rule inputs — persisted so the decision replays bit-for-bit. */
  snapshot: unknown;
  createdAt: string;
}
export interface RecordDecisionInput {
  winningSolutionId: number | null;
  decidedBy: string;
  ruleOutput: unknown;
  snapshot: unknown;
}

export interface CreatePanelSpec {
  goal: string;
  context?: string;
  /** `prompt` = the rendered solver template; it becomes the child card description
   *  so the existing move→onDispatch path delivers it to the running agent. */
  solvers: Array<{ agentId: string; angle: string; prompt: string }>;
  /** judge `prompt` is a placeholder at create; Phase 2 re-renders it with the
   *  frozen solutions right before dispatch. */
  judges: Array<{ role: JudgeRole; agentId: string; prompt: string }>;
  rubric: unknown;
  decisionRule: unknown;
  testCommand: string;
  branchPrefix: string;
  /** Defaults to 'code_change'; a HARD_LOCKED category can never self-apply (Phase 4). */
  category?: string;
  /** Initiating principal (operator vs agent id); defaults to 'operator' (v1.1 Part A). */
  createdBy?: string;
}

/** Evidence-backed gate over the winner's branch (Phase 4). */
export const GATE_STAGES = ['branch', 'test', 'review', 'approve', 'apply'] as const;
export type GateStage = (typeof GATE_STAGES)[number];
export type GateStatus = 'pending' | 'passed' | 'failed' | 'handoff';
export interface PanelGate {
  id: number;
  panelId: number;
  stage: GateStage;
  status: GateStatus;
  evidenceRef: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreatedPanel {
  panel: Panel;
  solutions: PanelSolution[];
  judges: PanelJudge[];
}

interface DbPanelRow {
  id: number;
  parent_card_id: number;
  status: string;
  rubric: string;
  decision_rule: string;
  test_command: string;
  branch_prefix: string;
  category: string;
  created_by: string;
  applied_at: string | null;
  created_at: string;
  updated_at: string;
}
interface DbSolutionRow {
  id: number;
  panel_id: number;
  solver_agent_id: string;
  child_card_id: number;
  branch: string;
  angle: string;
  commit_sha: string | null;
  tail_summary: string | null;
  status: string;
  deadline_at: string | null;
  created_at: string;
  updated_at: string;
}
interface DbJudgeRow {
  id: number;
  panel_id: number;
  role: string;
  judge_agent_id: string;
  child_card_id: number;
  status: string;
  deadline_at: string | null;
  reinjects: number;
  created_at: string;
  updated_at: string;
}
interface DbVerdictRow {
  id: number;
  panel_id: number;
  solution_id: number;
  judge: string;
  scores: string;
  refutations: string;
  recommendation: string;
  fatal_defect: number;
  created_at: string;
}
interface DbDecisionRow {
  id: number;
  panel_id: number;
  winning_solution_id: number | null;
  decided_by: string;
  rule_output: string;
  snapshot: string;
  created_at: string;
}
interface DbGateRow {
  id: number;
  panel_id: number;
  stage: string;
  status: string;
  evidence_ref: string | null;
  created_at: string;
  updated_at: string;
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
function mapPanel(r: DbPanelRow): Panel {
  return {
    id: r.id,
    parentCardId: r.parent_card_id,
    status: r.status as PanelStatus,
    rubric: safeJson(r.rubric),
    decisionRule: safeJson(r.decision_rule),
    testCommand: r.test_command,
    branchPrefix: r.branch_prefix,
    category: r.category,
    createdBy: r.created_by,
    appliedAt: r.applied_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
function mapSolution(r: DbSolutionRow): PanelSolution {
  return {
    id: r.id,
    panelId: r.panel_id,
    solverAgentId: r.solver_agent_id,
    childCardId: r.child_card_id,
    branch: r.branch,
    angle: r.angle,
    commitSha: r.commit_sha,
    tailSummary: r.tail_summary,
    status: r.status as SolutionStatus,
    deadlineAt: r.deadline_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
function mapJudge(r: DbJudgeRow): PanelJudge {
  return {
    id: r.id,
    panelId: r.panel_id,
    role: r.role as JudgeRole,
    judgeAgentId: r.judge_agent_id,
    childCardId: r.child_card_id,
    status: r.status as JudgeStatus,
    deadlineAt: r.deadline_at,
    reinjects: r.reinjects,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
function mapVerdict(r: DbVerdictRow): Verdict {
  return {
    id: r.id,
    panelId: r.panel_id,
    solutionId: r.solution_id,
    judge: r.judge as JudgeRole,
    scores: safeJson(r.scores) as Record<string, number>,
    refutations: safeJson(r.refutations) as Refutation[],
    recommendation: r.recommendation as Recommendation,
    fatalDefect: r.fatal_defect !== 0,
    createdAt: r.created_at,
  };
}
function mapDecision(r: DbDecisionRow): Decision {
  return {
    id: r.id,
    panelId: r.panel_id,
    winningSolutionId: r.winning_solution_id,
    decidedBy: r.decided_by,
    ruleOutput: safeJson(r.rule_output),
    snapshot: safeJson(r.snapshot),
    createdAt: r.created_at,
  };
}
function mapGate(r: DbGateRow): PanelGate {
  return {
    id: r.id,
    panelId: r.panel_id,
    stage: r.stage as GateStage,
    status: r.status as GateStatus,
    evidenceRef: r.evidence_ref,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const PANEL_COLS = 'id, parent_card_id, status, rubric, decision_rule, test_command, branch_prefix, category, created_by, applied_at, created_at, updated_at';
const SOL_COLS = 'id, panel_id, solver_agent_id, child_card_id, branch, angle, commit_sha, tail_summary, status, deadline_at, created_at, updated_at';
const JUDGE_COLS = 'id, panel_id, role, judge_agent_id, child_card_id, status, deadline_at, reinjects, created_at, updated_at';
const VERDICT_COLS = 'id, panel_id, solution_id, judge, scores, refutations, recommendation, fatal_defect, created_at';
const DECISION_COLS = 'id, panel_id, winning_solution_id, decided_by, rule_output, snapshot, created_at';
const GATE_COLS = 'id, panel_id, stage, status, evidence_ref, created_at, updated_at';

export class PanelStore {
  private readonly cardInsertStmt: StatementSync;
  private readonly panelInsertStmt: StatementSync;
  private readonly solInsertStmt: StatementSync;
  private readonly judgeInsertStmt: StatementSync;
  private readonly getPanelStmt: StatementSync;
  private readonly listPanelsStmt: StatementSync;
  private readonly panelByCardStmt: StatementSync;
  private readonly solutionsStmt: StatementSync;
  private readonly judgesStmt: StatementSync;
  private readonly setPanelStatusStmt: StatementSync;
  private readonly verdictInsertStmt: StatementSync;
  private readonly verdictsStmt: StatementSync;
  private readonly judgeByIdStmt: StatementSync;
  private readonly decisionInsertStmt: StatementSync;
  private readonly decisionStmt: StatementSync;
  private readonly gateUpsertStmt: StatementSync;
  private readonly gatesStmt: StatementSync;
  private readonly gateStmt: StatementSync;
  private readonly setAppliedStmt: StatementSync;

  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: Clock = systemClock,
  ) {
    // identical column set to KanbanStore.insertStmt (deliberate — see header).
    this.cardInsertStmt = db.prepare(
      `INSERT INTO kanban_cards
         (title, description, assignee, priority, project, parent_id, sort_order,
          requires_approval, due_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.panelInsertStmt = db.prepare(
      `INSERT INTO panels (parent_card_id, status, rubric, decision_rule, test_command, branch_prefix, category, created_by, created_at, updated_at)
       VALUES (?, 'soliciting', ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.solInsertStmt = db.prepare(
      `INSERT INTO panel_solutions (panel_id, solver_agent_id, child_card_id, branch, angle, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
    );
    this.judgeInsertStmt = db.prepare(
      `INSERT INTO panel_judges (panel_id, role, judge_agent_id, child_card_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
    );
    this.getPanelStmt = db.prepare(`SELECT ${PANEL_COLS} FROM panels WHERE id = ?`);
    this.listPanelsStmt = db.prepare(`SELECT ${PANEL_COLS} FROM panels ORDER BY id DESC`);
    this.panelByCardStmt = db.prepare(`SELECT ${PANEL_COLS} FROM panels WHERE parent_card_id = ?`);
    this.solutionsStmt = db.prepare(`SELECT ${SOL_COLS} FROM panel_solutions WHERE panel_id = ? ORDER BY id ASC`);
    this.judgesStmt = db.prepare(`SELECT ${JUDGE_COLS} FROM panel_judges WHERE panel_id = ? ORDER BY id ASC`);
    this.setPanelStatusStmt = db.prepare('UPDATE panels SET status = ?, updated_at = ? WHERE id = ?');
    this.verdictInsertStmt = db.prepare(
      `INSERT OR IGNORE INTO panel_verdicts (panel_id, solution_id, judge, scores, refutations, recommendation, fatal_defect, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.verdictsStmt = db.prepare(`SELECT ${VERDICT_COLS} FROM panel_verdicts WHERE panel_id = ? ORDER BY id ASC`);
    this.judgeByIdStmt = db.prepare(`SELECT ${JUDGE_COLS} FROM panel_judges WHERE id = ?`);
    this.decisionInsertStmt = db.prepare(
      `INSERT OR IGNORE INTO panel_decisions (panel_id, winning_solution_id, decided_by, rule_output, snapshot, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.decisionStmt = db.prepare(`SELECT ${DECISION_COLS} FROM panel_decisions WHERE panel_id = ?`);
    this.gateUpsertStmt = db.prepare(
      `INSERT INTO panel_gates (panel_id, stage, status, evidence_ref, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (panel_id, stage)
       DO UPDATE SET status = excluded.status, evidence_ref = excluded.evidence_ref, updated_at = excluded.updated_at`,
    );
    this.gatesStmt = db.prepare(`SELECT ${GATE_COLS} FROM panel_gates WHERE panel_id = ? ORDER BY id ASC`);
    this.gateStmt = db.prepare(`SELECT ${GATE_COLS} FROM panel_gates WHERE panel_id = ? AND stage = ?`);
    this.setAppliedStmt = db.prepare('UPDATE panels SET applied_at = ?, updated_at = ? WHERE id = ?');
  }

  /**
   * Atomic create: parent card + solver/judge child cards + panel + skeleton rows
   * in ONE transaction. Validation (judge==solver, <2 solvers, unknown agent) is
   * the caller's job, BEFORE this runs. Returns the assembled panel.
   */
  createPanel(spec: CreatePanelSpec): CreatedPanel {
    const now = isoNow(this.clock);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // parent (the panel job umbrella) — not dispatched; children are.
      const parentId = Number(
        this.cardInsertStmt.run(spec.goal, spec.context ?? null, '', 'normal', null, null, 0, 0, null, now, now).lastInsertRowid,
      );
      const panelId = Number(
        this.panelInsertStmt.run(
          parentId,
          JSON.stringify(spec.rubric ?? {}),
          JSON.stringify(spec.decisionRule ?? {}),
          spec.testCommand,
          spec.branchPrefix,
          spec.category ?? 'code_change',
          spec.createdBy ?? 'operator',
          now,
          now,
        ).lastInsertRowid,
      );
      for (const s of spec.solvers) {
        const branch = `${spec.branchPrefix}/sol-${s.agentId}`;
        const childId = Number(
          this.cardInsertStmt.run(
            `[panel #${panelId}] solver ${s.agentId}: ${spec.goal}`,
            s.prompt,
            s.agentId,
            'normal',
            null,
            parentId,
            0,
            0,
            null,
            now,
            now,
          ).lastInsertRowid,
        );
        this.solInsertStmt.run(panelId, s.agentId, childId, branch, s.angle, now, now);
      }
      for (const j of spec.judges) {
        const childId = Number(
          this.cardInsertStmt.run(
            `[panel #${panelId}] judge ${j.role} (${j.agentId}): ${spec.goal}`,
            j.prompt,
            j.agentId,
            'normal',
            null,
            parentId,
            0,
            0,
            null,
            now,
            now,
          ).lastInsertRowid,
        );
        this.judgeInsertStmt.run(panelId, j.role, j.agentId, childId, now, now);
      }
      this.db.exec('COMMIT');
      const panel = this.getPanel(panelId)!;
      return { panel, solutions: this.solutions(panelId), judges: this.judges(panelId) };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  getPanel(id: number): Panel | undefined {
    const r = this.getPanelStmt.get(id) as DbPanelRow | undefined;
    return r === undefined ? undefined : mapPanel(r);
  }
  panelByCard(cardId: number): Panel | undefined {
    const r = this.panelByCardStmt.get(cardId) as DbPanelRow | undefined;
    return r === undefined ? undefined : mapPanel(r);
  }
  list(): Panel[] {
    return (this.listPanelsStmt.all() as unknown as DbPanelRow[]).map(mapPanel);
  }
  solutions(panelId: number): PanelSolution[] {
    return (this.solutionsStmt.all(panelId) as unknown as DbSolutionRow[]).map(mapSolution);
  }
  judges(panelId: number): PanelJudge[] {
    return (this.judgesStmt.all(panelId) as unknown as DbJudgeRow[]).map(mapJudge);
  }
  solution(id: number): PanelSolution | undefined {
    const r = this.db.prepare(`SELECT ${SOL_COLS} FROM panel_solutions WHERE id = ?`).get(id) as DbSolutionRow | undefined;
    return r === undefined ? undefined : mapSolution(r);
  }

  /** Count of solutions that have produced an answer (the quorum numerator). */
  producedCount(panelId: number): number {
    return this.solutions(panelId).filter((s) => s.status === 'produced').length;
  }
  /** Quorum = at least 2 produced solutions (the panel can judge meaningfully). */
  hasQuorum(panelId: number, min = 2): boolean {
    return this.producedCount(panelId) >= min;
  }

  /** Transition the panel status — only declared edges are allowed. */
  setStatus(panelId: number, to: PanelStatus): Panel {
    const cur = this.getPanel(panelId);
    if (cur === undefined) throw new Error(`no such panel: ${panelId}`);
    if (cur.status === to) return cur;
    if (!ALLOWED_EDGES[cur.status].includes(to)) {
      throw new Error(`illegal panel transition ${cur.status} → ${to}`);
    }
    this.setPanelStatusStmt.run(to, isoNow(this.clock), panelId);
    return this.getPanel(panelId)!;
  }

  /** Stamp a per-solver / per-judge deadline (set at dispatch for the timeout). */
  setSolutionDeadline(solutionId: number, deadlineAt: string): void {
    this.db.prepare('UPDATE panel_solutions SET deadline_at = ?, updated_at = ? WHERE id = ?').run(deadlineAt, isoNow(this.clock), solutionId);
  }
  setJudgeDeadline(judgeId: number, deadlineAt: string): void {
    this.db.prepare('UPDATE panel_judges SET deadline_at = ?, updated_at = ? WHERE id = ?').run(deadlineAt, isoNow(this.clock), judgeId);
  }

  /** Record a produced solution (branch/commit/tail). Only a pending solution can
   *  become produced — a terminal status is never overwritten. */
  recordSolution(solutionId: number, fields: { commitSha?: string | null; tailSummary?: string | null; branch?: string }): PanelSolution {
    const cur = this.solution(solutionId);
    if (cur === undefined) throw new Error(`no such solution: ${solutionId}`);
    if (cur.status !== 'pending') return cur; // write-once: ignore a late finish
    this.db
      .prepare('UPDATE panel_solutions SET status = ?, commit_sha = ?, tail_summary = ?, branch = ?, updated_at = ? WHERE id = ?')
      .run('produced', fields.commitSha ?? null, fields.tailSummary ?? null, fields.branch ?? cur.branch, isoNow(this.clock), solutionId);
    return this.solution(solutionId)!;
  }

  /** Mark a still-pending solution as timed-out (the deadline passed with no finish). */
  markSolutionTimeout(solutionId: number): PanelSolution | undefined {
    const cur = this.solution(solutionId);
    if (cur === undefined || cur.status !== 'pending') return cur;
    this.db.prepare('UPDATE panel_solutions SET status = ?, updated_at = ? WHERE id = ?').run('timeout', isoNow(this.clock), solutionId);
    return this.solution(solutionId);
  }

  setJudgeStatus(judgeId: number, to: JudgeStatus): void {
    this.db.prepare('UPDATE panel_judges SET status = ?, updated_at = ? WHERE id = ?').run(to, isoNow(this.clock), judgeId);
  }
  judge(id: number): PanelJudge | undefined {
    const r = this.judgeByIdStmt.get(id) as DbJudgeRow | undefined;
    return r === undefined ? undefined : mapJudge(r);
  }
  /** Bump a judge's re-inject counter; returns the new count (the re-inject guard). */
  bumpJudgeReinjects(judgeId: number): number {
    this.db.prepare('UPDATE panel_judges SET reinjects = reinjects + 1, updated_at = ? WHERE id = ?').run(isoNow(this.clock), judgeId);
    return this.judge(judgeId)?.reinjects ?? 0;
  }

  // --- verdicts (Phase 2) ---

  /** Record a verdict (one per (solution, judge); a duplicate is ignored — write-once). */
  addVerdict(panelId: number, v: AddVerdictInput): void {
    this.verdictInsertStmt.run(
      panelId,
      v.solutionId,
      v.judge,
      JSON.stringify(v.scores ?? {}),
      JSON.stringify(v.refutations ?? []),
      v.recommendation,
      v.fatalDefect ? 1 : 0,
      isoNow(this.clock),
    );
  }
  verdicts(panelId: number): Verdict[] {
    return (this.verdictsStmt.all(panelId) as unknown as DbVerdictRow[]).map(mapVerdict);
  }
  /** True once EVERY produced solution has BOTH a probe and an oracle verdict. */
  hasAllVerdicts(panelId: number): boolean {
    const produced = this.solutions(panelId).filter((s) => s.status === 'produced');
    if (produced.length === 0) return false;
    const verdicts = this.verdicts(panelId);
    return produced.every((s) => {
      const v = verdicts.filter((x) => x.solutionId === s.id);
      return v.some((x) => x.judge === 'probe') && v.some((x) => x.judge === 'oracle');
    });
  }

  // --- decision (Phase 3) ---

  /** Write the IMMUTABLE decision (one per panel). INSERT OR IGNORE on the UNIQUE
   *  panel_id makes it write-once: a second call NEVER overwrites the first. */
  recordDecision(panelId: number, d: RecordDecisionInput): Decision {
    this.decisionInsertStmt.run(
      panelId,
      d.winningSolutionId,
      d.decidedBy,
      JSON.stringify(d.ruleOutput ?? {}),
      JSON.stringify(d.snapshot ?? {}),
      isoNow(this.clock),
    );
    return this.decision(panelId)!;
  }
  decision(panelId: number): Decision | undefined {
    const r = this.decisionStmt.get(panelId) as DbDecisionRow | undefined;
    return r === undefined ? undefined : mapDecision(r);
  }

  // --- gate (Phase 4) ---

  /** Set a gate stage's status + evidence (idempotent per (panel, stage)). */
  setGate(panelId: number, stage: GateStage, status: GateStatus, evidenceRef: string | null = null): PanelGate {
    const now = isoNow(this.clock);
    this.gateUpsertStmt.run(panelId, stage, status, evidenceRef, now, now);
    return this.gate(panelId, stage)!;
  }
  gates(panelId: number): PanelGate[] {
    return (this.gatesStmt.all(panelId) as unknown as DbGateRow[]).map(mapGate);
  }
  gate(panelId: number, stage: GateStage): PanelGate | undefined {
    const r = this.gateStmt.get(panelId, stage) as DbGateRow | undefined;
    return r === undefined ? undefined : mapGate(r);
  }

  /** Stamp the terminal apply time (the panel is now applied). */
  setApplied(panelId: number, appliedAt: string): void {
    this.setAppliedStmt.run(appliedAt, isoNow(this.clock), panelId);
  }
}
