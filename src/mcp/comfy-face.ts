// Character-consistent image generation via InstantID (SDXL) on the homelab
// ComfyUI: a reference face photo -> the same identity rendered in the scene/
// style described by the prompt. Reuses the comfy-client + ensureComfyUp
// plumbing; the InstantID custom node + models are installed on the GPU box.
import { mkdirSync, writeFileSync, readFileSync, realpathSync } from 'node:fs'
import { join, sep, basename } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { PROJECT_ROOT } from '../config.js'
import { getSystemSetting } from '../web/system-settings.js'
import { ComfyError, queuePrompt, waitForImages, fetchImage, listCheckpoints, comfyBaseUrl, type ComfyImageRef } from './comfy-client.js'
import { ensureComfyUp, freeOllamaVram } from './comfy-wake.js'

const OUTPUT_DIR = join(PROJECT_ROOT, 'store', 'comfy')
const INSTANTID_FILE = 'ip-adapter.bin'
const INSTANTID_CONTROLNET = 'instantid_control.safetensors'

export interface FaceParams {
  referenceImage: string   // local path to the face photo
  prompt: string
  negative?: string
  checkpoint?: string
  width?: number
  height?: number
  steps?: number
  cfg?: number
  weight?: number          // InstantID identity strength (0-1, default 0.8)
  seed?: number
}

export interface FaceResult {
  savedPaths: string[]
  checkpoint: string
  seed: number
  weight: number
  woke: boolean
}

const ALLOWED = [join(PROJECT_ROOT, 'store', 'comfy'), join(PROJECT_ROOT, 'store', 'comfy-video'), join(homedir(), 'incoming')]

function resolveRef(p: string): string {
  let real: string
  try { real = realpathSync(p) } catch { throw new ComfyError(`Referencia-kép nem található: ${p}`) }
  const ok = ALLOWED.some(b => { try { const rb = realpathSync(b); return real === rb || real.startsWith(rb + sep) } catch { return false } })
  if (!ok) throw new ComfyError('A referencia-kép csak store/comfy, store/comfy-video vagy ~/incoming alól vehető.')
  return real
}

async function uploadComfyImage(bytes: Buffer, name: string): Promise<string> {
  const form = new FormData()
  form.append('image', new Blob([new Uint8Array(bytes)]), name)
  form.append('overwrite', 'true')
  const res = await fetch(`${comfyBaseUrl()}/upload/image`, { method: 'POST', body: form })
  if (!res.ok) throw new ComfyError(`ComfyUI /upload/image -> ${res.status}`)
  const data = await res.json() as { name?: string; subfolder?: string }
  if (!data.name) throw new ComfyError('ComfyUI /upload/image válaszában nincs name')
  return data.subfolder ? `${data.subfolder}/${data.name}` : data.name
}

async function resolveCheckpoint(explicit?: string): Promise<string> {
  if (explicit?.trim()) return explicit.trim()
  const fromSetting = getSystemSetting('comfy_checkpoint').trim()
  if (fromSetting) return fromSetting
  const available = await listCheckpoints()
  if (!available.length) throw new ComfyError('Nincs elérhető checkpoint a ComfyUI szerveren.')
  return available[0]
}

// InstantID API graph: checkpoint + InstantID model + face analysis + controlnet
// + the reference face -> ApplyInstantID patches model/conditioning -> KSampler.
function buildInstantIDWorkflow(p: {
  prompt: string; negative: string; checkpoint: string; width: number; height: number
  steps: number; cfg: number; weight: number; seed: number; refImageName: string; filenamePrefix: string
}): Record<string, unknown> {
  return {
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: p.checkpoint } },
    '10': { class_type: 'InstantIDModelLoader', inputs: { instantid_file: INSTANTID_FILE } },
    '11': { class_type: 'InstantIDFaceAnalysis', inputs: { provider: 'CPU' } },
    '12': { class_type: 'ControlNetLoader', inputs: { control_net_name: INSTANTID_CONTROLNET } },
    '13': { class_type: 'LoadImage', inputs: { image: p.refImageName } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: p.prompt, clip: ['4', 1] } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: p.negative, clip: ['4', 1] } },
    '14': { class_type: 'ApplyInstantID', inputs: {
      instantid: ['10', 0], insightface: ['11', 0], control_net: ['12', 0], image: ['13', 0],
      model: ['4', 0], positive: ['6', 0], negative: ['7', 0], weight: p.weight, start_at: 0, end_at: 1,
    } },
    '5': { class_type: 'EmptyLatentImage', inputs: { width: p.width, height: p.height, batch_size: 1 } },
    '3': { class_type: 'KSampler', inputs: {
      seed: p.seed, steps: p.steps, cfg: p.cfg, sampler_name: 'euler', scheduler: 'normal', denoise: 1,
      model: ['14', 0], positive: ['14', 1], negative: ['14', 2], latent_image: ['5', 0],
    } },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: p.filenamePrefix, images: ['8', 0] } },
  }
}

export async function generateFaceImage(params: FaceParams): Promise<FaceResult> {
  if (!params.prompt?.trim()) throw new ComfyError('A prompt kötelező.')
  if (!params.referenceImage?.trim()) throw new ComfyError('A referencia-kép (face) kötelező.')
  const wake = await ensureComfyUp()
  await freeOllamaVram() // evict the (large) agent brain so InstantID + SDXL don't OOM
  const refReal = resolveRef(params.referenceImage.trim())
  const refName = await uploadComfyImage(readFileSync(refReal), basename(refReal))
  const checkpoint = await resolveCheckpoint(params.checkpoint)
  const width = params.width ?? 1016    // slightly off 1024 to avoid InstantID watermark artifacts
  const height = params.height ?? 1016
  const steps = params.steps ?? 30
  const cfg = params.cfg ?? 4.5         // InstantID needs low CFG
  const weight = Math.min(Math.max(params.weight ?? 0.8, 0), 1)
  const seed = params.seed ?? (randomBytes(4).readUInt32BE(0) % 2_000_000_000)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')

  const workflow = buildInstantIDWorkflow({
    prompt: params.prompt.trim(), negative: params.negative?.trim() || '',
    checkpoint, width, height, steps, cfg, weight, seed, refImageName: refName, filenamePrefix: `citadel/face-${stamp}`,
  })

  const clientId = `citadel-${randomBytes(4).toString('hex')}`
  const promptId = await queuePrompt(workflow, clientId)
  const images: ComfyImageRef[] = await waitForImages(promptId, { timeoutMs: 300_000 })

  mkdirSync(OUTPUT_DIR, { recursive: true })
  const savedPaths: string[] = []
  let idx = 0
  for (const ref of images) {
    const out = join(OUTPUT_DIR, `${stamp}_face${idx}_${ref.filename.replace(/[^\w.-]/g, '_')}`)
    writeFileSync(out, await fetchImage(ref))
    savedPaths.push(out)
    idx++
  }
  return { savedPaths, checkpoint, seed, weight, woke: wake.state === 'woke' }
}
