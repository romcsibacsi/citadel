// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { seedDir } from '../app/scaffold.js';

/**
 * ComfyUI API-format graph construction (FIX-studio-local). The literal node
 * graphs live as data assets in seed/comfy/ (the operator's external-service
 * contract, NOT orchestration code); here we load one, substitute its <<token>>
 * placeholders with real values (numeric tokens become JSON numbers), and — for
 * Wan 2.2 video — apply the t2v↔i2v and Lightning↔accurate deltas described in
 * each graph's _variants block + the README.
 */

export type Graph = Record<string, unknown>;

/** Load a graph template, stripping the documentation-only `_*` meta keys. */
function loadTemplate(name: string): Graph {
  const raw = readFileSync(join(seedDir(), 'comfy', name), 'utf8');
  const obj = JSON.parse(raw) as Record<string, unknown>;
  const clean: Graph = {};
  for (const [k, v] of Object.entries(obj)) if (!k.startsWith('_')) clean[k] = v;
  return clean;
}

/** Replace a value that is EXACTLY `<<name>>` with the typed token value. */
function substitute(node: unknown, tokens: Record<string, string | number>): unknown {
  if (typeof node === 'string') {
    const m = /^<<(.+)>>$/.exec(node);
    if (m !== null && Object.prototype.hasOwnProperty.call(tokens, m[1]!)) return tokens[m[1]!];
    return node;
  }
  if (Array.isArray(node)) return node.map((n) => substitute(n, tokens));
  if (node !== null && typeof node === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) o[k] = substitute(v, tokens);
    return o;
  }
  return node;
}

const clampInt = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, Math.round(v)));
const clampNum = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
export function randomSeed(): number {
  return randomBytes(4).readUInt32BE(0);
}

// --- IMAGE (SDXL, README §3) -------------------------------------------------

export interface ImageParams {
  prompt: string; negative: string; checkpoint: string;
  width?: number; height?: number; batch?: number; steps?: number; cfg?: number; seed?: number; prefix?: string;
  /** Optional LoRA (FIX-plugin-comfy-workflows §6): a LoraLoader is spliced between
   *  the checkpoint and the sampler/CLIP, scaled by loraStrength (0..2). */
  lora?: string; loraStrength?: number;
}

export function buildImageGraph(p: ImageParams): Graph {
  const tokens: Record<string, string | number> = {
    prompt: p.prompt,
    negative: p.negative,
    checkpoint: p.checkpoint,
    width: clampInt(p.width ?? 1024, 256, 2048),
    height: clampInt(p.height ?? 1024, 256, 2048),
    batch: clampInt(p.batch ?? 1, 1, 4),
    steps: clampInt(p.steps ?? 28, 1, 80),
    cfg: clampNum(p.cfg ?? 6, 1, 20),
    seed: p.seed ?? randomSeed(),
    prefix: p.prefix ?? 'studio/image',
  };
  const graph = substitute(loadTemplate('image-sdxl.api.json'), tokens) as Graph;
  if (p.lora !== undefined && p.lora.trim() !== '') return withLora(graph, p.lora.trim(), clampNum(p.loraStrength ?? 0.8, 0, 2));
  return graph;
}

/**
 * Splice a LoraLoader into an SDXL graph: it takes model+clip from the checkpoint (4)
 * and the sampler (3) + both CLIPTextEncodes (6,7) are repointed at the LoRA outputs,
 * so the LoRA scales BOTH the unet and the text encoder (standard ComfyUI wiring).
 */
function withLora(graph: Graph, loraName: string, strength: number): Graph {
  const g = graph as Record<string, Record<string, unknown>>;
  g['12'] = { class_type: 'LoraLoader', inputs: { lora_name: loraName, strength_model: strength, strength_clip: strength, model: ['4', 0], clip: ['4', 1] } };
  if (g['3']) (g['3'].inputs as Record<string, unknown>).model = ['12', 0];
  if (g['6']) (g['6'].inputs as Record<string, unknown>).clip = ['12', 1];
  if (g['7']) (g['7'].inputs as Record<string, unknown>).clip = ['12', 1];
  return g;
}

