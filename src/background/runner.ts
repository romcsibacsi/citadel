// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TmuxDriver } from '../runtime/claude/tmuxDriver.js';
import type { AgentLaunchSpec } from '../runtime/types.js';

/**
 * Background runner abstraction (PROMPT-12 §6.3): launches a DETACHED, HEADLESS
 * one-shot agent run, captures its console output, and lets the service poll for
 * completion + exit code, snapshot live output, and kill it. The task id IS the
 * handle (the runner derives its session name + logfile from it).
 *
 *  - TmuxBackgroundRunner drives the real fleet: a detached tmux session runs
 *    `claude -p` in print mode and echoes an exit-code marker; output is tailed
 *    to a logfile via pipe-pane. The prompt is passed via an env var (never
 *    interpolated into the shell command) so there is no shell-injection.
 *  - FakeBackgroundRunner is the deterministic test/dev double.
 */

export interface RunSnapshot {
  alive: boolean;
  /** Captured output so far, completion marker stripped. */
  output: string;
  /** Exit code once known; null while running or when the run vanished. */
  exitCode: number | null;
}

export interface BackgroundRunner {
  launch(input: { taskId: string; agentId: string; prompt: string }): Promise<void>;
  poll(taskId: string): Promise<RunSnapshot>;
  /** Live output snapshot for a running task (falls back to captured log). */
  snapshot(taskId: string): Promise<string>;
  /** Kill the run if still alive; returns whatever output was captured. */
  kill(taskId: string): Promise<string>;
}

const EXIT_MARKER = '__BGTASK_EXIT__';
const MARKER_RE = new RegExp(`${EXIT_MARKER}:(\\d+)`);

function stripMarker(raw: string): string {
  return raw.replace(new RegExp(`\\n?${EXIT_MARKER}:\\d+\\s*$`), '').replace(new RegExp(`${EXIT_MARKER}:\\d+`), '');
}

/** Real runner: one detached tmux session per task, print-mode claude. */
export class TmuxBackgroundRunner implements BackgroundRunner {
  constructor(
    private readonly driver: TmuxDriver,
    private readonly specFor: (agentId: string) => AgentLaunchSpec,
    private readonly logDir: string,
    private readonly sessionPrefix: string,
  ) {}

  private session(taskId: string): string {
    return `${this.sessionPrefix}-bg-${taskId}`;
  }
  private logfile(taskId: string): string {
    return join(this.logDir, `bg-${taskId}.log`);
  }

  async launch(input: { taskId: string; agentId: string; prompt: string }): Promise<void> {
    const spec = this.specFor(input.agentId);
    // carry print-mode + the agent's model/permission flags; drop resume flags
    const passthrough: string[] = [];
    const modelIdx = spec.args.indexOf('--model');
    if (modelIdx >= 0 && spec.args[modelIdx + 1]) passthrough.push('--model', spec.args[modelIdx + 1]!);
    if (spec.args.includes('--dangerously-skip-permissions')) passthrough.push('--dangerously-skip-permissions');
    // command pieces are config-controlled (trusted); the PROMPT travels in an
    // env var and is expanded by the shell, never interpolated into the command.
    const invoke = [spec.command, '-p', ...passthrough].join(' ');
    const script = `${invoke} "$BG_PROMPT"; echo "${EXIT_MARKER}:$?"`;
    const name = this.session(input.taskId);
    await this.driver.newSession({
      name,
      cwd: spec.cwd,
      env: { ...spec.env, BG_PROMPT: input.prompt },
      command: 'sh',
      args: ['-c', script],
    });
    await this.driver.pipeToFile(name, this.logfile(input.taskId));
  }

  private readLog(taskId: string): string {
    try {
      return readFileSync(this.logfile(taskId), 'utf8');
    } catch {
      return '';
    }
  }

  async poll(taskId: string): Promise<RunSnapshot> {
    const alive = await this.driver.hasSession(this.session(taskId));
    const raw = this.readLog(taskId);
    const m = MARKER_RE.exec(raw);
    if (m) return { alive: false, output: stripMarker(raw), exitCode: Number(m[1]) };
    if (alive) return { alive: true, output: raw, exitCode: null };
    return { alive: false, output: raw, exitCode: null };
  }

  async snapshot(taskId: string): Promise<string> {
    const name = this.session(taskId);
    if (await this.driver.hasSession(name)) {
      try {
        return await this.driver.capturePane(name, 400);
      } catch {
        /* fall through to the log */
      }
    }
    return stripMarker(this.readLog(taskId));
  }

  async kill(taskId: string): Promise<string> {
    const out = stripMarker(this.readLog(taskId));
    try {
      await this.driver.killSession(this.session(taskId));
    } catch {
      /* already gone */
    }
    return out;
  }
}

interface FakeEntry {
  agentId: string;
  prompt: string;
  output: string;
  exitCode: number | null;
  done: boolean;
  killed: boolean;
}

/**
 * Deterministic double. A prompt containing `[[done]]` finishes 0 on the next
 * poll, `[[fail]]` finishes non-zero; anything else stays running until killed
 * or the service's timeout guard fires. A fresh instance (a "restart") forgets
 * all handles, so the orphan sweep sees previously-running tasks as gone.
 */
export class FakeBackgroundRunner implements BackgroundRunner {
  private readonly entries = new Map<string, FakeEntry>();

  async launch(input: { taskId: string; agentId: string; prompt: string }): Promise<void> {
    this.entries.set(input.taskId, {
      agentId: input.agentId,
      prompt: input.prompt,
      output: `[bg:${input.agentId}] $ ${input.prompt}\n`,
      exitCode: null,
      done: false,
      killed: false,
    });
  }

  async poll(taskId: string): Promise<RunSnapshot> {
    const e = this.entries.get(taskId);
    if (e === undefined) return { alive: false, output: '', exitCode: null };
    if (e.done || e.killed) return { alive: false, output: e.output, exitCode: e.exitCode };
    if (e.prompt.includes('[[fail]]')) {
      e.done = true; e.exitCode = 1; e.output += 'task failed\n';
      return { alive: false, output: e.output, exitCode: 1 };
    }
    if (e.prompt.includes('[[done]]')) {
      e.done = true; e.exitCode = 0; e.output += 'task complete\n';
      return { alive: false, output: e.output, exitCode: 0 };
    }
    return { alive: true, output: e.output, exitCode: null };
  }

  async snapshot(taskId: string): Promise<string> {
    const e = this.entries.get(taskId);
    return e === undefined ? '' : `${e.output}[live snapshot]\n`;
  }

  async kill(taskId: string): Promise<string> {
    const e = this.entries.get(taskId);
    if (e === undefined) return '';
    e.killed = true; e.exitCode = e.exitCode ?? 130;
    return e.output;
  }
}
