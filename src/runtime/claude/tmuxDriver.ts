// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * Thin promisified tmux wrappers for the Claude Code adapter (SPEC §0, §3, §3a).
 *
 * - **Dedicated socket (SPEC §3a/§19a):** every command runs against an explicit
 *   `-L <socket>` server, so the orchestrator's agents live on their OWN tmux
 *   server — fully isolated from the operator's own tmux sessions and any other
 *   fleet on the default server. The system NEVER touches the default server.
 * - **Server ownership / persistence:** the dedicated tmux server is started by
 *   the first session command and daemonizes; it outlives the supervisor (it is
 *   not a child of the supervisor process). On restart the supervisor ADOPTS the
 *   existing sessions instead of recreating them.
 * - **Environment isolation:** `env -i` clears the inherited environment and the
 *   command runs with ONLY the explicit allowlist — inherited channel/bot tokens
 *   and ANTHROPIC_* never leak into an agent (SPEC §3a launch rules, §19a).
 * - No Node-level shell (execFile, not exec); the single string the tmux
 *   default-shell interprets is built exclusively from escapeShellArg'd pieces.
 * - All functions take an injectable exec so unit tests never need tmux.
 * - tmux targets use the '=' prefix for EXACT name matching — a plain name is
 *   prefix-matched and could hit the wrong agent.
 */

import { execFile } from 'node:child_process';

export interface ExecResult {
  stdout: string;
  stderr: string;
}

/** Run a binary with args; optional input is piped to stdin. Never a shell. */
export type ExecFn = (file: string, args: string[], input?: string) => Promise<ExecResult>;

/** Hard ceiling for any single tmux invocation (ms). tmux commands are normally
 *  instant; a multi-second hang means a wedged server/pane, so kill it and reject
 *  rather than let it block the status/capture/inject paths indefinitely. */
const TMUX_EXEC_TIMEOUT_MS = 10_000;

export const defaultExec: ExecFn = (file, args, input) =>
  new Promise<ExecResult>((resolve, reject) => {
    const child = execFile(file, args, { maxBuffer: 16 * 1024 * 1024, timeout: TMUX_EXEC_TIMEOUT_MS, killSignal: 'SIGKILL' }, (err, stdout, stderr) => {
      if (err) {
        const timedOut = (err as NodeJS.ErrnoException & { killed?: boolean }).killed === true;
        reject(new Error(`${file} ${args.join(' ')} ${timedOut ? `timed out after ${TMUX_EXEC_TIMEOUT_MS}ms` : 'failed'}: ${stderr.trim() || err.message}`));
      } else {
        resolve({ stdout, stderr });
      }
    });
    if (child.stdin) {
      if (input !== undefined) child.stdin.write(input);
      child.stdin.end();
    }
  });

/**
 * POSIX single-quote escaping: the only byte that needs handling inside single
 * quotes is the single quote itself ('\''). Everything else — $(cmd), backticks,
 * ;, newlines, double quotes, a leading dash — is inert.
 */
