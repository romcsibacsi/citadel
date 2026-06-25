// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { randomBytes } from 'node:crypto';
import { encryptSecret, decryptSecret, type EncryptedSecret } from '../vault/crypto.js';

/**
 * Per-machine encrypted backup + crypto-erasure (#106, management-plane code side).
 * A product instance snapshots its OWN state-dir (db, master.key, vault, config),
 * encrypts it under a PER-MACHINE backup key that lives SEPARATELY from the machine
 * (operator HSM/KMS per customer, or customer escrow) — never a shared key, never a
 * shared store. Two properties (PROBE UPDATE 3):
 *  - confidentiality: the backup contains the master.key + vault, so it MUST be
 *    encrypted at rest; we reuse the vetted AES-256-GCM vault primitive.
 *  - CRYPTO-ERASURE: destroying the per-customer backup key makes every backup of
 *    that customer permanently unrecoverable == GDPR erasure reaching the hardest
 *    layer (backups), without touching each archive.
 * The crypto here is pure + reuses src/vault/crypto.ts; the fs snapshot/restore is a
 * thin driver on top.
 */

export interface BackupEntry {
  /** Path relative to the state-dir root. */
  path: string;
  /** Octal file mode (preserved so master.key restores as 0600). */
  mode: number;
  /** File bytes. */
  data: Buffer;
}

interface PackedEntry { path: string; mode: number; b64: string }
interface PackedArchive { v: 1; entries: PackedEntry[] }

/** Generate a fresh 32-byte per-machine backup key. Caller stores it OFF the machine. */
export function generateBackupKey(): Buffer {
  return randomBytes(32);
}

/** Pack a set of files into one deterministic archive string (zero-dep, no tar). */
export function packArchive(entries: BackupEntry[]): string {
  const packed: PackedArchive = {
    v: 1,
    entries: entries.map((e) => ({ path: e.path, mode: e.mode, b64: e.data.toString('base64') })),
  };
  return JSON.stringify(packed);
}

/** Reverse of packArchive. Throws on a malformed/foreign archive. */
export function unpackArchive(archive: string): BackupEntry[] {
  const parsed = JSON.parse(archive) as PackedArchive;
  if (parsed.v !== 1 || !Array.isArray(parsed.entries)) throw new Error('unpackArchive: unrecognized archive');
  return parsed.entries.map((e) => ({ path: e.path, mode: e.mode, data: Buffer.from(e.b64, 'base64') }));
}

/** A portable, self-describing encrypted backup blob (base64 parts, JSON wrapper). */
export interface BackupBlob {
  v: 1;
  ciphertext: string;
  iv: string;
  salt: string;
  authTag: string;
}

/** Encrypt a packed archive under the per-machine backup key (AES-256-GCM, vault primitive). */
export function encryptArchive(archive: string, backupKey: Buffer): BackupBlob {
  const enc = encryptSecret(backupKey, archive);
  return {
    v: 1,
    ciphertext: enc.ciphertext.toString('base64'),
    iv: enc.iv.toString('base64'),
    salt: enc.salt.toString('base64'),
    authTag: enc.authTag.toString('base64'),
  };
}

/**
 * Decrypt a backup blob. Throws when the key is wrong/destroyed (crypto-erasure) or
 * any byte was tampered with (GCM authentication). This throw IS the erasure
 * guarantee: with the key gone, no archive is recoverable.
 */
export function decryptArchive(blob: BackupBlob, backupKey: Buffer): string {
  if (blob.v !== 1) throw new Error('decryptArchive: unrecognized blob version');
  const parts: EncryptedSecret = {
    ciphertext: Buffer.from(blob.ciphertext, 'base64'),
    iv: Buffer.from(blob.iv, 'base64'),
    salt: Buffer.from(blob.salt, 'base64'),
    authTag: Buffer.from(blob.authTag, 'base64'),
  };
  return decryptSecret(backupKey, parts);
}

/** Convenience: snapshot entries -> encrypted blob in one step. */
export function createEncryptedBackup(entries: BackupEntry[], backupKey: Buffer): BackupBlob {
  return encryptArchive(packArchive(entries), backupKey);
}

/** Convenience: encrypted blob + key -> restored entries. Throws if the key is erased/wrong. */
export function restoreEncryptedBackup(blob: BackupBlob, backupKey: Buffer): BackupEntry[] {
  return unpackArchive(decryptArchive(blob, backupKey));
}
