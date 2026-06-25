// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * Deterministic panel decision rule (BUILD-judge-panel Phase 3) — veto → score →
 * stable tie-break. PURE + TOTAL + INTEGER-ONLY: the winner is a pure function of a
 * FROZEN inputs snapshot; the same snapshot always replays to the same winner,
 * INDEPENDENT of input row order (the comparator ends on the unique lanePriority
 * index, so the order is total). NO model judgment, NO floats, NO randomness/time.
 */

export interface SolutionInputs {
  solutionId: number;
  /** Index in config.lanePriority (the declared solver order); unique → total tie-break. */
  lanePriorityIndex: number;
  /** Aggregate correctness across the judges (integer). */
  correctness: number;
  /** ORACLE's correctness score alone — the tie-break key. */
  oracleCorrectness: number;
  /** Count of severity=major refutations across the judges. */
  majorDefects: number;
  /** Count of severity=minor refutations across the judges. */
  minorDefects: number;
  /** Veto flag: a fatal defect (PROBE severity=fatal OR ORACLE fatalDefect). */
  fatal: boolean;
}

export interface DecisionRuleConfig {
  weights: { correctness: number; robustness: number; majorDefectPenalty: number };
  noWinnerIfAllVetoed: boolean;
}

export interface RuleInputsSnapshot {
  solutions: SolutionInputs[];
  config: DecisionRuleConfig;
}

export interface RankedEntry {
  solutionId: number;
  vetoed: boolean;
  composite: number;
  robustness: number;
  correctness: number;
  oracleCorrectness: number;
  majorDefects: number;
  minorDefects: number;
  lanePriorityIndex: number;
}

export type DecidedBy =
  | 'no-winner-all-vetoed'
  | 'least-bad-all-vetoed'
  | 'sole-eligible'
  | 'score'
  | 'tiebreak:fewerMajor'
  | 'tiebreak:fewerMinor'
  | 'tiebreak:higherCorrectness'
  | 'tiebreak:lanePriority';

export interface DecisionOutput {
  winningSolutionId: number | null;
  decidedBy: DecidedBy;
  /** Full ranking: eligible first (by the total order), vetoed last. */
  ranked: RankedEntry[];
  trace: string[];
}

/** robustness = the inverse of the defect count (more defects → lower). Integer.
 *  Guard against −0 so the in-memory output stays bit-identical to the JSON-replayed
 *  one (JSON.stringify(-0) → "0"), keeping the decision exactly replayable. */
function robustnessOf(s: SolutionInputs): number {
  const defects = s.majorDefects + s.minorDefects;
  return defects === 0 ? 0 : -defects;
}

function compositeOf(s: SolutionInputs, cfg: DecisionRuleConfig): number {
  const w = cfg.weights;
  return s.correctness * w.correctness + robustnessOf(s) * w.robustness - s.majorDefects * w.majorDefectPenalty;
}

function entry(s: SolutionInputs, cfg: DecisionRuleConfig): RankedEntry {
  return {
    solutionId: s.solutionId,
    vetoed: s.fatal,
    composite: compositeOf(s, cfg),
    robustness: robustnessOf(s),
    correctness: s.correctness,
    oracleCorrectness: s.oracleCorrectness,
    majorDefects: s.majorDefects,
    minorDefects: s.minorDefects,
    lanePriorityIndex: s.lanePriorityIndex,
  };
}

/** Total comparator for ELIGIBLE entries: a before b ⇒ negative. Ends on the unique
 *  lanePriorityIndex, so the order is total and input-order-independent. */
function compare(a: RankedEntry, b: RankedEntry): number {
  if (a.composite !== b.composite) return b.composite - a.composite; // higher first
  if (a.majorDefects !== b.majorDefects) return a.majorDefects - b.majorDefects; // fewer major
  if (a.minorDefects !== b.minorDefects) return a.minorDefects - b.minorDefects; // fewer minor
  if (a.oracleCorrectness !== b.oracleCorrectness) return b.oracleCorrectness - a.oracleCorrectness; // higher
  return a.lanePriorityIndex - b.lanePriorityIndex; // lower index (declared order) — unique
}

/** Which comparator field first distinguishes the winner from the runner-up. */
function decidingStep(w: RankedEntry, r: RankedEntry): DecidedBy {
  if (w.composite !== r.composite) return 'score';
  if (w.majorDefects !== r.majorDefects) return 'tiebreak:fewerMajor';
  if (w.minorDefects !== r.minorDefects) return 'tiebreak:fewerMinor';
  if (w.oracleCorrectness !== r.oracleCorrectness) return 'tiebreak:higherCorrectness';
  return 'tiebreak:lanePriority';
}

/**
 * Compute the winner deterministically. VETO disqualifies any fatal solution
 * regardless of score; if EVERY solution is vetoed → no winner (null) by default
 * (`noWinnerIfAllVetoed`, the v1 confirmed rule — never "least-bad"). The flag is
 * declarative so a future panel can opt into least-bad; either branch is total +
 * deterministic. Otherwise rank the eligible by the total order and pick the max.
 */
export function decideWinner(snapshot: RuleInputsSnapshot): DecisionOutput {
  const cfg = snapshot.config;
  const all = snapshot.solutions.map((s) => entry(s, cfg));
  const eligible = all.filter((e) => !e.vetoed).sort(compare);
  const vetoed = all.filter((e) => e.vetoed).sort(compare);
  const ranked = [...eligible, ...vetoed];
  const trace: string[] = [];
  trace.push(`veto: ${vetoed.length}/${all.length} disqualified (fatal)`);

  if (eligible.length === 0) {
    // Default v1: all vetoed → no winner. A future config may opt into least-bad
    // (the best vetoed by the same total order) — still deterministic + total.
    if (cfg.noWinnerIfAllVetoed || vetoed.length === 0) {
      trace.push('all solutions vetoed → no winner (null), never least-bad');
      return { winningSolutionId: null, decidedBy: 'no-winner-all-vetoed', ranked, trace };
    }
    const leastBad = vetoed[0]!;
    trace.push(`all vetoed but noWinnerIfAllVetoed=false → least-bad #${leastBad.solutionId}`);
    return { winningSolutionId: leastBad.solutionId, decidedBy: 'least-bad-all-vetoed', ranked, trace };
  }
  const winner = eligible[0]!;
  if (eligible.length === 1) {
    trace.push(`sole eligible solution #${winner.solutionId} wins`);
    return { winningSolutionId: winner.solutionId, decidedBy: 'sole-eligible', ranked, trace };
  }
  const runnerUp = eligible[1]!;
  const decidedBy = decidingStep(winner, runnerUp);
  trace.push(
    `composite (correctness×${cfg.weights.correctness} + robustness×${cfg.weights.robustness} − major×${cfg.weights.majorDefectPenalty}): ` +
      eligible.map((e) => `#${e.solutionId}=${e.composite}`).join(', '),
  );
  trace.push(`winner #${winner.solutionId} over #${runnerUp.solutionId} by ${decidedBy}`);
  return { winningSolutionId: winner.solutionId, decidedBy, ranked, trace };
}
