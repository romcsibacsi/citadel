// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import type { PrivilegeLevel } from '../config/types.js';

/**
 * The privilege gate (SPEC §15, §20.3). Pure — the caller resolves trust
 * classification and privilege levels BEFORE calling, so a forged `from`
 * can never reach this function claiming to be the hub.
 */

/** Hard ceiling: nothing above trusted-build (2) is EVER spawnable — not even by the operator. */
export const SPAWN_CEILING: PrivilegeLevel = 2;
/** Programmatic spawns at or below this level proceed without human approval. */
export const AUTO_SPAWN_MAX: PrivilegeLevel = 0;

export type SpawnVerdict = 'allow' | 'park' | 'deny';

export interface SpawnEvaluationInput {
  /**
   * Provenance: 'dashboard' = the operator acting through the authenticated
   * dashboard (absence of a requester id implies this); 'programmatic' = any
   * agent-initiated request.
   */
  origin: 'dashboard' | 'programmatic';
  /** Sanitized requester id for programmatic requests. */
  requesterId?: string;
  /** Resolved AFTER trust classification — never from the self-asserted sender. */
  requesterIsHub: boolean;
  /** The requesting agent's own privilege level (programmatic only). */
  requesterLevel?: PrivilegeLevel;
  /** Privilege level of the profile the new agent would get. */
  requestedLevel: PrivilegeLevel;
}

export interface SpawnEvaluation {
  verdict: SpawnVerdict;
  reason:
    | 'above-hard-ceiling'
    | 'operator-approved'
    | 'missing-requester'
    | 'only-hub-spawns'
    | 'self-escalation'
    | 'auto-allowed'
    | 'needs-human-approval';
}

export function evaluateSpawn(input: SpawnEvaluationInput): SpawnEvaluation {
  // 1. The hard ceiling is absolute (even for the operator/dashboard).
  if (input.requestedLevel > SPAWN_CEILING) {
    return { verdict: 'deny', reason: 'above-hard-ceiling' };
  }

  // 2. Dashboard/operator path counts as the human approval, up to the ceiling.
  if (input.origin === 'dashboard') {
    return { verdict: 'allow', reason: 'operator-approved' };
  }

  // 3. A programmatic request without an identified requester is invalid.
  if (input.requesterId === undefined || input.requesterId === '') {
    return { verdict: 'deny', reason: 'missing-requester' };
  }

  // 4. Only the hub may initiate a programmatic spawn.
  if (!input.requesterIsHub) {
    return { verdict: 'deny', reason: 'only-hub-spawns' };
  }

  // 5. No self-escalation: a child may never exceed the requester's privilege.
  const requesterLevel = input.requesterLevel ?? 0;
  if (input.requestedLevel > requesterLevel) {
    return { verdict: 'deny', reason: 'self-escalation' };
  }

  // 6. Sandbox-level spawns proceed; anything above parks for human approval.
  if (input.requestedLevel <= AUTO_SPAWN_MAX) {
    return { verdict: 'allow', reason: 'auto-allowed' };
  }
  return { verdict: 'park', reason: 'needs-human-approval' };
}
