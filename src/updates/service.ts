// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { createLogger } from '../core/log.js';

const log = createLogger('updates');

/**
 * Self-update service (PROMPT-18). Compares the running revision to the operator's
 * own source repo, lists incoming commits, and applies the update behind a
 * preflight safety gate + an on-disk concurrency lock that survives the
 * dashboard restarting mid-update. The git/GitHub/spawn layer is injected
 * (`UpdateDeps`) so production drives real git while tests + the fake-adapter app
 * drive a deterministic synthetic checker. Apply is NEVER auto-fired.
 */

export interface Commit { id: string; shortId: string; subject: string; author: string; date: string }
export interface UpdateStatus {
  current: string; currentShort: string; branch: string; repo: string | null;
  latest: string | null; latestShort: string | null; behind: number;
  commits: Commit[]; lastChecked: string; error: string | null; errorKey: string | null;
}

export type RefuseReason = 'detached-head' | 'not-on-main' | 'dirty-tree' | 'already-running' | 'policy-blocked';
export interface ApplyResult { ok: boolean; started?: boolean; reason?: RefuseReason; message?: string; branch?: string; pid?: number }

export interface LocalRev { revision: string; branch: string; detached: boolean }
export interface UpdateDeps {
  localRevision(): LocalRev | null;
  isDirty(): boolean;
  sourceRepo(): string | null;
  remoteTip(repo: string, branch: string): Promise<{ latest: string; commits: Commit[] }>;
  spawnUpdater(autoStash: boolean): void;
  /**
   * Optional hardened-update gate (#106). When present (product instance), it runs
   * AFTER the git preflight and BEFORE the updater spawns; a non-ok verdict refuses
   * the apply (signed-release / version-pin / anti-downgrade). ABSENT for the own
   * fleet => the update path is byte-unchanged.
   */
  checkPolicy?(): { ok: boolean; reason?: string };
}

/** Thrown by remoteTip with a stable key the UI localizes. */
export class RemoteCheckError extends Error {
  constructor(readonly key: string, message: string) { super(message); }
}

const STALE_MS = 60 * 60 * 1000;
const MAIN_BRANCH = 'main';

function pidAlive(pid: number): boolean {
  if (pid <= 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
}

export class UpdateService {
  private cache: UpdateStatus | undefined;

  constructor(
    private readonly deps: UpdateDeps,
    private readonly lockPath: string,
    private readonly now: () => Date = () => new Date(),
    private readonly synthetic = false,
  ) {}

  status(): UpdateStatus | undefined {
    return this.cache;
  }

  async forceCheck(): Promise<UpdateStatus> {
    const nowIso = this.now().toISOString();
    const local = this.deps.localRevision();
    const base: UpdateStatus = {
      current: local?.revision ?? '', currentShort: (local?.revision ?? '').slice(0, 7) || '—',
      branch: local?.branch ?? '', repo: null, latest: null, latestShort: null, behind: 0,
      commits: [], lastChecked: nowIso, error: null, errorKey: null,
    };
    if (local === null || local.detached) { base.error = 'detached'; base.errorKey = 'detached'; this.cache = base; return base; }
    const repo = this.deps.sourceRepo();
    base.repo = repo;
    if (repo === null || repo === '') { base.errorKey = 'no-repo'; base.error = 'no-repo'; this.cache = base; return base; }
    try {
      // Query the remote window on the CONFIGURED update branch (main), NOT the local
      // abbrev-ref HEAD: a deploy checked out on a stray branch (e.g. a leftover build
      // branch) whose HEAD content still equals origin/main would otherwise ask the
      // remote for that stray ref and get a window the running SHA is absent from —
      // a false 'head-not-on-repo'. The behind-count is a SHA-containment check inside
      // remoteTip, so main is always the right window; base.branch still shows the real
      // local branch for the UI. Apply already refuses off-main (not-on-main) separately.
      const { latest, commits } = await this.deps.remoteTip(repo, MAIN_BRANCH);
      base.latest = latest; base.latestShort = latest.slice(0, 7);
      base.behind = commits.length; base.commits = commits;
    } catch (err) {
      base.errorKey = err instanceof RemoteCheckError ? err.key : 'generic';
      base.error = err instanceof Error ? err.message : String(err);
    }
    this.cache = base;
    return base;
  }

  /** Read-only behind count for the nav badge (0 when unknown/up-to-date). */
  behindCount(): number {
    return this.cache?.error ? 0 : (this.cache?.behind ?? 0);
  }

  apply(autoStash: boolean): ApplyResult {
    const local = this.deps.localRevision();
    if (local === null || local.detached) return { ok: false, reason: 'detached-head' };
    if (local.branch !== MAIN_BRANCH) return { ok: false, reason: 'not-on-main', branch: local.branch };
    if (this.deps.isDirty() && !autoStash) return { ok: false, reason: 'dirty-tree' };

    // Hardened-update gate (#106): only present on the product instance. Refuse a
    // signature/version/anti-downgrade violation BEFORE spawning the updater.
    if (this.deps.checkPolicy !== undefined) {
      const verdict = this.deps.checkPolicy();
      if (!verdict.ok) return { ok: false, reason: 'policy-blocked', message: verdict.reason };
    }

    const lock = this.acquireLock();
    if (!lock.ok) return { ok: false, reason: 'already-running', pid: lock.pid };
    try {
      this.deps.spawnUpdater(autoStash);
    } catch (err) {
      this.releaseLock();
      throw err;
    }
    // synthetic mode has no real detached process to own the lock — release it.
    if (this.synthetic) this.releaseLock();
    return { ok: true, started: true };
  }

  // --- concurrency lock (on-disk pid + start epoch) ---
  private acquireLock(): { ok: true } | { ok: false; pid: number } {
    const content = `${process.pid} ${this.now().getTime()}`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        writeFileSync(this.lockPath, content, { flag: 'wx', mode: 0o600 });
        return { ok: true };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        let pid = 0; let epoch = 0;
        try { const parts = readFileSync(this.lockPath, 'utf8').trim().split(/\s+/); pid = Number(parts[0] ?? 0); epoch = Number(parts[1] ?? 0); } catch { /* unreadable -> treat stale */ }
        const stale = epoch > 0 && this.now().getTime() - epoch > STALE_MS;
        if (pidAlive(pid) && !stale) return { ok: false, pid };
        try { unlinkSync(this.lockPath); } catch { /* lost the race */ }
      }
    }
    return { ok: false, pid: 0 };
  }
  private releaseLock(): void {
    try { unlinkSync(this.lockPath); } catch { /* already gone */ }
    void log;
  }
}
