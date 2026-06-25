// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * API client: bearer from localStorage after the one-time ?token= bootstrap
 * (read then stripped from the URL, SPEC §17). SSE streams use ?token=
 * because EventSource cannot set headers.
 */

import { noteReachable, noteUnreachable } from './connection.js';

const TOKEN_KEY = 'ui.token';

export function bootstrapToken(): void {
  const url = new URL(window.location.href);
  const token = url.searchParams.get('token');
  if (token) {
    try {
      localStorage.setItem(TOKEN_KEY, token);
    } catch {
      /* ignore */
    }
    url.searchParams.delete('token');
    history.replaceState(null, '', url.toString());
  }
}

export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Per-request ceiling (ms). A request that never settles otherwise holds a
 *  browser connection open forever; enough of them exhaust the per-origin
 *  connection pool and the WHOLE dashboard tab appears frozen (every new fetch
 *  queues behind a dead one). A timeout turns that into a visible, recoverable
 *  error instead of a poisoned tab. */
const REQUEST_TIMEOUT_MS = 15_000;

// Client-side concurrency cap. The browser allows only ~6 connections per origin
// (HTTP/1.1); SSE streams hold some of those open for their whole lifetime. If the
// SPA fires unbounded fetches (bursts, stacked polls, a slow backend), it can starve
// its OWN pool so every NEW request queues behind a dead one and the tab appears
// frozen. Capping our concurrent fetches keeps headroom for streams + new requests,
// so the pool can never be exhausted by the dashboard itself.
const MAX_CONCURRENT = 4;
let active = 0;
const waiters: Array<() => void> = [];
function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) { active += 1; return Promise.resolve(); }
  return new Promise<void>((resolve) => waiters.push(resolve)); // slot handed over on release()
}
function release(): void {
  const next = waiters.shift();
  if (next) next();      // pass the slot straight to the next waiter (active unchanged)
  else active -= 1;      // no one waiting: free the slot
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  await acquire();
  try {
    return await doRequest<T>(method, path, body);
  } finally {
    release();
  }
}

// #425: a registered path-rewriter lets a vertical (the #261 accountant portal) transparently re-route
// its OWN calls — e.g. through a per-tenant proxy — WITHOUT the core api layer naming any vertical path.
// Default = identity: the dashboard never rewrites, so its requests are unaffected. The portal registers
// a rewriter (web/src/portal.ts) that owns the vertical path knowledge (the same registered-slot seam
// as the view-registry's registerNavSection/registerBootHook).
let pathRewriter: (path: string) => string = (p) => p;
/** Register a request-path rewriter (portal SPA only). Pass the identity `(p) => p` to clear. */
export function registerPathRewriter(fn: (path: string) => string): void {
  pathRewriter = fn;
}
function resolvePath(path: string): string {
  return pathRewriter(path);
}

async function doRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(resolvePath(path), {
      method,
      headers: {
        authorization: `Bearer ${getToken()}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    // AbortError (timeout) or a network failure — NO response came back, so the
    // connection is degraded. Surface as an ApiError so callers' catch → toast fires,
    // and tell the health tracker (the shell shows a banner + auto-recovers).
    noteUnreachable();
    const timedOut = err instanceof DOMException && err.name === 'TimeoutError';
    throw new ApiError(0, timedOut ? `request timed out after ${REQUEST_TIMEOUT_MS / 1000}s` : 'network error');
  }
  // a response arrived (even a 4xx/5xx) → the server is reachable; clear any degraded state.
  noteReachable();
  if (!res.ok) {
    let message = res.statusText;
    try {
      const parsed = (await res.json()) as { error?: string };
      if (parsed.error) message = parsed.error;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  delete: <T>(path: string, body?: unknown) => request<T>('DELETE', path, body),
};

/** EventSource with the query token; native auto-reconnect keeps the view alive. */
export function openStream(path: string): EventSource {
  const url = new URL(path, window.location.origin);
  url.searchParams.set('token', getToken());
  return new EventSource(url.toString());
}
