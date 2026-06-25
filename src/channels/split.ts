// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * Boundary-aware message splitting (SPEC §7).
 *
 * Preference order for cut points:
 *   1. paragraph breaks (a run of 2+ newlines)
 *   2. line breaks (a single newline)
 *   3. sentence boundaries (whitespace following '.', '!' or '?')
 *   4. hard cut at maxLen (last resort, e.g. one unbroken token)
 *
 * EXACT WHITESPACE RULE: separator whitespace is kept, attached to the END of
 * the chunk that precedes the boundary; nothing is ever inserted, trimmed or
 * collapsed. Consequently the chunks are contiguous slices of the input and
 * `chunks.join('')` reproduces the original text byte-for-byte (the
 * reassembly invariant, covered by tests).
 *
 * Guarantees: no chunk exceeds maxLen; no chunk is empty (empty input yields
 * an empty array). A chunk MAY consist solely of whitespace in the degenerate
 * case where the input starts with a separator run too large to merge —
 * allowed because exact reassembly takes precedence.
 */

const BOUNDARY_LEVELS: readonly RegExp[] = [
  /\n{2,}/g, // paragraph break
  /\n/g, // line break
  /(?<=[.!?])\s+/g, // sentence boundary: whitespace after terminal punctuation
];

export function splitMessage(text: string, maxLen: number): string[] {
  if (!Number.isInteger(maxLen) || maxLen < 1) {
    throw new RangeError(`maxLen must be a positive integer, got ${maxLen}`);
  }
  if (text.length === 0) return [];
  return splitAtLevel(text, maxLen, 0);
}

function splitAtLevel(text: string, maxLen: number, level: number): string[] {
  if (text.length <= maxLen) return [text];
  if (level >= BOUNDARY_LEVELS.length) return hardCut(text, maxLen);
  const separator = BOUNDARY_LEVELS[level];
  if (separator === undefined) return hardCut(text, maxLen);
  const pieces = tokenize(text, separator);
  if (pieces.length <= 1) return splitAtLevel(text, maxLen, level + 1);

  // Greedy packing: append pieces while they fit; an oversized single piece
  // descends to the next (finer) boundary level.
  const chunks: string[] = [];
  let buffer = '';
  for (const piece of pieces) {
    if (buffer.length + piece.length <= maxLen) {
      buffer += piece;
      continue;
    }
    if (buffer.length > 0) {
      chunks.push(buffer);
      buffer = '';
    }
    if (piece.length <= maxLen) {
      buffer = piece;
      continue;
    }
    const subs = splitAtLevel(piece, maxLen, level + 1);
    chunks.push(...subs.slice(0, -1));
    buffer = subs[subs.length - 1] ?? '';
  }
  if (buffer.length > 0) chunks.push(buffer);
  return chunks;
}

/**
 * Split into pieces where each separator match stays attached to the end of
 * the preceding piece, so pieces.join('') === text exactly.
 */
function tokenize(text: string, separator: RegExp): string[] {
  const pieces: string[] = [];
  let prev = 0;
  for (const m of text.matchAll(separator)) {
    const end = (m.index ?? 0) + m[0].length;
    pieces.push(text.slice(prev, end));
    prev = end;
  }
  if (prev < text.length) pieces.push(text.slice(prev));
  return pieces;
}

function hardCut(text: string, maxLen: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += maxLen) {
    chunks.push(text.slice(i, i + maxLen));
  }
  return chunks;
}
