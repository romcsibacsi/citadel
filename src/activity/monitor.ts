// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import type { OutputEvent } from '../runtime/types.js';

/**
 * Activity monitor (PROMPT-21): a small per-agent ring buffer of recent terminal
 * output, fed by the supervisor's fan-out output stream. The Activity board's
 * per-card tail (~last 8 non-empty lines) reads from here; state is derived from
 * the supervisor's live busy-state. Pure read — nothing is persisted.
 */

interface OutputSource {
  streamOutput(agentId: string, cb: (e: OutputEvent) => void): () => void;
}

const MAX_LINES = 200;

export class ActivityMonitor {
  private readonly buffers = new Map<string, string[]>();
  private readonly subs = new Map<string, () => void>();

  constructor(private readonly source: OutputSource) {}

  /** Idempotently attach to an agent's output stream (called lazily per poll). */
  watch(agentId: string): void {
    if (this.subs.has(agentId)) return;
    const unsub = this.source.streamOutput(agentId, (e) => {
      if ((e.kind === 'output' || e.kind === 'screen') && typeof e.text === 'string') this.push(agentId, e.text, e.kind === 'screen');
    });
    this.subs.set(agentId, unsub);
  }

  private push(agentId: string, text: string, replace: boolean): void {
    const lines = text.split(/\r?\n/);
    if (replace) { this.buffers.set(agentId, lines.slice(-MAX_LINES)); return; }
    const buf = this.buffers.get(agentId) ?? [];
    buf.push(...lines);
    while (buf.length > MAX_LINES) buf.shift();
    this.buffers.set(agentId, buf);
  }

  /** The last `n` non-empty, right-trimmed lines for the card preview. */
  tail(agentId: string, n = 8): string[] {
    const buf = this.buffers.get(agentId) ?? [];
    return buf.map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim() !== '').slice(-n);
  }

  stopAll(): void {
    for (const unsub of this.subs.values()) { try { unsub(); } catch { /* ignore */ } }
    this.subs.clear();
  }
}
