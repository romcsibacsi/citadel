// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { createLogger } from '../core/log.js';
import type { EmbeddingProvider } from './embedding.js';

/**
 * Local, config-driven embedding backend for memory vectorization (FIX-memory-
 * vectorization). Talks to the operator's OWN ollama (free, local) over its
 * embeddings API — never a paid/cloud provider, so it has no billing implication.
 *
 * The factory returns `undefined` when no usable HTTP endpoint is configured, so
 * the store stays honestly FTS-only (embeddingEnabled()=false) on a buyer with no
 * ollama. When configured, embed() FAILS SOFT (throws) so the store's fire-and-
 * forget save path and hybrid fallback both degrade gracefully — a missing model
 * or an unreachable host never breaks a save or a search.
 */

const log = createLogger('memory-embedding');

const DEFAULT_EMBED_MODEL = 'nomic-embed-text';
const DEFAULT_TIMEOUT_MS = 20_000;

function normBase(url: string): string {
  return url.trim().replace(/\/+$/, '');
}
function isHttp(url: string): boolean {
  return /^https?:\/\/[^\s]+$/i.test(url.trim());
}

class OllamaEmbeddingProvider implements EmbeddingProvider {
  constructor(
    private readonly base: string,
    private readonly model: string,
    private readonly fetchImpl: typeof fetch,
    private readonly timeoutMs: number,
  ) {}

  async embed(text: string): Promise<Float32Array> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.base}/api/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.model, prompt: text }),
        signal: ctl.signal,
      });
      if (!res.ok) throw new Error(`ollama /api/embeddings → HTTP ${res.status}`);
      const j = (await res.json()) as { embedding?: unknown };
      if (!Array.isArray(j.embedding) || j.embedding.length === 0) {
        throw new Error('ollama /api/embeddings returned no embedding');
      }
      return Float32Array.from(j.embedding as number[]);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Build an ollama EmbeddingProvider, or `undefined` when `url` is not a usable
 * HTTP endpoint (so the caller leaves the store FTS-only). `model` falls back to
 * a sensible default embedding model. Never throws here — only embed() can fail,
 * and only soft.
 */
export function makeOllamaEmbeddingProvider(
  url: string | undefined,
  model?: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): EmbeddingProvider | undefined {
  if (url === undefined || !isHttp(url)) return undefined;
  const base = normBase(url);
  const m = model && model.trim() !== '' ? model.trim() : DEFAULT_EMBED_MODEL;
  log.info('memory embedding provider configured', { base, model: m });
  return new OllamaEmbeddingProvider(base, m, fetchImpl, timeoutMs);
}
