// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { existsSync, statSync, readdirSync, readFileSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import type { MemoryStore, MemoryCategory } from '../memory/store.js';
import { screenMemoryContent } from '../memory/safety.js';

/**
 * Migration scan + import (PROMPT-17). Reads a legacy assistant workspace folder
 * (read-only — nothing on the source disk is touched), classifies known files +
 * a few likely subfolders into typed findings, then imports their content as
 * chunked, tier-classified agent memories. The per-chunk LLM tier categorizer is
 * a seam — a deterministic keyword heuristic stands in (default warm), so the
 * import never fails when no local model is available.
 */

export type FindingType =
  | 'personality' | 'profile' | 'memory' | 'hot' | 'warm' | 'cold'
  | 'heartbeat' | 'config' | 'daily-log' | 'schedule';

export interface Finding { type: FindingType; path: string; name: string; size: number }
export interface ScanSummary { personality: number; profile: number; memory: number; heartbeat: number; config: number; dailyLog: number; schedule: number; total: number }
export interface ScanResult { sourcePath: string; findings: Finding[]; summary: ScanSummary }

export type MigrationErrorCode = 'path_required' | 'not_found';
export class MigrationError extends Error {
  constructor(readonly code: MigrationErrorCode) { super(code); }
}

const MEMORY_TYPES: ReadonlySet<FindingType> = new Set(['memory', 'hot', 'warm', 'cold']);
const EXCLUDED = new Set(['package.json', 'package-lock.json', 'tsconfig.json', '.mcp.json']);
const SUBDIRS = ['memory', 'memories', 'bank', 'notes', ''];
/** Known files (relative path candidates) → the type they import as. */
const KNOWN: Array<{ rel: string; type: FindingType }> = [
  { rel: 'MEMORY.md', type: 'cold' },
  { rel: 'memory/hot/HOT.md', type: 'hot' },
  { rel: 'memory/warm/WARM.md', type: 'warm' },
  { rel: 'SOUL.md', type: 'personality' },
  { rel: 'PERSONALITY.md', type: 'personality' },
  { rel: 'USER.md', type: 'profile' },
  { rel: 'PROFILE.md', type: 'profile' },
  { rel: 'HEARTBEAT.md', type: 'heartbeat' },
  { rel: 'AGENTS.md', type: 'config' },
  { rel: 'TOOLS.md', type: 'config' },
  { rel: 'CLAUDE.md', type: 'config' },
  { rel: 'INSTRUCTIONS.md', type: 'config' },
];

function inferByName(name: string): FindingType {
  const n = name.toLowerCase();
  if (/soul|personality/.test(n)) return 'personality';
  if (/user|profile/.test(n)) return 'profile';
  if (/heartbeat/.test(n)) return 'heartbeat';
  if (/cron|schedule/.test(n)) return 'schedule';
  if (/^\d{4}-\d{2}-\d{2}/.test(name)) return 'daily-log';
  return 'memory';
}

export function scanFolder(rootPath: string): ScanResult {
  const root = (rootPath ?? '').trim();
  if (root === '') throw new MigrationError('path_required');
  if (!existsSync(root)) throw new MigrationError('not_found');
  const seen = new Set<string>();
  const findings: Finding[] = [];
  const add = (full: string, type: FindingType): void => {
    if (seen.has(full)) return;
    let st;
    try { st = statSync(full); } catch { return; }
    if (!st.isFile() || st.size <= 20) return;
    seen.add(full);
    findings.push({ type, path: full, name: basename(full), size: st.size });
  };
  for (const k of KNOWN) { const full = join(root, k.rel); if (existsSync(full)) add(full, k.type); }
  for (const sub of SUBDIRS) {
    const dir = sub === '' ? root : join(root, sub);
    if (!existsSync(dir)) continue;
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const entry of entries) {
      if (EXCLUDED.has(entry)) continue;
      if (!['.md', '.txt', '.json'].includes(extname(entry).toLowerCase())) continue;
      add(join(dir, entry), inferByName(entry));
    }
  }
  const summary: ScanSummary = {
    personality: findings.filter((f) => f.type === 'personality').length,
    profile: findings.filter((f) => f.type === 'profile').length,
    memory: findings.filter((f) => MEMORY_TYPES.has(f.type)).length,
    heartbeat: findings.filter((f) => f.type === 'heartbeat').length,
    config: findings.filter((f) => f.type === 'config').length,
    dailyLog: findings.filter((f) => f.type === 'daily-log').length,
    schedule: findings.filter((f) => f.type === 'schedule').length,
    total: findings.length,
  };
  return { sourcePath: root, findings, summary };
}

