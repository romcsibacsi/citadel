// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import type { DefaultPermissionPosture, PermissionDefaultMode, ProfileMode } from '../config/types.js';

/**
 * Permission precedence (SPEC §15): deny > ask > allow > defaultMode.
 * Pure and exhaustively unit-tested — this is what makes
 * `strict` + `defaultMode=bypassPermissions` a REAL sandbox: no prompts,
 * but deny rules still enforced.
 */

export type PermissionDecision = 'allow' | 'ask' | 'deny';

export interface PermissionRequest {
  tool: string;
  /** Tool argument being gated: a path for file tools, the command for Bash, a URL for web tools. */
  specifier?: string;
}

export interface PermissionRuleSet {
  mode: ProfileMode;
  defaultMode?: PermissionDefaultMode;
  allow: string[];
  ask: string[];
  deny: string[];
}

interface ParsedRule {
  tool: string; // '*' = any tool
  spec?: string; // glob; absent = any specifier
}

function parseRule(rule: string): ParsedRule | undefined {
  const trimmed = rule.trim();
  if (trimmed === '') return undefined;
  if (trimmed === '*') return { tool: '*' };
  const open = trimmed.indexOf('(');
  if (open === -1) return { tool: trimmed };
  if (!trimmed.endsWith(')')) return undefined; // malformed — ignore rather than misparse
  const tool = trimmed.slice(0, open).trim();
  const spec = trimmed.slice(open + 1, -1).trim();
  if (tool === '') return undefined;
  return spec === '' ? { tool } : { tool, spec };
}

/**
 * Glob semantics: '*' and '**' both match ANY characters (including '/').
 * Recorded ASSUMPTION: over-matching is biased toward safety here — a broad
 * deny always wins via precedence, so greedy wildcards cannot weaken a deny;
 * allow-rule authors should write precise rules.
 */
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\?]/g, '\\$&');
  const pattern = escaped.replace(/\*+/g, '.*');
  return new RegExp(`^${pattern}$`, 's');
}

function ruleMatches(rule: ParsedRule, req: PermissionRequest): boolean {
  if (rule.tool !== '*' && rule.tool !== req.tool) return false;
  if (rule.spec === undefined) return true; // bare tool rule covers every specifier
  if (req.specifier === undefined) {
    // a specifier-scoped rule only covers a specifier-less request if it is all-matching
    return /^\*+$/.test(rule.spec);
  }
  return globToRegExp(rule.spec).test(req.specifier);
}

function anyMatch(rules: string[], req: PermissionRequest): boolean {
  for (const raw of rules) {
    const parsed = parseRule(raw);
    if (parsed && ruleMatches(parsed, req)) return true;
  }
  return false;
}

export function decidePermission(rules: PermissionRuleSet, req: PermissionRequest): PermissionDecision {
  if (anyMatch(rules.deny, req)) return 'deny';
  if (anyMatch(rules.ask, req)) return 'ask';
  if (anyMatch(rules.allow, req)) return 'allow';
  switch (rules.defaultMode) {
    case 'deny':
      return 'deny';
    case 'allow':
      return 'allow';
    case 'ask':
      return 'ask';
    case 'bypassPermissions':
      // no prompts; deny rules were already given absolute precedence above
      return 'allow';
    case undefined:
      return rules.mode === 'permissive' ? 'allow' : 'ask';
  }
}

/**
 * Resolve a profile's effective defaultMode under the global permission posture
 * (FIX-agent-permissions-permissive). The 'permissive' posture (this install's
 * default) relaxes a CAUTIOUS profile — one whose fallback decision is 'ask' — to
 * bypassPermissions: no interactive prompts, but deny rules ALWAYS win
 * (decidePermission gives deny absolute precedence above defaultMode), so
 * dangerous ops stay blocked. Any other posture, or a profile with an explicit
 * allow/deny/bypassPermissions defaultMode, is a passthrough. SINGLE source of
 * truth for the scaffold (settings.json), the launch spec (bypass-accept seeding),
 * and the agent-tools gate, so the three never drift.
 */
export function effectivePermissionMode(
  profile: { mode: ProfileMode; defaultMode?: PermissionDefaultMode },
  posture: DefaultPermissionPosture,
): PermissionDefaultMode | undefined {
  if (posture !== 'permissive') return profile.defaultMode;
  const fallback = profile.defaultMode ?? (profile.mode === 'permissive' ? 'allow' : 'ask');
  return fallback === 'ask' ? 'bypassPermissions' : profile.defaultMode;
}

/** Resolve per-agent placeholders inside rule strings (SPEC §15). */
export function resolveRulePlaceholders(rules: string[], vars: Record<string, string>): string[] {
  return rules.map((rule) =>
    rule.replace(/\{([A-Z_]+)\}/g, (whole, name: string) => vars[name] ?? whole),
  );
}
