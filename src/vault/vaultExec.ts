// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * vault-exec — the launch wrapper (PROMPT-16 §6 / FIX-16, "wrap the launch
 * command so the running tool resolves the real value at runtime").
 *
 * Claude Code spawns each MCP server reading its config from disk. After sync,
 * that config holds `env: { KEY: "vault:<id>" }` (no plaintext) and the server's
 * command is rewritten to `vault-exec <real-command> <args...>`. At spawn time
 * this wrapper:
 *   1. resolves every `vault:<id>` value in ITS OWN inherited env to plaintext,
 *      reading the encrypted vault DB read-only with the file master key;
 *   2. execs the real command (argv array — NEVER a shell) with the resolved env
 *      and inherited stdio, so the MCP JSON-RPC stream passes straight through.
 *
 * The plaintext exists only in the spawned child's process env — never on disk,
 * never in argv, never logged. A missing secret / unreadable key fails the spawn
 * loudly, naming the env var (never any value), instead of starting the server
 * with a literal `vault:<id>` string.
 */

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openDatabase } from '../db/database.js';
import { resolvePaths, resolveStateDir } from '../config/load.js';
import { FileMasterKeyBackend } from './masterKey.js';
import { VaultStore } from './store.js';
import { resolveLaunchEnv } from './launchEnv.js';

/**
 * Resolve the wrapper's env (in-memory) and exec the wrapped command. Returns the
 * child's exit code; throws (caller maps to a non-zero exit) on a resolution
 * failure so the MCP server never starts with an unresolved ref.
 */
export function runVaultExec(argv: string[], env: NodeJS.ProcessEnv = process.env): number {
  const [command, ...args] = argv;
  if (command === undefined || command === '') {
    throw new Error('vault-exec: no command to run');
  }

  // Open the vault read-only (WAL allows concurrent readers alongside the live
  // orchestrator). The master key file is co-located in the state dir.
  const paths = resolvePaths(resolveStateDir(env));
  const db = openDatabase(paths.dbFile);
  let resolved: Record<string, string>;
  try {
    const vault = new VaultStore(db, new FileMasterKeyBackend(paths.masterKeyFile));
    // resolveLaunchEnv turns every `vault:<id>` value into plaintext, passes
    // literals through, and throws (naming id + env var, never a value) on a miss.
    resolved = resolveLaunchEnv(env as Record<string, string | undefined>, vault);
  } finally {
    db.close();
  }

  const child = spawnSync(command, args, { stdio: 'inherit', env: resolved });
  if (child.error) throw child.error;
  if (typeof child.status === 'number') return child.status;
  // killed by a signal — surface a conventional 128+signal code
  return 1;
}

/** CLI entry: `node dist/vault/vaultExec.js <command> [args...]`. */
export function main(argv: string[] = process.argv.slice(2)): never {
  try {
    process.exit(runVaultExec(argv));
  } catch (err) {
    // message names the env var / id but never a secret value (resolveLaunchEnv guarantees this)
    process.stderr.write(`vault-exec: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(127);
  }
}

// Entry point: `node dist/vault/vaultExec.js <command> [args...]`
const isMain = (() => {
  if (process.argv[1] === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
  } catch {
    return false;
  }
})();
if (isMain) main();
