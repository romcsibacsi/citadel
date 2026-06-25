// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * Secret-leak heuristics for the vault scan (PROMPT-16 §6 / FIX-16). Pure,
 * value-free in its outputs except the explicit mask — so the scan can flag a
 * plaintext config value as "looks like a real secret" by KEY NAME + VALUE
 * shape, and never echo the full value back to the client.
 *
 * A finding requires BOTH: a sensitive-looking key name AND a secret-looking
 * value. Either alone is not enough (a boolean named API_ENABLED is not a leak;
 * a long random value under a key named `description` is not flagged).
 */

import { isVaultRef } from './store.js';

/**
 * Key-name patterns the spec calls sensitive: ends-with _KEY/_TOKEN/_SECRET/
 * _PASSWORD/_PASS, starts-with API_/AUTH_/OAUTH_, or contains PASSWORD/
 * CREDENTIAL/ACCESS_KEY. Case-insensitive (env var names are conventionally
 * upper-case but we do not rely on it).
 */
export function isSensitiveKeyName(name: string): boolean {
  const n = name.toUpperCase();
  if (/(_KEY|_TOKEN|_SECRET|_PASSWORD|_PASS)$/.test(n)) return true;
  if (/^(API_|AUTH_|OAUTH_)/.test(n)) return true;
  if (/(PASSWORD|CREDENTIAL|ACCESS_KEY)/.test(n)) return true;
  return false;
}

/** Minimum length before a value is even considered secret-like. */
const MIN_SECRET_LEN = 12;

/**
 * A value "looks like a real secret" when it is long enough and is NOT an
 * obvious non-secret: a boolean/flag, a URL, a pure number, a filesystem path,
 * an env-var expansion, or an existing vault reference. Deliberately
 * conservative on the non-secret side (false negatives beat flagging benign
 * config), but length+shape catches real API keys/tokens/passwords.
 */
export function looksLikeSecretValue(value: string): boolean {
  const v = value.trim();
  if (v.length < MIN_SECRET_LEN) return false;
  if (isVaultRef(v)) return false; // already an indirection
  if (/^\$\{[^}]+\}$/.test(v) || /^\$[A-Za-z_]\w*$/.test(v)) return false; // ${VAR} / $VAR expansion
  if (/^(true|false|yes|no|on|off|enabled|disabled|null|none)$/i.test(v)) return false; // flag word
  if (/^-?\d+(\.\d+)?$/.test(v)) return false; // pure number
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return false; // scheme://… URL
  if (/^(\/|\.\/|\.\.\/|~\/)/.test(v)) return false; // filesystem path
  if (/\s/.test(v)) return false; // real secrets are single tokens, prose is not
  return true;
}

/**
 * Mask a value to first-few + last-few characters (the full value never leaves
 * the server during a scan, SPEC §6/§8). Short values are fully starred.
 */
export function maskSecret(value: string): string {
  const v = value;
  if (v.length <= 8) return '*'.repeat(Math.max(v.length, 4));
  return `${v.slice(0, 3)}…${v.slice(-3)}`;
}

/**
 * Suggest a vault id for a finding: `{server}-{envVar}` normalized to a tidy
 * lower-kebab id (SPEC §5D). Falls back to the envVar alone when server is empty.
 */
export function suggestVaultId(server: string, envVar: string): string {
  const raw = server.trim() !== '' ? `${server}-${envVar}` : envVar;
  const id = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return id === '' ? 'secret' : id;
}
