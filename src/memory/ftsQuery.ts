// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * FTS5 query sanitization (SPEC §8). Raw query text from users/agents/memories
 * is NEVER passed to MATCH as-is: we re-tokenize into plain word tokens and
 * rebuild a bounded, fully-quoted OR query. This neutralizes every FTS5
 * operator (double quotes, AND/OR/NOT, NEAR, '*', '^', '-', parentheses,
 * column filters via ':') because none of those characters survive
 * tokenization, and quoted strings are always plain terms.
 */

const MAX_TOKENS = 8;
const MAX_TOKEN_LENGTH = 64;
const PREFIX_EXPAND_MIN_LENGTH = 3;

/**
 * Extract plain unicode word tokens (letters + digits only), NFKC-normalized,
 * lowercased, capped at MAX_TOKENS tokens of MAX_TOKEN_LENGTH chars each.
 * Shared by the FTS builder and the LIKE fallback so both paths see the same
 * tokens. Lowercasing also defangs the uppercase-only FTS5 keyword operators.
 */
export function tokenizeQuery(raw: string): string[] {
  const matches = raw.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return matches.slice(0, MAX_TOKENS).map((t) => t.slice(0, MAX_TOKEN_LENGTH));
}

/**
 * Build a safe FTS5 MATCH expression from arbitrary input.
 * Tokens of length >= 3 are prefix-expanded ("tok"*); shorter tokens match
 * exactly (unbounded 1-char prefix scans are wasteful and noisy). Tokens are
 * OR-joined: recall over precision, ranking sorts it out.
 *
 * Returns '' when no usable token survives (operator soup, emoji, empty) —
 * the caller must then take the LIKE fallback path instead of MATCH.
 */
export function sanitizeFtsQuery(raw: string): string {
  return tokenizeQuery(raw)
    .map((t) => (t.length >= PREFIX_EXPAND_MIN_LENGTH ? `"${t}"*` : `"${t}"`))
    .join(' OR ');
}
