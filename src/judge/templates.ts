// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * Panel task templates (BUILD-judge-panel) — the 3-part shape injected into each
 * panelist's pane: feladat-spec + audit-kritérium + döntési-szabály, so work,
 * rubric, and decision are explicit and aligned. PURE string builders (no I/O), so
 * they're unit-testable and carry NO billing/credential surface.
 */
import type { CreatePanelSpec } from './store.js';
import { stripSecurityTags } from '../trust/frame.js';
import { PROCESS_SENTINEL } from '../core/ids.js';

export interface RubricCriterion {
  id: string;
  description: string;
  type: 'score' | 'boolean';
  weight: number;
  fatalIf?: string;
}

function rubricText(rubric: unknown): string {
  const crit = (rubric as { criteria?: RubricCriterion[] } | undefined)?.criteria;
  if (!Array.isArray(crit) || crit.length === 0) return '(no rubric provided)';
  return crit.map((c) => `  - ${c.id} [${c.type}, weight ${c.weight}]: ${c.description}${c.fatalIf ? ` (FATAL IF: ${c.fatalIf})` : ''}`).join('\n');
}

function ruleSummary(rule: unknown): string {
  const r = rule as { weights?: Record<string, number>; tieBreakChain?: string[] } | undefined;
  const w = r?.weights ?? {};
  return `winner = veto-on-fatal → max(correctness×${w.correctness ?? 2} + robustness×${w.robustness ?? 1} − majorDefects×${w.majorDefectPenalty ?? 1}) → tie-break(${(r?.tieBreakChain ?? ['fewerMajor', 'fewerMinor', 'higherCorrectness', 'lanePriority']).join(' → ')}); all-vetoed → no winner.`;
}

/** SOLVER feladat-spec for one solver (its assigned angle makes the N solutions differ).
 *  When `worktreePath` is given (v1.1 Part B), the solver works in its OWN git worktree —
 *  already checked out to its branch — so parallel solvers never share a working tree. */
export function renderSolverTemplate(spec: CreatePanelSpec, solver: { agentId: string; angle: string }, worktreePath?: string): string {
  const branch = `${spec.branchPrefix}/sol-${solver.agentId}`;
  const workLine = worktreePath !== undefined
    ? `- Dolgozz EBBEN a worktree-ben (már a saját branch-edre — \`${branch}\` — van állítva): \`${worktreePath}\`. \`cd\` ide, és ITT commitolj (NE a közös checkout-ban, NE main-en).`
    : `- Dolgozz a saját branch-eden: \`${branch}\` (NE main-en).`;
  return [
    `# Panel solver task — ${solver.agentId}`,
    '',
    `## Feladat (goal)`,
    spec.goal,
    // conditional section: spread (with its own blank-line separator) ONLY when present —
    // so absent context drops cleanly without collapsing every other section's spacing.
    ...(spec.context ? ['', `## Kontextus`, spec.context] : []),
    '',
    `## A te szöged (angle) — ezért különbözzön a megoldásod a többiekétől`,
    solver.angle || '(general best-effort)',
    '',
    `## Megkötések (constraints)`,
    workLine,
    `- A megoldásnak át kell mennie: \`${spec.testCommand}\`.`,
    `- Billing/autonómia: csak a meglévő subscription-pool eszközöket használd; semmi metered/API-kulcs.`,
    '',
    `## Leadás (deliverable)`,
    `- A végső megoldás: egy rövid pane-összefoglaló + commit a fenti branch-en.`,
    '',
    `## Audit-kritérium (a bírák UGYANEZT pontozzák — önellenőrzés)`,
    rubricText(spec.rubric),
    '',
    `## Döntési-szabály (így választunk győztest)`,
    ruleSummary(spec.decisionRule),
  ].join('\n');
}

export interface FrozenSolution {
  solutionId: number;
  solverAgentId: string;
  branch: string;
  tailSummary: string | null;
}

const MULTI_VERDICT_LINE =
  '{"verdicts":[{"solutionId":<id>,"scores":{"correctness":<int>,"robustness":<int>},"refutations":[{"claim":"…","severity":"fatal|major|minor","evidenceRef":"…"}],"fatalDefect":<bool>,"recommendation":"accept|reject|revise"}]}';

/**
 * The required-output section. With a `verdictPath`, the judge MUST write the JSON to that
 * DURABLE FILE (the panel's source of truth — immune to TUI redraw / 8-line-tail truncation;
 * the panel reads the file FIRST on the finish edge) AND echo the fenced block for humans.
 */
function outputSection(jsonLine: string, verdictPath: string | undefined): string {
  const fence = ['```panel-verdict', jsonLine, '```'];
  if (verdictPath === undefined) {
    return ['## Kötelező kimenet (EZT a blokkot add vissza, pontosan így)', ...fence].join('\n');
  }
  return [
    '## Kötelező kimenet (az ELSŐDLEGES forrás a FÁJL, nem a pane)',
    `1) ÍRD a TELJES verdict JSON-t EBBE a fájlba (abszolút útvonal, TUI-független): \`${verdictPath}\``,
    '2) ÉS echo-zd vissza ugyanezt a blokkot a pane-be is (emberi olvasásra):',
    ...fence,
  ].join('\n');
}

