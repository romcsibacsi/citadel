import { randomBytes } from 'node:crypto'
import { json, readBody } from '../http-helpers.js'
import { logger } from '../../logger.js'
import { runStudio, isStudioBusy, type StudioSettings, type StudioResult } from '../../studio/runtime.js'
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
  const sec = num(o.seconds, 1, 60); if (sec) st.seconds = sec
  const fr = num(o.frames, 5, 241); if (fr) st.frames = Math.round(fr)
  const stp = num(o.steps, 1, 80); if (stp) st.steps = Math.round(stp)
  const cfg = num(o.cfg, 1, 20); if (cfg) st.cfg = cfg
  const seed = num(o.seed, 0, 4_294_967_295); if (seed != null) st.seed = Math.round(seed)
  if (typeof o.negative === 'string' && o.negative.trim()) st.negative = o.negative.trim().slice(0, 2000)
  return st
}

// --- Async job store ----------------------------------------------------------
// A studio gen (esp. a 60s / 8-clip video) can take many minutes. A SYNCHRONOUS
// request would trip the reverse-proxy / browser read-timeout (the "(hálózat?)"
// failure) even though the backend keeps rendering. So /api/studio/run starts a
// background job and returns a jobId immediately; the UI polls /api/studio/job.
// Single-user: at most one job runs at a time (the GPU serializes anyway). Jobs
// are in-memory -- a dashboard restart loses the job record (a gen in flight may
// still finish and land in store/comfy-video, visible on the Fájlok page), and
// finished jobs are pruned after JOB_TTL_MS.
interface StudioJob {
  id: string
  status: 'running' | 'done' | 'error'
  progress: string
  startedAt: number
  finishedAt?: number
  result?: StudioResult
  error?: string
}

const jobs = new Map<string, StudioJob>()
const JOB_TTL_MS = 60 * 60 * 1000

function pruneJobs(): void {
  const now = Date.now()
  for (const [id, j] of jobs) {
    if (j.finishedAt && now - j.finishedAt > JOB_TTL_MS) jobs.delete(id)
  }
}

function startJob(request: string, opts: { model?: string; settings: StudioSettings; mode?: 'image' | 'video' }): StudioJob {
  const job: StudioJob = { id: randomBytes(8).toString('hex'), status: 'running', progress: 'indítás…', startedAt: Date.now() }
  jobs.set(job.id, job)
  // Fire-and-forget: the HTTP response already returned. The promise's settle
  // captures result/error onto the job; .then's reject arm means it never throws
  // an unhandled rejection.
  runStudio(request, {
    model: opts.model,
    settings: opts.settings,
    mode: opts.mode,
    onProgress: m => { job.progress = m },
  }).then(
    r => { job.status = 'done'; job.result = r; job.progress = 'kész'; job.finishedAt = Date.now() },
    e => {
      job.status = 'error'
      job.error = e instanceof Error ? e.message : String(e)
      job.finishedAt = Date.now()
      logger.warn({ err: e, jobId: job.id }, 'studio job failed')
    },
  )
  return job
}

// POST /api/studio/run  -> { jobId, status } (starts a background gen)
// GET  /api/studio/job?id=<id> -> { status, progress, elapsedMs, ...(reply/files/log | error) }
// The thin (Claude-Code-free) media studio: a plain-language request -> the local
// model autonomously calls the gen/edit tools. Auth is the usual dashboard bearer
// token (all /api/* are gated).
export async function tryHandleStudio(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  if (path === '/api/studio/run' && method === 'POST') {
    let body: { request?: unknown; model?: unknown; settings?: unknown; mode?: unknown }
    try { body = JSON.parse((await readBody(req, { maxBytes: 64 * 1024 })).toString()) } catch { json(res, { error: 'bad body' }, 400); return true }
    const request = String(body?.request ?? '').trim()
    if (!request) { json(res, { error: 'A request mező kötelező.' }, 400); return true }
    pruneJobs()
    // One gen at a time (GPU serializes). Reject a second up front with a clear
    // message rather than letting runStudio throw mid-flight.
    if (isStudioBusy() || [...jobs.values()].some(j => j.status === 'running')) {
      json(res, { error: 'Már fut egy generálás — várd meg, amíg befejeződik.' }, 409); return true
    }
    const model = typeof body?.model === 'string' && body.model.trim() ? body.model.trim() : undefined
    const settings = parseSettings(body?.settings)
    const mode = body?.mode === 'image' || body?.mode === 'video' ? body.mode : undefined
    const job = startJob(request, { model, settings, mode })
    json(res, { jobId: job.id, status: job.status })
    return true
  }

  if (path === '/api/studio/job' && method === 'GET') {
    pruneJobs()
    const id = url.searchParams.get('id') || ''
    const job = jobs.get(id)
    if (!job) { json(res, { error: 'ismeretlen vagy lejárt job' }, 404); return true }
    const elapsedMs = (job.finishedAt ?? Date.now()) - job.startedAt
    const base = { status: job.status, progress: job.progress, elapsedMs }
    if (job.status === 'done' && job.result) json(res, { ...base, ...job.result })
    else if (job.status === 'error') json(res, { ...base, error: job.error })
    else json(res, base)
    return true
  }

  return false
}
