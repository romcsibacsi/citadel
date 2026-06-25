// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { createReadStream, existsSync, realpathSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { ServerResponse } from 'node:http';

/**
 * Static SPA serving with strict containment: every resolved path must stay
 * under the web root both lexically and via realpath (symlink escape rejected).
 * Unknown non-API paths fall back to index.html (SPA routing).
 */

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

export function containsPath(rootDir: string, requested: string): string | undefined {
  // lexical check first: normalize and reject any '..' escape
  const normalized = normalize(requested).replace(/^([/\\])+/, '');
  if (normalized.split(sep).includes('..') || normalized.split('/').includes('..')) return undefined;
  const candidate = resolve(rootDir, normalized);
  const root = resolve(rootDir);
  if (candidate !== root && !candidate.startsWith(root + sep)) return undefined;
  if (!existsSync(candidate)) return candidate; // caller handles absence (SPA fallback)
  // realpath check: a symlink inside the root must not escape it
  const real = realpathSync(candidate);
  const realRoot = realpathSync(root);
  if (real !== realRoot && !real.startsWith(realRoot + sep)) return undefined;
  return candidate;
}

export function serveStatic(rootDir: string, pathname: string, res: ServerResponse, rootDoc = 'index.html'): void {
  // The root document: 'index.html' (the agent dashboard) or 'portal.html' (#261 accountant
  // portal instance). It is BOTH the '/' document AND the SPA-fallback for client-side routes.
  const wanted = pathname === '/' ? rootDoc : pathname;
  let filePath = containsPath(rootDir, wanted);
  if (filePath === undefined) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('forbidden');
    return;
  }
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    // SPA fallback — client-side routes render from the root document
    filePath = join(resolve(rootDir), rootDoc);
    if (!existsSync(filePath)) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
  }
  const type = CONTENT_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
  const cache = extname(filePath) === '.html' ? 'no-cache' : 'public, max-age=300';
  res.writeHead(200, { 'content-type': type, 'cache-control': cache });
  createReadStream(filePath).pipe(res);
}
