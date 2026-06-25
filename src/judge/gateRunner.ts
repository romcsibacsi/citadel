// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { execFile } from 'node:child_process';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GateRunner } from './service.js';

/**
 * The REAL git/test/merge seam for the panel gate (BUILD-judge-panel Phase 4).
 *
 * This is CI + git plumbing, NOT panel work — it runs the orchestrator's OWN
 * testCommand and git, never a metered Claude path (no headless CLI run, no SDK
 * call, no background-task service). The PanelService keeps this behind the
 * injectable `GateRunner` so the gate's state machine + the hard apply predicate are
 * unit-tested with stubs; this implementation is exercised on a real deploy.
 *
 * TEST runs inside a throwaway `git worktree` of the winner's branch, so the live
 * checkout is never disturbed and a failing test can never leave a dirty tree.
 */

function exec(file: string, args: string[], opts: { cwd: string; timeoutMs?: number }): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { cwd: opts.cwd, timeout: opts.timeoutMs ?? 15 * 60_000, maxBuffer: 32 * 1024 * 1024, killSignal: 'SIGKILL' },
      (err, stdout, stderr) => {
        const out = `${stdout ?? ''}\n${stderr ?? ''}`.trim();
        const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
        resolve({ code, out });
      },
    );
  });
}

export interface GitGateOptions {
  /** The orchestrator's own repo root (panels are the in-product self-improvement loop). */
  repoRoot: string;
  /** Integration branch the winner must be isolated from + merge into; default `main`. */
  baseBranch?: string;
}

export function createGitGateRunner(opts: GitGateOptions): GateRunner {
  const repoRoot = opts.repoRoot;
  const base = opts.baseBranch ?? 'main';

  /**
   * A fresh `git worktree` is a clean checkout WITHOUT node_modules (deps are gitignored,
   * not committed) → `tsc`/`tsx`/npm scripts can't resolve → the testCommand dies with
   * exit 127 (`tsc: not found`). Symlink the repo's installed node_modules INTO the worktree
   * (instant, vs a slow `npm ci`) so any worktree that runs tests has its deps. The symlink
   * lives inside the worktree, so `git worktree remove --force` reclaims it — the shared
   * repo-root node_modules (the symlink TARGET) is never touched.
   */
  async function linkNodeModules(wt: string): Promise<void> {
    const src = join(repoRoot, 'node_modules');
    const dest = join(wt, 'node_modules');
    if (!existsSync(src) || existsSync(dest)) return; // no deps to share, or already present
    await symlink(src, dest, 'dir').catch(() => undefined);
  }

  return {
    async branchIsolated(branch) {
      const exists = await exec('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repoRoot, timeoutMs: 30_000 });
      if (exists.code !== 0) return { isolated: false, evidence: `branch ${branch} does not exist` };
      const ahead = await exec('git', ['rev-list', '--count', `${base}..${branch}`], { cwd: repoRoot, timeoutMs: 30_000 });
      const aheadN = Number(ahead.out.trim()) || 0;
      if (aheadN === 0) return { isolated: false, evidence: `branch ${branch} has no commits ahead of ${base} — the work is not branch-isolated` };
      return { isolated: true, evidence: `${branch} is ${aheadN} commit(s) ahead of ${base} (branch-isolated)` };
    },

    async runTests(branch, command) {
      const wt = await mkdtemp(join(tmpdir(), 'panel-gate-'));
      try {
        const add = await exec('git', ['worktree', 'add', '--detach', wt, branch], { cwd: repoRoot, timeoutMs: 60_000 });
        if (add.code !== 0) return { passed: false, log: `worktree add failed (exit ${add.code}):\n${add.out}` };
        // make the repo's deps resolvable in the clean checkout (else tsc/npm → exit 127).
        await linkNodeModules(wt);
        // the testCommand may be a compound shell command (e.g. `npm run typecheck && npm test`).
        const res = await exec('bash', ['-lc', command], { cwd: wt });
        return { passed: res.code === 0, log: `\$ ${command}\nexit ${res.code}\n${res.out}`.slice(0, 8000) };
      } finally {
        await exec('git', ['worktree', 'remove', '--force', wt], { cwd: repoRoot, timeoutMs: 60_000 });
        await rm(wt, { recursive: true, force: true }).catch(() => undefined);
      }
    },

    async merge(branch) {
      // FAIL CLOSED: git merges into whatever HEAD points at. The daemon's working
      // tree is long-lived and HEAD is mutable, so refuse unless HEAD is exactly the
      // configured base — never silently merge the winner into the wrong branch.
      const head = await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot, timeoutMs: 30_000 });
      const current = head.out.trim();
      if (head.code !== 0 || current !== base) {
        return { merged: false, evidence: `refusing to merge ${branch}: HEAD is '${current || '(unknown)'}', expected base '${base}' — checkout ${base} first` };
      }
      const res = await exec('git', ['merge', '--no-ff', '--no-edit', branch], { cwd: repoRoot, timeoutMs: 120_000 });
      if (res.code !== 0) {
        // never leave a half-merged tree behind.
        await exec('git', ['merge', '--abort'], { cwd: repoRoot, timeoutMs: 30_000 });
      }
      return { merged: res.code === 0, evidence: `git merge --no-ff ${branch}: exit ${res.code}\n${res.out}`.slice(0, 4000) };
    },

    async archiveBranch(branch, panelId) {
      // forensics: stamp a per-PANEL archive tag; the branch is left intact (never deleted).
      // The panelId keeps the tag unique so a re-run with the same goal+solver (identical
      // branch name) never moves a prior panel's archive pointer.
      await exec('git', ['tag', '-f', `archive/p${panelId}-${branch.replace(/\//g, '-')}`, branch], { cwd: repoRoot, timeoutMs: 30_000 });
    },

    async prepareWorktree({ path, branch }) {
      // idempotent re-provision: clear any stale worktree at the path first (ignore errors).
      await exec('git', ['worktree', 'remove', '--force', path], { cwd: repoRoot, timeoutMs: 60_000 });
      const exists = await exec('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repoRoot, timeoutMs: 30_000 });
      const add =
        exists.code === 0
          ? await exec('git', ['worktree', 'add', path, branch], { cwd: repoRoot, timeoutMs: 60_000 })
          : await exec('git', ['worktree', 'add', '-b', branch, path, base], { cwd: repoRoot, timeoutMs: 60_000 });
      // a solver/judge running the testCommand in-place needs deps too — share node_modules.
      if (add.code === 0) await linkNodeModules(path);
      return { ok: add.code === 0, evidence: `worktree add ${branch} @ ${path}: exit ${add.code}\n${add.out}`.slice(0, 2000) };
    },

    async branchHead(branch) {
      const r = await exec('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repoRoot, timeoutMs: 30_000 });
      return r.code === 0 && r.out.trim() !== '' ? r.out.trim() : null;
    },

    async removeWorktree(path) {
      await exec('git', ['worktree', 'remove', '--force', path], { cwd: repoRoot, timeoutMs: 60_000 });
      await rm(path, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}
