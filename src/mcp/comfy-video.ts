// Wan 2.2 TI2V-5B video generation via the homelab ComfyUI (native Wan nodes,
// no custom wrapper). Mirrors comfy-generate.ts: reuses the comfy-client helpers
// + ensureComfyUp, builds the API-format graph, and saves the produced mp4.
// The 5B TI2V model does BOTH text->video and image->video (start_image).
import { mkdirSync, writeFileSync, readFileSync, statSync, realpathSync, unlinkSync, renameSync } from 'node:fs'
import { join, basename, sep } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { PROJECT_ROOT } from '../config.js'
import { ComfyError, queuePrompt, comfyBaseUrl, type ComfyImageRef } from './comfy-client.js'
import { ensureComfyUp, freeOllamaVram } from './comfy-wake.js'

const execFileAsync = promisify(execFile)

// Wan renders at a low native fps (16 for the 14B); the motion looks choppy.
// After generation we motion-interpolate (ffmpeg minterpolate) up to TARGET_FPS,
// preserving the clip duration, for smooth playback.
const TARGET_FPS = 30

// Probe the FINAL muxed mp4 for its real facts. Interpolation changes the frame
// count, so #3-honesty (report what was actually rendered, not what was asked)
// requires measuring the output file rather than trusting the computed values.
// Best-effort: null on any ffprobe failure -> caller falls back to computed.
async function probeVideo(path: string): Promise<{ width: number; height: number; fps: number; frames: number; durationSec: number } | null> {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,nb_frames,r_frame_rate,duration',
      '-of', 'json', path,
    ], { timeout: 15_000 })
    const s = (JSON.parse(stdout).streams || [])[0]
    if (!s) return null
    const [num, den] = String(s.r_frame_rate || '').split('/').map(Number)
    const fps = den ? num / den : Number(s.r_frame_rate) || 0
    return {
      width: Number(s.width) || 0,
      height: Number(s.height) || 0,
      fps: Math.round(fps),
      frames: Number(s.nb_frames) || 0,
      durationSec: Math.round((Number(s.duration) || 0) * 100) / 100,
    }
  } catch {
    return null
  }
}

// Wan 2.2 TI2V-5B files (downloaded into the ComfyUI model dirs).
const WAN_UNET = 'wan2.2_ti2v_5B_fp16.safetensors'
const WAN_CLIP = 'umt5_xxl_fp8_e4m3fn_scaled.safetensors'
const WAN_VAE = 'wan2.2_vae.safetensors'

// Wan 2.2 A14B (MoE dual-expert) fp8 + lightx2v 4-step LoRAs -- the stronger
// model (much better photoreal humans + motion than the 5B). It is a Mixture-of-
// Experts: a high-noise and a low-noise checkpoint that ComfyUI loads SEQUENTIALLY
// (only one ~14GB fp8 expert resident at a time -> ~25-27GB peak, fits the 5090's
// 32GB after freeOllamaVram). The two experts run as two chained KSamplerAdvanced
// (high does the early/high-noise steps, low finishes). Per-expert Lightning LoRA
// keeps it to ~4 steps. Flip VIDEO_MODEL to '5b' to revert to the smaller/faster
// single-expert path (buildWanWorkflow) with no other change.
const VIDEO_MODEL: '14b' | '5b' = '14b'
const WAN14 = {
  t2v: {
    high: 'wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors',
    low: 'wan2.2_t2v_low_noise_14B_fp8_scaled.safetensors',
    loraHigh: 'wan2.2_t2v_lightx2v_4steps_lora_v1.1_high_noise.safetensors',
    loraLow: 'wan2.2_t2v_lightx2v_4steps_lora_v1.1_low_noise.safetensors',
  },
  i2v: {
    high: 'wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors',
    low: 'wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors',
    loraHigh: 'wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors',
    loraLow: 'wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors',
  },
} as const
const WAN14_VAE = 'wan_2.1_vae.safetensors' // 14B uses the 2.1 VAE, NOT the 5B's wan2.2_vae
const WAN14_FPS = 16                          // A14B is trained at 16fps (81 frames ≈ 5s)
const WAN14_SHIFT = 8.0                        // ModelSamplingSD3 sigma shift (Wan 2.2 720p default)

