// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * Two-tier skill storage on the FILESYSTEM (SPEC §10). No DB involvement.
 *
 * A skill is a directory <root>/<skill-name>/ containing SKILL.md
 * (frontmatter: name + description + optional pinned, then a markdown body)
 * plus optional helper files beside it. Two scopes exist:
 *
 *  - global: visible to every agent, root = roots.globalRoot
 *  - local:  visible only to the owning agent, root = roots.agentRoot(agentId)
 *
 * A local skill of the same name SHADOWS the global one. An agent's view
 * never includes another agent's locals.
 *
 * HUB SPECIAL CASE: the hub's skill root IS the global root. Consequently
 * listLocal(hubId) is always empty (the hub has no separate local scope) and
 * any 'local' mutation by the hub redirects to the GLOBAL scope. Because the
 * hub is itself the approver of global changes, the redirect counts as
 * hub-approved (a hub action cannot lack the hub's approval).
 *
 * Governance (SPEC §10): mutating GLOBAL skills requires approvedByHub=true;
 * agent-local skills are free. Pinned (factory/plugin) skills are immutable
 * and undeletable in every scope, even with approval.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFile, ensureDir } from '../core/fsx.js';
import { createLogger } from '../core/log.js';
import { sanitizeId } from '../trust/sanitize.js';

const log = createLogger('skills');

/** The single well-known document inside a skill directory. */
export const SKILL_FILE = 'SKILL.md';

/** The skill-library index file (reserved; never a skill directory). */
export const SKILL_INDEX_FILE = '.skill-index.md';

/**
 * Names a skill scan MUST skip (SPEC §9): a nested `skills` folder (would recurse
 * the tree into itself), the index file, and temp/hidden scratch dirs. The match
 * is by name only — these are reserved regardless of contents.
 */
export function isReservedSkillEntry(name: string): boolean {
  if (name === 'skills' || name === SKILL_INDEX_FILE) return true;
  if (name.startsWith('.')) return true; // hidden + the index file + scratch dirs
  if (/^(tmp|temp)$/i.test(name) || name.endsWith('.tmp')) return true;
  return false;
}

export type SkillScope = 'global' | 'local';

/** Filesystem layout contract injected by the host (paths come from config). */
export interface SkillRoots {
  globalRoot: string;
  agentRoot: (agentId: string) => string;
  hubId: string;
}

/** Level-0 surface: what the index exposes per skill. */
export interface SkillMeta {
  name: string;
  description: string;
  scope: SkillScope;
  pinned: boolean;
  /** True when the SKILL.md has a non-trivial body (real docs, not just a stub) — drives the "documented" filter (FIX-skills-view-filter). */
  docPresent: boolean;
}

/** A SKILL.md body of at least this many trimmed chars counts as "documented". */
const DOC_PRESENT_MIN_BODY = 80;

/** Whether a SKILL.md body is non-trivial ("documented") — the shared predicate. */
export function isDocumentedBody(body: string): boolean {
  return body.trim().length >= DOC_PRESENT_MIN_BODY;
}

/** Level-1 (body) + Level-2 (helper file names) surface. */
export interface SkillDoc {
  meta: SkillMeta;
  body: string;
  /** Relative paths ('/'-separated, sorted) of helper files beside SKILL.md. */
  helpers: string[];
}

export interface SkillGovernanceOpts {
  approvedByHub?: boolean;
}

/** Parsed SKILL.md content. */
export interface ParsedSkillFile {
  name: string;
  description: string;
  pinned: boolean;
  body: string;
}

/**
 * Parse a SKILL.md: a `---` line, then `key: value` lines (name, description,
 * optional `pinned: true`), then a closing `---`, then the markdown body.
 * Returns undefined when the frontmatter is missing/unterminated or when
 * name/description are absent — callers treat that as "malformed".
 */
export function parseSkillFile(content: string): ParsedSkillFile | undefined {
  const lines = content.split(/\r?\n/);
  if (lines.length === 0 || lines[0]?.trim() !== '---') return undefined;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) return undefined;
  let name = '';
  let description = '';
  let pinned = false;
  for (const raw of lines.slice(1, end)) {
    const match = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(raw.trim());
    if (!match) continue;
    const key = match[1] ?? '';
    const value = (match[2] ?? '').trim();
    if (key === 'name') name = value;
    else if (key === 'description') description = value;
    else if (key === 'pinned') pinned = value === 'true';
  }
  if (name === '' || description === '') return undefined;
  return { name, description, pinned, body: lines.slice(end + 1).join('\n') };
}

/**
 * Serialize a SKILL.md. The description is collapsed to a single line because
 * the frontmatter format is line-based.
 */
