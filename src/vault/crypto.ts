// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

/**
 * Vault encryption primitives (SPEC §16).
 *
 * Authenticated AES-256-GCM with a per-secret key derived via scrypt from the
 * master key and a FRESH random salt; a FRESH random 12-byte IV per call.
 * Tampering with any part (ciphertext, auth tag, IV, salt) fails the GCM
 * authentication check and throws.
 */

/** GCM-standard IV size. */
export const IV_LENGTH = 12;
/** Per-secret scrypt salt size. */
export const SALT_LENGTH = 16;
/** AES-256 key size. */
export const KEY_LENGTH = 32;
/** Full-strength GCM auth tag. */
export const AUTH_TAG_LENGTH = 16;

/** Explicit scrypt cost parameters — pinned so stored secrets stay decryptable. */
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

export interface EncryptedSecret {
  ciphertext: Buffer;
  iv: Buffer;
  salt: Buffer;
  authTag: Buffer;
}

function deriveKey(masterKey: Buffer, salt: Buffer): Buffer {
  if (masterKey.length === 0) throw new Error('master key must not be empty');
  return scryptSync(masterKey, salt, KEY_LENGTH, SCRYPT_PARAMS);
}

/**
 * Encrypt one secret value. A fresh random salt and IV are generated on EVERY
 * call — two encryptions of the same plaintext never share salt, IV or
 * ciphertext.
 */
export function encryptSecret(masterKey: Buffer, plaintext: string): EncryptedSecret {
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const key = deriveKey(masterKey, salt);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { ciphertext, iv, salt, authTag };
}

/**
 * Decrypt one secret value. Throws when the master key is wrong or ANY part
 * has been tampered with (GCM authentication).
 */
export function decryptSecret(masterKey: Buffer, parts: EncryptedSecret): string {
  const key = deriveKey(masterKey, parts.salt);
  const decipher = createDecipheriv('aes-256-gcm', key, parts.iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(parts.authTag);
  const plaintext = Buffer.concat([decipher.update(parts.ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}
