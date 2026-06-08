import { json, readBody } from '../http-helpers.js'
import { runStudio } from '../../studio/runtime.js'
import type { RouteContext } from './types.js'

// POST /api/studio/run -- the thin (Claude-Code-free) media studio: a plain-
// language request -> the local model autonomously calls the gen/edit tools ->
// returns {reply, files, log}. Synchronous (gen can take minutes; the caller
// waits). Auth is the usual dashboard bearer token (all /api/* are gated).
export async function tryHandleStudio(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx
  if (path === '/api/studio/run' && method === 'POST') {
    let body: { request?: unknown; model?: unknown }
    try { body = JSON.parse((await readBody(req, { maxBytes: 64 * 1024 })).toString()) } catch { json(res, { error: 'bad body' }, 400); return true }
    const request = String(body?.request ?? '').trim()
    if (!request) { json(res, { error: 'A request mező kötelező.' }, 400); return true }
    const model = typeof body?.model === 'string' && body.model.trim() ? body.model.trim() : undefined
    try {
      const r = await runStudio(request, { model })
      json(res, r)
    } catch (err) {
      json(res, { error: err instanceof Error ? err.message : String(err) }, 500)
    }
    return true
  }
  return false
}