// --- WORKFLOW PACK (FIX-plugin-comfy-workflows) ------------------------------

export interface Img2ImgParams { prompt: string; negative: string; checkpoint: string; sourceImage: string; denoise?: number; steps?: number; cfg?: number; seed?: number; prefix?: string }
export function buildImg2ImgGraph(p: Img2ImgParams): Graph {
  return substitute(loadTemplate('image-img2img.api.json'), {
    prompt: p.prompt, negative: p.negative, checkpoint: p.checkpoint, source_image: p.sourceImage,
    denoise: clampNum(p.denoise ?? 0.6, 0.05, 1),
    steps: clampInt(p.steps ?? 28, 1, 80), cfg: clampNum(p.cfg ?? 6, 1, 20),
    seed: p.seed ?? randomSeed(), prefix: p.prefix ?? 'studio/img2img',
  }) as Graph;
}

export interface UpscaleParams { sourceImage: string; upscaleModel: string; prefix?: string }
export function buildUpscaleGraph(p: UpscaleParams): Graph {
  return substitute(loadTemplate('image-upscale.api.json'), {
    source_image: p.sourceImage, upscale_model: p.upscaleModel, prefix: p.prefix ?? 'studio/upscale',
  }) as Graph;
}

export interface InpaintParams { prompt: string; negative: string; checkpoint: string; sourceImage: string; maskImage: string; denoise?: number; steps?: number; cfg?: number; seed?: number; outpaintPad?: number; prefix?: string }
export function buildInpaintGraph(p: InpaintParams): Graph {
  const graph = substitute(loadTemplate('image-inpaint.api.json'), {
    prompt: p.prompt, negative: p.negative, checkpoint: p.checkpoint, source_image: p.sourceImage, mask_image: p.maskImage,
    denoise: clampNum(p.denoise ?? 0.8, 0.05, 1),
    steps: clampInt(p.steps ?? 28, 1, 80), cfg: clampNum(p.cfg ?? 6, 1, 20),
    seed: p.seed ?? randomSeed(), prefix: p.prefix ?? 'studio/inpaint',
  }) as Graph;
  // OUTPAINT: pad the source by N px per side and feed the generated alpha as the mask.
  if (p.outpaintPad !== undefined && p.outpaintPad > 0) {
    const g = graph as Record<string, Record<string, unknown>>;
    const pad = clampInt(p.outpaintPad, 8, 512);
    g['14'] = { class_type: 'ImagePadForOutpaint', inputs: { image: ['10', 0], left: pad, top: pad, right: pad, bottom: pad, feathering: 24 } };
    (g['13']!.inputs as Record<string, unknown>).pixels = ['14', 0];
    (g['13']!.inputs as Record<string, unknown>).mask = ['14', 1]; // the pad node emits the outpaint mask
    delete g['12']; // no separate mask image in outpaint mode
  }
  return graph;
}

export interface BgRemovalParams { sourceImage: string; prefix?: string }
export function buildBgRemovalGraph(p: BgRemovalParams): Graph {
  return substitute(loadTemplate('image-bg-removal.api.json'), { source_image: p.sourceImage, prefix: p.prefix ?? 'studio/cutout' }) as Graph;
}

export interface ControlNetPoseParams { prompt: string; negative: string; checkpoint: string; controlNetName: string; poseImage: string; strength?: number; width?: number; height?: number; steps?: number; cfg?: number; seed?: number; prefix?: string }
export function buildControlNetPoseGraph(p: ControlNetPoseParams): Graph {
  return substitute(loadTemplate('image-controlnet-pose.api.json'), {
    prompt: p.prompt, negative: p.negative, checkpoint: p.checkpoint, control_net_name: p.controlNetName, pose_image: p.poseImage,
    strength: clampNum(p.strength ?? 0.8, 0, 2),
    width: clampInt(p.width ?? 1024, 256, 2048), height: clampInt(p.height ?? 1024, 256, 2048),
    steps: clampInt(p.steps ?? 28, 1, 80), cfg: clampNum(p.cfg ?? 6, 1, 20),
    seed: p.seed ?? randomSeed(), prefix: p.prefix ?? 'studio/pose',
  }) as Graph;
}

