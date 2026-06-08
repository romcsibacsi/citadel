import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { PROJECT_ROOT } from '../config.js'
import { getSystemSetting } from '../web/system-settings.js'
import {
  ComfyError, queuePrompt, waitForImages, fetchImage, listCheckpoints, type ComfyImageRef,
} from './comfy-client.js'

export interface GenerateParams {
  prompt: string
  negative?: string
  checkpoint?: string
  width?: number
  height?: number
  steps?: number
  cfg?: number
  sampler?: string
  scheduler?: string
  seed?: number
  batch?: number
  filenamePrefix?: string
}

export interface GenerateResult {
  savedPaths: string[]
  checkpoint: string
  seed: number
  width: number
  height: number
  steps: number
}

// Output dir is gitignored (store/) -- generated art is not source. The
// dashboard can later surface a gallery from here.
const OUTPUT_DIR = join(PROJECT_ROOT, 'store', 'comfy')

// Standard ComfyUI txt2img API graph for a SD/SDXL checkpoint. (Flux uses a
// different node set -- add a separate template if a Flux model is configured.)
export function buildTxt2ImgWorkflow(p: Required<Omit<GenerateParams, 'filenamePrefix'>> & { filenamePrefix: string }): Record<string, unknown> {
  return {
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: p.checkpoint } },
    '5': { class_type: 'EmptyLatentImage', inputs: { width: p.width, height: p.height, batch_size: p.batch } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: p.prompt, clip: ['4', 1] } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: p.negative, clip: ['4', 1] } },
    '3': { class_type: 'KSampler', inputs: {
      seed: p.seed, steps: p.steps, cfg: p.cfg, sampler_name: p.sampler, scheduler: p.scheduler,
      denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0],
    } },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: p.filenamePrefix, images: ['8', 0] } },
  }
}

// Resolve the checkpoint: explicit param > comfy_checkpoint setting > first
// checkpoint the ComfyUI server reports. Throws if the server has none.
async function resolveCheckpoint(explicit?: string): Promise<string> {
  if (explicit?.trim()) return explicit.trim()
  const fromSetting = getSystemSetting('comfy_checkpoint').trim()
  if (fromSetting) return fromSetting
  const available = await listCheckpoints()
  if (!available.length) throw new ComfyError('A ComfyUI szerveren nincs elérhető checkpoint (modell). Telepíts egyet, vagy add meg a comfy_checkpoint beállítást.')
  return available[0]
}

export async function generateImage(params: GenerateParams): Promise<GenerateResult> {
  if (!params.prompt?.trim()) throw new ComfyError('A prompt kötelező.')
  const checkpoint = await resolveCheckpoint(params.checkpoint)
  const width = params.width ?? 1024
  const height = params.height ?? 1024
  const steps = params.steps ?? 28
  const cfg = params.cfg ?? 6
  const sampler = params.sampler ?? 'euler'
  const scheduler = params.scheduler ?? 'normal'
  const batch = Math.min(Math.max(params.batch ?? 1, 1), 4)
  // 31-bit positive seed (ComfyUI KSampler accepts a wide range; keep it sane).
  const seed = params.seed ?? (randomBytes(4).readUInt32BE(0) % 2_000_000_000)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const filenamePrefix = params.filenamePrefix?.trim() || `citadel/${stamp}`

  const workflow = buildTxt2ImgWorkflow({
    prompt: params.prompt.trim(),
    negative: params.negative?.trim() || '',
    checkpoint, width, height, steps, cfg, sampler, scheduler, seed, batch, filenamePrefix,
  })

  const clientId = `citadel-${randomBytes(4).toString('hex')}`
  const promptId = await queuePrompt(workflow, clientId)
  const images: ComfyImageRef[] = await waitForImages(promptId)

  mkdirSync(OUTPUT_DIR, { recursive: true })
  const savedPaths: string[] = []
  let idx = 0
  for (const ref of images) {
    const bytes = await fetchImage(ref)
    const out = join(OUTPUT_DIR, `${stamp}_${idx}_${ref.filename.replace(/[^\w.-]/g, '_')}`)
    writeFileSync(out, bytes)
    savedPaths.push(out)
    idx++
  }

  return { savedPaths, checkpoint, seed, width, height, steps }
}
