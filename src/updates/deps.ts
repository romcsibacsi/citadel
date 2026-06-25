// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { RemoteCheckError, type Commit, type LocalRev, type UpdateDeps } from './service.js';

/**
 * Production update deps: real local git + the GitHub commits API + a detached
 * updater script. Read-only checks; the apply spawn is the only mutating path
 * (operator-gated upstream). All git calls are defensive — a non-repo or a
 * missing binary degrades to null/false rather than throwing.
 */

function git(repoRoot: string, args: string[]): string | null {
  try { return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
}

/** A self-rewriting status file the agent churns — never let it count as dirty. */
const IGNORE_DIRTY = /(^|\/)(STATUS\.md|HEARTBEAT\.md|\.heartbeat)$/;

export type UpdateProvider = 'github' | 'gitea';

/** Normalize a free-text provider value; anything unknown falls back to github. */
export function normalizeProvider(raw: string | null | undefined): UpdateProvider {
  return String(raw ?? '').trim().toLowerCase() === 'gitea' ? 'gitea' : 'github';
}

interface CommitsRequest {
  url: string;
  headers: Record<string, string>;
}

/**
 * Build the "list commits" request for the chosen provider (pure — no network,
 * so it is unit-tested directly). Gitea mirrors the GitHub commits API but on a
 * self-hosted base and with `token <t>` auth + `limit` paging. The token is only
 * ever placed in an Authorization header here; callers never log this object.
 */
export function buildCommitsRequest(
  provider: UpdateProvider,
  repo: string,
  branch: string,
  token: string | undefined,
  apiBaseUrl: string | undefined,
  /** 1-based page; pages past the first are only requested to locate a far-behind HEAD (#237). */
  page?: number,
): CommitsRequest {
  const headers: Record<string, string> = { 'user-agent': 'orchestrator-self-update' };
  // Page 1 (the common case) keeps the original URL exactly; deeper pages add &page=N.
  const pageParam = page !== undefined && page > 1 ? `&page=${page}` : '';
  if (provider === 'gitea') {
    const base = (apiBaseUrl ?? '').trim().replace(/\/+$/, '');
    if (base === '') throw new RemoteCheckError('no-host', 'gitea base URL is not configured');
    headers.accept = 'application/json';
    if (token) headers.authorization = `token ${token}`;
    return {
      url: `${base}/api/v1/repos/${repo}/commits?sha=${encodeURIComponent(branch)}&limit=30${pageParam}`,
      headers,
    };
  }
  headers.accept = 'application/vnd.github+json';
  if (token) headers.authorization = `Bearer ${token}`;
  return {
    url: `https://api.github.com/repos/${repo}/commits?sha=${encodeURIComponent(branch)}&per_page=30${pageParam}`,
    headers,
  };
}

interface RawCommit {
  sha: string;
  commit: { message?: string; author?: { name?: string; date?: string } };
}

const COMMITS_PAGE_SIZE = 30;
/** How deep to page when HEAD is not in the first window (#237). 10 * 30 = 300 commits. */
const MAX_COMMIT_PAGES = 10;

/** Map one raw provider commit to the trimmed Commit shape. */
function toCommit(c: RawCommit): Commit {
  return {
    id: c.sha,
    shortId: c.sha.slice(0, 7),
    subject: (c.commit.message ?? '').split('\n')[0] ?? '',
    author: c.commit.author?.name ?? '',
    date: (c.commit.author?.date ?? '').slice(0, 10),
  };
}

/**
 * Reduce a GitHub/Gitea commits array (newest first) to {latest, commits-ahead-
 * of-local} (pure). Both providers return the same shape. Throws if the running
 * HEAD is not present in the returned window (diverged / unknown commit).
 */
export function parseCommits(data: RawCommit[], localHead: string): { latest: string; commits: Commit[] } {
  const latest = data[0]?.sha ?? '';
  const idx = data.findIndex((c) => c.sha === localHead);
  if (idx === -1) throw new RemoteCheckError('head-not-on-repo', 'local HEAD not found on the repo');
  return { latest, commits: data.slice(0, idx).map(toCommit) };
}

/**
 * Locate the local HEAD in the remote branch history and return the commits ahead of it
 * (#237). The first page is the fast path (the overwhelming common case: HEAD within the
 * newest 30). When HEAD is NOT in that window, this disambiguates the two cases the old
 * single-page check conflated:
 *   - a far-behind (e.g. dormant) fleet whose HEAD sits just past the window — page deeper
 *     and report the true behind-count, NOT a misleading head-not-on-repo;
 *   - a genuinely diverged / unknown HEAD — recognised by paging to the END of the branch
 *     history (a short page) without ever seeing HEAD -> head-not-on-repo (the real error).
 * If HEAD is still unseen after MAX_COMMIT_PAGES (history longer than the cap), the fleet is
 * very far behind: report a floor count ('cap+ behind, update available') rather than error.
 * `fetchPage(page)` returns one provider page (newest-first); it owns network + auth.
 */
export async function collectCommitsBehind(
  fetchPage: (page: number) => Promise<RawCommit[]>,
  localHead: string,
  maxPages: number = MAX_COMMIT_PAGES,
): Promise<{ latest: string; commits: Commit[] }> {
  const accumulated: RawCommit[] = [];
  let latest = '';
  for (let page = 1; page <= maxPages; page++) {
    const data = await fetchPage(page);
    if (page === 1) latest = data[0]?.sha ?? '';
    accumulated.push(...data);
    const idx = accumulated.findIndex((c) => c.sha === localHead);
    if (idx !== -1) return { latest, commits: accumulated.slice(0, idx).map(toCommit) };
    // A short page means we have enumerated the entire branch history and HEAD was never
    // in it -> the local HEAD is genuinely not an ancestor of this branch (truly diverged).
    if (data.length < COMMITS_PAGE_SIZE) throw new RemoteCheckError('head-not-on-repo', 'local HEAD not found on the repo');
  }
  // Cap reached with more history beyond it: a very-far-behind fleet. Reporting the floor
  // count (an update IS available) is correct; a false head-not-on-repo is not.
  return { latest, commits: accumulated.map(toCommit) };
}

/**
 * Normalize a user-entered repo reference to `owner/name`. Accepts a bare
 * `owner/name` (passed through) or a full http(s) URL (GitHub or Gitea) whose
 * first two path segments are owner + name; a trailing `.git` is stripped.
 * Returns null when both parts cannot be extracted (caller surfaces a field error).
 */
export function normalizeRepo(input: string): string | null {
  const raw = input.trim();
  if (raw === '') return null;
  let ownerName = raw;
  if (/^https?:\/\//i.test(raw)) {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return null;
    }
    const segs = parsed.pathname.split('/').filter((s) => s !== '');
    if (segs.length < 2) return null;
    ownerName = `${segs[0]}/${segs[1]}`;
  }
  ownerName = ownerName.replace(/\.git$/i, '');
  return /^[\w.-]+\/[\w.-]+$/.test(ownerName) ? ownerName : null;
}

