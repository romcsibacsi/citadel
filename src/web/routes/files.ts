import { readdirSync, statSync, unlinkSync, realpathSync, createWriteStream, openSync, statfsSync, constants as fsConstants } from 'node:fs'
import { join, extname, sep } from 'node:path'
import { homedir } from 'node:os'
import type { IncomingMessage } from 'node:http'
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
  comfyvideo: join(PROJECT_ROOT, 'store', 'comfy-video'),
  incoming: join(homedir(), 'incoming'),
}

// Extensions the UI may render inline as a thumbnail / lightbox image. SVG is
// intentionally excluded (served as a download instead) to sidestep any
// script-in-SVG concerns; everything here is a raster format MIME knows.
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.bmp'])

class FilesError extends Error {}

// Hard ceiling for a single uploaded file. Generous for a homelab manager, but
// bounded so a runaway upload can't fill the disk unchecked.
const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024 // 1 GB
// Refuse new uploads once this many are already streaming, so concurrent
// uploads can't multiply past the per-file cap and fill the disk together.
const MAX_CONCURRENT_UPLOADS = 3
// Keep at least this much free even after a worst-case upload completes.
const FREE_SPACE_MARGIN = 512 * 1024 * 1024 // 512 MB
let activeUploads = 0

// Reduce an arbitrary client filename to a safe basename. Order matters: strip
// control chars, trim, THEN drop leading dots (so a leading space can't shield a
// `..`/dotfile) and collapse trailing dots/spaces. safeJoin re-checks containment.
function safeFilename(raw: string): string {
  const base = (raw || '').split(/[/\\]/).pop() || ''
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\x00-\x1f]/g, '').trim().replace(/^\.+/, '').replace(/[. ]+$/, '').trim()
  // Slice by code point so a 200-unit cut can't split a surrogate pair.
  return [...cleaned].slice(0, 200).join('') || 'upload'
}

// Atomically create a fresh file in `dir` for `name`, never following a symlink
// and never clobbering. O_EXCL makes the create fail (EEXIST) on ANY existing
// path -- including a symlink, live or dangling -- so a planted symlink can't
// redirect the write outside the root; O_NOFOLLOW double-guards. Returns the
// open fd + final path, advancing " (n)" on collision.
function openUniqueExclusive(dir: string, name: string): { fd: number; path: string } {
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  const flags = fsConstants.O_CREAT | fsConstants.O_WRONLY | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW
  for (let i = 0; i < 1000; i++) {
    const cand = safeJoin(dir, i === 0 ? name : `${stem} (${i})${ext}`)
    try {
      return { fd: openSync(cand, flags, 0o644), path: cand }
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'EEXIST' || code === 'ELOOP') continue // taken / is a symlink -> next name
      throw e
    }
  }
  throw new FilesError('nem sikerült egyedi célnevet nyitni')
}

// Stream a request body into an already-open fd with a running size cap. Never
// buffers the whole upload in RAM. On overflow we stop writing and DRAIN the
// rest of the request (instead of destroying the socket) so the handler can
// still send a clean 413 response.
function streamToFile(req: IncomingMessage, targetPath: string, fd: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let written = 0
    let over = false
    const ws = createWriteStream(targetPath, { fd, autoClose: true })
    const fail = (e: Error) => { ws.destroy(); reject(e) }
    req.on('data', (c: Buffer) => {
      if (over) return
      written += c.length
      if (written > MAX_UPLOAD_BYTES) {
        over = true
        req.unpipe(ws)
        ws.destroy()
        req.resume() // discard the remainder so the response can flush cleanly
        req.once('end', () => reject(new FilesError('too-large')))
        req.once('error', () => reject(new FilesError('too-large')))
      }
    })
    req.on('error', fail)
    ws.on('error', fail)
    ws.on('finish', resolve)
    req.pipe(ws)
  })
}

// Whether `dir`'s filesystem has room for `need` bytes plus the safety margin.
function freeSpaceOk(dir: string, need: number): boolean {
  try {
    const s = statfsSync(dir)
    return s.bavail * s.bsize - need >= FREE_SPACE_MARGIN
  } catch {
    return true // statfs unavailable -> the per-file + concurrency caps still apply
  }
}

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

  // Upload one file (raw body) into root+path, streamed to disk. The filename
  // rides in ?name= so the body stays the pure file bytes (no multipart parse,
  // no full-RAM buffering).
  if (path === '/api/files/upload' && method === 'POST') {
    const tooBigMsg = `túl nagy fájl (max ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB)`
    // Early rejects must drain the request body: the browser starts streaming
    // the File before we validate headers, so an undrained reject can wedge a
    // keep-alive socket.
    const reject = (msg: string, code = 400): boolean => { req.resume(); json(res, { error: msg }, code); return true }
    const root = url.searchParams.get('root') || ''
    const rel = url.searchParams.get('path') || ''
    const rawName = url.searchParams.get('name') || ''
    if (!ROOTS[root]) return reject('unknown root')
    let dir: string
    try { dir = resolveWithin(root, rel) } catch { return reject('invalid path') }
    try { if (!statSync(dir).isDirectory()) return reject('a cél nem mappa') }
    catch { return reject('a célmappa nem létezik') }
    const declared = Number(req.headers['content-length'] || 0)
    if (declared > MAX_UPLOAD_BYTES) return reject(tooBigMsg, 413)
    if (!freeSpaceOk(dir, declared || MAX_UPLOAD_BYTES)) return reject('nincs elég szabad lemezhely', 507)
    if (activeUploads >= MAX_CONCURRENT_UPLOADS) return reject('túl sok egyidejű feltöltés, próbáld újra', 503)

    let opened: { fd: number; path: string }
    try { opened = openUniqueExclusive(dir, safeFilename(rawName)) }
    catch (err) {
      const traversal = err instanceof Error && /traversal/i.test(err.message)
      return reject(traversal ? 'invalid path' : (err instanceof Error ? err.message : String(err)), traversal ? 400 : 500)
    }
    activeUploads++
    try {
      await streamToFile(req, opened.path, opened.fd)
      json(res, { ok: true, name: opened.path.split(sep).pop() })
    } catch (err) {
      try { unlinkSync(opened.path) } catch { /* best-effort cleanup of the partial file */ }
      const tooBig = err instanceof Error && err.message === 'too-large'
      json(res, { error: tooBig ? tooBigMsg : (err instanceof Error ? err.message : String(err)) }, tooBig ? 413 : 500)
    } finally {
      activeUploads--
    }
    return true
  }

  return false
}
