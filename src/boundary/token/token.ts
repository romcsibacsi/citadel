// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
// #312 M1 — the REAL keyed tokenizer (replaces the #288 STUB). A keyed HMAC-SHA256 over (class, domainTag,
// value) with a vault-master-key-derived K_mask: the token is one-way + UNFORGEABLE without the key, and
// carries per-class + per-domain separation (the same value under a different class or field yields an
// unrelated token; equality within a (class, domain) is preserved for join/dedup). The class-prefix
// (UNI/HMC/FPE/OPQ) is metadata, not secret. 'uniform' carries NEITHER country NOR original length/format
// (XC-2b) — the foreign-bit is unobservable (fixed-length output).
//
// FF3-1 format-preservation is DEFERRED (documented option): under clean-minimum the only fpe field
// (example_table.invoice_number) is never cloud-routed, so a preserved sorszám FORMAT has no consumer, and a
// keyed equality-token suffices. Rolling FF3-1 by hand is a security risk (NIST-vector tests + crypto-review)
// we avoid until a real format-consumer needs it.
//
// The tokenizer is an INJECTED dependency (Tokenizer) so the pure engine stays testable: production wires a
// KeyedTokenizer (vault K_mask); the cut/acceptance tests use the keyless stub (they prove STRUCTURE +
// class-routing, not crypto strength). The deep crypto only changes the token's inner bytes.

import { createHash, createHmac, hkdfSync } from 'node:crypto';
import type { TokenClass } from '../policy/types.js';

/** Branded token type — only produced by a Tokenizer; never a raw plaintext string by construction. */
export type Token = string & { readonly __token: unique symbol };

/** Maps a leaf value to its class token. Injected (keyed in production, stub in tests). */
export interface Tokenizer {
  tokenize(value: string, cls: TokenClass, domainTag: string): Token;
}

function prefixFor(cls: TokenClass): string {
  switch (cls) {
    case 'uniform': return 'UNI';
    case 'fpe': return 'FPE';
    case 'hmac':
    case 'clear-eligible': return 'HMC';
    case 'opaque':
    case 'vocab-clear': return 'OPQ';
  }
}

/**
 * Derive the masking subkey K_mask from the 32-byte vault master key via HKDF-SHA256 with a domain label.
 * HKDF (not scrypt) because the master key is already high-entropy: we want fast key-EXPANSION, not
 * password-stretching. The distinct `info` label domain-separates K_mask from every other vault-derived key,
 * so the masking key is independent of secret-encryption keys even though both descend from master.key.
 *
 * #344 PER-BATCH ROTATION (cross-batch unlinkability): an optional `epoch` is mixed into the HKDF `info` label,
 * so a different export batch derives a DIFFERENT K_mask -> the SAME value tokenizes DIFFERENTLY across epochs
 * and the cloud cannot link a record longitudinally across batches (no per-entity time-series re-id). Within one
 * epoch the key is stable, so intra-batch join/dedup still works. A cross-batch legitimate join would need a
 * vault-resident stable-id map (an explicit whitelist), NOT a stable token -- absent such a whitelist, every
 * dimension is per-epoch by default (IRON LAW: determinism only for an explicit join). Omitting `epoch`
 * reproduces the original single-key behavior (pre-rotation contexts and the structure tests).
 */
export function deriveMaskKey(masterKey: Buffer, epoch?: string): Buffer {
  const info = epoch !== undefined && epoch !== '' ? `citadel-mask-v1:${epoch}` : 'citadel-mask-v1';
  return Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), info, 32));
}

const SEP = '\x1f'; // unit-separator: unambiguous field boundary in the HMAC message

/**
 * Production tokenizer: keyed HMAC-SHA256(K_mask, cls SEP domainTag SEP value), base64url, 16 chars.
 * 'opaque' is keyed to a FIXED 'opaque' domain (no class/field/length structure beyond one-wayness — it is
 * VALUE-LOCAL and never crosses). Everything else carries (cls, domainTag) separation in the HMAC message.
 */
export function makeKeyedTokenizer(kMask: Buffer): Tokenizer {
  return {
    tokenize(value, cls, domainTag) {
      // #339: opaque now carries (cls, domainTag) separation like every other class -- the engine passes a
      // PER-COLUMN domain, so equal values in different columns/tables no longer collide (no equi-join re-id).
      const d = createHmac('sha256', kMask).update(`${cls}${SEP}${domainTag}${SEP}${value}`).digest('base64url').slice(0, 16);
      return `${prefixFor(cls)}-${d}` as Token;
    },
  };
}

/**
 * Keyless deterministic STUB tokenizer (the #288 behavior) — the default when no key is wired, for the
 * cut/acceptance tests + pre-key contexts. Same input -> same token; proves structure/class-routing, NOT
 * crypto strength.
 */
export function makeStubTokenizer(): Tokenizer {
  const digest = (domainTag: string, value: string): string =>
    createHash('sha256').update(`${domainTag} ${value}`).digest('base64url').slice(0, 12);
  return {
    tokenize(value, cls, domainTag) {
      switch (cls) {
        case 'uniform': return `UNI-${digest(domainTag, value)}` as Token;
        case 'fpe': return `FPE-${digest(domainTag, value)}` as Token;
        case 'hmac':
        case 'clear-eligible': return `HMC-${digest(domainTag, value)}` as Token;
        case 'opaque':
        case 'vocab-clear': return `OPQ-${digest(domainTag, value)}` as Token; // #339: per-column (was fixed 'opaque')
      }
    },
  };
}

/** Default tokenizer used when the engine isn't given a keyed one (tests + pre-key contexts). */
export const stubTokenizer: Tokenizer = makeStubTokenizer();

/**
 * Back-compat module-level tokenize (the engine's default path) — delegates to the stub. Production threads
 * a KeyedTokenizer via the ResolvedPolicy (M1-step-2) instead of calling this.
 */
export function tokenize(value: string, cls: TokenClass, domainTag: string): Token {
  return stubTokenizer.tokenize(value, cls, domainTag);
}
