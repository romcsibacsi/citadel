// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { execFile } from 'node:child_process';
import { rm, symlink, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { sanitizeId } from '../trust/sanitize.js';

/**
 * Per-agent git worktree isolation (#44).
 *
 * Root cause this addresses: the whole fleet + the dev session share ONE git
 * working tree (the canonical checkout). Agents `cd` into it and run raw bash
 * git, so parallel checkout/commit/merge stomp each other's HEAD/index — the
 * 2026-06-16 incident where one agent's checkout moved another's uncommitted
 * work, and a self-merge slipped past the review gate.
 *
 * This generalizes the judge-panel worktree pattern (src/judge/gateRunner.ts):
 * each agent gets its OWN worktree at <worktreeRoot>/<id>/repo on its own
 * `agent/<id>` branch — a separate HEAD/index over the SHARED `.git` object
 * store. Agents create their feature branches there; the canonical checkout
 * keeps `main` and is never touched by agent work.
 *
 * Key difference from the panel pattern: provisioning is NON-DESTRUCTIVE. A
 * panel solver worktree is ephemeral and re-provisioned with `remove --force`
 * first; an agent worktree is long-lived and may hold uncommitted work, so we
 * NEVER blow it away on a routine (re)start — provision is idempotent and only
 * creates what is missing. Removal is explicit (agent teardown), not a stop.
 */

function exec(file: string, args: string[], opts: { cwd: string; timeoutMs?: number }): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { cwd: opts.cwd, timeout: opts.timeoutMs ?? 60_000, maxBuffer: 32 * 1024 * 1024, killSignal: 'SIGKILL' },
      (err, stdout, stderr) => {
        const out = `${stdout ?? ''}\n${stderr ?? ''}`.trim();
        const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
        resolve({ code, out });
      },
    );
  });
}

/** Absolute worktree path for an agent (pure). The single source of truth, reused by specFactory. */
export function agentWorktreePath(worktreeRoot: string, agentId: string): string {
  return join(worktreeRoot, sanitizeId(agentId), 'repo');
}

/** The agent's dedicated branch name (pure). */
export function agentWorktreeBranch(agentId: string): string {
  return `agent/${sanitizeId(agentId)}`;
}

export interface AgentWorktreeOptions {
  /** The canonical checkout that owns the shared `.git` object store (the fleet's repo). */
  repoRoot: string;
  /** Base dir under which each agent's worktree lives (typically paths.agentsDir). */
  worktreeRoot: string;
  /** Branch each agent worktree is forked from; default `main`. */
  baseBranch?: string;
}

export interface ProvisionResult {
  ok: boolean;
  /** Absolute path to the agent's worktree (whether or not provisioning succeeded). */
  path: string;
  /** The agent's dedicated branch. */
  branch: string;
  /** true if a worktree was newly created; false if it already existed (idempotent no-op). */
  created: boolean;
  evidence: string;
}

export interface AgentWorktreeManager {
  /** Absolute worktree path for an agent (pure; does not touch disk). */
  pathFor(agentId: string): string;
  /** The agent's dedicated branch name (pure). */
  branchFor(agentId: string): string;
  /** Idempotently ensure the agent's isolated worktree exists. Never destroys existing work. */
  provision(agentId: string): Promise<ProvisionResult>;
  /** Whether a valid worktree is already registered for the agent. */
  isProvisioned(agentId: string): Promise<boolean>;
  /** Explicit teardown (agent removal) — NOT a routine stop. Removes the worktree dir. */
  remove(agentId: string): Promise<void>;
}

