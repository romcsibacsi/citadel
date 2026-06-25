// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
// #288 — the LOCUS engine contract (compute-locus + result-locus). The §4 unifying principle as a
// mechanism: anything needing an EXACT value or value-PROXIMITY runs LOCAL; the cloud gets band+token+
// structure and AUTHORS rules. A task's manifest declares which ops are local; a local result re-enters
// the cloud-facing zone ONLY as a NON-IDENTIFYING aggregate (DZ-B result-locus). This file is the
// interface + the decision mechanism; the deep local execution + band-derivation land in #280.

import type { TaskManifest } from './policy/types.js';

/** Ops that ALWAYS run local regardless of manifest (the §4 floor — exact/proximity-bound). */
export const ALWAYS_LOCAL = ['arithmetic', 'reconcile', 'dedup', 'dup-payment', 'checksum', 'serial-continuity'] as const;

/** Compute-locus: does this op run local for this task? */
export function isLocalOp(op: string, manifest: TaskManifest | undefined): boolean {
  if ((ALWAYS_LOCAL as readonly string[]).includes(op)) return true;
  return manifest?.localOps.includes(op) ?? true; // default-local when unknown (conservative)
}

/** L1 dimension-minimization: may this token dimension cross to cloud for this task? */
export function dimensionCrosses(fieldPath: string, manifest: TaskManifest | undefined): boolean {
  return manifest?.dimensionsToCloud.includes(fieldPath) ?? false; // default: does NOT cross
}

/** Result-locus (DZ-B): a local result may cross ONLY as a non-identifying aggregate. The deep
 *  re-masking of a computed result is #280; here the contract is the shape constraint. */
export type LocalResult =
  | { kind: 'bool'; name: string; value: boolean } //   {dup_detected: true}
  | { kind: 'pattern'; name: string } //                {anomaly_type: 'vat_mismatch'}
  | { kind: 'band'; name: string; band: string }; //    {amount_band: 'M'} — never the exact value
