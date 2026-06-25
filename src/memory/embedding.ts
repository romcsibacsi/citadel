// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * Pluggable embedding backend (SPEC §8). The DEFAULT is NONE: the memory store
 * works fully FTS-only, and hybrid/vector search degrades gracefully when no
 * provider is configured. Embedding work is always async fire-and-forget — a
 * save NEVER waits on or fails because of an embedding.
 */
export interface EmbeddingProvider {
  embed(text: string): Promise<Float32Array>;
}

/** Serialize a vector for the memories.embedding BLOB column (copying). */
export function embeddingToBlob(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength).slice();
}

/** Deserialize a memories.embedding BLOB back into a vector (copying). */
export function blobToEmbedding(blob: Uint8Array): Float32Array {
  if (blob.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
    throw new Error(`embedding blob length ${blob.byteLength} is not a multiple of ${Float32Array.BYTES_PER_ELEMENT}`);
  }
  const copy = blob.slice();
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / Float32Array.BYTES_PER_ELEMENT);
}

/**
 * Cosine similarity in [-1, 1]. Returns 0 for empty or length-mismatched vectors
 * (e.g. the embedding model changed mid-corpus) so hybrid search degrades to a
 * pure-FTS contribution for that row rather than throwing.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