export function createAgentWorktreeManager(opts: AgentWorktreeOptions): AgentWorktreeManager {
  const repoRoot = opts.repoRoot;
  const base = opts.baseBranch ?? 'main';
  const worktreeRoot = opts.worktreeRoot;

  function pathFor(agentId: string): string {
    return agentWorktreePath(worktreeRoot, agentId);
  }
  function branchFor(agentId: string): string {
    return agentWorktreeBranch(agentId);
  }

  /**
   * Serialize all mutating git operations. At fleet boot ~14 agents start at once
   * and would each run `git worktree add/prune` against the SAME canonical repo —
   * git takes a repo-level lock, so concurrent adds can fail transiently. A single
   * in-process promise chain makes provisioning deterministic and lock-contention-free.
   * (Reads like pathFor/branchFor are pure and not serialized.)
   */
  let opQueue: Promise<unknown> = Promise.resolve();
  function serialize<T>(op: () => Promise<T>): Promise<T> {
    const run = opQueue.then(op, op);
    opQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Share the canonical checkout's installed node_modules (deps are gitignored,
   * not committed) so tsc/tsx/npm resolve in the fresh worktree without a slow
   * `npm ci`. The symlink lives inside the worktree, so removal reclaims it; the
   * shared target is never touched. (Mirrors gateRunner.linkNodeModules.)
   */
  async function linkNodeModules(wt: string): Promise<void> {
    const src = join(repoRoot, 'node_modules');
    const dest = join(wt, 'node_modules');
    if (!existsSync(src) || existsSync(dest)) return;
    await symlink(src, dest, 'dir').catch(() => undefined);
  }

  /** Canonicalize a path (resolve symlinks); fall back to the raw path if it doesn't exist yet. */
  async function canon(p: string): Promise<string> {
    return realpath(p).catch(() => p);
  }

  /**
   * Is `path` a git-registered worktree?
   *  - 'yes'     — git lists it (matched after realpath-canonicalizing BOTH sides,
   *                so a symlinked worktreeRoot — git emits realpaths, pathFor() is raw —
   *                is NOT a false negative; this was a data-loss bug, #44/PROBE).
   *  - 'no'      — git could be queried and the path is genuinely absent.
   *  - 'unknown' — `git worktree list` failed (e.g. a transient external git lock).
   *                The caller MUST treat this as "do not reclaim/delete": an unknown
   *                state must never trigger a destructive rm.
   */
  async function registeredStatus(path: string): Promise<'yes' | 'no' | 'unknown'> {
    const list = await exec('git', ['worktree', 'list', '--porcelain'], { cwd: repoRoot, timeoutMs: 30_000 });
    if (list.code !== 0) return 'unknown';
    const target = await canon(path);
    for (const line of list.out.split('\n')) {
      if (!line.startsWith('worktree ')) continue;
      const listed = line.slice('worktree '.length);
      if (listed === path || (await canon(listed)) === target) return 'yes';
    }
    return 'no';
  }

  /**
   * May we safely reclaim (rm) a path that git does NOT list as a worktree?
   * FAIL-SAFE: a non-worktree orphan dir is fine to clear, but if the path still
   * holds worktree git-state we only clear it when its tree is provably clean —
   * any uncommitted change, or an unreadable status, means REFUSE (never risk
   * deleting live agent work).
   */
  async function safeToReclaim(path: string): Promise<{ safe: boolean; reason: string }> {
    if (!existsSync(join(path, '.git'))) return { safe: true, reason: 'orphan dir, no git worktree state' };
    const status = await exec('git', ['-C', path, 'status', '--porcelain'], { cwd: repoRoot, timeoutMs: 30_000 });
    if (status.code !== 0) return { safe: false, reason: 'path holds git state but its status is unreadable' };
    if (status.out.trim() !== '') return { safe: false, reason: 'path holds a worktree with uncommitted changes' };
    return { safe: true, reason: 'worktree tree is clean' };
  }

  return {
    pathFor,
    branchFor,

    async isProvisioned(agentId) {
      const path = pathFor(agentId);
      return existsSync(path) && (await registeredStatus(path)) === 'yes';
    },

    provision(agentId) {
      return serialize(async () => {
        const path = pathFor(agentId);
        const branch = branchFor(agentId);
        const status = await registeredStatus(path);
        // NON-DESTRUCTIVE: a valid (realpath-matched) worktree is left untouched,
        // together with any uncommitted work in it — only ensure deps are linked.
        if (status === 'yes') {
          await linkNodeModules(path);
          return { ok: true, path, branch, created: false, evidence: `worktree already provisioned at ${path}` };
        }
        // FAIL-SAFE on uncertainty: if git couldn't be queried, NEVER reclaim the
        // path. A transient `git worktree list` failure (external lock) would
        // otherwise look like "not registered" and rm live work (#44/PROBE).
        if (status === 'unknown') {
          return { ok: false, path, branch, created: false, evidence: `refusing to provision ${path}: 'git worktree list' failed — worktree state unknown, not reclaiming` };
        }
        // status === 'no': the path is not a registered worktree. Before reclaiming
        // it, refuse if it still holds a worktree with uncommitted changes (or its
        // state is unreadable) — never risk deleting live agent work.
        if (existsSync(path)) {
          const guard = await safeToReclaim(path);
          if (!guard.safe) {
            return { ok: false, path, branch, created: false, evidence: `refusing to reclaim ${path}: ${guard.reason}` };
          }
          await exec('git', ['worktree', 'prune'], { cwd: repoRoot, timeoutMs: 30_000 });
          await rm(path, { recursive: true, force: true }).catch(() => undefined);
        } else {
          // clear any stale bookkeeping for a path git pruned but still half-tracks
          await exec('git', ['worktree', 'prune'], { cwd: repoRoot, timeoutMs: 30_000 });
        }
        // Each agent gets its OWN branch so two worktrees never contend for one ref
        // (git forbids the same branch checked out in two worktrees). Reuse the
        // agent branch if it already exists, else fork it from base.
        const exists = await exec('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repoRoot, timeoutMs: 30_000 });
        const add =
          exists.code === 0
            ? await exec('git', ['worktree', 'add', path, branch], { cwd: repoRoot, timeoutMs: 60_000 })
            : await exec('git', ['worktree', 'add', '-b', branch, path, base], { cwd: repoRoot, timeoutMs: 60_000 });
        if (add.code === 0) await linkNodeModules(path);
        return {
          ok: add.code === 0,
          path,
          branch,
          created: add.code === 0,
          evidence: `worktree add ${branch} @ ${path}: exit ${add.code}\n${add.out}`.slice(0, 2000),
        };
      });
    },

    remove(agentId) {
      return serialize(async () => {
        const path = pathFor(agentId);
        await exec('git', ['worktree', 'remove', '--force', path], { cwd: repoRoot, timeoutMs: 60_000 });
        await rm(path, { recursive: true, force: true }).catch(() => undefined);
      });
    },
  };
}