export function escapeShellArg(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface NewSessionOptions {
  name: string;
  cwd: string;
  /** Explicit allowlist env for the agent — the ONLY environment it receives (env -i). */
  env: Record<string, string>;
  command: string;
  args: string[];
}

export interface PaneInfo {
  session: string;
  /** pid of the process running in the pane (the agent's shell/REPL). */
  pid: number;
}

export interface TmuxDriver {
  /** Socket name this driver targets (for diagnostics / orphan attribution). */
  readonly socket: string;
  newSession(opts: NewSessionOptions): Promise<void>;
  hasSession(name: string): Promise<boolean>;
  killSession(name: string): Promise<void>;
  sendText(name: string, text: string): Promise<void>;
  sendKey(name: string, key: string): Promise<void>;
  /** Literal text, no key interpretation, no submit (raw keystroke forwarding). */
  sendLiteral(name: string, text: string): Promise<void>;
  capturePane(name: string, lastLines: number): Promise<string>;
  /** Append the live pane output to a file (pipe-pane -o). */
  pipeToFile(name: string, filePath: string): Promise<void>;
  /** Every live pane on the dedicated server + its pid (for orphan attribution, §19a). */
  listPanes(): Promise<PaneInfo[]>;
  /** Whether the dedicated tmux server is up at all. */
  serverRunning(): Promise<boolean>;
  /** Kill the WHOLE dedicated server — TEST/teardown ONLY, never a recovery path. */
  killServer(): Promise<void>;
}

/** Exact-match tmux SESSION target. */
function target(name: string): string {
  return `=${name}`;
}

/**
 * Exact-match PANE-level target (capture/paste/send-keys/pipe). tmux does not
 * resolve a bare '=name' to a pane; the trailing ':' selects the session's
 * active window/pane while keeping the exact session match (verified on 3.4).
 */
function paneTarget(name: string): string {
  return `=${name}:`;
}

let bufferSeq = 0;

/** Largest literal paste pushed in one buffer (keeps well under any TUI paste cap). */
const PASTE_CHUNK_BYTES = 1024;

export interface TmuxDriverOptions {
  exec?: ExecFn;
  tmuxBin?: string;
  /** Dedicated server socket name (SPEC §3a isolation). */
  socket: string;
}

export function createTmuxDriver(opts: TmuxDriverOptions): TmuxDriver {
  const exec = opts.exec ?? defaultExec;
  const tmuxBin = opts.tmuxBin ?? 'tmux';
  const socket = opts.socket;
  /** Prefix every invocation with the dedicated socket. */
  const run = (args: string[], input?: string): Promise<ExecResult> =>
    exec(tmuxBin, ['-L', socket, ...args], input);

  return {
    socket,

    async newSession({ name, cwd, env, command, args }) {
      // env -i: the agent inherits NOTHING; only the explicit allowlist below.
      // This guarantees no inherited channel/bot token or ANTHROPIC_* leaks in.
      const parts: string[] = ['exec', 'env', '-i'];
      for (const [key, value] of Object.entries(env)) parts.push(escapeShellArg(`${key}=${value}`));
      parts.push(escapeShellArg(command));
      for (const arg of args) parts.push(escapeShellArg(arg));
      try {
        await run(['new-session', '-d', '-s', name, '-c', cwd, parts.join(' ')]);
      } catch (err) {
        // Never let env VALUES (secrets) reach logs through the error message.
        let message = err instanceof Error ? err.message : String(err);
        for (const value of Object.values(env)) {
          if (value.length >= 8) message = message.split(value).join('<redacted>');
        }
        throw new Error(message);
      }
    },

    async hasSession(name) {
      try {
        await run(['has-session', '-t', target(name)]);
        return true;
      } catch {
        return false;
      }
    },

    async killSession(name) {
      try {
        await run(['kill-session', '-t', target(name)]);
      } catch {
        // tolerant: an already-absent session is the desired state
      }
    },

    async sendText(name, text) {
      // Deliver as literal chunks via named buffers (atomic, no keystroke
      // interpretation — a leading dash can never be read as a flag), then a
      // SEPARATE submit keystroke. Chunks stay under PASTE_CHUNK_BYTES so no
      // TUI paste cap is hit; the submit is sent once, after all chunks.
      const chunks = chunkUtf8(text, PASTE_CHUNK_BYTES);
      for (const chunk of chunks) {
        const buffer = `orch-${process.pid}-${++bufferSeq}`;
        await run(['load-buffer', '-b', buffer, '-'], chunk);
        await run(['paste-buffer', '-d', '-p', '-b', buffer, '-t', paneTarget(name)]);
      }
      await run(['send-keys', '-t', paneTarget(name), 'Enter']);
    },

    async sendKey(name, key) {
      await run(['send-keys', '-t', paneTarget(name), key]);
    },

    async sendLiteral(name, text) {
      // -l = literal: send the text verbatim, no key-name interpretation and no
      // submit (raw per-keystroke typing into the live input box).
      await run(['send-keys', '-l', '-t', paneTarget(name), text]);
    },

    async capturePane(name, lastLines) {
      const { stdout } = await run(['capture-pane', '-p', '-t', paneTarget(name), '-S', `-${lastLines}`]);
      return stdout;
    },

    async pipeToFile(name, filePath) {
      await run(['pipe-pane', '-t', paneTarget(name), '-o', `cat >> ${escapeShellArg(filePath)}`]);
    },

    async listPanes() {
      try {
        const { stdout } = await run(['list-panes', '-a', '-F', '#{pane_pid} #{session_name}']);
        const panes: PaneInfo[] = [];
        for (const line of stdout.split('\n')) {
          const trimmed = line.trim();
          if (trimmed === '') continue;
          const sp = trimmed.indexOf(' ');
          if (sp === -1) continue;
          const pid = Number(trimmed.slice(0, sp));
          const session = trimmed.slice(sp + 1);
          if (Number.isInteger(pid)) panes.push({ pid, session });
        }
        return panes;
      } catch {
        // Server not running -> no panes. (A genuine "can't determine" is the
        // server being up but the query failing; callers treat undefined-ability
        // as fail-safe-refuse — see the reaper.)
        return [];
      }
    },

    async serverRunning() {
      try {
        await run(['list-sessions']);
        return true;
      } catch {
        return false;
      }
    },

    async killServer() {
      try {
        await run(['kill-server']);
      } catch {
        // already down
      }
    },
  };
}

/** Split a string into chunks whose UTF-8 byte length is <= maxBytes, never mid-codepoint. */
export function chunkUtf8(text: string, maxBytes: number): string[] {
  if (text === '') return [''];
  const chunks: string[] = [];
  let current = '';
  let currentBytes = 0;
  for (const ch of text) {
    const chBytes = Buffer.byteLength(ch, 'utf8');
    if (currentBytes + chBytes > maxBytes && current !== '') {
      chunks.push(current);
      current = '';
      currentBytes = 0;
    }
    current += ch;
    currentBytes += chBytes;
  }
  if (current !== '') chunks.push(current);
  return chunks;
}
