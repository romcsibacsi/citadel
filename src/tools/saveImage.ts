// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { openSync, writeSync, closeSync, mkdirSync, realpathSync, constants as FS } from 'node:fs';
import { join, basename, sep } from 'node:path';

/**
 * Contained buffer-write into the Files IMAGES root for tool artifacts (browse
 * screenshots, rendered charts/diagrams). FilesService streams UPLOADS but offers
 * no direct buffer write, and we never hand a tool a raw path, so this is the
 * single audited helper: the filename must be a plain basename (no separators, no
 * traversal, no control chars), the write uses O_EXCL|O_NOFOLLOW (no clobber, no
 * symlink follow), and the resolved target is realpath-contained under the images
 * root — so a tool can never escape it. Returns { root, name }.
 */

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export interface SavedArtifact {
  root: 'images';
  name: string;
}

export function saveImageArtifact(imagesDir: string, name: string, bytes: Buffer): SavedArtifact {
  const safe = basename(name);
  if (safe === '' || safe === '.' || safe === '..' || name.includes('/') || name.includes('\\') || CONTROL_CHARS.test(name) || name !== safe) {
    throw new Error('invalid artifact filename');
  }
  mkdirSync(imagesDir, { recursive: true });
  let realRoot: string;
  try {
    realRoot = realpathSync(imagesDir);
  } catch {
    throw new Error('images root unavailable');
  }
  const target = join(realRoot, safe);
  if (!target.startsWith(realRoot + sep)) {
    throw new Error('path escapes images root');
  }
  let fd: number;
  try {
    fd = openSync(target, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW, 0o600);
  } catch (err) {
    if ((err as { code?: string }).code === 'EEXIST') throw new Error('an artifact with that name already exists');
    throw new Error('cannot create artifact file');
  }
  try {
    writeSync(fd, bytes);
  } finally {
    closeSync(fd);
  }
  return { root: 'images', name: safe };
}
