// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { existsSync, mkdirSync, realpathSync, readdirSync, statSync, openSync, createWriteStream, unlinkSync, statfsSync, constants as FS } from 'node:fs';
import { join, basename, extname, sep } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { createLogger } from '../core/log.js';

/**
 * Embedded file browser (BUILD-22). Exposes ONLY a small allow-list of roots
 * (generated images, generated videos, the operator uploads dir) — the secret /
 * state dir is never a root, so it is unreachable by construction. Every (root,
 * path) is contained BOTH lexically (no `..`) AND via realpath (no symlink
 * escape). Uploads stream to disk with O_EXCL|O_NOFOLLOW (no clobber, no symlink
 * follow), a size cap, a concurrency cap, and a free-space check; the request
 * body is drained on an early reject so the response always lands.
 */

const log = createLogger('files');

export const FILE_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.bmp']);
export const FILE_VIDEO_EXTS = new Set(['.mp4', '.webm']);
const UPLOAD_MAX_BYTES = 1024 * 1024 * 1024; // ~1 GB
const MAX_CONCURRENT_UPLOADS = 3;
const MIN_FREE_BYTES = 64 * 1024 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.avif': 'image/avif', '.bmp': 'image/bmp', '.mp4': 'video/mp4', '.webm': 'video/webm',
};
export function fileContentType(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
}
/** SVG (and anything not a known inline media type) is served as a download, never inline (XSS). */
export function servesInline(path: string): boolean {
  const ext = extname(path).toLowerCase();
  return FILE_IMAGE_EXTS.has(ext) || FILE_VIDEO_EXTS.has(ext);
}

export interface FileRootDef { id: string; dir: string; uploadable: boolean }
export interface FileEntry { name: string; kind: 'dir' | 'file'; size: number; modified: string; ext: string; media: 'image' | 'video' | 'other' }

export class FilesError extends Error {
  constructor(readonly httpStatus: number, message: string) {
    super(message);
  }
}

export class FilesService {
  private inFlight = 0;
  constructor(private readonly defs: FileRootDef[]) {
    for (const d of defs) {
      try { mkdirSync(d.dir, { recursive: true }); } catch (err) { log.warn('could not create file root', { dir: d.dir, error: String(err) }); }
    }
  }

  roots(): Array<{ id: string; uploadable: boolean }> {
    return this.defs.map((d) => ({ id: d.id, uploadable: d.uploadable }));
  }
  private rootDef(id: string): FileRootDef {
    const d = this.defs.find((r) => r.id === id);
    if (d === undefined) throw new FilesError(404, 'unknown root');
    return d;
  }

  /**
   * Resolve a (root, relative-path) to an absolute path, enforcing containment.
   * Lexical: each segment must be a plain name (no `..`, no NUL). Realpath: the
   * resolved target (or its parent for an upload) must live under the root's own
   * realpath — defeating a symlink that points outside.
   */
  private resolve(rootId: string, rel: string, opts: { mustExist?: boolean; parent?: boolean } = {}): { abs: string; root: FileRootDef } {
    const root = this.rootDef(rootId);
    const segs = (rel ?? '').split(/[\\/]+/).filter((s) => s !== '' && s !== '.');
    if (segs.some((s) => s === '..' || s.includes('\0'))) throw new FilesError(400, 'invalid path');
    const abs = segs.length > 0 ? join(root.dir, ...segs) : root.dir;
    const check = opts.parent ? join(abs, '..') : abs;
    let realRoot: string;
    try { realRoot = realpathSync(root.dir); } catch { throw new FilesError(500, 'root unavailable'); }
    let real: string;
    try { real = realpathSync(check); } catch { throw new FilesError(opts.mustExist ? 404 : 400, 'not found'); }
    if (real !== realRoot && !real.startsWith(realRoot + sep)) throw new FilesError(400, 'path escapes root');
    return { abs, root };
  }

  list(rootId: string, rel: string): { root: string; path: string; entries: FileEntry[] } {
    const { abs } = this.resolve(rootId, rel, { mustExist: true });
    if (!statSync(abs).isDirectory()) throw new FilesError(400, 'not a directory');
    const entries: FileEntry[] = [];
    for (const d of readdirSync(abs, { withFileTypes: true })) {
      if (d.name.startsWith('.')) continue; // hide dotfiles (and never expose hidden state)
      let s;
      try { s = statSync(join(abs, d.name)); } catch { continue; } // a broken symlink: skip
      const isDir = d.isDirectory();
      const ext = extname(d.name).toLowerCase();
      entries.push({
        name: d.name, kind: isDir ? 'dir' : 'file', size: isDir ? 0 : s.size, modified: s.mtime.toISOString(), ext,
        media: FILE_IMAGE_EXTS.has(ext) ? 'image' : FILE_VIDEO_EXTS.has(ext) ? 'video' : 'other',
      });
    }
    entries.sort((a, b) => (a.kind !== b.kind ? (a.kind === 'dir' ? -1 : 1) : a.name.localeCompare(b.name)));
    return { root: rootId, path: rel ?? '', entries };
  }

