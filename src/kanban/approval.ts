// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * Approval-gate helpers (PROMPT-05 §6.7 / FIX-05 §2). A one-shot operator
 * notification must fire only on the false→true transition into needs-approval
 * — when a card is created already needing approval, or an update flips the flag
 * up — never on a save that leaves the flag unchanged (or lowers it). Pure so the
 * one-shot rule is unit-testable independent of the notification transport.
 */

/** True when a write moves a card INTO the needs-approval state for the first time. */
export function newlyNeedsApproval(before: boolean | undefined, after: boolean): boolean {
  return after === true && before !== true;
}
