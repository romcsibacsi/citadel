// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  decideUpdate,
  verifyManifestSignature,
  type ReleaseManifest,
  type UpdatePolicy,
  type UpdateRefusal,
} from './updatePolicy.js';

/**
 * Update TRANSPORT (#113, management-plane code side). The pure decision core
 * (updatePolicy.decideUpdate) verifies the SIGNED MANIFEST — signature + version
 * policy — but, by design, it never touches the network and never sees the artifact
 * BYTES. That leaves exactly one open hole in the chain of trust: a validly-signed
 * manifest could be paired with a swapped artifact (the signature proves WHAT release
 * was authorised, not that the bytes on disk ARE that release).
 *
 * This module closes that hole by binding the manifest to the artifact through a
 * signed SHA-256, completing the chain:
 *
 *     Ed25519 signature -> manifest bytes -> manifest.artifact_sha256 -> artifact bytes
 *
 * The artifact hash lives INSIDE the signed manifest, so the existing signature
 * transitively authenticates it; the transport then verifies the fetched artifact
 * against that hash before declaring the update applicable. Every gate is fail-closed,
 * the artifact is fetched ONLY after the manifest has been fully accepted, and all IO
 * is injected so the driver is unit-testable (and SSRF-guarded in production).
 *
 * The own fleet configures no update policy, so this path is dormant there.
 */

/** Lowercase-hex SHA-256 of the given bytes. */
export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Constant-time check that `bytes` hash to `expectedSha256` (lowercase or uppercase
 * hex). Returns false on any absent or non-64-hex expectation — never throws
 * (fail-closed). A missing/garbage expectation can therefore never accidentally pass.
 */
export function verifyArtifact(bytes: Buffer, expectedSha256: string | undefined): boolean {
  if (typeof expectedSha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(expectedSha256)) return false;
  const actual = Buffer.from(sha256Hex(bytes), 'hex');
  const expected = Buffer.from(expectedSha256.toLowerCase(), 'hex');
  // Lengths are equal by construction (both 32 bytes); guard anyway before the compare.
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

export interface UpdateTransportDeps {
  /** Currently installed version (the anti-downgrade baseline). */
  current: string;
  /** The active update policy (signature requirement, version pins/floors, channel). */
  policy: UpdatePolicy;
  /** Pinned release-signing public key (PEM). Only consulted when policy.requireSignature. */
  publicKeyPem: string;
  /** Fetch the signed manifest: its raw bytes (signed verbatim) + the detached base64 signature. */
  fetchManifest: () => Promise<{ bytes: Buffer; signatureB64: string }>;
  /** Fetch the artifact bytes the (already accepted) manifest describes. */
  fetchArtifact: (manifest: ReleaseManifest) => Promise<Buffer>;
}

/** Why the transport refused — the policy core's reasons plus the transport-only ones. */
export type TransportRefusal =
  | UpdateRefusal
  | 'malformed-manifest'
  | 'missing-artifact-hash'
  | 'artifact-hash-mismatch';

export type UpdateOutcome =
  | { apply: false; reason: TransportRefusal }
  | { apply: true; manifest: ReleaseManifest; artifact: Buffer };

/**
 * Drive one update attempt end to end, fail-closed at every step:
 *  1. Verify the Ed25519 signature over the EXACT manifest bytes (this transitively
 *     covers artifact_sha256). An unsigned/forged manifest is rejected outright.
 *  2. Parse the manifest; bytes we cannot parse into a well-formed descriptor are
 *     never acted on.
 *  3. Run the pure version policy (decideUpdate): channel/pin/floor/anti-downgrade.
 *  4. Require the signed artifact hash, fetch the artifact, and verify its SHA-256
 *     against the manifest. A signed manifest with no hash, or paired with a swapped
 *     artifact, is refused. Only here is the network touched for the (large) artifact.
 */
export async function prepareUpdate(deps: UpdateTransportDeps): Promise<UpdateOutcome> {
  const { bytes, signatureB64 } = await deps.fetchManifest();

  // 1. Signature over the raw bytes BEFORE trusting their contents.
  const signatureValid = verifyManifestSignature(bytes, signatureB64, deps.publicKeyPem);
  if (deps.policy.requireSignature && !signatureValid) return { apply: false, reason: 'bad-signature' };

  // 2. Parse — fail-closed on anything that is not a well-formed manifest.
  let manifest: ReleaseManifest;
  try {
    manifest = JSON.parse(bytes.toString('utf8')) as ReleaseManifest;
  } catch {
    return { apply: false, reason: 'malformed-manifest' };
  }
  if (typeof manifest?.version !== 'string' || typeof manifest?.commit !== 'string') {
    return { apply: false, reason: 'malformed-manifest' };
  }

  // 3. Version policy (the existing pure core), reusing the signature validity above.
  const decision = decideUpdate({ current: deps.current, manifest, policy: deps.policy, signatureValid });
  if (!decision.apply) return { apply: false, reason: decision.reason as UpdateRefusal };

  // 4. The artifact binding — the gap this module exists to close. Fetch the artifact
  //    ONLY now (manifest fully accepted), then bind it to the signed hash.
  if (typeof manifest.artifact_sha256 !== 'string') return { apply: false, reason: 'missing-artifact-hash' };
  const artifact = await deps.fetchArtifact(manifest);
  if (!verifyArtifact(artifact, manifest.artifact_sha256)) return { apply: false, reason: 'artifact-hash-mismatch' };

  return { apply: true, manifest, artifact };
}
