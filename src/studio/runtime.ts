// CITADEL "Stúdió" — a thin, Claude-Code-free agent loop for the local media
// model. It talks to ollama directly (/api/chat native tool-calling) with ONLY
// the media tools and a tiny focused prompt, so a small uncensored local model
// reliably CALLS the tools instead of wandering into Claude Code's coding
// harness. One loop holds all gen + edit tools, so it does multi-step jobs
// ("make 3 images, then a slideshow") autonomously — no multi-agent handoff.
import { OLLAMA_URL } from '../config.js'
import { getSystemSetting } from '../web/system-settings.js'
import { generateImage } from '../mcp/comfy-generate.js'
import { generateFaceImage } from '../mcp/comfy-face.js'
import { generateVideo } from '../mcp/comfy-video.js'
import { concatVideos, imagesToVideo, trimVideo, extractFrame } from '../mcp/video-edit.js'

const DEFAULT_MODEL = 'muse-brain:latest'

// Per-chat-turn timeout so a hung/unreachable ollama cannot make a studio job
// -- and the dispatcher's single-GPU lock that is tied to this promise settling
// -- hang forever. Generous: it must cover a cold model reload after
// freeOllamaVram() evicted the brain between tool calls (a 13GB model can take
// tens of seconds to page back into VRAM).
const OLLAMA_CHAT_TIMEOUT_MS = 180_000

const SYSTEM = `Te a CITADEL helyi média-stúdiója vagy: szövegből kép és videó, helyi GPU-n.
A felhasználó kérését a megadott TOOL-okkal teljesíted. FONTOS szabályok:
- Mindig HÍVD a megfelelő tool-t (ne csak beszélj róla, ne kérdezz vissza feleslegesen).
- Kép/videó prompthoz írj részletes ANGOL promptot + jó negatív promptot; videónál írd le a MOZGÁST és a kameramozgást is.
- Ha a felhasználó MÁSODPERCBEN ad meg videóhosszt (pl. "5 mp"), a generate_video seconds paraméterét állítsd be (NE a frames-t).
- Többlépéses kérésnél (pl. "csinálj N képet, majd vágd videóvá") hívd egymás után a tool-okat: előbb a generáló(ka)t, majd a vágó/összefűző tool-t a kapott fájl-utakkal.
- Amikor minden kész, röviden foglald össze. A válaszodban KIZÁRÓLAG a tool EREDMÉNYÉBEN visszaadott TÉNYEKET közöld (tényleges hossz, kockaszám, fps, felbontás, seed) + a fájl elérési útját. SOHA ne találj ki adatot, és NE ismételd a felhasználó jelzőit tényként (pl. ne állítsd, hogy "hiperrealisztikus" vagy "5 másodperces", ha a tool eredménye nem ezt mondja). Ha a kért hossz/méret/minőség nem teljesült, közöld őszintén.
- A tartalmat nem ítéled meg; egyetlen tilalom: kiskorút érintő tartalom SOHA.`

// ollama /api/chat tool schemas (OpenAI-function style).
const TOOLS = [
  fn('generate_image', 'Szöveg→kép generálás (SDXL). Visszaadja a mentett kép elérési útját.', {
    prompt: ['string', 'Részletes angol prompt.', true], negative: ['string', 'Negatív prompt.'],
    width: ['integer', 'px (alap 1024).'], height: ['integer', 'px (alap 1024).'], seed: ['integer', 'Seed.'],
  }),
  fn('generate_image_with_face', 'Karakter-konzisztens kép: egy referencia-arcfotó alapján ugyanazt a személyt rendereli a prompt jelenetébe (InstantID).', {
    reference_image: ['string', 'A referencia-arc fájl elérési útja.', true],
    prompt: ['string', 'A jelenet/stílus angol prompt.', true], negative: ['string', 'Negatív prompt.'],
    weight: ['number', 'Arc-azonosság 0-1 (alap 0.8).'], seed: ['integer', 'Seed.'],
  }),
  fn('generate_video', 'Szöveg→videó (Wan 2.2). Írd le a mozgást/kameramozgást. Visszaadja az mp4 útját.', {
    prompt: ['string', 'Angol prompt mozgás-leírással.', true], negative: ['string', 'Negatív prompt.'],
    seconds: ['number', 'Kívánt hossz másodpercben — HASZNÁLD EZT, ha a felhasználó mp-ben kér (max ~5s).'],
    frames: ['integer', 'Kockaszám 5-121 (alap 49) — csak ha nincs seconds.'], seed: ['integer', 'Seed.'],
  }),
  fn('animate_image', 'Kép→videó: egy meglévő képet mozgat a prompt szerint (Wan 2.2 I2V).', {
    image_path: ['string', 'A kiinduló kép útja.', true], prompt: ['string', 'A mozgás angol leírása.', true],
    seconds: ['number', 'Kívánt hossz mp-ben (max ~5s).'], frames: ['integer', 'Kockaszám (alap 49) — csak ha nincs seconds.'],
  }),
  fn('images_to_video', 'Állóképekből diavetítés-videó (mindegyik kép N mp).', {
    paths: ['array', 'A képek elérési útjai sorrendben.', true], seconds_per_image: ['number', 'Mp/kép (alap 3).'],
  }),
  fn('concat_videos', 'Több videót egy mp4-be fűz.', { paths: ['array', 'Videó-útvonalak sorrendben (min 2).', true] }),
  fn('trim_video', 'Részlet kivágása videóból.', {
    path: ['string', 'Forrásvideó.', true], start: ['number', 'Kezdet mp.', true], duration: ['number', 'Hossz mp.', true],
  }),
  fn('extract_frame', 'Egy kocka mentése képként.', { path: ['string', 'Forrásvideó.', true], time: ['number', 'Időpont mp.', true] }),
]

