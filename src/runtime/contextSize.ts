// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Read an agent session's LIVE context size (tokens) from its Claude Code transcript, for the auto-compact
 * watcher (#296). Claude Code writes one JSONL per session under <sessionDir>/projects/<cwd-encoded>/ (e.g.
 * <configRoot>/projects/-home-...-agents-nexus-workdir/<uuid>.jsonl). The latest turn's `usage` carries the
 * context: input_tokens + cache_read_input_tokens + cache_creation_input_tokens (output_tokens is the new
 * reply, not the standing context). We scan the NEWEST transcript from the end for the last turn that carries
 * a usage and sum those three. Returns null when there is no transcript / no usage yet (a fresh session) so
 * the watcher treats "unknown" as "do nothing".
 *
 * The newest-.jsonl-anywhere-under-projects walk is robust to the cwd-encoded subdir name (we never need to
 * reconstruct it). All I/O is swallowed to null -- a heartbeat read must never throw into the watcher loop.
 */
export function readContextTokens(sessionDir: string): number | null {
  try {
    const projects = join(sessionDir, 'projects');
    if (!existsSync(projects)) return null;
    let newest: { path: string; mtime: number } | undefined;
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.jsonl')) {
          const mtime = statSync(p).mtimeMs;
          if (newest === undefined || mtime > newest.mtime) newest = { path: p, mtime };
        }
      }
    };
    walk(projects);
    if (newest === undefined) return null;
    const lines = readFileSync(newest.path, 'utf-8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]?.trim();
      if (line === undefined || line === '') continue;
      try {
        const u = (JSON.parse(line) as { message?: { usage?: Record<string, unknown> } }).message?.usage;
        if (u !== undefined && u !== null && typeof u === 'object') {
          const inp = Number(u.input_tokens) || 0;
          const cr = Number(u.cache_read_input_tokens) || 0;
          const cc = Number(u.cache_creation_input_tokens) || 0;
          const total = inp + cr + cc;
          if (total > 0) return total;
        }
      } catch {
        /* skip a malformed JSONL line */
      }
    }
    return null;
  } catch {
    return null;
  }
}
