// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { createServer, type Server } from 'node:http';
import { createLogger } from '../core/log.js';
import { checkAuth, checkOrigin, ownOrigins, type AuthPolicy } from './auth.js';
import { HttpError, Router, readJsonBody, sendError, sendJson } from './router.js';
import { mapDomainError } from './domainError.js';
import { serveStatic } from './static.js';

const log = createLogger('server');

export interface HttpServerOptions {
  host: string;
  port: number;
  bearer: string;
  router: Router;
  staticRoot: string;
  /** Root SPA document — 'portal.html' on a #261 accountant-portal instance; default 'index.html'. */
  rootDoc?: string;
  extraAllowedOrigins: string[];
  authPolicy: AuthPolicy;
  agentTokens?: ReadonlyMap<string, string>;
  /** Localizes error responses carrying an i18n key (operator-facing prose). */
  translate?: (key: string, params?: Record<string, string | number>) => string;
}

/**
 * The single HTTP entrypoint: auth gate -> origin gate -> API router -> static
 * SPA handler last (SPEC §17 routing order).
 */
export function createHttpServer(opts: HttpServerOptions): Server {
  const allowedOrigins = new Set([...ownOrigins(opts.host, opts.port), ...opts.extraAllowedOrigins]);

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${opts.host}:${opts.port}`}`);

      const auth = checkAuth(req, url, opts.bearer, opts.authPolicy, opts.agentTokens);
      if (auth.kind === 'unauthorized') {
        sendError(res, 401, 'unauthorized');
        return;
      }

      if (checkOrigin(req, allowedOrigins) === 'forbidden') {
        sendError(res, 403, 'foreign origin rejected');
        return;
      }

      if (url.pathname.startsWith('/api/')) {
        let body: unknown;
        try {
          const method = (req.method ?? 'GET').toUpperCase();
          const hasBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
          body = hasBody && !opts.router.needsRawBody(method, url.pathname) ? await readJsonBody(req) : undefined;
          const handled = await opts.router.dispatch({ req, res, url, body, auth });
          if (!handled) sendError(res, 404, 'no such endpoint');
        } catch (err) {
          // operator-facing rendering goes through the i18n boundary
          // (SPEC §7a/§20.14); the stable key travels along in the payload.
          let httpErr = err instanceof HttpError ? err : mapDomainError(err);
          if (httpErr !== undefined && httpErr.i18nKey === undefined) {
            const mapped = mapDomainError(new Error(httpErr.message));
            if (mapped !== undefined) {
              httpErr = new HttpError(httpErr.status, httpErr.message, mapped.i18nKey, mapped.i18nParams);
            }
          }
          if (httpErr !== undefined) {
            const message =
              httpErr.i18nKey !== undefined && opts.translate !== undefined
                ? opts.translate(httpErr.i18nKey, httpErr.i18nParams)
                : httpErr.message;
            sendJson(res, httpErr.status, {
              error: message,
              ...(httpErr.i18nKey !== undefined ? { key: httpErr.i18nKey } : {}),
            });
          } else {
            log.error('unhandled API error', { path: url.pathname, error: String(err) });
            if (!res.headersSent) sendError(res, 500, 'internal error');
            else res.end();
          }
        }
        return;
      }

      serveStatic(opts.staticRoot, url.pathname, res, opts.rootDoc);
    })().catch((err: unknown) => {
      log.error('request pipeline failure', { error: String(err) });
      if (!res.headersSent) sendError(res, 500, 'internal error');
    });
  });

  return server;
}
