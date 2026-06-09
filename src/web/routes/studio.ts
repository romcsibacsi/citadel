import { json, readBody } from '../http-helpers.js'
import { runStudio, type StudioSettings } from '../../studio/runtime.js'
import type { RouteContext } from './types.js'

// Coerce + clamp the UI-supplied settings object to safe ranges. Anything out of
// range or non-numeric is dropped (falls back to the model's arg / the gen
// default), so a malformed/abusive payload can't push a 16k render at the GPU.
function parseSettings(raw: unknown): StudioSettings {
  if (!raw || typeof raw !== 'object') return {}
  const o = raw as Record<string, unknown>
  const num = (v: unknown, min: number, max: number): number | undefined => {
    const x = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
    return Number.isFinite(x) ? Math.min(Math.max(x, min), max) : undefined
  }
  const st: StudioSettings = {}
  const w = num(o.width, 256, 2048); if (w) st.width = Math.round(w)
  const h = num(o.height, 256, 2048); if (h) st.height = Math.round(h)
  const sec = num(o.seconds, 1, 10); if (sec) st.seconds = sec
  const fr = num(o.frames, 5, 241); if (fr) st.frames = Math.round(fr)
  const stp = num(o.steps, 1, 80); if (stp) st.steps = Math.round(stp)
  const cfg = num(o.cfg, 1, 20); if (cfg) st.cfg = cfg
  const seed = num(o.seed, 0, 4_294_967_295); if (seed != null) st.seed = Math.round(seed)
  if (typeof o.negative === 'string' && o.negative.trim()) st.negative = o.negative.trim().slice(0, 2000)
  return st
}

// POST /api/studio/run -- the thin (Claude-Code-free) media studio: a plain-
// language request -> the local model autonomously calls the gen/edit tools ->
// returns {reply, files, log}. Synchronous (gen can take minutes; the caller
// waits). Auth is the usual dashboard bearer token (all /api/* are gated).
export async function tryHandleStudio(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx
  if (path === '/api/studio/run' && method === 'POST') {
    let body: { request?: unknown; model?: unknown; settings?: unknown; mode?: unknown }
    try { body = JSON.parse((await readBody(req, { maxBytes: 64 * 1024 })).toString()) } catch { json(res, { error: 'bad body' }, 400); return true }
    const request = String(body?.request ?? '').trim()
    if (!request) { json(res, { error: 'A request mező kötelező.' }, 400); return true }
    const model = typeof body?.model === 'string' && body.model.trim() ? body.model.trim() : undefined
    const settings = parseSettings(body?.settings)
    const mode = body?.mode === 'image' || body?.mode === 'video' ? body.mode : undefined
    try {
      const r = await runStudio(request, { model, settings, mode })
      json(res, r)
    } catch (err) {
      json(res, { error: err instanceof Error ? err.message : String(err) }, 500)
    }
    return true
  }
  return false
}
