// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * Skill directory import (SPEC §10). Copies an external skill directory into
 * a scope root with hostile-input hardening:
 *
 *  - path traversal rejected: every relative path is checked lexically (no
 *    '..'/empty segments, never absolute) AND via realpath containment in the
 *    source tree; destination paths are containment-checked against the
 *    target dir before any copy;
 *  - symlinks rejected anywhere in the source tree (lstat on every entry,
 *    files AND directories, plus the source root itself);
 *  - only regular files are copied (anything else — fifo, socket, device —
 *    rejects the import); relative structure is preserved;
 *  - the source SKILL.md must parse (name + description) or the import is
 *    rejected; the sanitized frontmatter name becomes the target directory
 *    name, so directory identity and declared identity always agree;
 *  - an existing target name is refused (never overwrite).
 *
 * Validation runs to completion BEFORE anything is written, so a rejected
 * import leaves no partial target directory behind. Governance mirrors
 * SkillStore.createSkill via the shared resolveSkillTarget: a global import
 * requires approvedByHub=true; a hub 'local' import redirects to global.
 */
import { constants as fsConstants, copyFileSync, existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { ensureDir } from '../core/fsx.js';
import { createLogger } from '../core/log.js';
import { sanitizeId } from '../trust/sanitize.js';
import {
  SKILL_FILE,
  parseSkillFile,
  resolveSkillTarget,
  isDocumentedBody,
  type SkillGovernanceOpts,
  type SkillMeta,
  type SkillRoots,
  type SkillScope,
} from './store.js';

const log = createLogger('skills.importer');

/**
 * Lexical safety check for a relative path: rejects absolute paths (POSIX and
 * drive-letter forms) and any '..', '.', or empty segment. Exported so the
 * '..'-segment rule is unit-testable directly (a file literally named '..'
 * cannot be created on a real filesystem).
 */
export function isUnsafeRelativePath(rel: string): boolean {
  if (rel.length === 0) return true;
  if (isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) return true;
  return rel.split(/[\\/]/).some((segment) => segment === '..' || segment === '.' || segment === '');
}

interface WalkedFile {
  rel: string;
  abs: string;
}

/**
 * Walk the source tree, validating every entry (lexical path safety, no
 * symlinks via lstat, realpath containment, regular files/dirs only).
 * Returns the regular files to copy. Throws on the first violation.
 */
function walkAndValidate(sourceDir: string): WalkedFile[] {
  const realRoot = realpathSync(sourceDir);
  const files: WalkedFile[] = [];
  const visit = (dir: string, rel: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const abs = join(dir, entry);
      const relPath = rel === '' ? entry : `${rel}/${entry}`;
      if (isUnsafeRelativePath(relPath)) {
        throw new Error(`skill import rejected: unsafe path in source: ${relPath}`);
      }
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) {
        throw new Error(`skill import rejected: symlink in source: ${relPath}`);
      }
      // Realpath containment: even a non-symlink entry must physically live
      // inside the (resolved) source root.
      const real = realpathSync(abs);
      if (real !== realRoot && !real.startsWith(realRoot + sep)) {
        throw new Error(`skill import rejected: path escapes source via realpath: ${relPath}`);
      }
      if (st.isDirectory()) {
        visit(abs, relPath);
      } else if (st.isFile()) {
        files.push({ rel: relPath, abs });
      } else {
        throw new Error(`skill import rejected: unsupported entry type: ${relPath}`);
      }
    }
  };
  visit(sourceDir, '');
  return files;
}

/**
 * Import a skill directory into the given scope. Returns the imported skill's
 * meta. See module doc for the rejection rules.
 */
export function importSkillDir(
  roots: SkillRoots,
  scope: SkillScope,
  agentId: string | null,
  sourceDir: string,
  opts: SkillGovernanceOpts = {},
): SkillMeta {
  let rootStat;
  try {
    rootStat = lstatSync(sourceDir);
  } catch {
    throw new Error(`skill import rejected: source does not exist: ${sourceDir}`);
  }
  if (rootStat.isSymbolicLink()) throw new Error('skill import rejected: source directory is a symlink');
  if (!rootStat.isDirectory()) throw new Error('skill import rejected: source is not a directory');

  const target = resolveSkillTarget(roots, scope, agentId, opts);
  if (target.scope === 'global' && !target.approved) {
    throw new Error('global skill import requires hub approval');
  }

  // Validate the whole tree before writing anything.
  const files = walkAndValidate(sourceDir);
  if (!files.some((f) => f.rel === SKILL_FILE)) {
    throw new Error(`skill import rejected: source has no ${SKILL_FILE}`);
  }
  const parsed = parseSkillFile(readFileSync(join(sourceDir, SKILL_FILE), 'utf8'));
  if (!parsed) {
    throw new Error(`skill import rejected: ${SKILL_FILE} is malformed (name + description required)`);
  }
  const name = sanitizeId(parsed.name);
  if (name === '') {
    throw new Error(`skill import rejected: invalid skill name: ${JSON.stringify(parsed.name)}`);
  }

  const targetDir = resolve(target.root, name);
  if (existsSync(targetDir)) {
    throw new Error(`skill already exists in ${target.scope} scope: ${name}`);
  }

  ensureDir(targetDir);
  for (const file of files) {
    const dest = resolve(targetDir, file.rel);
    // Lexical containment of the destination — belt-and-braces on top of the
    // per-segment source checks above.
    if (dest !== targetDir && !dest.startsWith(targetDir + sep)) {
      throw new Error(`skill import rejected: destination escapes target: ${file.rel}`);
    }
    ensureDir(dirname(dest));
    copyFileSync(file.abs, dest, fsConstants.COPYFILE_EXCL);
  }
  log.info('skill imported', { name, scope: target.scope, files: files.length });
  return { name, description: parsed.description, scope: target.scope, pinned: parsed.pinned, docPresent: isDocumentedBody(parsed.body) };
}
