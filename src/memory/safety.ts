// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * Memory content-safety filter (PROMPT-08 §6.3/§8). Every memory write through
 * the API (operator OR agent) is screened: text matching prompt-injection or
 * shell-execution patterns is rejected server-side with a 400. This is a
 * guardrail against a compromised/abused write poisoning the shared corpus or
 * smuggling an instruction the agents later recall and act on.
 *
 * The patterns are deliberately HIGH-SIGNAL — they target the recognizable
 * shapes of an attack (override-the-instructions phrasing, destructive shell
 * one-liners, command substitution invoking dangerous binaries, credential
 * exfiltration) rather than broad keywords, so ordinary notes that merely
 * mention "deploy", "build", or "code" are never rejected.
 */

const INJECTION_PATTERNS: RegExp[] = [
  // "ignore/disregard/forget (all) previous/prior/above INSTRUCTIONS|PROMPTS|RULES|CONTEXT"
  // The instruction-object is REQUIRED so "forget the previous meeting" stays benign.
  /\b(?:ignore|disregard|forget)\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|earlier|preceding|above)\s+(?:instructions?|prompts?|messages?|directions?|rules?|context|commands?)\b/i,
  // "override/bypass/disable the SYSTEM PROMPT / SAFETY / GUARDRAILS" (high-signal objects only)
  /\b(?:override|bypass|disable|circumvent)\s+(?:your\s+|the\s+|all\s+)?(?:system\s+prompt|system\s+instructions|safety\s*(?:filters?|guards?|checks?|measures?|rails?)?|guardrails?|safeguards?|content\s+polic\w+)\b/i,
  // "override/ignore YOUR instructions/rules/programming" (possessive — not "the README's instructions")
  /\b(?:override|ignore|disregard|bypass)\s+your\s+(?:instructions?|directives?|rules?|programming|training|guidelines?)\b/i,
  // "reveal/print/repeat the SYSTEM PROMPT / your instructions" (NOT generic secrets/credentials/keys)
  /\b(?:reveal|print|show|repeat|output|disclose)\s+(?:me\s+)?(?:your\s+|the\s+|all\s+(?:of\s+)?your\s+)?(?:system\s+prompt|system\s+instructions|initial\s+instructions|hidden\s+(?:prompt|instructions)|prompt\s+above|instructions\s+above)\b/i,
  // persona-hijack: "you are now … unrestricted/unfiltered/jailbroken/DAN/developer mode/free of your rules"
  /\byou\s+are\s+now\s+[\w\s,'-]{0,24}?(?:unrestricted|unfiltered|unbounded|jailbroken|\bDAN\b|developer\s+mode|free\s+of\s+(?:your\s+)?(?:rules?|restrictions?|guidelines?|filters?)|able\s+to\s+ignore)/i,
  // Hungarian: "hagyd figyelmen kívül / felejtsd el az eddigi/előző UTASÍTÁS|PARANCS|SZABÁLY|PROMPT…"
  // (instruction-object REQUIRED so "felejtsd el az előző találkozót" stays benign)
  /\b(?:hagyd\s+figyelmen\s+kívül|felejtsd\s+el|tekints\s+el(?:\s+az?)?)\s+(?:az?\s+)?(?:eddigi|előző|fenti|korábbi|összes)\s+(?:utasítás|parancs|szabály|üzenet|prompt|instrukció|kontextus)/i,
];

const EXEC_PATTERNS: RegExp[] = [
  /\brm\s+-[rf]{1,2}\b/i, // rm -rf / rm -f / rm -r
  /\bsudo\s+\S/i, // sudo <something>
  /\b(?:curl|wget)\b[^\n]*\|\s*(?:sh|bash|zsh|python\d?)\b/i, // curl … | sh
  /\$\(\s*[^)]*\b(?:rm|curl|wget|eval|sh|bash|cat|nc|ncat)\b[^)]*\)/i, // $(… dangerous …)
  /\b(?:mkfs|chmod\s+777|chown\s+-R|dd\s+if=)\b/i,
  /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, // fork bomb :(){ :|:& };:
  // child_process invoked for execution (NOT a benign mention like "child_process.fork for workers")
  /\bchild_process\b[\s'")\]]*\.\s*(?:exec|execSync|spawn|spawnSync)\s*\(/i,
  /require\(\s*['"]child_process['"]\s*\)\s*\.\s*(?:exec|spawn)/i,
  /\beval\s*\(/i,
  /\/etc\/(?:passwd|shadow)\b/i, // credential file exfiltration
];

export interface ScreenResult {
  ok: boolean;
  /** Which guard tripped (for server-side logging only — never shown raw). */
  kind?: 'injection' | 'exec';
}

/** Screen memory content; ok=false means the write must be rejected with a 400. */
export function screenMemoryContent(text: string): ScreenResult {
  const s = typeof text === 'string' ? text : '';
  if (INJECTION_PATTERNS.some((re) => re.test(s))) return { ok: false, kind: 'injection' };
  if (EXEC_PATTERNS.some((re) => re.test(s))) return { ok: false, kind: 'exec' };
  return { ok: true };
}
