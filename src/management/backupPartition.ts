// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { createEncryptedBackup, type BackupEntry, type BackupBlob } from './backup.js';

/**
 * Partitioning backup emitter (#110-prep, management-plane code side). The #106 backup
 * sealed a machine's whole state into ONE blob under ONE key — crypto-erasing that key
 * erases EVERYTHING. GDPR erasure of a single customer's PII while the accounting-law
 * (Szt.169) financial records are RETAINED needs a finer cut: partition each tenant's
 * stores by CLASS and seal one BackupBlob per class under its OWN key. RELAY then
 * crypto-erases only MGMT_BACKUP_<tenant>_PII — every PII/CS blob becomes unrecoverable
 * while the _FIN blob (sealed under the untouched _FIN key) still opens.
 *
 * This module is pure crypto + classification; the store enumeration/export (live db ->
 * NamedStore[]) is an upstream driver, and the per-class key comes from an injected
 * just-in-time fetch (the RELAY mesh key-API in prod, the vault in tests). The fetched
 * key is used immediately and wiped — it never persists on the machine.
 */

/** _FIN = Szt.169 financial records (retained, never GDPR-erased); _PII = everything else (erasable). */
export type BackupClass = 'FIN' | 'PII';

/**
 * Classify a logical store by name. Financial/bookkeeping stores (bk_* and the explicit
 * financial-store) are _FIN. EVERYTHING ELSE is _PII — a deliberate default-deny:
 * customer stores (cs_*), general data, AND the machine secrets (master.key / vault /
 * config) whose confidentiality is bound to the customer. A crypto-erasure must reach
 * ALL of a customer's recoverable PII, so anything not provably financial is PII.
 */
export function classifyStore(name: string): BackupClass {
  const n = name.trim().toLowerCase();
  return n.startsWith('bk_') || n === 'financial-store' ? 'FIN' : 'PII';
}

/** A logical store to back up: a name (drives classification) + its file entries. */
export interface NamedStore {
  name: string;
  entries: BackupEntry[];
}

/**
 * Seal a tenant's stores into ONE encrypted BackupBlob PER CLASS. Each store is
 * classified, entries grouped by class, and each class sealed under its own 32-byte key
 * fetched just-in-time and wiped after use. A class with no entries is omitted. The
 * caller persists each blob as MGMT_BACKUP_<tenant>_<CLASS>, so erasure(_PII) is
 * key-scoped to exactly the erasable partition.
 */
export function sealPartitionedBackup(
  stores: NamedStore[],
  fetchKey: (cls: BackupClass) => Buffer,
): Partial<Record<BackupClass, BackupBlob>> {
  const grouped = new Map<BackupClass, BackupEntry[]>();
  for (const store of stores) {
    const cls = classifyStore(store.name);
    const bucket = grouped.get(cls) ?? [];
    bucket.push(...store.entries);
    grouped.set(cls, bucket);
  }

  const out: Partial<Record<BackupClass, BackupBlob>> = {};
  for (const [cls, entries] of grouped) {
    if (entries.length === 0) continue;
    const key = fetchKey(cls); // JIT: used immediately below, never stored
    try {
      out[cls] = createEncryptedBackup(entries, key);
    } finally {
      key.fill(0); // best-effort wipe — the per-class key must not linger on the machine
    }
  }
  return out;
}

/** Minimal read view over the db; node:sqlite's DatabaseSync satisfies it structurally (testable). */
export interface ReadableDb {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
}

/** Only real, safe table identifiers are exported (defensive — names come from the schema, never a user). */
const SAFE_TABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Serialize rows to JSON, preserving BLOB columns (Uint8Array) as tagged base64 (reversible). */
function serializeRows(rows: unknown[]): Buffer {
  return Buffer.from(
    JSON.stringify(rows, (_k, v) => (v instanceof Uint8Array ? { __blob_b64__: Buffer.from(v).toString('base64') } : v)),
  );
}

/**
 * Export every user table as a NamedStore (name = table, one BackupEntry holding its
 * rows). The single shared db is thereby partitioned at TABLE granularity — bk_* tables
 * classify FIN, everything else PII — without a file split. BLOB columns survive as
 * tagged base64; sqlite-internal tables and any non-identifier name are skipped.
 */
export function exportDbStores(db: ReadableDb): NamedStore[] {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string }[];
  const stores: NamedStore[] = [];
  for (const { name } of tables) {
    if (!SAFE_TABLE.test(name)) continue; // never interpolate a non-identifier into SQL
    const rows = db.prepare(`SELECT * FROM "${name}"`).all();
    stores.push({ name, entries: [{ path: `db/${name}.json`, mode: 0o600, data: serializeRows(rows) }] });
  }
  return stores;
}

/**
 * Finish the partitioned backup end to end: export the db's tables + any extra
 * file-stores (master.key / config — classified PII), then seal one BackupBlob per
 * class. The _FIN key MUST be fetched from OFF the machine (aggregator vault / operator
 * KMS), never the local vault, and is wiped after use — so a crypto-erasure of _PII +
 * the machine master.key never reaches _FIN, and Szt.169 records survive.
 */
export function runPartitionedBackup(
  db: ReadableDb,
  fileStores: NamedStore[],
  fetchKey: (cls: BackupClass) => Buffer,
): Partial<Record<BackupClass, BackupBlob>> {
  return sealPartitionedBackup([...exportDbStores(db), ...fileStores], fetchKey);
}