function frozenBlock(solutions: FrozenSolution[]): string {
  return solutions
    .map((s) => {
      // tailSummary is RAW untrusted solver pane output — neutralize framing tags HERE, at
      // the point untrusted content enters the template, so EVERY judge-bound delivery path
      // carries safe content: the primary move→onDispatch (idempotent double-strip) AND the
      // two direct injectInput re-injects (malformed-verdict + running-PROBE review). The
      // solver id + branch are system-derived/sanitized, not stripped.
      const summary = s.tailSummary === null ? '(no summary)' : stripSecurityTags(s.tailSummary, PROCESS_SENTINEL);
      return `### solution #${s.solutionId} — ${s.solverAgentId} (branch ${s.branch})\n${summary}`;
    })
    .join('\n\n');
}

/** PROBE (refuter): attack/break each frozen solution; NEVER proposes its own. */
export function renderProbeTemplate(spec: CreatePanelSpec, solutions: FrozenSolution[], verdictPath?: string): string {
  return [
    `# Panel judge — PROBE (adversarial refuter)`,
    '',
    `Szereped: TÁMADD és törd meg az alábbi megoldásokat. Soha ne javasolj sajátot. Ne találj ki hibát; csak valós, bizonyítható defektet jelölj.`,
    `Feladat (amit a megoldások céloznak): ${spec.goal}`,
    '',
    `## Befagyasztott megoldások (1..N)`,
    frozenBlock(solutions),
    '',
    `## Audit-kritérium (pontozd MINDEGYIKET egész számmal)`,
    rubricText(spec.rubric),
    '',
    `## fatalDefect definíció`,
    `severity=fatal CSAK diszkvalifikáló (a megoldást alapjaiban érvénytelenítő) defektre. Egyébként major/minor.`,
    '',
    outputSection(MULTI_VERDICT_LINE, verdictPath),
  ].join('\n');
}

/** ORACLE (correctness/research): verify correctness + sources of each frozen solution. */
export function renderOracleTemplate(spec: CreatePanelSpec, solutions: FrozenSolution[], verdictPath?: string): string {
  return [
    `# Panel judge — ORACLE (correctness & source verification)`,
    '',
    `Szereped: igazold a HELYESSÉGET és a forrásokat. Minden teherviselő (load-bearing) állítást jelölj: verified | unsupported | false (evidenceRef-fel).`,
    `Feladat: ${spec.goal}`,
    '',
    `## Befagyasztott megoldások (1..N)`,
    frozenBlock(solutions),
    '',
    `## Audit-kritérium (korrektség-pontok egész számmal)`,
    rubricText(spec.rubric),
    '',
    `## fatalDefect szabály`,
    `Ha egy TEHERVISELŐ állítás verified-FALSE → fatalDefect=true az adott megoldásra.`,
    '',
    outputSection(MULTI_VERDICT_LINE, verdictPath),
  ].join('\n');
}

/** REVIEW (Phase 4): PROBE re-refutes the SINGLE winning solution post-test. review
 *  passes ONLY on a recorded `accept`; reject/revise bounces the panel. The winner's
 *  test evidence is included so the refutation is grounded in the passing run. */
export function renderReviewTemplate(spec: CreatePanelSpec, winner: FrozenSolution, testEvidence: string, round: string, verdictPath?: string): string {
  // a per-round REVIEW output line carrying a nonce the judge must echo back — so a STALE
  // judging verdict block (which has no `round`) can never satisfy the review parse.
  const reviewLine = `{"round":"${round}","verdicts":[{"solutionId":${winner.solutionId},"scores":{"correctness":<int>,"robustness":<int>},"refutations":[{"claim":"…","severity":"fatal|major|minor","evidenceRef":"…"}],"fatalDefect":<bool>,"recommendation":"accept|reject|revise"}]}`;
  const reviewFormat = [
    outputSection(reviewLine, verdictPath),
    `A "round" mezőt VÁLTOZATLANUL másold vissza (\`${round}\`) — e nélkül a review-verdict érvénytelen (a régi bírálati blokk nem fogadható el).`,
  ].join('\n');
  return [
    `# Panel REVIEW — PROBE re-refutes the WINNER (final adversarial check, post-test)`,
    '',
    `Szereped: a győztes megoldást MOST támadd meg utoljára, a sikeres teszt UTÁN. Ez a végső kapu a merge előtt.`,
    `Feladat: ${spec.goal}`,
    '',
    `## A győztes megoldás`,
    frozenBlock([winner]),
    '',
    `## Teszt-bizonyíték (a győztes branch lefutott tesztje)`,
    // the test log is produced by running the (solver-authored) branch → also untrusted; strip.
    stripSecurityTags(testEvidence, PROCESS_SENTINEL).slice(0, 2000) || '(no test evidence captured)',
    '',
    `## Audit-kritérium`,
    rubricText(spec.rubric),
    '',
    `## Döntés`,
    `recommendation=accept CSAK ha nincs több diszkvalifikáló/blokkoló defekt; egyébként reject (vagy revise). Egyetlen bejegyzés, a győztes solutionId-jával.`,
    '',
    reviewFormat,
  ].join('\n');
}

/** Shared header for a judge's frozen-solutions block (Phase 2 renders the full body). */
export function renderJudgePlaceholder(role: 'probe' | 'oracle', spec: CreatePanelSpec): string {
  const job =
    role === 'probe'
      ? 'Adversariális refuter: minden megoldást TÁMADJ/törj meg (sosem javasolsz sajátot).'
      : 'Korrektség/forrás-ellenőrző: igazold a helyességet és a forrásokat.';
  return [
    `# Panel judge (${role}) — vár a kvórumra`,
    '',
    job,
    '',
    `A befagyasztott megoldásokat a panel a kvórum elérésekor küldi ide (audit-kritérium + kötelező kimeneti formátum).`,
    `Feladat: ${spec.goal}`,
  ].join('\n');
}
