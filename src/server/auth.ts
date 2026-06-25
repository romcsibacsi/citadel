// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { createExclusive } from '../core/fsx.js';
import { newToken } from '../core/ids.js';

/**
 * Dashboard auth (SPEC §17): one opaque root-equivalent bearer token, generated
 * on first run, stored 0600, NEVER logged. Every /api/* route requires it with
 * tiny explicit exceptions; ?token= is accepted ONLY for the SSE stream and raw
 * file GET paths (they cannot set headers).
 */

export function loadOrCreateBearer(path: string): string {
  if (!existsSync(path)) {
    createExclusive(path, newToken(32), 0o600);
  }
  return readFileSync(path, 'utf8').trim();
}

/** Constant-time comparison; hashing first removes length leakage. */
export function tokensEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}

export interface AuthPolicy {
  /** Paths (exact or prefix via trailing *) that require no auth at all. */
  publicPaths: string[];
  /** Predicate for the GET-only paths where ?token= is accepted. */
  allowTokenQuery: (pathname: string) => boolean;
}

function isPublicPath(pathname: string, publicPaths: string[]): boolean {
  for (const p of publicPaths) {
    if (p.endsWith('*')) {
      if (pathname.startsWith(p.slice(0, -1))) return true;
    } else if (pathname === p) {
      return true;
    }
  }
  return false;
}

/**
 * Identity model: the dashboard bearer is root-equivalent ('operator'); each
 * agent additionally holds a scoped per-agent token ('agent'), used by the
 * agent-facing endpoints to stamp `from` server-side (defense in depth over
 * SPEC §6's reserved-id rejection).
 */
export type AuthIdentity =
  | { kind: 'operator' }
  | { kind: 'agent'; agentId: string }
  | { kind: 'public' }
  | { kind: 'unauthorized' };

export function checkAuth(
  req: Pick<IncomingMessage, 'headers' | 'method'>,
  url: URL,
  bearer: string,
  policy: AuthPolicy,
  agentTokens?: ReadonlyMap<string, string>,
): AuthIdentity {
  if (!url.pathname.startsWith('/api/')) return { kind: 'public' }; // static assets
  if (isPublicPath(url.pathname, policy.publicPaths)) return { kind: 'public' };

  const header = req.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    const presented = header.slice('Bearer '.length).trim();
    if (tokensEqual(presented, bearer)) return { kind: 'operator' };
    if (agentTokens) {
      for (const [agentId, token] of agentTokens) {
        if (tokensEqual(presented, token)) return { kind: 'agent', agentId };
      }
    }
    return { kind: 'unauthorized' };
  }

  const queryToken = url.searchParams.get('token');
  if (queryToken !== null && (req.method ?? 'GET') === 'GET' && policy.allowTokenQuery(url.pathname)) {
    if (tokensEqual(queryToken, bearer)) return { kind: 'operator' };
  }
  return { kind: 'unauthorized' };
}

const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * CSRF posture (SPEC §17): reject state-changing requests carrying a FOREIGN
 * Origin; ALLOW requests with no Origin (some browsers omit it same-origin).
 */
export function checkOrigin(
  req: Pick<IncomingMessage, 'headers' | 'method'>,
  allowedOrigins: ReadonlySet<string>,
): 'ok' | 'forbidden' {
  const method = (req.method ?? 'GET').toUpperCase();
  if (!STATE_CHANGING_METHODS.has(method)) return 'ok';
  const origin = req.headers.origin;
  if (origin === undefined || origin === '') return 'ok';
  return allowedOrigins.has(origin) ? 'ok' : 'forbidden';
}

/** The origins implied by the server's own bind address. */
export function ownOrigins(host: string, port: number): string[] {
  const hosts = new Set<string>([host]);
  if (host === '127.0.0.1' || host === 'localhost' || host === '::1') {
    hosts.add('127.0.0.1');
    hosts.add('localhost');
  }
  const origins: string[] = [];
  for (const h of hosts) {
    origins.push(`http://${h}:${port}`, `https://${h}:${port}`);
  }
  return origins;
}