export function realUpdateDeps(opts: {
  repoRoot: string;
  sourceRepo: () => string | null;
  token: () => string | undefined;
  /** Update-source provider; defaults to github when the closure is absent/blank. */
  provider?: () => string | null | undefined;
  /** Gitea self-hosted API base (e.g. https://gitea.example.com); github ignores it. */
  apiBaseUrl?: () => string | undefined;
  logFile: string;
  updaterScript: string;
}): UpdateDeps {
  return {
    localRevision(): LocalRev | null {
      const revision = git(opts.repoRoot, ['rev-parse', 'HEAD']);
      if (revision === null) return null;
      const branch = git(opts.repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']) ?? 'HEAD';
      return { revision, branch, detached: branch === 'HEAD' };
    },
    isDirty(): boolean {
      const out = git(opts.repoRoot, ['status', '--porcelain']);
      if (out === null || out === '') return false;
      for (const line of out.split('\n')) {
        if (line.trim() === '') continue;
        if (line.startsWith('??')) continue; // untracked never blocks
        const path = line.slice(3);
        if (IGNORE_DIRTY.test(path)) continue;
        return true;
      }
      return false;
    },
    sourceRepo: opts.sourceRepo,
    async remoteTip(repo: string, branch: string): Promise<{ latest: string; commits: Commit[] }> {
      const provider = normalizeProvider(opts.provider?.());
      const token = opts.token();
      const apiBase = opts.apiBaseUrl?.();
      const fetchPage = async (page: number): Promise<RawCommit[]> => {
        const { url, headers } = buildCommitsRequest(provider, repo, branch, token, apiBase, page);
        const res = await fetch(url, { headers });
        if (res.status === 404) throw new RemoteCheckError('no-branch-on-repo', 'branch or repo not found');
        if (!res.ok) throw new RemoteCheckError('generic', `${provider} ${res.status}`);
        return (await res.json()) as RawCommit[];
      };
      const local = git(opts.repoRoot, ['rev-parse', 'HEAD']) ?? '';
      // Page 1 is the fast path; a far-behind HEAD pages deeper instead of falsely
      // reporting head-not-on-repo (#237). Pages past the first only fire on a miss.
      return collectCommitsBehind(fetchPage, local);
    },
    spawnUpdater(autoStash: boolean): void {
      if (!existsSync(opts.updaterScript)) throw new Error('updater script missing');
      const child = spawn('bash', [opts.updaterScript], {
        cwd: opts.repoRoot, detached: true, stdio: 'ignore',
        env: { ...process.env, SELFUPDATE_AUTOSTASH: autoStash ? '1' : '0', SELFUPDATE_LOG: opts.logFile },
      });
      child.unref();
    },
  };
}

/** Deterministic synthetic deps for tests + the fake-adapter app (no git/network). */
export function syntheticUpdateDeps(): UpdateDeps {
  const commits: Commit[] = [
    { id: 'abcdef0123456789', shortId: 'abcdef0', subject: 'Add the activity feed view', author: 'NEXUS', date: '2026-06-12' },
    { id: 'bcdef01234567890', shortId: 'bcdef01', subject: 'Harden the vault scan', author: 'FORGE', date: '2026-06-11' },
    { id: 'cdef012345678901', shortId: 'cdef012', subject: 'Fix the token-monitor axis', author: 'FORGE', date: '2026-06-10' },
  ];
  return {
    localRevision: () => ({ revision: '1234567abcdef0000', branch: 'main', detached: false }),
    isDirty: () => true, // exercises the auto-stash confirm path (autoStash skips it)
    sourceRepo: () => 'owner/orchestrator',
    remoteTip: async () => ({ latest: 'abcdef0123456789', commits }),
    spawnUpdater: () => { /* no-op in synthetic mode */ },
  };
}