  /** Absolute path of a contained, existing FILE (for raw serving). */
  rawFile(rootId: string, rel: string): string {
    const { abs } = this.resolve(rootId, rel, { mustExist: true });
    if (!statSync(abs).isFile()) throw new FilesError(404, 'not a file');
    return abs;
  }

  remove(rootId: string, rel: string): void {
    const { abs } = this.resolve(rootId, rel, { mustExist: true });
    if (!statSync(abs).isFile()) throw new FilesError(400, 'only files can be deleted');
    unlinkSync(abs);
  }

  /**
   * Drain (and discard) a request body before a pre-check reject, so the 4xx
   * response lands on a clean keep-alive connection. The drain is AWAITED by the
   * caller — returning the rejection before the body is consumed would desync the
   * next request on the socket. A polite drain is bounded: past the cap we drop
   * the socket rather than read an attacker's gigabyte just to say "no".
   */
  private drain(req: IncomingMessage, capBytes = 256 * 1024): Promise<void> {
    return new Promise<void>((resolve) => {
      let seen = 0;
      const finish = (): void => {
        req.removeListener('data', onData);
        req.removeListener('end', finish);
        req.removeListener('error', finish);
        req.removeListener('close', finish);
        resolve();
      };
      const onData = (chunk: Buffer): void => {
        seen += chunk.length;
        if (seen > capBytes) { req.destroy(); finish(); } // too much to politely drain — drop it
      };
      req.on('data', onData);
      req.once('end', finish);
      req.once('error', finish);
      req.once('close', finish);
      req.resume();
    });
  }
  private async drainReject(req: IncomingMessage, status: number, msg: string): Promise<never> {
    await this.drain(req);
    throw new FilesError(status, msg);
  }

  /**
   * Stream an upload into an uploadable root. Pre-checks drain the body then throw
   * (so the client gets the 4xx); the write uses O_EXCL|O_NOFOLLOW and a hard size
   * cap, unlinking a partial file on any failure.
   */
  async upload(rootId: string, dirRel: string, name: string, req: IncomingMessage): Promise<{ name: string; size: number }> {
    const root = this.defs.find((r) => r.id === rootId);
    if (root === undefined) return this.drainReject(req, 404, 'unknown root');
    if (!root.uploadable) return this.drainReject(req, 403, 'this root is read-only');
    // a path-bearing name is REJECTED, not silently sanitized: the uploaded name
    // must be a single plain basename (no separators, no traversal, no control
    // chars — control chars defeat terminal/log spoofing and odd-filename tricks).
    const raw = name ?? '';
    const safe = basename(raw);
    // eslint-disable-next-line no-control-regex
    const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
    if (safe === '' || safe === '.' || safe === '..' || raw.includes('/') || raw.includes('\\') || CONTROL_CHARS.test(raw) || raw !== safe) return this.drainReject(req, 400, 'invalid filename');
    if (this.inFlight >= MAX_CONCURRENT_UPLOADS) return this.drainReject(req, 429, 'too many concurrent uploads');
    const declared = Number(req.headers['content-length'] ?? 0);
    if (Number.isFinite(declared) && declared > UPLOAD_MAX_BYTES) return this.drainReject(req, 413, 'file too large');

    let dirAbs: string;
    try { dirAbs = this.resolve(rootId, dirRel, { mustExist: true }).abs; } catch (err) { await this.drain(req); throw err; }
    if (!statSync(dirAbs).isDirectory()) return this.drainReject(req, 400, 'target is not a directory');
    try {
      const f = statfsSync(dirAbs);
      const avail = f.bavail * f.bsize;
      if (avail < MIN_FREE_BYTES || (declared > 0 && avail < declared)) return this.drainReject(req, 507, 'insufficient storage');
    } catch (err) { if (err instanceof FilesError) throw err; /* statfs unsupported: skip the check */ }

    const target = join(dirAbs, safe);
    let fd: number;
    try {
      fd = openSync(target, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW, 0o600);
    } catch (err) {
      await this.drain(req);
      if ((err as { code?: string }).code === 'EEXIST') throw new FilesError(409, 'a file with that name already exists');
      throw new FilesError(400, 'cannot create file');
    }

    this.inFlight += 1;
    let written = 0;
    let aborted = false;
    const ws = createWriteStream('', { fd });
    try {
      await new Promise<void>((resolve, reject) => {
        req.on('data', (chunk: Buffer) => {
          written += chunk.length;
          if (written > UPLOAD_MAX_BYTES && !aborted) {
            aborted = true;
            ws.destroy();
            req.destroy();
            reject(new FilesError(413, 'file too large'));
          }
        });
        req.on('error', reject);
        ws.on('error', reject);
        ws.on('finish', () => resolve());
        req.pipe(ws);
      });
      log.info('upload stored', { root: rootId, name: safe, bytes: written });
      return { name: safe, size: written };
    } catch (err) {
      try { unlinkSync(target); } catch { /* partial cleanup best-effort */ }
      throw err;
    } finally {
      this.inFlight -= 1;
    }
  }
}

export function defaultFileRoots(images: string, videos: string, uploads: string): FileRootDef[] {
  return [
    { id: 'images', dir: images, uploadable: false },
    { id: 'videos', dir: videos, uploadable: false },
    { id: 'uploads', dir: uploads, uploadable: true },
  ];
}
