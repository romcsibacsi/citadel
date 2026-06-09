// Wan 2.2 TI2V-5B video generation via the homelab ComfyUI (native Wan nodes,
// no custom wrapper). Mirrors comfy-generate.ts: reuses the comfy-client helpers
// + ensureComfyUp, builds the API-format graph, and saves the produced mp4.
// The 5B TI2V model does BOTH text->video and image->video (start_image).
import { mkdirSync, writeFileSync, readFileSync, statSync, realpathSync } from 'node:fs'
import { join, basename, sep } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { PROJECT_ROOT } from '../config.js'
import { ComfyError, queuePrompt, comfyBaseUrl, type ComfyImageRef } from './comfy-client.js'
import { ensureComfyUp, freeOllamaVram } from './comfy-wake.js'

// Wan 2.2 TI2V-5B files (downloaded into the ComfyUI model dirs).
const WAN_UNET = 'wan2.2_ti2v_5B_fp16.safetensors'
const WAN_CLIP = 'umt5_xxl_fp8_e4m3fn_scaled.safetensors'
const WAN_VAE = 'wan2.2_vae.safetensors'

const OUTPUT_DIR = join(PROJECT_ROOT, 'store', 'comfy-video')

export interface VideoParams {
  prompt: string
  negative?: string
  imagePath?: string   // local path -> image->video (animate). Empty = text->video.
  width?: number
  height?: number
  frames?: number      // latent length; 5B does up to ~121 (≈5s @ 24fps)
  fps?: number
  steps?: number
  cfg?: number
  seed?: number
}

export interface VideoResult {
  savedPath: string
  seed: number
  width: number
  height: number
  frames: number
  fps: number
  mode: 't2v' | 'i2v'
  woke: boolean
  freedVram: boolean
}

// Build the native Wan 2.2 5B API graph. With startImageName the latent node
// gets a start_image (image->video); without it, pure text->video.
function buildWanWorkflow(
  p: { prompt: string; negative: string; width: number; height: number; frames: number; fps: number; steps: number; cfg: number; seed: number },
  startImageName?: string,
): Record<string, unknown> {
  const latentInputs: Record<string, unknown> = {
    vae: ['39', 0], width: p.width, height: p.height, length: p.frames, batch_size: 1,
  }
  if (startImageName) latentInputs.start_image = ['50', 0]

  const wf: Record<string, unknown> = {
    '37': { class_type: 'UNETLoader', inputs: { unet_name: WAN_UNET, weight_dtype: 'default' } },
    '38': { class_type: 'CLIPLoader', inputs: { clip_name: WAN_CLIP, type: 'wan' } },
    '39': { class_type: 'VAELoader', inputs: { vae_name: WAN_VAE } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: p.prompt, clip: ['38', 0] } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: p.negative, clip: ['38', 0] } },
    '55': { class_type: 'Wan22ImageToVideoLatent', inputs: latentInputs },
    '3': { class_type: 'KSampler', inputs: {
      seed: p.seed, steps: p.steps, cfg: p.cfg, sampler_name: 'euler', scheduler: 'simple', denoise: 1,
      model: ['37', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['55', 0],
    } },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['39', 0] } },
    '40': { class_type: 'CreateVideo', inputs: { images: ['8', 0], fps: p.fps } },
    '41': { class_type: 'SaveVideo', inputs: { video: ['40', 0], filename_prefix: 'citadel/reel', format: 'mp4', codec: 'h264' } },
  }
  if (startImageName) wf['50'] = { class_type: 'LoadImage', inputs: { image: startImageName } }
  return wf
}

// Upload a local image into ComfyUI's input dir (for image->video). Returns the
// stored filename to reference from a LoadImage node.
// Per-request timeout so a hung-but-accepted socket (RTX 5090 bus-drop: TCP up,
// no HTTP response) cannot block forever. Kept under waitForVideoOutput's poll
// deadline so a hung fetch aborts and the deadline loop can reject -> the studio
// GPU lock (tied to the job promise settling) recovers instead of wedging.
const COMFY_REQUEST_TIMEOUT_MS = 60_000

async function uploadComfyImage(bytes: Buffer, name: string): Promise<string> {
  const form = new FormData()
  form.append('image', new Blob([new Uint8Array(bytes)]), name)
  form.append('overwrite', 'true')
  const res = await fetch(`${comfyBaseUrl()}/upload/image`, { method: 'POST', body: form, signal: AbortSignal.timeout(COMFY_REQUEST_TIMEOUT_MS) })
  if (!res.ok) throw new ComfyError(`ComfyUI /upload/image -> ${res.status}`)
  const data = await res.json() as { name?: string; subfolder?: string }
  if (!data.name) throw new ComfyError('ComfyUI /upload/image válaszában nincs name')
  return data.subfolder ? `${data.subfolder}/${data.name}` : data.name
}

