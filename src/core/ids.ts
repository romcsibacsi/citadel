// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { randomUUID, randomBytes } from 'node:crypto';

export function newId(): string {
  return randomUUID();
}

/** URL-safe random token (used for the dashboard bearer and per-agent API tokens). */
export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Per-process random sentinel used by the trust framing layer when neutralizing
 * forged security tags (SPEC §6). Unpredictable across restarts by design.
 */
export const PROCESS_SENTINEL: string = randomBytes(12).toString('hex');
