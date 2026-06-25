// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExclusive } from '../core/fsx.js';
import { createLogger } from '../core/log.js';

const log = createLogger('lock');

/**
 * Single-supervisor lock (SPEC §1, §19, §20.9): a pidfile with liveness check.
 * Three independent singleton resources guard a supervisor (#187/#190); it starts
 * only if it holds ALL of them, any collision → the second supervisor refuses:
 *   (a) the STATE-DIR lock (this file at paths.lockFile) — protects one install's db/vault;
 *   (b) the TMUX-SOCKET lock (socketLockPath, host-global keyed by uid+socket) — protects
 *       the SHARED tmux server, the actual 2026-06-18 churn vector for co-located installs;
 *   (c) the HTTP PORT bind (server.listen) — the third, OS-enforced singleton.
 * We never kill an unrelated process — a live holder means WE refuse to start.
 */

interface LockContent {
  pid: number;
  startedAt: string;
  /**
   * A start-token identifying the exact process INCARNATION (boot_id + kernel start-time),
   * so a RECYCLED pid (the old supervisor died, the OS reassigned its pid to an unrelated
   * live process) is detected as stale instead of a false-positive "still running". Absent
   * on a legacy lock or a non-Linux host → we fall back to pid-only liveness.
   */
  startToken?: string;
}

let cachedBootId: string | undefined;
function bootId(): string {
  if (cachedBootId !== undefined) return cachedBootId;
  try { cachedBootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch { cachedBootId = ''; }
  return cachedBootId;
}

/**
 * A stable identity for a process incarnation: the host boot_id + the kernel start-time
 * (field 22 of /proc/<pid>/stat, in jiffies since boot). Two processes that reuse one pid
 * across a death (or a reboot — boot_id changes) get DIFFERENT tokens. Returns undefined
 * when /proc is unreadable (non-Linux / dead pid) so callers fall back to pid-only liveness.
 * /proc/<pid>/stat is world-readable, so this works even for an EPERM-unsignalable holder.
 */
export function processStartToken(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // comm (field 2) is parenthesized and may contain spaces/parens — split AFTER the last
    // ')' so field offsets are stable; field 22 (starttime) is index 19 of the remainder.
    const starttime = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    if (starttime === undefined || starttime === '') return undefined;
    const bid = bootId();
    return bid === '' ? starttime : `${bid}:${starttime}`;
  } catch {
    return undefined;
  }
}

/**
 * Host-global path for the tmux-socket singleton lock (b), keyed by uid + socket name. tmux
 * already scopes its socket under /tmp/tmux-<uid>/, so a same-uid co-located install on the
 * same socket name is the collision domain this guard closes.
 */
export function socketLockPath(socket: string): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'nouid';
  const safe = socket.replace(/[^a-zA-Z0-9._-]/g, '_');
  return join(tmpdir(), `citadel-sock-${uid}-${safe}.lock`);
}

/**
 * Is `pid` a live process? CRITICAL for the lock: a live holder must NEVER look dead, or
 * a rival supervisor clears the lock and starts a SECOND reconciler on the shared tmux
 * socket (the 2026-06-18 dual-main.js churn). process.kill(pid, 0) throws EPERM when the
 * process EXISTS but we may not signal it (e.g. a different uid / restricted context) —
 * that is STILL ALIVE and must hold the lock. Only ESRCH (no such process) is dead.
 */
export function isProcessAlive(pid: number, kill: (pid: number, sig: number) => void = process.kill): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false; // PID-recycling guard: never trust pid<=1
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'; // EPERM = alive-but-unsignalable
  }
}

export interface AcquireLockOptions {
  /** Liveness probe (injectable for tests); defaults to a real signal-0 with EPERM=alive. */
  isAlive?: (pid: number) => boolean;
  /** Start-token probe (injectable for tests); defaults to the real /proc reader. */
  startToken?: (pid: number) => string | undefined;
  /** Human label for the guarded resource, used in the refusal message. */
  resource?: string;
}

/**
 * Has the holder's pid been RECYCLED? True only when the lock carries a start-token AND the
 * pid currently maps to a DIFFERENT incarnation. Unknown (legacy lock / unreadable /proc) →
 * false, so we never falsely clear a genuinely-live holder on the strength of a missing token.
 */
function pidRecycled(holder: LockContent, startToken: (pid: number) => string | undefined): boolean {
  if (holder.startToken === undefined) return false;
  const current = startToken(holder.pid);
  return current !== undefined && current !== holder.startToken;
}

export function acquireSupervisorLock(lockFile: string, opts: AcquireLockOptions = {}): void {
  const isAlive = opts.isAlive ?? ((pid: number) => isProcessAlive(pid));
  const startToken = opts.startToken ?? processStartToken;
  const resource = opts.resource ?? 'state-dir';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const tok = startToken(process.pid);
      const content: LockContent = {
        pid: process.pid,
        startedAt: new Date().toISOString(),
        ...(tok !== undefined ? { startToken: tok } : {}),
      };
      createExclusive(lockFile, JSON.stringify(content), 0o600);
      return;
    } catch {
      // lock exists — examine the holder
      let holder: LockContent | undefined;
      try {
        holder = JSON.parse(readFileSync(lockFile, 'utf8')) as LockContent;
      } catch {
        holder = undefined;
      }
      if (holder && isAlive(holder.pid) && !pidRecycled(holder, startToken)) {
        throw new Error(
          `another supervisor is already running (pid ${holder.pid}, since ${holder.startedAt}) for this ` +
            `${resource}; exactly one supervising process may own the scheduler/reconcilers/tmux sessions. ` +
            'Use the systemd service (e.g. `systemctl status citadel`) instead of starting a second `npm start`.',
        );
      }
      log.warn('removing stale supervisor lock', {
        holderPid: holder?.pid ?? 'unparseable',
        recycled: holder !== undefined && pidRecycled(holder, startToken),
        resource,
      });
      try {
        unlinkSync(lockFile);
      } catch {
        /* lost a race with another starter; the retry's createExclusive decides */
      }
    }
  }
  throw new Error('could not acquire the supervisor lock after clearing a stale one');
}

export function releaseSupervisorLock(lockFile: string): void {
  try {
    if (!existsSync(lockFile)) return;
    const holder = JSON.parse(readFileSync(lockFile, 'utf8')) as LockContent;
    if (holder.pid === process.pid) unlinkSync(lockFile);
  } catch {
    /* releasing best-effort */
  }
}
