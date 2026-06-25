// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
// #289 — (b)-DB PROJECTOR built on the F0-engine classifyLeaf (the CANONICAL classification). This
// REPLACES the RELAY separate-projector (db-split-shadow.py): instead of re-implementing the clear/token/
// opaque decision (which keeps diverging), the (b)-DB projection calls the SAME classifyLeaf that the
// encode-projector, the zero-raw-assert, and the gate use. No divergence by construction — the keystone.
//
// The core stays domain-FREE: the (b)-DB column -> pack-field mapping (`ColumnMap`) is supplied by the
// MODULE (accounting). An unmapped (b)-DB column -> OPAQUE (default-deny by absence).

import type { ResolvedPolicy } from './policy/registry.js';
import { classifyLeaf, isClearLegit, recordSaltOf, type SealedLeaf } from './engine.js';

/** 'table.column' -> 'schemaId.fieldPath' (pack-provided; keeps the core domain-free). */
export type ColumnMap = Record<string, string>;

export type ColumnClass = 'clear' | 'token' | 'opaque';
export interface ProjectedRow {
  table: string;
  cols: Record<string, { class: ColumnClass; value: string }>;
}

function classOf(leaf: SealedLeaf): ColumnClass {
  return leaf.t === 'const' ? 'clear' : leaf.t === 'opaque' ? 'opaque' : 'token';
}

/** Project one (b)-DB row via classifyLeaf. A cleared cell carries the real value (committed constant);
 *  a token/opaque cell carries the token. Unmapped column -> OPAQUE (default-deny by absence). */
export function projectRow(
  table: string,
  row: Record<string, string>,
  columnMap: ColumnMap,
  policy: ResolvedPolicy,
): ProjectedRow {
  const cols: ProjectedRow['cols'] = {};
  const salt = recordSaltOf(row); // #344-C: one per-record salt for the whole row (salted fields get it)
  for (const [col, value] of Object.entries(row)) {
    const logical = columnMap[`${table}.${col}`];
    let leaf: SealedLeaf;
    if (logical === undefined) {
      // pack keyed by real table.column -> use (table, col) directly; classifyLeaf returns OPAQUE for an
      // unmapped/unknown column (default-deny by absence — the projector cannot skip).
      leaf = classifyLeaf(table, col, value, policy, salt);
    } else {
      const dot = logical.lastIndexOf('.');
      leaf = classifyLeaf(logical.slice(0, dot), logical.slice(dot + 1), value, policy, salt);
    }
    // STRUCTURAL fails-closed at the (b)-DB egress: a cell may carry a real (clear) value ONLY when the
    // policy validates it as a committed-allowlist constant / vocab-clear field. classifyLeaf already
    // honours this, so this guard is the invariant assertion that NO (b)-DB column can carry a false-clear
    // regardless of pack/columnMap misconfiguration — the recurrence-proof for the projector false-clear.
    if (!isClearLegit(leaf, policy)) {
      throw new Error(`projectRow: ${table}.${col} false-clear — not a committed-allowlist / vocab-clear value (fails-closed default-deny)`);
    }
    cols[col] = { class: classOf(leaf), value: leaf.v };
  }
  return { table, cols };
}
