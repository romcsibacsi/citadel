// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * Credential / header-field hardening (#118 phase-3, PROBE phase-1 flag). The IMAP
 * client quotes credentials but does NOT escape CR/LF, and host/address fields go
 * into IMAP/SMTP commands and mail headers verbatim — a CR/LF there could inject a
 * protocol command or a forged header. A legitimate credential/host/address never
 * contains a control char, so we FAIL CLOSED at the config/vault boundary rather than
 * silently stripping (a stripped password would just fail to authenticate confusingly).
 */
export class CredentialError extends Error {}

/** Reject a value containing CR, LF, or NUL (control-char / injection guard). */
export function assertSafeField(value: string, field: string): string {
  if (/[\r\n\0]/.test(value)) {
    throw new CredentialError(`${field} contains a forbidden control character (CR/LF/NUL)`);
  }
  return value;
}

/** Strip CR/LF from a header-bound, UNTRUSTED value (e.g. a subject) — header-injection guard. */
export function stripHeaderInjection(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}
