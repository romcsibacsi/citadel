// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { readFileSync } from 'node:fs';

/**
 * Linux /proc helpers for orphan attribution + frozen-tool CPU sampling
 * (SPEC §19a). Best-effort: on a non-Linux host or for a vanished pid they
 * return undefined, which the reaper treats as fail-safe (refuse) and the
 * frozen-tool watcher treats as "cannot confirm frozen" (no action).
 */

/** Parse /proc/<pid>/stat robustly (comm can contain spaces/parens). */
function statFields(pid: number): string[] | undefined {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = raw.lastIndexOf(')');
    if (close === -1) return undefined;
    const afterComm = raw.slice(close + 2).trim().split(/\s+/);
    // field index in the standard layout: [0]=pid [1]=comm; we return
    // pseudo-fields starting at state so caller indexes match `man proc` - 2.
    return afterComm;
  } catch {
    return undefined;
  }
}

/** Parent pid of `pid`, or undefined if unknown. */
export function parentPid(pid: number): number | undefined {
  const f = statFields(pid);
  // After "comm)" the next field is state, then ppid. So ppid is index 1.
  if (f === undefined || f.length < 2) return undefined;
  const ppid = Number(f[1]);
  return Number.isInteger(ppid) ? ppid : undefined;
}

/** Cumulative CPU jiffies (utime+stime) of `pid`, or undefined. */
export function cpuJiffies(pid: number): number | undefined {
  const f = statFields(pid);
  // utime is field 14 (1-based) -> after comm+state that is index 11; stime 12.
  if (f === undefined || f.length < 13) return undefined;
  const utime = Number(f[11]);
  const stime = Number(f[12]);
  if (!Number.isInteger(utime) || !Number.isInteger(stime)) return undefined;
  return utime + stime;
}

/** True when /proc is available (Linux). */
export function procAvailable(): boolean {
  return parentPid(process.pid) !== undefined;
}