export function serializeSkillFile(name: string, description: string, body: string, pinned = false): string {
  const singleLineDescription = description.replace(/\s*\r?\n\s*/g, ' ').trim();
  const fm = ['---', `name: ${name}`, `description: ${singleLineDescription}`];
  if (pinned) fm.push('pinned: true');
  fm.push('---');
  const normalizedBody = body.endsWith('\n') ? body : `${body}\n`;
  return `${fm.join('\n')}\n${normalizedBody}`;
}

/** Deterministic, locale-independent name ordering. */
export function compareSkillNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Recursively list regular helper files (everything except the root SKILL.md). */
function listHelpers(skillDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      if (isReservedSkillEntry(entry)) continue; // skip the index file, nested skills/, temp/hidden (§9)
      const abs = join(dir, entry);
      const relPath = rel === '' ? entry : `${rel}/${entry}`;
      const st = lstatSync(abs);
      if (st.isDirectory()) walk(abs, relPath);
      else if (st.isFile() && relPath !== SKILL_FILE) out.push(relPath);
    }
  };
  walk(skillDir, '');
  return out.sort();
}

interface ResolvedTarget {
  scope: SkillScope;
  root: string;
  approved: boolean;
}

/**
 * Resolve the effective (scope, root, approval) for a mutation, applying the
 * hub redirect: a 'local' operation by the hub targets the GLOBAL root and is
 * implicitly hub-approved (the hub is the approver). Shared with the importer
 * so governance cannot diverge between create and import.
 */
export function resolveSkillTarget(
  roots: SkillRoots,
  scope: SkillScope,
  agentId: string | null,
  opts: SkillGovernanceOpts,
): ResolvedTarget {
  const approved = opts.approvedByHub === true;
  if (scope === 'local') {
    if (agentId === null) throw new Error('local skill operations require an agentId');
    if (agentId === roots.hubId) {
      // Hub special case: its skill root IS the global root.
      return { scope: 'global', root: roots.globalRoot, approved: true };
    }
    return { scope: 'local', root: roots.agentRoot(agentId), approved };
  }
  return { scope: 'global', root: roots.globalRoot, approved };
}

export class SkillStore {
  constructor(private readonly roots: SkillRoots) {}

  /** Level-0 listing of the global scope. Malformed skill dirs are skipped (logged). */
  listGlobal(): SkillMeta[] {
    return this.scanRoot(this.roots.globalRoot, 'global');
  }

  /**
   * Level-0 listing of one agent's local scope. The hub has NO local scope
   * (its root is the global root), so listLocal(hubId) is always [].
   */
  listLocal(agentId: string): SkillMeta[] {
    if (agentId === this.roots.hubId) return [];
    return this.scanRoot(this.roots.agentRoot(agentId), 'local');
  }

  /**
   * The agent's effective skill set: global + own locals; a local of the same
   * name shadows the global. Never includes another agent's locals (locals are
   * read exclusively from this agent's own root). Sorted by name.
   */
  effectiveSkills(agentId: string): SkillMeta[] {
    const byName = new Map<string, SkillMeta>();
    for (const meta of this.listGlobal()) byName.set(meta.name, meta);
    for (const meta of this.listLocal(agentId)) byName.set(meta.name, meta); // local shadows global
    return [...byName.values()].sort((a, b) => compareSkillNames(a.name, b.name));
  }

  /**
   * Levels 1+2: full body + helper file list, resolved with the same shadowing
   * as effectiveSkills (the agent's local wins over the global).
   */
  readSkill(name: string, agentId: string): SkillDoc | undefined {
    const clean = sanitizeId(name);
    if (clean === '') return undefined;
    if (agentId !== this.roots.hubId) {
      const local = this.readFrom(join(this.roots.agentRoot(agentId), clean), clean, 'local');
      if (local) return local;
    }
    return this.readFrom(join(this.roots.globalRoot, clean), clean, 'global');
  }

  /**
   * Create a skill. Global creation REQUIRES approvedByHub=true; local is
   * free. A hub 'local' create redirects to the global scope (implicitly
   * approved). Same-scope duplicates are refused; shadowing an existing
   * global with a local IS legal (different roots).
   */
  createSkill(
    scope: SkillScope,
    agentId: string | null,
    name: string,
    description: string,
    body: string,
    opts: SkillGovernanceOpts = {},
  ): SkillMeta {
    const clean = this.cleanName(name);
    const target = resolveSkillTarget(this.roots, scope, agentId, opts);
    if (target.scope === 'global' && !target.approved) {
      throw new Error('global skill create requires hub approval');
    }
    const dir = join(target.root, clean);
    if (existsSync(dir)) {
      throw new Error(`skill already exists in ${target.scope} scope: ${clean}`);
    }
    ensureDir(dir);
    atomicWriteFile(join(dir, SKILL_FILE), serializeSkillFile(clean, description, body));
    log.info('skill created', { name: clean, scope: target.scope });
    return {
      name: clean,
      description: description.replace(/\s*\r?\n\s*/g, ' ').trim(),
      scope: target.scope,
      pinned: false,
      docPresent: body.trim().length >= DOC_PRESENT_MIN_BODY,
    };
  }

