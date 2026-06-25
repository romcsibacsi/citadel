// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { createReadStream } from 'node:fs';
import type { Router } from '../router.js';
import { HttpError, requireOperator, sendJson } from '../router.js';
import type { AppContext } from '../../app/context.js';
import { FilesError, fileContentType, servesInline } from '../../files/service.js';

/**
 * Files (Fájlok) routes (BUILD-22). Operator-only; the raw GET is the one route
 * that may carry ?token= (AUTH_POLICY), so an <img>/<video> can load it. All
 * containment + streaming-upload safety lives in FilesService.
 */
export function registerFilesRoutes(router: Router, ctx: AppContext): void {
  const wrap = (fn: () => void): void => {
    try { fn(); } catch (err) {
      if (err instanceof FilesError) throw new HttpError(err.httpStatus, err.message);
      throw err;
    }
  };

  router.get('/api/files/roots', (c) => {
    requireOperator(c);
    sendJson(c.res, 200, { roots: ctx.files.roots() });
  });

  router.get('/api/files/list', (c) => {
    requireOperator(c);
    const root = c.url.searchParams.get('root') ?? '';
    const path = c.url.searchParams.get('path') ?? '';
    wrap(() => sendJson(c.res, 200, ctx.files.list(root, path)));
  });

  // Raw file serving — bearer OR ?token= (the documented exception). Images/videos
  // inline so the grid + lightbox render; everything else (and ?download=1) attaches.
  router.get('/api/files/raw', (c) => {
    requireOperator(c);
    const root = c.url.searchParams.get('root') ?? '';
    const path = c.url.searchParams.get('path') ?? '';
    const download = c.url.searchParams.get('download') === '1';
    let abs: string;
    try { abs = ctx.files.rawFile(root, path); } catch (err) {
      if (err instanceof FilesError) throw new HttpError(err.httpStatus, err.message);
      throw err;
    }
    const inline = !download && servesInline(abs);
    const name = abs.split('/').pop() ?? 'file';
    c.res.writeHead(200, {
      'content-type': fileContentType(abs),
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${name.replace(/["\\]/g, '_')}"`,
      'cache-control': 'private, max-age=60',
      'x-content-type-options': 'nosniff', // never let the browser sniff a served file into an executable type
    });
    createReadStream(abs).pipe(c.res);
  });

  // Streaming upload (rawBody: the router does NOT pre-read the body).
  router.register('POST', '/api/files/upload', async (c) => {
    requireOperator(c);
    const root = c.url.searchParams.get('root') ?? '';
    const dir = c.url.searchParams.get('path') ?? '';
    const name = c.url.searchParams.get('name') ?? '';
    try {
      sendJson(c.res, 201, await ctx.files.upload(root, dir, name, c.req));
    } catch (err) {
      if (err instanceof FilesError) throw new HttpError(err.httpStatus, err.message);
      throw err;
    }
  }, { rawBody: true });

  router.delete('/api/files', (c) => {
    requireOperator(c);
    const root = c.url.searchParams.get('root') ?? '';
    const path = c.url.searchParams.get('path') ?? '';
    wrap(() => { ctx.files.remove(root, path); sendJson(c.res, 200, { removed: true }); });
  });
}
