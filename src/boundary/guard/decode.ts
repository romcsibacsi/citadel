// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
// #288 — the DECODE-GUARD contract (return path), equal-strength to the encode-guard. The cloud cannot
// forge a token (no key) but can echo/covert-channel, so the SealedResponse is a CLOSED type with three
// invariants. This file is the INTERFACE + the structural checks; the deep session-registry + the deep
// rule-card evaluator land in #280 (the SQC v8 reference).

/** Closed response type: only structured shapes; NO free-text leaf (covert-channel closed). */
export type SealedResponse =
  | { kind: 'signals'; signals: string[] } //          closed enum signals
  | { kind: 'token-refs'; refs: string[] } //          references to THIS-session-issued tokens only
  | { kind: 'rule-card'; tree: RuleNode } //           static decision-tree (declarative, NOT a program)
  | { kind: 'error'; code: string }; //                closed error-code enum

/** A static JSON decision-tree node. Allowed ops are a closed whitelist — NEVER CALL_TOOL/EXEC/HTTP/LOOP/EVAL. */
export type RuleNode =
  | { op: 'field-eq'; field: string; value: string; then: RuleNode; else?: RuleNode }
  | { op: 'field-in-set'; field: string; set: string[]; then: RuleNode; else?: RuleNode }
  | { op: 'threshold-compare'; field: string; cmp: '<' | '<=' | '>' | '>='; value: number; then: RuleNode; else?: RuleNode }
  | { op: 'dict-lookup'; field: string; dict: string; then: RuleNode; else?: RuleNode }
  | { op: 'emit-label'; label: string };

export const ALLOWED_OPS = ['field-eq', 'field-in-set', 'threshold-compare', 'dict-lookup', 'emit-label'] as const;
export type AllowedOp = (typeof ALLOWED_OPS)[number];

/** (a) provenance: only THIS-request-issued tokens are decodable. The deep REQUEST_TOKEN_REGISTRY is #280. */
export interface RequestTokenRegistry {
  /** True iff the token was issued in the current request/session (foreign/replay/hallucinated -> false). */
  wasIssued(token: string): boolean;
}

/** (b)+(c): a SealedResponse is decodable iff it is a closed shape AND every rule-card op is whitelisted
 *  AND every token-ref was issued this request. Throws on free-text / unknown-op / foreign token. */
export function assertDecodable(resp: SealedResponse, reg: RequestTokenRegistry): void {
  switch (resp.kind) {
    case 'signals':
    case 'error':
      return; // closed enums, no free text
    case 'token-refs':
      for (const t of resp.refs) {
        if (!reg.wasIssued(t)) throw new Error(`assertDecodable: foreign/replayed token ref ${t}`);
      }
      return;
    case 'rule-card':
      assertRuleOps(resp.tree);
      return;
  }
}

function assertRuleOps(node: RuleNode): void {
  if (!(ALLOWED_OPS as readonly string[]).includes(node.op)) {
    throw new Error(`assertDecodable: rule-card op not in allowed-ops-whitelist: ${(node as { op: string }).op}`);
  }
  for (const child of [
    (node as { then?: RuleNode }).then,
    (node as { else?: RuleNode }).else,
  ]) {
    if (child !== undefined) assertRuleOps(child);
  }
}