// --- CHARACTER-CONSISTENT IMAGE (InstantID, README §3a) ----------------------

export interface FaceParams {
  prompt: string; negative: string; checkpoint: string; refImageName: string;
  width?: number; height?: number; steps?: number; cfg?: number; weight?: number; seed?: number; prefix?: string;
}

/**
 * Build the InstantID face graph: a reference face → the same identity rendered
 * into the prompt's scene. Defaults per README §3a: 1016² (off-1024 avoids the
 * InstantID watermark), 30 steps, cfg 4.5 (InstantID needs LOW cfg, clamp keeps
 * it sane), weight 0.8 (identity strength, clamp 0..1).
 */
export function buildFaceGraph(p: FaceParams): Graph {
  const tokens: Record<string, string | number> = {
    prompt: p.prompt,
    negative: p.negative,
    checkpoint: p.checkpoint,
    ref_image_name: p.refImageName,
    width: clampInt(p.width ?? 1016, 256, 2048),
    height: clampInt(p.height ?? 1016, 256, 2048),
    steps: clampInt(p.steps ?? 30, 1, 80),
    cfg: clampNum(p.cfg ?? 4.5, 1, 5), // InstantID needs LOW cfg (README §3a) — clamp ≤5, not the SDXL 1..20
    weight: clampNum(p.weight ?? 0.8, 0, 1),
    seed: p.seed ?? randomSeed(),
    prefix: p.prefix ?? 'studio/face',
  };
  return substitute(loadTemplate('image-face-instantid.api.json'), tokens) as Graph;
}

// --- VIDEO (Wan 2.2, README §4) ----------------------------------------------

/** Always folded into the video negative (the model is prone to extra limbs). */
export const ANATOMY_NEGATIVE =
  'extra limbs, extra legs, extra arms, three legs, missing limbs, deformed, bad anatomy, mutated, fused fingers, extra fingers, distorted, low quality, blurry, watermark, text';

/**
 * Snap a requested duration to a Wan-legal latent length. The VAE temporal stride
 * is 4 so length MUST be 4n+1; `seconds` wins over `frames`. A non-conforming
 * value is silently rounded DOWN by ComfyUI, so snapping keeps duration honest.
 */
export function snapFrames(opts: { seconds?: number; frames?: number; fps: number }): number {
  const raw = opts.seconds !== undefined && opts.seconds > 0
    ? Math.round(opts.seconds * opts.fps)
    : (opts.frames ?? 49);
  const snapped = Math.round((raw - 1) / 4) * 4 + 1;
  return clampInt(snapped, 5, 121);
}

export type VideoModel = '14b' | '5b';

export interface VideoParams {
  prompt: string; negative?: string;
  width?: number; height?: number;
  seconds?: number; frames?: number; steps?: number; cfg?: number; seed?: number; fps?: number;
  /** i2v: the uploaded source-image name returned by /upload/image (subfolder/name or name). */
  uploadedImage?: string;
}

export interface BuiltVideo { graph: Graph; fps: number; frames: number; width: number; height: number; steps: number; mode: 'lightning' | 'accurate'; origin: 't2v' | 'i2v' }