const OUTPUT_DIR = join(PROJECT_ROOT, 'store', 'comfy-video')

export interface VideoParams {
  prompt: string
  negative?: string
  imagePath?: string   // local path -> image->video (animate). Empty = text->video.
  width?: number
  height?: number
  seconds?: number     // requested duration; converted to frames (round(seconds*fps)). Wins over `frames`.
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
  durationSec: number  // frames / fps, rounded -- the ACTUAL clip length
  steps: number
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

// Build the Wan 2.2 A14B MoE graph: two experts (high/low noise), each with its
// Lightning LoRA + ModelSamplingSD3 shift, run as two chained KSamplerAdvanced
// (high-noise expert: steps 0..boundary with leftover noise; low-noise expert:
// boundary..end). t2v omits the start_image; i2v wires LoadImage into the latent.
function buildWan14BWorkflow(
  p: { prompt: string; negative: string; width: number; height: number; frames: number; fps: number; steps: number; cfg: number; seed: number },
  mode: 't2v' | 'i2v',
  startImageName?: string,
): Record<string, unknown> {
  const m = WAN14[mode]
  const boundary = Math.max(1, Math.min(p.steps - 1, Math.round(p.steps / 2)))
  // The 14B uses the wan_2.1_vae (8x spatial / 4x temporal). Wan22ImageToVideoLatent
  // is the 5B TI2V node and sizes the latent at 16x -> it yields HALF-resolution
  // output with the 2.1 VAE. For t2v use EmptyHunyuanLatentVideo, whose 8x/4x
  // geometry + 16-channel latent matches the 2.1 VAE (the established ComfyUI node
  // for Wan t2v). i2v still needs the start-image encode, so it keeps the Wan22
  // node (see the i2v note below).
  const latentNode: Record<string, unknown> = startImageName
    ? { class_type: 'Wan22ImageToVideoLatent', inputs: { vae: ['39', 0], width: p.width, height: p.height, length: p.frames, batch_size: 1, start_image: ['50', 0] } }
    : { class_type: 'EmptyHunyuanLatentVideo', inputs: { width: p.width, height: p.height, length: p.frames, batch_size: 1 } }

  const wf: Record<string, unknown> = {
    '37h': { class_type: 'UNETLoader', inputs: { unet_name: m.high, weight_dtype: 'default' } },
    '37l': { class_type: 'UNETLoader', inputs: { unet_name: m.low, weight_dtype: 'default' } },
    '61h': { class_type: 'LoraLoaderModelOnly', inputs: { model: ['37h', 0], lora_name: m.loraHigh, strength_model: 1.0 } },
    '61l': { class_type: 'LoraLoaderModelOnly', inputs: { model: ['37l', 0], lora_name: m.loraLow, strength_model: 1.0 } },
    '62h': { class_type: 'ModelSamplingSD3', inputs: { model: ['61h', 0], shift: WAN14_SHIFT } },
    '62l': { class_type: 'ModelSamplingSD3', inputs: { model: ['61l', 0], shift: WAN14_SHIFT } },
    '38': { class_type: 'CLIPLoader', inputs: { clip_name: WAN_CLIP, type: 'wan' } },
    '39': { class_type: 'VAELoader', inputs: { vae_name: WAN14_VAE } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: p.prompt, clip: ['38', 0] } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: p.negative, clip: ['38', 0] } },
    '55': latentNode,
    '3h': { class_type: 'KSamplerAdvanced', inputs: {
      add_noise: 'enable', noise_seed: p.seed, steps: p.steps, cfg: p.cfg, sampler_name: 'euler', scheduler: 'simple',
      model: ['62h', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['55', 0],
      start_at_step: 0, end_at_step: boundary, return_with_leftover_noise: 'enable',
    } },
    '3l': { class_type: 'KSamplerAdvanced', inputs: {
      add_noise: 'disable', noise_seed: p.seed, steps: p.steps, cfg: p.cfg, sampler_name: 'euler', scheduler: 'simple',
      model: ['62l', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['3h', 0],
      start_at_step: boundary, end_at_step: 10000, return_with_leftover_noise: 'disable',
    } },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3l', 0], vae: ['39', 0] } },
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

  const is14b = VIDEO_MODEL === '14b'
  const width = params.width ?? 1280
  const height = params.height ?? 704
  const fps = params.fps ?? (is14b ? WAN14_FPS : 24)
  // `seconds` (operator-requested duration) wins over `frames`. The Wan VAE
  // temporal stride is 4, so the latent length MUST be 4n+1 (5, 9, … 45, 49 …);
  // a non-conforming value (e.g. 48 from 2s×24fps) is silently rounded DOWN by
  // ComfyUI and the decoded mp4 ends up shorter than requested (observed 48->45).
  // Snap to the nearest valid 4n+1 so the duration is honored AND the reported
  // frame count matches the actual output. Clamped to the 5B's 5..121 range.
  const rawFrames = params.seconds != null ? Math.round(params.seconds * fps) : (params.frames ?? 49)
  const frames = Math.min(Math.max(Math.round((rawFrames - 1) / 4) * 4 + 1, 5), 121)
  // Lightning LoRAs make the 14B a ~4-step / cfg-1 model; the 5B uses 30 / cfg 5.
  // The 14B runs Lightning LoRAs (distilled for ~4-8 steps). The image-oriented
  // quality presets (20/30/45) would be slow AND degrade it, so remap any
  // requested step count into the Lightning range: Gyors(<=22)->4, Normál->6,
  // Magas(>35)->8. The 5B uses the raw value. cfg is forced to 1 for the 14B
  // because Lightning requires CFG=1 (a higher cfg produces artifacts).
  const steps = is14b
    ? (params.steps == null ? 4 : params.steps <= 22 ? 4 : params.steps <= 35 ? 6 : 8)
    : (params.steps ?? 30)
  const cfg = is14b ? 1 : (params.cfg ?? 5)
  const seed = params.seed ?? (randomBytes(4).readUInt32BE(0) % 2_000_000_000)

  const gp = { prompt: params.prompt.trim(), negative: params.negative?.trim() || '', width, height, frames, fps, steps, cfg, seed }
  const wf = is14b ? buildWan14BWorkflow(gp, mode, startImageName) : buildWanWorkflow(gp, startImageName)

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
  const durationSec = Math.round((frames / fps) * 100) / 100

  // Smooth the low native fps up to TARGET_FPS via motion-compensated
  // interpolation (clip duration preserved). Best-effort: any ffmpeg failure
  // keeps the native-fps render so a generation is never lost.
  let outFps = fps
  let outFrames = frames
  if (fps < TARGET_FPS && ext.toLowerCase() === '.mp4') {
    const rawPath = savedPath.replace(/\.mp4$/i, '.raw.mp4')
    writeFileSync(rawPath, bytes)
    try {
      await execFileAsync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', rawPath,
        '-vf', `minterpolate=fps=${TARGET_FPS}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1`,
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', savedPath],
        { timeout: 300_000, maxBuffer: 16 * 1024 * 1024 })
      outFps = TARGET_FPS
      outFrames = Math.round(durationSec * TARGET_FPS)
      try { unlinkSync(rawPath) } catch { /* keep raw if cleanup fails */ }
    } catch {
      try { renameSync(rawPath, savedPath) } catch { writeFileSync(savedPath, bytes) }
    }
  } else {
    writeFileSync(savedPath, bytes)
  }

  // Report the ACTUAL muxed file's facts (interpolation changes the frame count)
  // so the metadata matches the file the operator gets; fall back to computed.
  const probe = await probeVideo(savedPath)
  return {
    savedPath, seed,
    width: probe?.width || width,
    height: probe?.height || height,
    frames: probe?.frames || outFrames,
    fps: probe?.fps || outFps,
    durationSec: probe?.durationSec || durationSec,
    steps, mode, woke: wake.state === 'woke', freedVram,
  }
}
