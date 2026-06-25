// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { mkdirSync, openSync, closeSync, writeSync, renameSync, readFileSync, existsSync, writeFileSync, fsyncSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

/** Create a directory (and parents) with restrictive permissions. */
export function ensureDir(path: string, mode = 0o700): void {
  mkdirSync(path, { recursive: true, mode });
}

/**
 * Atomic file write: temp sibling on the SAME filesystem, then rename (SPEC §18).
 */
export function atomicWriteFile(path: string, data: string | Buffer, mode = 0o600): void {
  ensureDir(dirname(path));
  const tmp = join(dirname(path), `.${randomBytes(6).toString('hex')}.tmp`);
  const fd = openSync(tmp, 'wx', mode);
  try {
    writeSync(fd, typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

/**
 * Create a file exclusively (O_EXCL) with the given mode. Throws if it already
 * exists. Used to close fresh-install TOCTOU windows (SPEC §18) and for locks.
 */
export function createExclusive(path: string, data: string | Buffer, mode = 0o600): void {
  ensureDir(dirname(path));
  const fd = openSync(path, 'wx', mode);
  try {
    writeSync(fd, typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function readTextIfExists(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  return readFileSync(path, 'utf8');
}

/** Write only when the target does not exist yet (scaffolding-never-overwrites, SPEC §4). */
export function writeIfAbsent(path: string, data: string, mode = 0o644): boolean {
  if (existsSync(path)) return false;
  ensureDir(dirname(path));
  writeFileSync(path, data, { mode, flag: 'wx' });
  return true;
}
