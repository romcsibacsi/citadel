// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { verify as cryptoVerify, createPublicKey } from 'node:crypto';

/**
 * Hardened pull-update policy (#106, management-plane code side). The product
 * instance pulls its own updates (no inbound mgmt port), but MUST NOT apply an
 * update blindly: today self-update.sh does `git pull --ff-only` and verifies
 * NOTHING (no signature, no version floor, no anti-downgrade). This module is the
 * pure decision core that closes that gap — it never touches git or the network;
 * the driver fetches a signed release manifest and feeds it here.
 *
 * The own fleet does not configure an update policy, so this is dormant there.
 */

/** A signed release descriptor the build/release process publishes alongside the artifact. */
export interface ReleaseManifest {
  /** Monotonic dotted-numeric version, e.g. "0.2.0". Ordering is what anti-downgrade enforces. */
  version: string;
  /** The exact commit the release was built from (build-provenance, #88 build-from-origin). */
  commit: string;
  /** Optional release channel ('stable'|'beta'); a policy may pin to one. */
  channel?: string;
  /**
   * Lowercase-hex SHA-256 of the release artifact this manifest describes. It is part
   * of the SIGNED manifest bytes, so the Ed25519 signature transitively binds the
   * manifest to the EXACT artifact: a validly-signed manifest paired with a swapped
   * artifact is rejected at transport. Optional in the TYPE only, so the version-policy
   * core (decideUpdate) stays decoupled from artifact transport; the transport REQUIRES
   * it and fails closed when it is absent (see updateTransport.ts, #113).
   *
   * snake_case to match the on-the-wire manifest JSON key verbatim (the cross-impl
   * golden vectors sign `"artifact_sha256"`), so JSON.parse maps it directly.
   */
  artifact_sha256?: string;
}

export interface UpdatePolicy {
  /** Refuse any update whose manifest signature did not verify against the pinned public key. */
  requireSignature: boolean;
  /** If set, ONLY this exact version may be applied (operator-pinned rollout). */
  pinnedVersion?: string;
  /** If set, refuse anything strictly below this floor (min supported / known-good). */
  minVersion?: string;
  /** If set, the candidate channel must equal this. */
  channel?: string;
}

export type UpdateRefusal =
  | 'bad-signature'
  | 'malformed-version'
  | 'malformed-policy'
  | 'wrong-channel'
  | 'not-pinned-version'
  | 'below-min-floor'
  | 'anti-downgrade'
  | 'already-current';

export interface UpdateDecision {
  apply: boolean;
  reason: UpdateRefusal | 'ok';
}

/**
 * Parse a dotted-numeric version into its numeric components. Returns null for
 * anything that is not strictly `\d+(\.\d+)*` — a malformed version is never
 * comparable and is treated as a hard refusal upstream (fail-closed).
 */
export function parseVersion(v: string): number[] | null {
  if (typeof v !== 'string' || v.trim() === '') return null;
  const parts = v.trim().split('.');
  const nums: number[] = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    nums.push(Number(p));
  }
  return nums;
}

/**
 * Compare two dotted-numeric versions. Returns -1 / 0 / 1 (a<b / a==b / a>b).
 * Missing trailing components count as 0 ("1.2" == "1.2.0"). Throws on a
 * malformed input so callers must validate first (fail-closed).
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (pa === null || pb === null) throw new Error('compareVersions: malformed version');
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

/**
 * Verify an Ed25519 signature over the EXACT manifest bytes (the release process
 * signs `manifest.json` verbatim and ships `manifest.sig`). Returns false on any
 * failure — bad key, bad signature, wrong bytes — never throws (fail-closed). The
 * signing private key stays offline/HSM; only the public key ships with the image.
 */
export function verifyManifestSignature(manifestBytes: Buffer, signatureB64: string, publicKeyPem: string): boolean {
  try {
    const key = createPublicKey(publicKeyPem);
    const sig = Buffer.from(signatureB64, 'base64');
    if (sig.length === 0) return false;
    // Ed25519: algorithm is null; the key type carries it.
    return cryptoVerify(null, manifestBytes, key, sig);
  } catch {
    return false;
  }
}

/**
 * The pure update decision. Order matters and every gate is fail-closed:
 *  1. signature (if required) — an unsigned/forged manifest is rejected outright.
 *  2. version well-formedness — a manifest (or a policy bound) we cannot order is
 *     never applied (U4: a malformed policy pin/floor refuses, never throws).
 *  3. channel pin.
 *  4. exact version pin (operator-staged rollout).
 *  5. min-floor (no known-vulnerable releases).
 *  6. anti-downgrade — refuse a version <= current (a SIGNED but older release is
 *     still a downgrade attack; equal means already-current).
 */
export function decideUpdate(input: {
  current: string;
  manifest: ReleaseManifest;
  policy: UpdatePolicy;
  signatureValid: boolean;
}): UpdateDecision {
  const { current, manifest, policy } = input;

  if (policy.requireSignature && !input.signatureValid) return { apply: false, reason: 'bad-signature' };

  if (parseVersion(manifest.version) === null || parseVersion(current) === null) {
    return { apply: false, reason: 'malformed-version' };
  }

  // U4 (PROBE LOW): guard the POLICY-supplied versions too — a malformed operator
  // pin/floor must fail closed (refuse), never throw out of compareVersions below.
  if (policy.pinnedVersion !== undefined && parseVersion(policy.pinnedVersion) === null) {
    return { apply: false, reason: 'malformed-policy' };
  }
  if (policy.minVersion !== undefined && parseVersion(policy.minVersion) === null) {
    return { apply: false, reason: 'malformed-policy' };
  }

  if (policy.channel !== undefined && manifest.channel !== policy.channel) {
    return { apply: false, reason: 'wrong-channel' };
  }

  if (policy.pinnedVersion !== undefined && compareVersions(manifest.version, policy.pinnedVersion) !== 0) {
    return { apply: false, reason: 'not-pinned-version' };
  }

  if (policy.minVersion !== undefined && compareVersions(manifest.version, policy.minVersion) < 0) {
    return { apply: false, reason: 'below-min-floor' };
  }

  const vsCurrent = compareVersions(manifest.version, current);
  if (vsCurrent < 0) return { apply: false, reason: 'anti-downgrade' };
  if (vsCurrent === 0) return { apply: false, reason: 'already-current' };

  return { apply: true, reason: 'ok' };
}
