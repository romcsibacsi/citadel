// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { basename, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { DEFAULT_SERVER_PORT } from '../config/defaults.js';

/**
 * Per-instance isolation identity (#190). The 2026-06-18 churn: two co-located CITADEL
 * installs on the SAME host but DIFFERENT state-dirs (~/.orchestrator and
 * ~/.orchestrator-kkv-duna) shared the GLOBAL tmux socket (default name) and would have
 * shared the HTTP port (default 7080) — the per-state-dir supervisor lock could not catch
 * them because the lock is state-dir-scoped while the socket/port are host-global.
 *
 * The fix makes isolation the DEFAULT, not a manual step: each install derives a stable
 * instance id from its state-dir and uses it for the tmux socket, the session prefix, and
 * a port offset, so "1 instance = 1 (state-dir, socket, port)" without operator config.
 *
 * BACKWARD-COMPAT: the primary install at the default state-dir (~/.orchestrator) maps to
 * the empty id, so its socket/prefix/port are UNCHANGED — a running fleet is never
 * disrupted (its existing tmux sessions stay re-adoptable). Only sibling/per-tenant
 * installs (a non-default state-dir) get a distinct suffix/offset.
 */

/** Derive a stable instance id from the state-dir. '' for the default install. */
export function deriveInstanceId(stateDir: string): string {
  const base = basename(resolve(stateDir).replace(/[/\\]+$/, ''));
  if (base === '.orchestrator' || base === 'orchestrator') return ''; // primary install: legacy names
  // A readable suffix from `.orchestrator-<name>`; fall back to a short hash for any other path.
  const suffix = base.replace(/^\.?orchestrator-?/i, '').replace(/[^a-zA-Z0-9-]/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
  return suffix !== '' ? suffix : createHash('sha256').update(resolve(stateDir)).digest('hex').slice(0, 8);
}

/** Per-instance tmux socket / session prefix: the base, suffixed by a non-empty instance id. */
export function instanceName(base: string, instanceId: string): string {
  return instanceId === '' ? base : `${base}-${instanceId}`;
}

/**
 * Per-instance HTTP port. Precedence (highest first):
 *   1. an explicit PORT env (provisioning sets it) — always wins;
 *   2. the primary install (empty id) — the configured port, unchanged;
 *   3. an operator-chosen port (configured port ≠ the default) — honored verbatim, since
 *      the operator deliberately picked it (a co-located deployment sets distinct ports);
 *   4. otherwise (a sibling still on the DEFAULT port) — default + a deterministic offset,
 *      so two co-located default installs never both land on 7080.
 * The offset is best-effort (a different id could collide mod the window) — provisioning
 * should still set distinct ports for a production co-location; this only fixes the DEFAULT.
 */
export function instancePort(
  configuredPort: number,
  instanceId: string,
  portEnv?: string,
  defaultPort: number = DEFAULT_SERVER_PORT,
): number {
  if (portEnv !== undefined && portEnv.trim() !== '') {
    const n = Number(portEnv);
    if (Number.isInteger(n) && n > 0 && n < 65536) return n;
  }
  if (instanceId === '') return configuredPort;
  if (configuredPort !== defaultPort) return configuredPort; // operator picked it deliberately
  const offset = (parseInt(createHash('sha256').update(instanceId).digest('hex').slice(0, 6), 16) % 1000) + 1;
  return defaultPort + offset;
}
