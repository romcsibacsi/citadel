// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { createLogger } from '../core/log.js';
import { isVaultRef, VAULT_REF_PREFIX, type VaultStore } from './store.js';

const log = createLogger('vault');

/**
 * Launch-time env resolution (SPEC §16): any env value of the form
 * `vault:<id>` is swapped for the plaintext JUST IN TIME for a child-process
 * launch. The result is handed to the spawn call and never persisted.
 *
 * A vault ref pointing at a missing secret fails the launch loudly — the
 * error names the secret id and env var, NEVER any value.
 */
export function resolveLaunchEnv(
  env: Record<string, string | undefined>,
  vault: VaultStore,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (!isVaultRef(value)) {
      resolved[name] = value;
      continue;
    }
    const secretId = value.slice(VAULT_REF_PREFIX.length);
    const plaintext = vault.getSecretValue(secretId);
    if (plaintext === undefined) {
      throw new Error(`vault secret '${secretId}' referenced by env var ${name} was not found`);
    }
    log.debug('resolved vault ref for launch env', { envVar: name, secretId });
    resolved[name] = plaintext;
  }
  return resolved;
}
