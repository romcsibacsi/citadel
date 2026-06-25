// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import type { DatabaseSync } from 'node:sqlite';
import { systemClock, isoNow, type Clock } from '../core/clock.js';
import { createLogger } from '../core/log.js';
import { decryptSecret, encryptSecret } from './crypto.js';
import type { MasterKeyBackend } from './masterKey.js';

const log = createLogger('vault');

/** Config indirection prefix: a value of `vault:<id>` resolves at launch (SPEC §16). */
export const VAULT_REF_PREFIX = 'vault:';

/** True when a config/env value is a vault indirection rather than a literal. */
export function isVaultRef(value: string): boolean {
  return value.startsWith(VAULT_REF_PREFIX);
}

/** Build a `vault:<id>` indirection token for a secret id. */
export function vaultRef(id: string): string {
  return `${VAULT_REF_PREFIX}${id}`;
}

/**
 * A binding target encodes WHICH config file + named server a secret's env var
 * is wired into. The schema's single `target` TEXT column stores both as
 * `<filePath>|<serverName>` (decoded at the LAST '|', so a path containing '|'
 * is fine; the server name must not). The empty string is the legacy "no
 * specific file yet" target (a recorded intent that sync applies once a matching
 * server appears) — kept so a bind with no resolved file still records cleanly.
 */
export function encodeTarget(filePath: string, serverName: string): string {
  if (serverName.includes('|')) throw new Error('server name must not contain "|"');
  return `${filePath}|${serverName}`;
}

/** Decode an encoded file+server target; null for the legacy/global empty target. */
export function decodeTarget(target: string): { filePath: string; serverName: string } | null {
  if (target === '') return null;
  const i = target.lastIndexOf('|');
  if (i === -1) return null; // legacy bare-serverName target (no file)
  return { filePath: target.slice(0, i), serverName: target.slice(i + 1) };
}

/** Metadata only — the list surface NEVER carries values (SPEC §16). */
export interface SecretMetadata {
  id: string;
  label: string;
  createdAt: string;
  updatedAt: string;
}

/** A secret-id → env-var mapping, optionally scoped to a target config file. */
export interface VaultBinding {
  secretId: string;
  envVar: string;
  target: string;
}

interface SecretRow {
  ciphertext: Uint8Array;
  iv: Uint8Array;
  salt: Uint8Array;
  auth_tag: Uint8Array;
}

/**
 * The secrets vault over vault_secrets / vault_bindings (SPEC §16).
 *
 * API discipline:
 *  - listMetadata() returns id/label/timestamps ONLY — never values.
 *  - getSecretValue(id) is the single value-returning read.
 *  - No value or master key material is ever logged.
 */
export class VaultStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly backend: MasterKeyBackend,
    private readonly clock: Clock = systemClock,
  ) {}

  /**
   * Insert or update a secret. Every write — including an update of an
   * existing id — re-encrypts with a FRESH salt and IV.
   */
  setSecret(id: string, label: string, plaintext: string): void {
    const parts = encryptSecret(this.backend.load(), plaintext);
    const now = isoNow(this.clock);
    this.db
      .prepare(
        `INSERT INTO vault_secrets (id, label, ciphertext, iv, salt, auth_tag, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           label = excluded.label,
           ciphertext = excluded.ciphertext,
           iv = excluded.iv,
           salt = excluded.salt,
           auth_tag = excluded.auth_tag,
           updated_at = excluded.updated_at`,
      )
      .run(id, label, parts.ciphertext, parts.iv, parts.salt, parts.authTag, now, now);
    log.info('vault secret stored', { id });
  }

  /** The ONLY value-returning read. Explicit single-id access by design. */
  getSecretValue(id: string): string | undefined {
    const row = this.db
      .prepare('SELECT ciphertext, iv, salt, auth_tag FROM vault_secrets WHERE id = ?')
      .get(id) as SecretRow | undefined;
    if (!row) return undefined;
    return decryptSecret(this.backend.load(), {
      ciphertext: Buffer.from(row.ciphertext),
      iv: Buffer.from(row.iv),
      salt: Buffer.from(row.salt),
      authTag: Buffer.from(row.auth_tag),
    });
  }

  /** Metadata only — NEVER values (SPEC §16 MUST). */
  listMetadata(): SecretMetadata[] {
    const rows = this.db
      .prepare('SELECT id, label, created_at, updated_at FROM vault_secrets ORDER BY id')
      .all() as Array<{ id: string; label: string; created_at: string; updated_at: string }>;
    return rows.map((r) => ({ id: r.id, label: r.label, createdAt: r.created_at, updatedAt: r.updated_at }));
  }

  /**
   * Explicit operator action. Bindings cascade via the FK. Returns true when
   * a secret was actually removed.
   */
  deleteSecret(id: string): boolean {
    const result = this.db.prepare('DELETE FROM vault_secrets WHERE id = ?').run(id);
    const deleted = result.changes > 0;
    if (deleted) log.info('vault secret deleted', { id });
    return deleted;
  }

  /** Map a secret to an env var (optionally for one target config file). Idempotent. */
  bind(secretId: string, envVar: string, target = ''): void {
    this.db
      .prepare('INSERT OR IGNORE INTO vault_bindings (secret_id, env_var, target) VALUES (?, ?, ?)')
      .run(secretId, envVar, target);
  }

  /** Remove one binding. Returns true when a row was removed. */
  unbind(secretId: string, envVar: string, target = ''): boolean {
    const result = this.db
      .prepare('DELETE FROM vault_bindings WHERE secret_id = ? AND env_var = ? AND target = ?')
      .run(secretId, envVar, target);
    return result.changes > 0;
  }

  /** All bindings, or just those of one secret. */
  listBindings(secretId?: string): VaultBinding[] {
    const rows = (
      secretId === undefined
        ? this.db.prepare('SELECT secret_id, env_var, target FROM vault_bindings ORDER BY secret_id, env_var, target').all()
        : this.db
            .prepare('SELECT secret_id, env_var, target FROM vault_bindings WHERE secret_id = ? ORDER BY env_var, target')
            .all(secretId)
    ) as Array<{ secret_id: string; env_var: string; target: string }>;
    return rows.map((r) => ({ secretId: r.secret_id, envVar: r.env_var, target: r.target }));
  }

  /**
   * Resolve a config value: `vault:<id>` becomes the plaintext (undefined when
   * the id is unknown); anything else passes through unchanged so literal env
   * values keep working.
   */
  resolveRef(ref: string): string | undefined {
    if (!isVaultRef(ref)) return ref;
    return this.getSecretValue(ref.slice(VAULT_REF_PREFIX.length));
  }
}