/** Build a Wan 2.2 video graph (A14B default, 5B fallback) with all README §4 rules applied. */
export function buildVideoGraph(model: VideoModel, p: VideoParams): BuiltVideo {
  const i2v = p.uploadedImage !== undefined && p.uploadedImage !== '';
  const requestedSteps = p.steps;
  const accurate = requestedSteps !== undefined && requestedSteps > 12;
  const fps = p.fps ?? (model === '14b' ? 16 : 24);
  const frames = snapFrames({ ...(p.seconds !== undefined ? { seconds: p.seconds } : {}), ...(p.frames !== undefined ? { frames: p.frames } : {}), fps });

  // resolution: accurate mode caps the max side to ~960 (/16) because cfg>1 doubles activation memory
  let width = clampInt(p.width ?? (model === '14b' ? 1280 : 1280), 256, 2048);
  let height = clampInt(p.height ?? (model === '14b' ? 704 : 704), 256, 2048);
  if (accurate) {
    const cap = 960;
    const scale = Math.min(1, cap / Math.max(width, height));
    width = Math.round((width * scale) / 16) * 16;
    height = Math.round((height * scale) / 16) * 16;
  }
  const steps = accurate ? clampInt(requestedSteps ?? 20, 10, 40) : clampInt(requestedSteps ?? 4, 2, 8);
  const cfg = accurate ? clampNum(p.cfg ?? 4.5, 1, 20) : 1;
  const seed = p.seed ?? randomSeed();
  const boundary = Math.max(1, Math.min(steps - 1, Math.round(steps / 2)));
  const negative = [ANATOMY_NEGATIVE, (p.negative ?? '').trim()].filter((s) => s !== '').join(', ');

  const tokens: Record<string, string | number> = {
    prompt: p.prompt, negative, width, height, frames, seed, steps, cfg, fps, boundary,
    uploaded_input_name: p.uploadedImage ?? '',
  };

  const graph = (model === '14b'
    ? build14b(substitute(loadTemplate('video-wan22-14b.api.json'), tokens) as Graph, { i2v, accurate, width, height, frames, uploaded: p.uploadedImage ?? '' })
    : build5b(substitute(loadTemplate('video-wan22-5b.api.json'), tokens) as Graph, { i2v, uploaded: p.uploadedImage ?? '' }));

  return { graph, fps, frames, width, height, steps, mode: accurate ? 'accurate' : 'lightning', origin: i2v ? 'i2v' : 't2v' };
}

function build14b(graph: Graph, o: { i2v: boolean; accurate: boolean; width: number; height: number; frames: number; uploaded: string }): Graph {
  const g = graph as Record<string, Record<string, unknown>>;
  if (o.accurate) {
    // accurate mode: drop the Lightning LoRAs and point the model-sampling nodes at the raw unets
    delete g['61h'];
    delete g['61l'];
    (g['62h']!.inputs as Record<string, unknown>).model = ['37h', 0];
    (g['62l']!.inputs as Record<string, unknown>).model = ['37l', 0];
  }
  if (o.i2v) {
    // i2v: LoadImage → WanImageToVideo (VAE-encodes the start image + injects conditioning)
    g['50'] = { class_type: 'LoadImage', inputs: { image: o.uploaded } };
    g['55'] = {
      class_type: 'WanImageToVideo',
      inputs: { positive: ['6', 0], negative: ['7', 0], vae: ['39', 0], width: o.width, height: o.height, length: o.frames, batch_size: 1, start_image: ['50', 0] },
    };
    // rewire both samplers onto WanImageToVideo's conditioning + latent
    const hi = g['3h']!.inputs as Record<string, unknown>;
    hi.positive = ['55', 0]; hi.negative = ['55', 1]; hi.latent_image = ['55', 2];
    const lo = g['3l']!.inputs as Record<string, unknown>;
    lo.positive = ['55', 0]; lo.negative = ['55', 1]; // latent_image stays ['3h',0]
  }
  return g;
}

function build5b(graph: Graph, o: { i2v: boolean; uploaded: string }): Graph {
  const g = graph as Record<string, Record<string, unknown>>;
  if (o.i2v) {
    g['50'] = { class_type: 'LoadImage', inputs: { image: o.uploaded } };
    (g['55']!.inputs as Record<string, unknown>).start_image = ['50', 0];
  }
  return g;
}
