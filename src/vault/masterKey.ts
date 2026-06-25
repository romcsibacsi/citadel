// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createExclusive } from '../core/fsx.js';
import { createLogger } from '../core/log.js';
import { KEY_LENGTH } from './crypto.js';

const log = createLogger('vault');

/**
 * Where the vault master key comes from (SPEC §16). The master key lives
 * OUTSIDE the encrypted store. The file backend below is the portable
 * baseline; an OS-keychain backend can plug in behind the same interface
 * without touching the store.
 */
export interface MasterKeyBackend {
  /** Return the raw 32-byte master key. MUST never be logged. */
  load(): Buffer;
}

/**
 * 0600 key file backend. On first use it creates the file with 32 fresh
 * random bytes using O_EXCL (no TOCTOU window); afterwards every load returns
 * the same key. Only the file PATH is ever logged — never key material.
 */
export class FileMasterKeyBackend implements MasterKeyBackend {
  private cached: Buffer | undefined;

  constructor(private readonly path: string) {}

  load(): Buffer {
    if (this.cached) return this.cached;
    let key: Buffer;
    try {
      const fresh = randomBytes(KEY_LENGTH);
      createExclusive(this.path, fresh, 0o600);
      log.info('vault master key created', { path: this.path });
      key = fresh;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      key = readFileSync(this.path);
    }
    if (key.length !== KEY_LENGTH) {
      // Length only — never the content.
      throw new Error(`master key file ${this.path} has invalid length ${key.length}, expected ${KEY_LENGTH}`);
    }
    this.cached = key;
    return key;
  }
}