  /**
   * Replace a skill's body (frontmatter is preserved). Same governance as
   * create; REFUSES pinned skills in every scope, even with approval.
   */
  patchSkill(
    scope: SkillScope,
    agentId: string | null,
    name: string,
    newBody: string,
    opts: SkillGovernanceOpts = {},
  ): void {
    const clean = this.cleanName(name);
    const target = resolveSkillTarget(this.roots, scope, agentId, opts);
    if (target.scope === 'global' && !target.approved) {
      throw new Error('global skill patch requires hub approval');
    }
    const file = join(target.root, clean, SKILL_FILE);
    if (!existsSync(file)) {
      throw new Error(`skill not found in ${target.scope} scope: ${clean}`);
    }
    const parsed = parseSkillFile(readFileSync(file, 'utf8'));
    if (!parsed) throw new Error(`skill file is malformed: ${clean}`);
    if (parsed.pinned) throw new Error(`skill is pinned and cannot be patched: ${clean}`);
    atomicWriteFile(file, serializeSkillFile(clean, parsed.description, newBody, parsed.pinned));
    log.info('skill patched', { name: clean, scope: target.scope });
  }

  /**
   * Delete a skill directory. Global deletion requires approvedByHub=true;
   * pinned skills are NEVER deletable (any scope, even with approval).
   */
  deleteSkill(scope: SkillScope, agentId: string | null, name: string, opts: SkillGovernanceOpts = {}): void {
    const clean = this.cleanName(name);
    const target = resolveSkillTarget(this.roots, scope, agentId, opts);
    if (target.scope === 'global' && !target.approved) {
      throw new Error('global skill delete requires hub approval');
    }
    const dir = join(target.root, clean);
    if (!existsSync(dir)) {
      throw new Error(`skill not found in ${target.scope} scope: ${clean}`);
    }
    const file = join(dir, SKILL_FILE);
    if (existsSync(file)) {
      const parsed = parseSkillFile(readFileSync(file, 'utf8'));
      if (parsed?.pinned) throw new Error(`skill is pinned and cannot be deleted: ${clean}`);
    }
    rmSync(dir, { recursive: true, force: true });
    log.info('skill deleted', { name: clean, scope: target.scope });
  }

  private cleanName(raw: string): string {
    const clean = sanitizeId(raw);
    if (clean === '') throw new Error(`invalid skill name: ${JSON.stringify(raw)}`);
    return clean;
  }

  private scanRoot(root: string, scope: SkillScope): SkillMeta[] {
    if (!existsSync(root)) return [];
    const metas: SkillMeta[] = [];
    for (const entry of readdirSync(root).sort()) {
      // skip reserved names (SPEC §9): a nested `skills` folder, the index file,
      // and temp/hidden scratch dirs are NOT skills and must never be listed.
      if (isReservedSkillEntry(entry)) continue;
      const dir = join(root, entry);
      let st;
      try {
        st = lstatSync(dir);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      const meta = this.readMeta(dir, entry, scope);
      if (meta) metas.push(meta);
      else log.warn('skipping malformed skill directory', { dir });
    }
    return metas;
  }

  /** The directory name is the canonical skill identity (lookups go by it). */
  private readMeta(dir: string, dirName: string, scope: SkillScope): SkillMeta | undefined {
    const file = join(dir, SKILL_FILE);
    if (!existsSync(file)) return undefined;
    const parsed = parseSkillFile(readFileSync(file, 'utf8'));
    if (!parsed) return undefined;
    return {
      name: dirName,
      description: parsed.description,
      scope,
      pinned: parsed.pinned,
      docPresent: parsed.body.trim().length >= DOC_PRESENT_MIN_BODY,
    };
  }

  private readFrom(dir: string, name: string, scope: SkillScope): SkillDoc | undefined {
    const file = join(dir, SKILL_FILE);
    if (!existsSync(file)) return undefined;
    const parsed = parseSkillFile(readFileSync(file, 'utf8'));
    if (!parsed) return undefined;
    return {
      meta: {
        name,
        description: parsed.description,
        scope,
        pinned: parsed.pinned,
        docPresent: parsed.body.trim().length >= DOC_PRESENT_MIN_BODY,
      },
      body: parsed.body,
      helpers: listHelpers(dir),
    };
  }
}
