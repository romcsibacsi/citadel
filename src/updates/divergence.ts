// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { execFileSync } from 'node:child_process';

/**
 * Deploy-checkout divergence monitor (#88). The shared deploy checkout's local main
 * can pick up a commit that never went through the PR flow (a direct operator commit
 * — the recurring root cause). That is NOT itself blocked (the operator legitimately
 * owns the repo), but it MUST be VISIBLE: a diverged local main breaks a plain
 * fast-forward deploy and risks shipping un-reviewed content if a build runs from the
 * mutable checkout. This is a NON-BLOCKING signal only — it warns, never gates.
 *
 * Same shape as the #80/#86 monitors: a pure classifier (unit-tested) + a periodic
 * driver that surfaces a DURABLE operator alert once per episode plus a dashboard/
 * webhook signal, with the side-effects injected so the logic is testable.
 */

export interface DivergenceCommit {
  sha: string;
  author: string;
  subject: string;
}

export interface DivergenceStatus {
  /** Local <branch> has commit(s) not on origin/<branch>. */
  diverged: boolean;
  aheadCount: number;
  commits: DivergenceCommit[];
  branch: string;
  /** Non-null when git could not be queried (treated as 'not diverged', never an alert). */
  error: string | null;
  checkedAt: string;
}

/** Returns the commits on local `branch` that are NOT on origin/`branch`, or null if git is unavailable. */
export type DivergenceProbe = (branch: string) => DivergenceCommit[] | null;

/** Pure classification of a probe result into a status (no side-effects, no clock except the stamp). */
export function classifyDivergence(probe: DivergenceProbe, branch: string, nowIso: string): DivergenceStatus {
  let commits: DivergenceCommit[] | null;
  try {
    commits = probe(branch);
  } catch {
    commits = null;
  }
  if (commits === null) {
    return { diverged: false, aheadCount: 0, commits: [], branch, error: 'git-unavailable', checkedAt: nowIso };
  }
  return { diverged: commits.length > 0, aheadCount: commits.length, commits, branch, error: null, checkedAt: nowIso };
}

/**
 * Real-git probe over a checkout: best-effort `git fetch` to refresh origin/<branch>,
 * then list local commits not on origin. Defensive — any git failure (non-repo, no
 * remote, offline) returns null so the monitor stays silent rather than false-alarming.
 */
export function createGitDivergenceProbe(repoRoot: string): DivergenceProbe {
  const git = (args: string[]): string | null => {
    try {
      return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();
    } catch {
      return null;
    }
  };
  return (branch) => {
    git(['fetch', 'origin', branch]); // best-effort; ignore failure (use last-known origin ref)
    const out = git(['log', '--no-decorate', `--format=%H%x00%an%x00%s`, `origin/${branch}..${branch}`]);
    if (out === null) return null; // git/ref unavailable → unknown, not an alert
    if (out === '') return [];
    return out.split('\n').map((line) => {
      const [sha = '', author = '', subject = ''] = line.split("\x00");
      return { sha: sha.slice(0, 12), author, subject };
    });
  };
}

export interface DivergenceMonitorDeps {
  probe: DivergenceProbe;
  branch?: string;
  now?: () => Date;
  /** Durable operator alert (#80/#86 pattern) — fired ONCE per divergence episode. */
  notifyOperator: (text: string) => void;
  /** Structured signal for the dashboard/integrations — fired once per episode. */
  emitEvent?: (status: DivergenceStatus) => void;
}

/**
 * Periodic driver. Each tick re-classifies; on the transition clean→diverged it fires
 * the durable alert + event ONCE (not every tick), and re-arms when the divergence
 * clears (the operator pushed/merged it). `status()` feeds the dashboard.
 */
export class DivergenceMonitor {
  private last: DivergenceStatus | undefined;
  private alerted = false;
  private readonly branch: string;
  private readonly now: () => Date;

  constructor(private readonly deps: DivergenceMonitorDeps) {
    this.branch = deps.branch ?? 'main';
    this.now = deps.now ?? ((): Date => new Date());
  }

  status(): DivergenceStatus | undefined {
    return this.last;
  }

  tick(): DivergenceStatus {
    const status = classifyDivergence(this.deps.probe, this.branch, this.now().toISOString());
    this.last = status;
    if (status.diverged) {
      if (!this.alerted) {
        this.alerted = true;
        const list = status.commits.map((c) => `  ${c.sha}  ${c.author}  ${c.subject}`).join('\n');
        this.deps.notifyOperator(
          `⚠ The deploy checkout's local '${status.branch}' has ${status.aheadCount} commit(s) NOT on origin/${status.branch} (divergence). Deploys build from origin, so nothing un-reviewed ships — but a fast-forward deploy will fail until these are pushed through the PR flow or dropped:\n${list}`,
        );
        try {
          this.deps.emitEvent?.(status);
        } catch {
          /* event sink failures must never break the monitor */
        }
      }
    } else if (status.error === null) {
      // re-arm ONLY on a CONFIRMED clean (#88/PROBE): a transient git-unavailable blip
      // is NOT a clean state, so it must not re-arm — otherwise a diverged → git-flap →
      // diverged sequence would double-alert. Hold the alerted state until truly clean.
      this.alerted = false;
    }
    return status;
  }
}