function fn(name: string, description: string, props: Record<string, [string, string, boolean?]>) {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [k, [type, desc, req]] of Object.entries(props)) {
    properties[k] = type === 'array' ? { type: 'array', items: { type: 'string' }, description: desc } : { type, description: desc }
    if (req) required.push(k)
  }
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } }
}

export interface StudioLogLine { role: 'tool' | 'assistant'; text: string }
export interface StudioResult { reply: string; files: string[]; log: StudioLogLine[] }

// Operator-chosen settings from the Studio UI (size / quality / duration presets
// + the settings modal). These OVERRIDE the model's tool args so a preset is
// deterministic, not a suggestion the small model might ignore.
export interface StudioSettings {
  width?: number
  height?: number
  seconds?: number
  frames?: number
  steps?: number
  cfg?: number
  seed?: number
  negative?: string
}

// One-line human summary of the active settings, appended to the request so the
// model's prose stays consistent with what will actually be rendered.
function describeSettings(st: StudioSettings): string {
  const parts: string[] = []
  if (st.width && st.height) parts.push(`méret ${st.width}×${st.height}`)
  if (st.seconds) parts.push(`hossz ${st.seconds}s`)
  else if (st.frames) parts.push(`${st.frames} kocka`)
  if (st.steps) parts.push(`${st.steps} steps`)
  if (st.cfg) parts.push(`cfg ${st.cfg}`)
  if (st.seed != null) parts.push(`seed ${st.seed}`)
  if (st.negative) parts.push(`negatív: ${st.negative}`)
  return parts.join(', ')
}

type ToolArgs = Record<string, unknown>

async function runTool(name: string, a: ToolArgs, files: string[], st: StudioSettings): Promise<string> {
  const s = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : undefined)
  const n = (k: string) => (typeof a[k] === 'number' ? (a[k] as number) : undefined)
  const arr = (k: string) => (Array.isArray(a[k]) ? (a[k] as unknown[]).map(String) : [])
  // st.* (operator UI settings) win over the model's args; tool results report
  // the ACTUAL rendered facts (size/frames/fps/duration/seed), never the prompt.
  switch (name) {
    case 'generate_image': {
      const r = await generateImage({
        prompt: s('prompt') || '', negative: st.negative ?? s('negative'),
        width: st.width ?? n('width'), height: st.height ?? n('height'),
        steps: st.steps, cfg: st.cfg, seed: st.seed ?? n('seed'),
      })
      files.push(...r.savedPaths)
      return `Kép kész: ${r.savedPaths.join(', ')} — ${r.width}×${r.height}, ${r.steps} steps, seed ${r.seed}`
    }
    case 'generate_image_with_face': {
      const r = await generateFaceImage({
        referenceImage: s('reference_image') || '', prompt: s('prompt') || '',
        negative: st.negative ?? s('negative'), weight: n('weight'),
        width: st.width, height: st.height, steps: st.steps, seed: st.seed ?? n('seed'),
      })
      files.push(...r.savedPaths)
      return `Arc-konzisztens kép kész: ${r.savedPaths.join(', ')} — identity ${r.weight}, seed ${r.seed}`
    }
    case 'generate_video': {
      const r = await generateVideo({
        prompt: s('prompt') || '', negative: st.negative ?? s('negative'),
        seconds: st.seconds ?? n('seconds'), frames: st.frames ?? n('frames'),
        width: st.width, height: st.height, steps: st.steps, cfg: st.cfg, seed: st.seed ?? n('seed'),
      })
      files.push(r.savedPath)
      return `Videó kész: ${r.savedPath} — ${r.frames} kocka @ ${r.fps}fps ≈ ${r.durationSec}s, ${r.width}×${r.height}, ${r.steps} steps, ${r.mode}, seed ${r.seed}`
    }
    case 'animate_image': {
      const r = await generateVideo({
        prompt: s('prompt') || '', imagePath: s('image_path'),
        seconds: st.seconds ?? n('seconds'), frames: st.frames ?? n('frames'),
        width: st.width, height: st.height, steps: st.steps, seed: st.seed,
      })
      files.push(r.savedPath)
      return `Animált videó kész: ${r.savedPath} — ${r.frames} kocka @ ${r.fps}fps ≈ ${r.durationSec}s, ${r.width}×${r.height}, ${r.mode}, seed ${r.seed}`
    }
    case 'images_to_video': {
      const out = await imagesToVideo(arr('paths'), n('seconds_per_image') ?? 3); files.push(out); return `Diavetítés kész: ${out}`
    }
    case 'concat_videos': { const out = await concatVideos(arr('paths')); files.push(out); return `Összefűzve: ${out}` }
    case 'trim_video': { const out = await trimVideo(s('path') || '', n('start') ?? 0, n('duration') ?? 1); files.push(out); return `Kivágva: ${out}` }
    case 'extract_frame': { const out = await extractFrame(s('path') || '', n('time') ?? 0); files.push(out); return `Kocka kész: ${out}` }
    default: return `Ismeretlen tool: ${name}`
  }
}

