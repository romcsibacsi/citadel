// Thin HTTP client for a ComfyUI server (runs on the GPU box; CITADEL calls it
// over the LAN). The base URL is web-managed via the Vault "Rendszer-
// integrációk" card (comfy_url system-setting), read at RUNTIME so a change
// takes effect without restarting the MCP server. Pure fetch -> unit-testable.
import { getSystemSetting } from '../web/system-settings.js'

export interface ComfyImageRef {
  filename: string
  subfolder: string
  type: string
}

export class ComfyError extends Error {}

/** Base URL (no trailing slash). Throws if unset so callers surface a clear
 *  "set COMFY_URL in the dashboard" message instead of hitting localhost. */
export function comfyBaseUrl(): string {
  const raw = getSystemSetting('comfy_url').trim()
  if (!raw) throw new ComfyError('ComfyUI URL nincs beállítva — add meg a dashboard Vault → Rendszer-integrációk kártyán (comfy_url).')
  return raw.replace(/\/+$/, '')
}

async function comfyFetch(path: string, init?: RequestInit): Promise<Response> {
  const url = `${comfyBaseUrl()}${path}`
  let res: Response
  try {
    res = await fetch(url, init)
  } catch (err) {
    throw new ComfyError(`ComfyUI nem elérhető (${url}): ${err instanceof Error ? err.message : String(err)}`)
  }
  return res
}

/** Reachability + basic info. Returns the parsed /system_stats or throws. */
export async function comfyStatus(): Promise<unknown> {
  const res = await comfyFetch('/system_stats')
  if (!res.ok) throw new ComfyError(`ComfyUI /system_stats -> ${res.status}`)
  return res.json()
}

/** Available checkpoint filenames, read from /object_info. */
export async function listCheckpoints(): Promise<string[]> {
  const res = await comfyFetch('/object_info/CheckpointLoaderSimple')
  if (!res.ok) throw new ComfyError(`ComfyUI /object_info -> ${res.status}`)
  const data = await res.json() as Record<string, unknown>
  // Shape: { CheckpointLoaderSimple: { input: { required: { ckpt_name: [ [names...], {...} ] } } } }
  const node = data.CheckpointLoaderSimple as any
  const opt = node?.input?.required?.ckpt_name
  const names = Array.isArray(opt) ? opt[0] : undefined
  return Array.isArray(names) ? names.filter((n): n is string => typeof n === 'string') : []
}

/** Queue a workflow (API-format graph). Returns the prompt_id. */
export async function queuePrompt(workflow: Record<string, unknown>, clientId: string): Promise<string> {
  const res = await comfyFetch('/prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: clientId }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new ComfyError(`ComfyUI /prompt -> ${res.status}: ${text.slice(0, 400)}`)
  }
  const data = await res.json() as { prompt_id?: string }
  if (!data.prompt_id) throw new ComfyError('ComfyUI /prompt válaszában nincs prompt_id')
  return data.prompt_id
}

/** Poll /history/{id} until the run produces outputs (or times out). Returns
 *  the flat list of produced images across all SaveImage nodes. */
export async function waitForImages(
  promptId: string,
  opts: { timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<ComfyImageRef[]> {
  const timeoutMs = opts.timeoutMs ?? 180_000
  const intervalMs = opts.intervalMs ?? 1500
  const sleep = opts.sleep ?? ((ms: number) => new Promise(r => setTimeout(r, ms)))
  const deadline = Date.now() + timeoutMs

  for (;;) {
    const res = await comfyFetch(`/history/${encodeURIComponent(promptId)}`)
    if (res.ok) {
      const hist = await res.json() as Record<string, any>
      const entry = hist[promptId]
      if (entry) {
        const status = entry.status?.status_str
        if (status === 'error') {
          throw new ComfyError(`ComfyUI futtatás hibára futott (prompt_id=${promptId})`)
        }
        const outputs = entry.outputs || {}
        const images: ComfyImageRef[] = []
        for (const nodeId of Object.keys(outputs)) {
          for (const img of (outputs[nodeId]?.images || [])) {
            if (img?.filename) images.push({ filename: img.filename, subfolder: img.subfolder || '', type: img.type || 'output' })
          }
        }
        if (images.length) return images
        // entry present but no images yet AND completed -> nothing produced
        if (entry.status?.completed === true) return images
      }
    }
    if (Date.now() > deadline) throw new ComfyError(`ComfyUI időtúllépés ${Math.round(timeoutMs / 1000)}s alatt (prompt_id=${promptId})`)
    await sleep(intervalMs)
  }
}

/** Download a produced image as bytes via /view. */
export async function fetchImage(ref: ComfyImageRef): Promise<Buffer> {
  const qs = new URLSearchParams({ filename: ref.filename, subfolder: ref.subfolder, type: ref.type })
  const res = await comfyFetch(`/view?${qs.toString()}`)
  if (!res.ok) throw new ComfyError(`ComfyUI /view -> ${res.status} (${ref.filename})`)
  return Buffer.from(await res.arrayBuffer())
}