/** Deterministic stand-in for the LLM tier categorizer (default warm). */
function classifyChunk(text: string): { tier: MemoryCategory; keywords: string } {
  const t = text.toLowerCase();
  if (/\b(urgent|now|asap|critical|blocker|immediately)\b/.test(t)) return { tier: 'hot', keywords: 'urgent, active' };
  if (/\b(lesson|learned|mistake|postmortem|archive|retrospective)\b/.test(t)) return { tier: 'cold', keywords: 'lesson, archive' };
  if (/\b(shared|everyone|all agents|team-wide|convention)\b/.test(t)) return { tier: 'shared', keywords: 'shared, team' };
  return { tier: 'warm', keywords: 'imported' };
}

function chunkContent(name: string, raw: string): string[] {
  const ext = extname(name).toLowerCase();
  let pieces: string[] = [];
  if (ext === '.json') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) pieces = parsed.map((el) => (el && typeof el === 'object' && 'content' in el ? String((el as { content: unknown }).content) : el && typeof el === 'object' && 'text' in el ? String((el as { text: unknown }).text) : JSON.stringify(el)));
      else if (parsed && typeof parsed === 'object') pieces = Object.entries(parsed as Record<string, unknown>).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
      else pieces = [raw];
    } catch { pieces = [raw]; }
  } else if (ext === '.md') {
    pieces = raw.split(/\n(?=#{1,6}\s)/);
  } else {
    pieces = raw.split(/\n\s*\n/);
  }
  return pieces.map((p) => p.trim()).filter((p) => p.length > 20).map((p) => p.slice(0, 2000));
}

export interface RunDetail { kind: 'personality' | 'profile' | 'heartbeat' | 'chunks'; name?: string; n?: number }
export interface RunResult { ok: true; imported: number; skipped: number; stats: Record<MemoryCategory, number>; details: RunDetail[] }

export function runImport(findings: Finding[], agentId: string, memory: MemoryStore): RunResult {
  const stats: Record<MemoryCategory, number> = { hot: 0, warm: 0, cold: 0, shared: 0 };
  const details: RunDetail[] = [];
  let imported = 0;
  let skipped = 0;
  const read = (f: Finding, cap: number): string => { try { return readFileSync(f.path, 'utf8').slice(0, cap); } catch { return ''; } };
  // Screen EVERY imported chunk (PROMPT-08 §8 / FIX-08 §1): legacy workspace files
  // are untrusted, so an injection/exec snippet must not land in the corpus here
  // any more than via POST /api/memories. Rejected chunks are skipped, not stored.
  const store = (tier: MemoryCategory, content: string, keywords: string): boolean => {
    if (content.trim() === '') return false;
    if (!screenMemoryContent(content).ok) { skipped += 1; return false; }
    memory.save({ agentId, category: tier, sector: 'semantic', content, keywords, autoGenerated: true });
    stats[tier] += 1; imported += 1;
    return true;
  };

  for (const f of findings.filter((x) => x.type === 'personality')) { if (store('warm', read(f, 3000), 'personality, soul, import')) details.push({ kind: 'personality', name: f.name }); }
  for (const f of findings.filter((x) => x.type === 'profile')) { if (store('warm', read(f, 3000), 'user, profile, import')) details.push({ kind: 'profile', name: f.name }); }
  for (const f of findings.filter((x) => x.type === 'heartbeat')) { if (store('warm', read(f, 2000), 'heartbeat, config, import')) details.push({ kind: 'heartbeat', name: f.name }); }

  let chunkCount = 0;
  const bulk = findings.filter((f) => MEMORY_TYPES.has(f.type) || f.type === 'config' || f.type === 'daily-log');
  for (const f of bulk) {
    for (const chunk of chunkContent(f.name, read(f, 200_000))) {
      const { tier, keywords } = classifyChunk(chunk);
      if (store(tier, chunk, keywords)) chunkCount += 1;
    }
  }
  if (chunkCount > 0) details.push({ kind: 'chunks', n: chunkCount });
  return { ok: true, imported, skipped, stats, details };
}
