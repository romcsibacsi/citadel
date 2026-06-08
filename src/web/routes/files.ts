import { readdirSync, statSync, unlinkSync, realpathSync } from 'node:fs'
import { join, extname, sep } from 'node:path'
import { homedir } from 'node:os'
import { PROJECT_ROOT } from '../../config.js'
import { json, serveFile, readBody } from '../http-helpers.js'
import { safeJoin } from '../sanitize.js'
import type { RouteContext } from './types.js'

// The embedded file browser exposes exactly two trees, by deliberate design:
// the ComfyUI generated-image output dir and the operator's ~/incoming. The
// secret-bearing store/ root (vault, tokens, db, dashboard token) is NOT here
// and must never be added.
const ROOTS: Record<string, string> = {
  comfy: join(PROJECT_ROOT, 'store', 'comfy'),
  incoming: join(homedir(), 'incoming'),
}

// Extensions the UI may render inline as a thumbnail / lightbox image. SVG is
// intentionally excluded (served as a download instead) to sidestep any
// script-in-SVG concerns; everything here is a raster format MIME knows.
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.bmp'])

class FilesError extends Error {}

// Resolve a (root, relativePath) pair to an absolute path, rejecting any escape
// out of the root -- both lexical (`..`) via safeJoin and via symlinks (realpath
// containment) for paths that already exist on disk.
function resolveWithin(rootKey: string, rel: string): string {
  const base = ROOTS[rootKey]
  if (!base) throw new FilesError('unknown root')
  const target = safeJoin(base, rel)
  try {
    const realBase = realpathSync(base)
    const realTarget = realpathSync(target)
    if (realTarget !== realBase && !realTarget.startsWith(realBase + sep)) {
      throw new FilesError('symlink escape rejected')
    }
  } catch (e) {
    if (e instanceof FilesError) throw e
    // ENOENT: base or target not materialised yet -- safeJoin already
    // guaranteed lexical containment, so allow (a missing file 404s later).
  }
  return target
}

export async function tryHandleFiles(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  // List a directory under one of the two roots.
  if (path === '/api/files/list' && method === 'GET') {
    const root = url.searchParams.get('root') || ''
    const rel = url.searchParams.get('path') || ''
    if (!ROOTS[root]) { json(res, { error: 'unknown root' }, 400); return true }
    let dir: string
    try { dir = resolveWithin(root, rel) } catch { json(res, { error: 'invalid path' }, 400); return true }
    let dirents
    // Empty list on any readdir failure is deliberate: the comfy root legitimately
    // does not exist until the first image is generated, and returning [] keeps
    // the UI showing a clean "empty folder" instead of an error on a fresh box.
    try { dirents = readdirSync(dir, { withFileTypes: true }) } catch { json(res, { root, path: rel, entries: [] }); return true }
    const entries = dirents
      .filter(d => !d.name.startsWith('.'))
      .map(d => {
        const isDir = d.isDirectory()
        let size = 0, mtime = 0
        try { const s = statSync(join(dir, d.name)); size = s.size; mtime = s.mtimeMs } catch { /* race / broken symlink */ }
        return { name: d.name, type: isDir ? 'dir' : 'file', size, mtime, isImage: !isDir && IMAGE_EXTS.has(extname(d.name).toLowerCase()) }
      })
      // Directories first (alphabetical), then files newest-first -- so freshly
      // generated images land at the top of the comfy view.
      .sort((a, b) =>
        a.type !== b.type ? (a.type === 'dir' ? -1 : 1)
          : a.type === 'dir' ? a.name.localeCompare(b.name) : b.mtime - a.mtime)
    json(res, { root, path: rel, entries })
    return true
  }

  // Serve one file -- inline for preview, attachment when download=1. Auth for
  // this GET also accepts ?token= (see web.ts) because <img src>/downloads
  // cannot carry an Authorization header.
  if (path === '/api/files/raw' && method === 'GET') {
    const root = url.searchParams.get('root') || ''
    const rel = url.searchParams.get('path') || ''
    if (!ROOTS[root]) { res.writeHead(400); res.end('bad root'); return true }
    let target: string
    try { target = resolveWithin(root, rel) } catch { res.writeHead(400); res.end('bad path'); return true }
    let isFile = false
    try { isFile = statSync(target).isFile() } catch { /* 404 below */ }
    if (!isFile) { res.writeHead(404); res.end('not found'); return true }
    const headers: Record<string, string> = {}
    if (url.searchParams.get('download') === '1') {
      const fname = target.split(sep).pop() || 'download'
      headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`
    }
    serveFile(req, res, target, { headers })
    return true
  }

  // Delete a single file (never a directory).
  if (path === '/api/files/delete' && method === 'POST') {
    let body: { root?: unknown; path?: unknown }
    try { body = JSON.parse((await readBody(req, { maxBytes: 4096 })).toString()) } catch { json(res, { error: 'bad body' }, 400); return true }
    const root = String(body?.root ?? ''), rel = String(body?.path ?? '')
    if (!ROOTS[root]) { json(res, { error: 'unknown root' }, 400); return true }
    let target: string
    try { target = resolveWithin(root, rel) } catch { json(res, { error: 'invalid path' }, 400); return true }
    try {
      if (!statSync(target).isFile()) { json(res, { error: 'csak fájl törölhető' }, 400); return true }
      unlinkSync(target)
      json(res, { ok: true })
    } catch (err) {
      json(res, { error: err instanceof Error ? err.message : String(err) }, 500)
    }
    return true
  }

  return false
}