// Poll /history until the run produces an output file (SaveVideo reports its
// file under one of images/gifs/videos depending on version -- scan them all).
async function waitForVideoOutput(
  promptId: string,
  opts: { timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<ComfyImageRef[]> {
  const timeoutMs = opts.timeoutMs ?? 600_000
  const intervalMs = opts.intervalMs ?? 2000
  const sleep = opts.sleep ?? ((ms: number) => new Promise(r => setTimeout(r, ms)))
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const res = await fetch(`${comfyBaseUrl()}/history/${encodeURIComponent(promptId)}`, { signal: AbortSignal.timeout(COMFY_REQUEST_TIMEOUT_MS) })
    if (res.ok) {
      const hist = await res.json() as Record<string, any>
      const entry = hist[promptId]
      if (entry) {
        if (entry.status?.status_str === 'error') throw new ComfyError(`ComfyUI futtatás hibára futott (prompt_id=${promptId})`)
        const outputs = entry.outputs || {}
        const refs: ComfyImageRef[] = []
        for (const nodeId of Object.keys(outputs)) {
          for (const key of ['images', 'gifs', 'videos']) {
            for (const f of (outputs[nodeId]?.[key] || [])) {
              if (f?.filename) refs.push({ filename: f.filename, subfolder: f.subfolder || '', type: f.type || 'output' })
            }
          }
        }
        if (refs.length) return refs
        if (entry.status?.completed === true) return refs
      }
    }
    if (Date.now() > deadline) throw new ComfyError(`ComfyUI videó-időtúllépés ${Math.round(timeoutMs / 1000)}s alatt (prompt_id=${promptId})`)
    await sleep(intervalMs)
  }
}

async function fetchOutput(ref: ComfyImageRef): Promise<Buffer> {
  const qs = new URLSearchParams({ filename: ref.filename, subfolder: ref.subfolder, type: ref.type })
  const res = await fetch(`${comfyBaseUrl()}/view?${qs.toString()}`, { signal: AbortSignal.timeout(COMFY_REQUEST_TIMEOUT_MS) })
  if (!res.ok) throw new ComfyError(`ComfyUI /view -> ${res.status} (${ref.filename})`)
  return Buffer.from(await res.arrayBuffer())
}

// Only these roots are readable as an I2V source -- the generated images and the
// operator's uploads. Prevents an arbitrary-path read through the MCP.
function resolveSourceImage(p: string): string {
  const allowed = [join(PROJECT_ROOT, 'store', 'comfy'), join(PROJECT_ROOT, 'store', 'comfy-video'), join(homedir(), 'incoming')]
  const real = realpathSync(p)
  if (!allowed.some(base => real === realpathSync(base) || real.startsWith(realpathSync(base) + sep))) {
    throw new ComfyError('A forráskép csak a store/comfy, store/comfy-video vagy ~/incoming mappából vehető.')
  }
  return real
}

export async function generateVideo(params: VideoParams): Promise<VideoResult> {
  if (!params.prompt?.trim()) throw new ComfyError('A prompt kötelező.')
  const wake = await ensureComfyUp()
  const freedVram = await freeOllamaVram()

  let startImageName: string | undefined
  const mode: 't2v' | 'i2v' = params.imagePath?.trim() ? 'i2v' : 't2v'
  if (mode === 'i2v') {
    const srcPath = resolveSourceImage(params.imagePath!.trim())
    startImageName = await uploadComfyImage(readFileSync(srcPath), basename(srcPath))
  }

  const width = params.width ?? 1280
  const height = params.height ?? 704
  const frames = Math.min(Math.max(params.frames ?? 49, 5), 121)
  const fps = params.fps ?? 24
  const steps = params.steps ?? 30
  const cfg = params.cfg ?? 5
  const seed = params.seed ?? (randomBytes(4).readUInt32BE(0) % 2_000_000_000)

  const wf = buildWanWorkflow(
    { prompt: params.prompt.trim(), negative: params.negative?.trim() || '', width, height, frames, fps, steps, cfg, seed },
    startImageName,
  )

  const clientId = `citadel-${randomBytes(4).toString('hex')}`
  const promptId = await queuePrompt(wf, clientId)
  const outs = await waitForVideoOutput(promptId)
  if (!outs.length) throw new ComfyError('A ComfyUI nem adott vissza videó-kimenetet.')

  mkdirSync(OUTPUT_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const ref = outs[outs.length - 1] // SaveVideo's mp4 is the final output
  const bytes = await fetchOutput(ref)
  const ext = ref.filename.includes('.') ? ref.filename.slice(ref.filename.lastIndexOf('.')) : '.mp4'
  const savedPath = join(OUTPUT_DIR, `${stamp}_${mode}${ext}`)
  writeFileSync(savedPath, bytes)

  return { savedPath, seed, width, height, frames, fps, mode, woke: wake.state === 'woke', freedVram }
}
