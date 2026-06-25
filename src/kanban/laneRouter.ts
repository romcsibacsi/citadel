// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import type { LaneConfig } from '../config/types.js';

/**
 * Pure "guess the assignee/lane" router (SPEC §11): maps free-text to a
 * specialty lane. Config-driven lanes, first-match in config order, keywords
 * matched at a LEADING word boundary with prefix expansion so inflected
 * (e.g. Hungarian suffixed) forms still match: "kutat" matches "kutatási".
 */

function isWordChar(ch: string): boolean {
  return /[\p{L}\p{N}]/u.test(ch);
}

function keywordMatches(textLower: string, keywordLower: string): boolean {
  if (keywordLower === '') return false;
  let from = 0;
  for (;;) {
    const idx = textLower.indexOf(keywordLower, from);
    if (idx === -1) return false;
    const before = idx === 0 ? '' : textLower[idx - 1]!;
    if (before === '' || !isWordChar(before)) return true; // leading boundary; suffix free
    from = idx + 1;
  }
}

export function guessLane(text: string, lanes: LaneConfig[]): string | null {
  const lower = text.toLocaleLowerCase();
  for (const lane of lanes) {
    for (const keyword of lane.keywords) {
      if (keywordMatches(lower, keyword.toLocaleLowerCase())) return lane.agentId;
    }
  }
  return null;
}
