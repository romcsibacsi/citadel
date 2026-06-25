// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * THE sanitizer (SPEC §6). Exactly one implementation, used identically by the
 * public write guard (to REJECT reserved ids) and by the router/classifier (to
 * MATCH them). Any second implementation is a forgery bypass — do not fork.
 */

/** Reserved sender identities — code constants, never config (SPEC §6, §20.2). */
export const OPERATOR_ID = 'operator';
export const CHANNEL_ID = 'channel';
export const RESERVED_IDS: readonly string[] = [OPERATOR_ID, CHANNEL_ID];

const MAX_ID_LENGTH = 64;

/**
 * Canonicalize an agent/sender id:
 *  - Unicode NFKC normalization (defeats confusable forms like fullwidth letters)
 *  - lowercase
 *  - strip every character outside [a-z0-9-]
 *  - collapse runs of '-' and trim leading/trailing '-'
 *  - cap length
 *
 * Stripping (rather than replacing) is deliberate: "op.er.ator" canonicalizes
 * to "operator" and is therefore caught by the reserved-id check.
 */
export function sanitizeId(raw: string): string {
  return raw
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_ID_LENGTH);
}

/** True when a raw sender id canonicalizes to a reserved identity. */
export function isReservedId(raw: string): boolean {
  const s = sanitizeId(raw);
  return RESERVED_IDS.includes(s);
}
