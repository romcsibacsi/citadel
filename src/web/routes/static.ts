import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { serveFile } from '../http-helpers.js'
import type { RouteContext } from './types.js'

export async function tryHandleStatic(ctx: RouteContext, webDir: string): Promise<boolean> {
  const { req, res, path } = ctx

  if (path === '/' || path === '/index.html') { serveFile(req, res, join(webDir, 'index.html')); return true }
  if (path === '/style.css') { serveFile(req, res, join(webDir, 'style.css')); return true }
  if (path === '/themes.css') { serveFile(req, res, join(webDir, 'themes.css')); return true }
  if (path === '/app.js') { serveFile(req, res, join(webDir, 'app.js')); return true }

  // PWA: web app manifest (served with the spec content-type).
  if (path === '/manifest.json') {
    serveFile(req, res, join(webDir, 'manifest.json'), {
      contentType: 'application/manifest+json; charset=utf-8',
    })
    return true
  }

  // PWA: service worker. Must be served at root scope so it can control '/'.
  // Service-Worker-Allowed lets it claim scope '/'; text/javascript is the
  // spec-recommended SW content-type.
  if (path === '/sw.js') {
    serveFile(req, res, join(webDir, 'sw.js'), {
      contentType: 'text/javascript; charset=utf-8',
      headers: { 'Service-Worker-Allowed': '/' },
    })
    return true
  }

  if (path.startsWith('/icons/')) {
    const iconFile = path.replace('/icons/', '')
    const iconPath = join(webDir, 'icons', iconFile)
    if (iconFile && !iconFile.includes('..') && existsSync(iconPath)) { serveFile(req, res, iconPath); return true }
    res.writeHead(404); res.end()
    return true
  }

  if (path.startsWith('/avatars/')) {
    const avatarFile = path.replace('/avatars/', '')
    const avatarPath = join(webDir, 'avatars', avatarFile)
    if (existsSync(avatarPath)) { serveFile(req, res, avatarPath); return true }
    res.writeHead(404); res.end()
    return true
  }

  // Phase 7B: framed base-agent portraits (large) — roster + agent-detail.
  if (path.startsWith('/portraits/')) {
    const file = path.replace('/portraits/', '')
    const filePath = join(webDir, 'portraits', file)
    if (file && !file.includes('..') && existsSync(filePath)) { serveFile(req, res, filePath); return true }
    res.writeHead(404); res.end()
    return true
  }

  // Phase 7B: base-agent glyphs (small) — nav, chat avatars, badges, favicon.
  if (path.startsWith('/glyphs/')) {
    const file = path.replace('/glyphs/', '')
    const filePath = join(webDir, 'glyphs', file)
    if (file && !file.includes('..') && existsSync(filePath)) { serveFile(req, res, filePath); return true }
    res.writeHead(404); res.end()
    return true
  }

  return false
}
