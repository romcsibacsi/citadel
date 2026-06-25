// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { createHmac, timingSafeEqual } from 'node:crypto';
import { type Clock, systemClock } from '../core/clock.js';

/**
 * Inbound webhook authentication + rate limiting (FIX-plugin-webhook).
 *
 * Auth is NOT the dashboard bearer: each hook carries its OWN secret and the
 * sender must present an HMAC-SHA256 signature over the RAW request body. We
 * recompute the HMAC with the hook secret and compare in constant time
 * (timingSafeEqual) — a missing or wrong signature is a 401. The signature is
 * read from the `x-webhook-signature` header (hex; an optional `sha256=` prefix
 * is tolerated for GitHub-style senders).
 *
 * A per-hook token-bucket rate limit caps abuse: a public endpoint that a bad
 * actor knows the URL of must not be a free amplifier into the kanban/idea/agent
 * surfaces.
 */

export const SIGNATURE_HEADER = 'x-webhook-signature';

/** Compute the hex HMAC-SHA256 of a raw body with a secret (the value a sender signs). */
export function signBody(secret: string, rawBody: Buffer | string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

/** Normalize a presented signature: lowercase hex, strip an optional `sha256=` prefix. */
function normalizeSig(raw: string): string {
  return raw.trim().toLowerCase().replace(/^sha256=/, '');
}

/**
 * Verify a presented signature against the body using the hook secret. Constant-
 * time over equal-length hex; unequal lengths (or non-hex) fail closed without a
 * comparison. An empty secret never verifies (a hook with no secret is unusable,
 * not open).
 */
export function verifySignature(secret: string | undefined, rawBody: Buffer, presented: string | undefined): boolean {
  if (secret === undefined || secret === '') return false;
  if (presented === undefined || presented === '') return false;
  const expected = signBody(secret, rawBody);
  const got = normalizeSig(presented);
  if (got.length !== expected.length) return false;
  if (!/^[0-9a-f]+$/.test(got)) return false;
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(got, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * A simple per-hook token bucket. Each hook gets `capacity` tokens that refill at
 * `refillPerSec`. A request consumes one token; an empty bucket is throttled.
 * Pure-in-memory + clock-injectable so it is deterministic in tests.
 */
export class HookRateLimiter {
  private readonly buckets = new Map<string, { tokens: number; last: number }>();
  constructor(
    private readonly capacity = 30,
    private readonly refillPerSec = 1,
    private readonly clock: Clock = systemClock,
  ) {}

  /** Returns true when the request is allowed (a token was consumed). */
  allow(hookId: string): boolean {
    const now = this.clock.now().getTime();
    const b = this.buckets.get(hookId) ?? { tokens: this.capacity, last: now };
    const elapsedSec = Math.max(0, (now - b.last) / 1000);
    b.tokens = Math.min(this.capacity, b.tokens + elapsedSec * this.refillPerSec);
    b.last = now;
    if (b.tokens < 1) {
      this.buckets.set(hookId, b);
      return false;
    }
    b.tokens -= 1;
    this.buckets.set(hookId, b);
    return true;
  }
}
