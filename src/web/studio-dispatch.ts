import { logger } from '../logger.js'
import { sanitizeAgentIdent } from '../prompt-safety.js'
import {
  createAgentMessage,
  markMessageDelivered,
  markMessageFailed,
  type AgentMessage,
} from '../db.js'
import { runStudio } from '../studio/runtime.js'

// MUSE / REEL are "studio-backed" identities. A local-model Claude-Code tmux
// agent driving the gen tools is unreliable -- the small model wanders into the
// coding harness (TodoWrite) instead of calling generate_image/generate_video.
// So a message addressed to one of these is handled HERE by the thin Studio
// runtime (ollama native tool-calling, harness-free, uncensored muse-brain) and
// a reply is posted back to the requester. The roster names stay as addressable
// identities (dashboard chat, inter-agent); the message-router routes them here
// BEFORE any tmux delivery, so a stale agent-muse/agent-reel session (if still
// alive) never receives the message. See message-router.ts.
//
// muse -> image-leaning, reel -> video-leaning: a light Hungarian role hint is
// prepended so the small model reaches for the right tool family. The request
// text still drives the actual choice (runStudio holds all tools).
const STUDIO_AGENTS = new Map<string, string>([
  ['muse', '[Kep-keres: a felhasznalo KEPET var. Hasznald a generate_image vagy generate_image_with_face tool-t.]'],
  ['reel', '[Video-keres: a felhasznalo VIDEOT var. Hasznald a generate_video, animate_image vagy images_to_video tool-t.]'],
])

export function isStudioAgent(toAgent: string): boolean {
  return STUDIO_AGENTS.has(sanitizeAgentIdent(toAgent))
}

export type StudioRoute = 'dispatch' | 'consume' | 'pass'

// Pure routing decision (unit-testable without ollama/comfy/db):
//   'pass'     -> not addressed to a studio identity; normal router delivery.
//   'consume'  -> studio -> studio: the loop-breaker. A studio identity never
//                 legitimately INITIATES a job; if its reply (or a forged
//                 from=reel,to=muse via the public POST) were dispatched, the
//                 reply row would re-enter this intercept and burn one full GPU
//                 render per 5s tick, forever. Consume it without generating.
//   'dispatch' -> a non-studio sender asked a studio identity; generate.
export function studioRouteDecision(fromAgent: string, toAgent: string): StudioRoute {
  if (!isStudioAgent(toAgent)) return 'pass'
  if (isStudioAgent(fromAgent)) return 'consume'
  return 'dispatch'
}

// In-flight message ids so a re-scan across 5s router ticks does not re-dispatch
// the same job, plus a single global lock: the GPU does one generation at a
// time, so a second studio message waits (stays pending) until the first job
// finishes and the next tick picks it up.
const inFlight = new Set<number>()
let busy = false

// Watchdog: if a job overruns this, the requester is told and the message is
// marked failed -- but the GPU lock is NOT released here (see below). runStudio
// is internally bounded (ollama per-turn timeout + ComfyUI 180s poll deadline),
// so the lock always releases when the job's own promise settles.
const STUDIO_WATCHDOG_MS = 35 * 60 * 1000 // > the 30-min per-clip gen wait, so a slow video isn't prematurely reported failed

function formatReply(files: string[], reply: string): string {
  const body = reply.trim()
  if (files.length) {
    const list = files.map(f => `• ${f}`).join('\n')
    return `✅ Kész.\n${list}\n\nMegnyithatod/letöltheted a dashboard Fájlok oldalán.${body ? `\n\n${body}` : ''}`
  }
  return body || '(A stúdió nem készített fájlt — pontosíts a kérésen, pl. "készíts egy képet …".)'
}

// Non-blocking and idempotent: safe to call on every router tick for the same
// pending message (the in-flight set + busy lock guard it). The generation and
// the reply happen async so the 5s router loop is never blocked by a minutes-
// long render. The original message is marked delivered/failed only AFTER the
// job settles, so a dashboard restart mid-job leaves it pending and the request
// resumes. The GPU lock is released ONLY when runStudio's own promise settles
// (never at the watchdog), so a runaway render can never be joined by a second
// concurrent job on the same GPU.
export function dispatchStudioMessage(msg: AgentMessage): void {
  // Defensive: only a non-studio sender -> studio target should reach gen. The
  // router already handles 'consume'/'pass'; this keeps the function safe if
  // ever called directly with a studio -> studio row.
  if (studioRouteDecision(msg.from_agent, msg.to_agent) !== 'dispatch') return
  if (inFlight.has(msg.id)) return // this job is already running
  if (busy) return // GPU busy with another studio job; retry on the next tick
  inFlight.add(msg.id)
  busy = true

  const hint = STUDIO_AGENTS.get(sanitizeAgentIdent(msg.to_agent)) ?? ''
  const request = hint ? `${hint}\n\n${msg.content}` : msg.content
  // Canonical sender id for the reply so downstream trust/labeling sees the
  // real agent id, not a raw '@muse.' variant.
  const fromCanon = sanitizeAgentIdent(msg.to_agent)
  const replyTo = msg.from_agent
  let settled = false

  // Single settle point: posts the reply + marks the row, exactly once. Every
  // DB call is swallowed-on-throw so this async chain can never reject (no
  // unhandled rejection) and a transient DB error can never wedge the lock.
  const settle = (content: string, mark: 'delivered' | 'failed', failResult?: string): void => {
    if (settled) return
    settled = true
    try {
      createAgentMessage(fromCanon, replyTo, content)
      const ok = mark === 'delivered' ? markMessageDelivered(msg.id) : markMessageFailed(msg.id, failResult ?? '')
      if (!ok) logger.warn({ id: msg.id, mark }, 'studio: mark affected 0 rows')
    } catch (e) {
      logger.warn({ err: e, id: msg.id }, 'studio: reply/mark threw (swallowed)')
    }
  }

  logger.info({ id: msg.id, from: msg.from_agent, to: msg.to_agent }, 'Studio job started')

  // Watchdog informs the requester + marks failed if the job overruns, but does
  // NOT release the lock -- the real job still owns the GPU until it settles.
  const watchdog = setTimeout(() => {
    settle(
      `⚠️ A generálás túllépte a ${Math.round(STUDIO_WATCHDOG_MS / 60000)} percet. Lehet, hogy még fut a háttérben — nézd meg kicsit később a Fájlok oldalt.`,
      'failed',
      'studio: watchdog timeout (job may still be running)',
    )
  }, STUDIO_WATCHDOG_MS)

  runStudio(request)
    .then(
      r => settle(formatReply(r.files, r.reply), 'delivered'),
      err => {
        const m = err instanceof Error ? err.message : String(err)
        settle(`⚠️ Hiba a generálás közben: ${m}`, 'failed', `studio: ${m}`)
        logger.warn({ err, id: msg.id }, 'Studio job failed')
      },
    )
    .catch(e => logger.warn({ err: e, id: msg.id }, 'studio: settle handler threw (swallowed)'))
    .finally(() => {
      clearTimeout(watchdog)
      inFlight.delete(msg.id)
      busy = false
      logger.info({ id: msg.id, to: msg.to_agent }, 'Studio job released lock')
    })
}
