// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import type { AddVerdictInput, JudgeRole, Recommendation, Refutation, Severity } from './store.js';

/**
 * Parse a judge's pane output into one verdict per frozen solution (BUILD-judge-panel
 * Phase 2). The TUI has no structured return, so the judge template asks for a single
 * fenced block:
 *
 *   ```panel-verdict
 *   {"verdicts":[{"solutionId":1,"scores":{"correctness":3},"refutations":[{"claim":"…","severity":"major"}],"fatalDefect":false,"recommendation":"accept"}]}
 *   ```
 *
 * PURE + total: returns {ok:false} on any malformed/missing/incomplete output (caller
 * then re-injects ONCE, then escalates) — it NEVER throws and NEVER invents a verdict.
 */

export type ParseResult = { ok: true; verdicts: AddVerdictInput[] } | { ok: false; reason: string };

const SEVERITIES = new Set<Severity>(['fatal', 'major', 'minor']);
const RECS = new Set<Recommendation>(['accept', 'reject', 'revise']);

/**
 * Extract the verdict JSON. Judges in practice emit a generic fence (or write a pure-JSON
 * artifact FILE), so accept a ```panel-verdict / ```json / bare ``` fenced block (newest
 * first) AND a bare {…"verdicts"…} object (the file case, possibly with a leading "round").
 */
function extractJson(text: string): string | null {
  const fences = [...text.matchAll(/```(?:panel-verdict|json)?[ \t]*\r?\n?([\s\S]*?)```/g)];
  for (let i = fences.length - 1; i >= 0; i--) {
    const inner = fences[i]![1]!;
    if (inner.includes('"verdicts"')) {
      const obj = extractObjectWithVerdicts(inner);
      if (obj !== null) return obj;
    }
  }
  // bare object — a pure-JSON artifact file, or a fenceless pane.
  return extractObjectWithVerdicts(text);
}

/** The LAST balanced {...} object whose body mentions "verdicts" (string-aware). */
function extractObjectWithVerdicts(text: string): string | null {
  let result: string | null = null;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    const sliced = sliceBalanced(text, i);
    if (sliced !== null && sliced.includes('"verdicts"')) {
      result = sliced;
      i += sliced.length - 1; // skip past this object so we keep the LAST one
    }
  }
  return result;
}

/** Return the balanced {...} starting at `from`, or null if unbalanced. String-aware:
 *  braces inside JSON string literals (and escapes) are ignored. */
function sliceBalanced(text: string, from: number): string | null {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(from, i + 1);
    }
  }
  return null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function normRefutations(raw: unknown): Refutation[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  const out: Refutation[] = [];
  for (const r of raw) {
    if (!isRecord(r) || typeof r.claim !== 'string') return null;
    const severity = r.severity as Severity;
    if (!SEVERITIES.has(severity)) return null;
    out.push({ claim: r.claim, severity, ...(typeof r.evidenceRef === 'string' ? { evidenceRef: r.evidenceRef } : {}) });
  }
  return out;
}

function normScores(raw: unknown): Record<string, number> | null {
  if (!isRecord(raw)) return null;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    out[k] = Math.trunc(v); // integer arithmetic only (the rule is integer-only)
  }
  return out;
}

export function parseVerdicts(
  paneText: string,
  judge: JudgeRole,
  expectedSolutionIds: number[],
  opts?: { expectedRound?: string },
): ParseResult {
  const json = extractJson(paneText);
  if (json === null) return { ok: false, reason: 'no verdict block found' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, reason: 'panel-verdict block is not valid JSON' };
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.verdicts)) return { ok: false, reason: 'missing verdicts array' };
  // REVIEW round freshness: when a round nonce is expected, the block MUST echo it —
  // this is what stops a stale judging verdict (no `round`) from passing the review gate.
  if (opts?.expectedRound !== undefined && parsed.round !== opts.expectedRound) {
    return { ok: false, reason: `stale or missing review round (expected '${opts.expectedRound}', got '${String(parsed.round)}')` };
  }

  const byId = new Map<number, AddVerdictInput>();
  for (const raw of parsed.verdicts) {
    if (!isRecord(raw)) return { ok: false, reason: 'a verdict entry is not an object' };
    const solutionId = typeof raw.solutionId === 'number' ? raw.solutionId : NaN;
    if (!Number.isInteger(solutionId)) return { ok: false, reason: 'a verdict has no integer solutionId' };
    const scores = normScores(raw.scores);
    if (scores === null) return { ok: false, reason: `solution ${solutionId}: scores must be a {string:number} map` };
    const refutations = normRefutations(raw.refutations);
    if (refutations === null) return { ok: false, reason: `solution ${solutionId}: malformed refutations` };
    const recommendation = raw.recommendation as Recommendation;
    if (!RECS.has(recommendation)) return { ok: false, reason: `solution ${solutionId}: recommendation must be accept|reject|revise` };
    const fatalDefect = raw.fatalDefect === true || refutations.some((r) => r.severity === 'fatal');
    byId.set(solutionId, { solutionId, judge, scores, refutations, recommendation, fatalDefect });
  }

  // every frozen solution MUST have a verdict — judging cannot close with a gap.
  const missing = expectedSolutionIds.filter((id) => !byId.has(id));
  if (missing.length > 0) return { ok: false, reason: `missing verdicts for solutions: ${missing.join(', ')}` };
  return { ok: true, verdicts: expectedSolutionIds.map((id) => byId.get(id)!) };
}