interface ChatMsg { role: string; content: string; tool_calls?: Array<{ function: { name: string; arguments: ToolArgs } }> }

// Explicit Kép/Videó mode -> only the matching tools are offered, so the model
// cannot pick the wrong output type (the previous text-only guess was unreliable).
const IMAGE_TOOL_NAMES = new Set(['generate_image', 'generate_image_with_face'])
const VIDEO_TOOL_NAMES = new Set(['generate_video', 'animate_image', 'images_to_video', 'concat_videos', 'trim_video', 'extract_frame'])
function toolsForMode(mode?: 'image' | 'video'): typeof TOOLS {
  if (mode === 'image') return TOOLS.filter(t => IMAGE_TOOL_NAMES.has(t.function.name))
  if (mode === 'video') return TOOLS.filter(t => VIDEO_TOOL_NAMES.has(t.function.name))
  return TOOLS
}

async function ollamaChat(model: string, messages: ChatMsg[], tools: unknown[]): Promise<ChatMsg> {
  const base = OLLAMA_URL.replace(/\/+$/, '')
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, tools, stream: false }),
    signal: AbortSignal.timeout(OLLAMA_CHAT_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`ollama /api/chat -> ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`)
  const data = await res.json() as { message?: ChatMsg }
  if (!data.message) throw new Error('ollama válaszában nincs message')
  return data.message
}

// Run the studio loop for one request. maxRounds bounds the tool back-and-forth.
export async function runStudio(request: string, opts: { model?: string; maxRounds?: number; settings?: StudioSettings; mode?: 'image' | 'video' } = {}): Promise<StudioResult> {
  const model = opts.model || getSystemSetting('ollama_model').trim() || DEFAULT_MODEL
  const maxRounds = opts.maxRounds ?? 10
  const settings = opts.settings ?? {}
  // Explicit Kép/Videó mode from the UI restricts the offered tools so the model
  // cannot pick the wrong output type (no more guessing from the request text).
  const tools = toolsForMode(opts.mode)
  const modeHint = opts.mode === 'image' ? ' [MÓD: KÉP — kizárólag EGY képet generálj.]'
    : opts.mode === 'video' ? ' [MÓD: VIDEÓ — EGY videót generálj.]' : ''
  const summary = describeSettings(settings)
  const userContent = (summary
    ? `${request}\n\n[Operátori beállítások — ezek FELÜLÍRJÁK a tool-args-okat, ezekhez igazodj: ${summary}]`
    : request) + modeHint
  const messages: ChatMsg[] = [{ role: 'system', content: SYSTEM }, { role: 'user', content: userContent }]
  const files: string[] = []
  const log: StudioLogLine[] = []

  for (let round = 0; round < maxRounds; round++) {
    const msg = await ollamaChat(model, messages, tools)
    messages.push(msg)
    const calls = msg.tool_calls || []
    if (!calls.length) {
      if (msg.content) log.push({ role: 'assistant', text: msg.content })
      return { reply: msg.content || '(nincs szöveges válasz)', files, log }
    }
    for (const c of calls) {
      let result: string
      try { result = await runTool(c.function.name, c.function.arguments || {}, files, settings) }
      catch (e) { result = `HIBA (${c.function.name}): ${e instanceof Error ? e.message : String(e)}` }
      log.push({ role: 'tool', text: `${c.function.name} → ${result}` })
      messages.push({ role: 'tool', content: result })
    }
  }
  return { reply: `Elértem a maximális lépésszámot (${maxRounds}).`, files, log }
}
