// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuthIdentity } from './auth.js';

/**
 * Minimal HTTP router. Matching prefers routes with more static segments, so
 * specific routes always beat catch-all :param routes regardless of
 * registration order (SPEC §17 "routing order matters" made unorderable).
 */

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  body: unknown;
  auth: AuthIdentity;
}

/** Routes that only the operator (dashboard bearer) may call. */
export function requireOperator(ctx: RouteContext): void {
  if (ctx.auth.kind !== 'operator') throw new HttpError(403, 'operator token required');
}

export type RouteHandler = (ctx: RouteContext) => Promise<void> | void;

interface RouteEntry {
  method: string;
  segments: string[];
  staticCount: number;
  handler: RouteHandler;
  /** When true the body is NOT pre-read (streaming endpoints). */
  rawBody: boolean;
  /** A trailing '*' segment captures the remaining path tail into params['*'] (proxy routes). */
  wildcard: boolean;
}

export const MAX_JSON_BODY_BYTES = 1024 * 1024;

export class Router {
  private readonly routes: RouteEntry[] = [];

  register(method: string, pattern: string, handler: RouteHandler, opts?: { rawBody?: boolean }): void {
    const segments = pattern.split('/').filter((s) => s !== '');
    const wildcard = segments[segments.length - 1] === '*';
    const staticCount = segments.filter((s) => !s.startsWith(':') && s !== '*').length;
    this.routes.push({
      method: method.toUpperCase(),
      segments,
      staticCount,
      handler,
      rawBody: opts?.rawBody ?? false,
      wildcard,
    });
  }

  get(pattern: string, handler: RouteHandler, opts?: { rawBody?: boolean }): void {
    this.register('GET', pattern, handler, opts);
  }
  post(pattern: string, handler: RouteHandler): void {
    this.register('POST', pattern, handler);
  }
  put(pattern: string, handler: RouteHandler): void {
    this.register('PUT', pattern, handler);
  }
  patch(pattern: string, handler: RouteHandler): void {
    this.register('PATCH', pattern, handler);
  }
  delete(pattern: string, handler: RouteHandler): void {
    this.register('DELETE', pattern, handler);
  }

  /**
   * Returns the best-matching route or undefined. An exact (non-wildcard) route ALWAYS beats
   * a trailing-'*' wildcard route; within each category more static segments win ties.
   */
  match(method: string, pathname: string): { entry: RouteEntry; params: Record<string, string> } | undefined {
    const parts = pathname.split('/').filter((s) => s !== '');
    let best: { entry: RouteEntry; params: Record<string, string> } | undefined;
    let bestScore = -1;
    for (const entry of this.routes) {
      if (entry.method !== method.toUpperCase()) continue;
      const params: Record<string, string> = {};
      let ok = true;
      if (entry.wildcard) {
        // [...prefix, '*']: match the prefix exactly, '*' captures the remaining tail (>=1 part).
        const prefixLen = entry.segments.length - 1;
        if (parts.length <= prefixLen) continue; // the tail must be non-empty
        for (let i = 0; i < prefixLen; i++) {
          const seg = entry.segments[i]!;
          const part = parts[i]!;
          if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(part);
          else if (seg !== part) { ok = false; break; }
        }
        if (!ok) continue;
        params['*'] = parts.slice(prefixLen).map((p) => decodeURIComponent(p)).join('/');
      } else {
        if (entry.segments.length !== parts.length) continue;
        for (let i = 0; i < parts.length; i++) {
          const seg = entry.segments[i]!;
          const part = parts[i]!;
          if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(part);
          else if (seg !== part) { ok = false; break; }
        }
        if (!ok) continue;
      }
      // a non-wildcard match outranks any wildcard match; then by static specificity.
      const score = (entry.wildcard ? 0 : 1_000_000) + entry.staticCount;
      if (score > bestScore) { best = { entry, params }; bestScore = score; }
    }
    return best;
  }

  needsRawBody(method: string, pathname: string): boolean {
    return this.match(method, pathname)?.entry.rawBody ?? false;
  }

  async dispatch(ctx: Omit<RouteContext, 'params'>): Promise<boolean> {
    const found = this.match(ctx.req.method ?? 'GET', ctx.url.pathname);
    if (!found) return false;
    await found.entry.handler({ ...ctx, params: found.params });
    return true;
  }
}

/** Read and parse a JSON request body with a size cap; drains on overflow. */
export function readJsonBody(req: IncomingMessage, maxBytes = MAX_JSON_BODY_BYTES): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let overflowed = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        overflowed = true;
        chunks.length = 0; // keep draining the socket, discard data
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (overflowed) {
        reject(new HttpError(413, 'request body too large'));
        return;
      }
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Catalog key for the operator-facing rendering (SPEC §7a/§20.14). */
    readonly i18nKey?: string,
    readonly i18nParams?: Record<string, string | number>,
  ) {
    super(message);
  }
}

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}
