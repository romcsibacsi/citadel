// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { randomBytes } from 'node:crypto';
import { writeFileSync, mkdirSync, existsSync, realpathSync, readFileSync, unlinkSync } from 'node:fs';
import { join, extname, isAbsolute } from 'node:path';
import { execFile } from 'node:child_process';
import { type Clock, systemClock } from '../core/clock.js';
import { createLogger } from '../core/log.js';
import { ComfyClient, ComfyUnavailable, type ComfyOutputFile } from './comfyClient.js';
import { buildImageGraph, buildFaceGraph, buildVideoGraph, buildImg2ImgGraph, buildUpscaleGraph, buildInpaintGraph, buildBgRemovalGraph, buildControlNetPoseGraph, type VideoModel } from './graphs.js';
import { runBrain, ollamaModels, studioBrainSystem, studioBrainTools, toolAllowed, GEN_TOOLS } from './brain.js';

/**
 * Studio media-generation service (PROMPT-19, FIX-studio-local). Drives the
 * operator's LOCAL ComfyUI GPU server — never the chat LLM, never an API key.
 * One generation runs at a time (the single-GPU lock taken synchronously at
 * entry, released in finally → a 2nd concurrent run is 409); the heavy render is
 * an async job the UI polls. The pipeline (README §1): ensureComfyUp →
 * freeOllamaVram → build the ComfyUI API graph (SDXL for image; Wan 2.2 A14B
 * default / 5B fallback for video, with t2v/i2v + Lightning/accurate deltas) →
 * POST /prompt → poll /history → /view → save into the Files image/video roots →
 * (video) ffmpeg interpolate to 30fps + ffprobe the FINAL file for honest facts.
 * The fake-adapter app + most tests keep a deterministic synthetic placeholder.
 *
 * The ollama "brain" (prompt-expansion / multi-step tool loop, README §6) is a
 * follow-up: this ships the minimum-viable direct path (form → graph → submit →
 * poll → save → Files); the rendering path is identical either way.
 */

const log = createLogger('studio');

export type Mode = 'image' | 'video';
export type JobStatus = 'running' | 'done' | 'error';

export interface StudioSettings {
  width?: number; height?: number; seconds?: number; frames?: number; steps?: number; cfg?: number; seed?: number; negative?: string; checkpoint?: string;
  /** LoRA pick for the txt2img path (FIX-plugin-comfy-workflows §6). */
  lora?: string; loraStrength?: number;
}
/** The ComfyUI workflow-pack kinds (FIX-plugin-comfy-workflows), reachable as Studio image-mode controls. */
export type WorkflowKind = 'img2img' | 'upscale' | 'inpaint' | 'bg-removal' | 'controlnet-pose';
export interface RunOptions {
  model?: VideoModel; sourceImage?: string; referenceImage?: string; weight?: number;
  /** Workflow pack (image mode): the source image is the allow-listed `sourceImage`. */
  workflow?: WorkflowKind; maskImage?: string; poseImage?: string;
  denoise?: number; upscaleModel?: string; controlNetName?: string; strength?: number; outpaintPad?: number;
}
/** Args for the secondary edit tools (README §6). Paths are allow-listed at use. */
export interface ToolArgs { images?: string[]; videos?: string[]; video?: string; secondsPerImage?: number; start?: number; duration?: number; at?: number }
export interface Job {
  id: string; status: JobStatus; progress: string; startedAt: number; finishedAt?: number;
  reply?: string; files?: string[]; log?: string[]; error?: string;
  /** A one-line note (e.g. a brain-fallback hint) prepended to the final log. */
  pendingNote?: string;
}

/** Live ComfyUI / GPU config, resolved per-job from operator settings. */
export interface ComfyConfig {
  url?: string;
  ssh?: string;
  checkpoint?: string;
  ollamaModel?: string;
  ollamaUrl?: string;
  /** Remote wake command run over SSH (FIX-integrations-connect §3); defaults to `bash ~/comfyui-wake.sh`. */
  wakeCmd?: string;
}

/** Injectable command runner (ssh wake, ffmpeg, ffprobe) — mocked in tests. */
export type CommandRunner = (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>;

export interface StudioOptions {
  comfy?: () => ComfyConfig;
  clock?: Clock;
  pollIntervalMs?: number;
  fetchImpl?: typeof fetch;
  runner?: CommandRunner;
}

export class StudioBadRequest extends Error {}
export class StudioBusy extends Error {}

function clampInt(v: unknown, lo: number, hi: number): number | undefined {
  const n = Number(v); if (!Number.isFinite(n)) return undefined;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}
function clampNum(v: unknown, lo: number, hi: number): number | undefined {
  const n = Number(v); if (!Number.isFinite(n)) return undefined;
  return Math.min(hi, Math.max(lo, n));
}

/** Server-authoritative clamp (README §3/§4) — drop non-numeric / out-of-range. */
export function clampSettings(raw: Record<string, unknown>): StudioSettings {
  const out: StudioSettings = {};
  const w = clampInt(raw.width, 256, 2048); if (w !== undefined) out.width = w;
  const h = clampInt(raw.height, 256, 2048); if (h !== undefined) out.height = h;
  const sec = clampNum(raw.seconds, 1, 60); if (sec !== undefined) out.seconds = sec;
  const fr = clampInt(raw.frames, 5, 121); if (fr !== undefined) out.frames = fr; // Wan per-clip cap (README §4)
  const st = clampInt(raw.steps, 1, 80); if (st !== undefined) out.steps = st;
  const cfg = clampNum(raw.cfg, 1, 20); if (cfg !== undefined) out.cfg = cfg;
  const seed = clampInt(raw.seed, 0, 4_294_967_295); if (seed !== undefined) out.seed = seed;
  if (typeof raw.negative === 'string' && raw.negative.trim() !== '') out.negative = raw.negative.trim().slice(0, 2000);
  if (typeof raw.checkpoint === 'string' && raw.checkpoint.trim() !== '') out.checkpoint = raw.checkpoint.trim();
  if (typeof raw.lora === 'string' && raw.lora.trim() !== '') out.lora = raw.lora.trim();
  const ls = clampNum(raw.loraStrength, 0, 2); if (ls !== undefined) out.loraStrength = ls;
  return out;
}

/** Coerce a model-supplied tool arg to a finite number, else undefined. */
function numOf(v: unknown): number | undefined { const n = Number(v); return Number.isFinite(n) ? n : undefined; }
/** Coerce a model-supplied tool arg to a string array. */
function strArr(v: unknown): string[] { return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []; }

const ONE_HOUR = 3600_000;
// Wall-clock cap (README §1, FIX-19): a job still "running" past this is force-failed
// so a hung GPU can never wedge the single-job lock.
const MAX_JOB_MS = 45 * 60_000;
const IMAGE_DEADLINE_MS = 180_000; // README §2
const VIDEO_DEADLINE_MS = 30 * 60_000;
// a minimal valid 1x1 PNG used as the synthetic render placeholder
const PLACEHOLDER_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

const defaultRunner: CommandRunner = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ stdout: stdout ?? '', stderr: stderr ?? '', code: err && typeof (err as { code?: number }).code === 'number' ? (err as { code: number }).code : err ? 1 : 0 });
    });
  });

export class StudioService {
  private readonly jobs = new Map<string, Job>();
  private lockHeld = false;
  private readonly comfy: () => ComfyConfig;
  private readonly clock: Clock;
  private readonly pollIntervalMs: number;
  private readonly runner: CommandRunner;
  private readonly client: ComfyClient;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly dirs: { image: string; video: string; uploads?: string },
    private readonly synthetic: boolean,
    options: StudioOptions = {},
  ) {
    this.comfy = options.comfy ?? (() => ({}));
    this.clock = options.clock ?? systemClock;
    this.pollIntervalMs = options.pollIntervalMs ?? 2000;
    this.runner = options.runner ?? defaultRunner;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.client = new ComfyClient({ baseUrl: () => this.comfy().url, fetchImpl: this.fetchImpl });
    mkdirSync(dirs.image, { recursive: true });
    mkdirSync(dirs.video, { recursive: true });
  }

  run(request: string, rawSettings: Record<string, unknown>, mode: Mode, opts: RunOptions = {}): { jobId: string; status: JobStatus } {
    if (typeof request !== 'string' || request.trim() === '') throw new StudioBadRequest('request required');
    if (this.lockHeld) throw new StudioBusy('a generation is already running');
    const settings = clampSettings(rawSettings);
    const id = randomBytes(6).toString('hex');
    const job: Job = { id, status: 'running', progress: 'a GPU előkészítése…', startedAt: this.clock.now().getTime() };
    this.jobs.set(id, job);
    this.lockHeld = true; // taken synchronously at entry; released in finally (process)
    this.startJob(job, request, settings, mode, opts);
    return { jobId: id, status: 'running' };
  }

  job(id: string): (Job & { elapsed: number }) | undefined {
    this.prune();
    const j = this.jobs.get(id);
    if (j === undefined) return undefined;
    if (j.status === 'running' && this.clock.now().getTime() - j.startedAt > MAX_JOB_MS) {
      j.status = 'error';
      j.error = 'Generation timed out (exceeded 45 minutes).';
      j.finishedAt = this.clock.now().getTime();
      this.lockHeld = false;
    }
    const end = j.finishedAt ?? this.clock.now().getTime();
    return { ...j, elapsed: Math.max(0, Math.round((end - j.startedAt) / 1000)) };
  }

  /** Serve only files under the media roots; reject anything else (realpath). */
  resolveMedia(path: string): string | null {
    return this.underRoots(path, [this.dirs.image, this.dirs.video]);
  }

  private underRoots(path: string, roots: Array<string | undefined>): string | null {
    if (path === '' || !existsSync(path)) return null;
    let real: string; try { real = realpathSync(path); } catch { return null; }
    for (const root of roots) {
      if (root === undefined) continue;
      let realRoot: string; try { realRoot = realpathSync(root); } catch { continue; }
      if (real === realRoot || real.startsWith(realRoot + '/')) return real;
    }
    return null;
  }

  private startJob(job: Job, request: string, settings: StudioSettings, mode: Mode, opts: RunOptions): void {
    if (this.synthetic) {
      setTimeout(() => this.runSynthetic(job, request, settings, mode), 200);
      return;
    }
    void this.process(job, request, settings, mode, opts).catch((err) =>
      this.failJob(job, err instanceof Error ? err.message : String(err)),
    );
  }

  /** The real local-GPU pipeline (README §1). Lock released in finally. */
  private async process(job: Job, request: string, settings: StudioSettings, mode: Mode, opts: RunOptions): Promise<void> {
    try {
      await this.ensureComfyUp(job);
      await this.freeOllamaVram();
      // An explicit workflow-pack run is a deterministic Studio control — never route
      // it through the prompt-expansion brain. Otherwise, when a local ollama brain is
      // configured + reachable, route through it (HU→EN expansion + tool pick).
      if (opts.workflow === undefined && await this.tryBrain(job, request, settings, mode, opts)) return;
      if (mode === 'video') await this.generateVideo(job, request, settings, opts);
      else if (opts.workflow !== undefined) await this.generateWorkflow(job, request, settings, opts);
      else if (opts.referenceImage !== undefined && opts.referenceImage !== '') await this.generateFaceImage(job, request, settings, opts);
      else await this.generateImage(job, request, settings);
    } catch (err) {
      this.failJob(job, err instanceof Error ? err.message : String(err));
    } finally {
      if (job.status === 'running') this.failJob(job, 'generation ended without a result');
      this.lockHeld = false; // covers errors/timeouts too (README §1)
    }
  }

  // --- render primitives: produce files (NO finishJob) so the brain can chain
  //     several per job, while the raw path wraps one render + finishJob. ---

  /** Render one SDXL image; returns the saved files + a log line. */
  private async renderImage(job: Job, prompt: string, settings: StudioSettings): Promise<{ files: string[]; log: string[] }> {
    const checkpoint = await this.resolveCheckpoint(settings.checkpoint ?? this.comfy().checkpoint);
    job.progress = 'kép renderelése…';
    const graph = buildImageGraph({
      prompt,
      negative: settings.negative ?? '',
      checkpoint,
      ...(settings.width !== undefined ? { width: settings.width } : {}),
      ...(settings.height !== undefined ? { height: settings.height } : {}),
      ...(settings.steps !== undefined ? { steps: settings.steps } : {}),
      ...(settings.cfg !== undefined ? { cfg: settings.cfg } : {}),
      ...(settings.seed !== undefined ? { seed: settings.seed } : {}),
      ...(settings.lora !== undefined ? { lora: settings.lora } : {}),
      ...(settings.loraStrength !== undefined ? { loraStrength: settings.loraStrength } : {}),
      prefix: `studio/${this.stamp(job)}`,
    });
    const promptId = await this.client.submit(graph, `studio-${job.id}`);
    const files = await this.pollAndSave(job, promptId, this.dirs.image, IMAGE_DEADLINE_MS, 1500);
    const loraNote = settings.lora !== undefined ? `, lora ${settings.lora}` : '';
    return { files, log: [`Image: ${files.length} file(s), checkpoint ${checkpoint}${loraNote} ← "${prompt.slice(0, 80)}"`] };
  }

  /** Render one InstantID character-consistent image; returns the saved files + a log line. */
  private async renderFace(job: Job, prompt: string, settings: StudioSettings, opts: { referenceImage: string; weight?: number }): Promise<{ files: string[]; log: string[] }> {
    if (!(await this.client.hasNode('InstantIDModelLoader'))) {
      throw new Error('InstantID not installed on the ComfyUI server (the InstantID custom node + its models are required for face-consistent generation).');
    }
    if (opts.referenceImage.trim() === '') throw new Error('a reference face image is required for generate_image_with_face');
    const checkpoint = await this.resolveCheckpoint(settings.checkpoint ?? this.comfy().checkpoint);
    job.progress = 'arckép feltöltése…';
    const refName = await this.uploadSource(opts.referenceImage); // allow-listed + uploaded
    job.progress = 'karakter-konzisztens kép renderelése…';
    const graph = buildFaceGraph({
      prompt,
      negative: settings.negative ?? '',
      checkpoint,
      refImageName: refName,
      ...(settings.width !== undefined ? { width: settings.width } : {}),
      ...(settings.height !== undefined ? { height: settings.height } : {}),
      ...(settings.steps !== undefined ? { steps: settings.steps } : {}),
      ...(settings.cfg !== undefined ? { cfg: settings.cfg } : {}),
      ...(opts.weight !== undefined ? { weight: opts.weight } : {}),
      ...(settings.seed !== undefined ? { seed: settings.seed } : {}),
      prefix: `studio/face-${this.stamp(job)}`,
    });
    const promptId = await this.client.submit(graph, `studio-${job.id}`);
    const files = await this.pollAndSave(job, promptId, this.dirs.image, IMAGE_DEADLINE_MS, 1500);
    return { files, log: [`Face image: ${files.length} file(s), weight ${(opts.weight ?? 0.8)} ← "${prompt.slice(0, 80)}"`] };
  }

  /** Render one Wan video (t2v/i2v), interpolate + probe; returns files, log, honest cap note. */
  private async renderVideo(job: Job, prompt: string, settings: StudioSettings, opts: { model?: VideoModel; sourceImage?: string }): Promise<{ files: string[]; log: string[]; capped: boolean }> {
    const model: VideoModel = opts.model === '5b' ? '5b' : '14b';
    let uploadedImage: string | undefined;
    if (opts.sourceImage !== undefined && opts.sourceImage !== '') {
      uploadedImage = await this.uploadSource(opts.sourceImage); // i2v
    }
    const built = buildVideoGraph(model, {
      prompt,
      negative: settings.negative ?? '',
      ...(settings.width !== undefined ? { width: settings.width } : {}),
      ...(settings.height !== undefined ? { height: settings.height } : {}),
      ...(settings.seconds !== undefined ? { seconds: settings.seconds } : {}),
      ...(settings.frames !== undefined ? { frames: settings.frames } : {}),
      ...(settings.steps !== undefined ? { steps: settings.steps } : {}),
      ...(settings.cfg !== undefined ? { cfg: settings.cfg } : {}),
      ...(settings.seed !== undefined ? { seed: settings.seed } : {}),
      ...(uploadedImage !== undefined ? { uploadedImage } : {}),
    });
    job.progress = `videó renderelése (Wan 2.2 ${model}, ${built.mode}, ${built.origin})…`;
    const promptId = await this.client.submit(built.graph, `studio-${job.id}`);
    const files = await this.pollAndSave(job, promptId, this.dirs.video, VIDEO_DEADLINE_MS, this.pollIntervalMs);

    // best-effort post-process: smooth to 30fps then ffprobe the FINAL file so the
    // reported facts are ACTUAL, not requested (interpolation changes the frame count).
    const finalFiles: string[] = [];
    const facts: string[] = [];
    for (const f of files) {
      const out = built.fps < 30 ? await this.interpolate(f) : f;
      finalFiles.push(out);
      const probed = await this.probe(out);
      facts.push(probed ?? `${built.width}×${built.height}, ${built.frames}f @${built.fps}fps (reported)`);
    }
    // honest length (README §5): a request longer than one clip's cap is ONE clip.
    const clipSec = built.frames / built.fps;
    const capped = settings.seconds !== undefined && settings.seconds > clipSec + 0.2;
    return {
      files: finalFiles,
      capped,
      log: [
        ...(capped ? [`Note: requested ${settings.seconds!.toFixed(0)}s exceeds one clip (~${clipSec.toFixed(1)}s); rendered as a single clip.`] : []),
        `Video (${built.origin}, ${built.mode}, Wan 2.2 ${model}) ← "${prompt.slice(0, 80)}"`,
        ...facts.map((f) => `Actual: ${f}`),
      ],
    };
  }

  // --- raw path (no brain): one render + finishJob -----------------------------

  private async generateImage(job: Job, request: string, settings: StudioSettings): Promise<void> {
    const r = await this.renderImage(job, request, settings);
    this.finishJob(job, r.files, [`Planned: ${request.slice(0, 80)}`, ...r.log], `Kész: ${r.files.length} kép renderelve.`);
  }

  private async generateFaceImage(job: Job, request: string, settings: StudioSettings, opts: RunOptions): Promise<void> {
    const r = await this.renderFace(job, request, settings, { referenceImage: opts.referenceImage ?? '', ...(opts.weight !== undefined ? { weight: opts.weight } : {}) });
    this.finishJob(job, r.files, [`Planned (face): ${request.slice(0, 80)}`, ...r.log], `Kész: ${r.files.length} karakter-konzisztens kép.`);
  }

  private async generateVideo(job: Job, request: string, settings: StudioSettings, opts: RunOptions): Promise<void> {
    const r = await this.renderVideo(job, request, settings, { ...(opts.model !== undefined ? { model: opts.model } : {}), ...(opts.sourceImage !== undefined ? { sourceImage: opts.sourceImage } : {}) });
    const reply = r.capped
      ? `Kész: 1 videó (a kért ${settings.seconds!.toFixed(0)}s egy klipre lett vágva).`
      : `Kész: ${r.files.length} videó renderelve.`;
    this.finishJob(job, r.files, [`Planned: ${request.slice(0, 80)}`, ...r.log], reply);
  }

  // --- workflow pack (FIX-plugin-comfy-workflows): img2img / upscale / inpaint /
  //     bg-removal / controlnet-pose. Each reuses the lock/wake/save contracts; the
  //     custom-node workflows probe hasNode → a clear "not installed" message + the
  //     lock is released in process()'s finally. ---

  private async generateWorkflow(job: Job, request: string, settings: StudioSettings, opts: RunOptions): Promise<void> {
    const r = await this.renderWorkflow(job, request, settings, opts);
    this.finishJob(job, r.files, [`Planned (${opts.workflow}): ${request.slice(0, 80)}`, ...r.log], `Kész: ${r.files.length} fájl (${opts.workflow}).`);
  }

  private renderWorkflow(job: Job, prompt: string, settings: StudioSettings, opts: RunOptions): Promise<{ files: string[]; log: string[] }> {
    switch (opts.workflow) {
      case 'img2img': return this.renderImg2Img(job, prompt, settings, opts);
      case 'upscale': return this.renderUpscale(job, opts);
      case 'inpaint': return this.renderInpaint(job, prompt, settings, opts);
      case 'bg-removal': return this.renderBgRemoval(job, opts);
      case 'controlnet-pose': return this.renderControlNetPose(job, prompt, settings, opts);
      default: throw new StudioBadRequest('unknown workflow');
    }
  }

  private async renderImg2Img(job: Job, prompt: string, settings: StudioSettings, opts: RunOptions): Promise<{ files: string[]; log: string[] }> {
    if ((opts.sourceImage ?? '').trim() === '') throw new StudioBadRequest('img2img requires a source image');
    const checkpoint = await this.resolveCheckpoint(settings.checkpoint ?? this.comfy().checkpoint);
    const name = await this.uploadSource(opts.sourceImage!);
    job.progress = 'img2img renderelése…';
    const graph = buildImg2ImgGraph({
      prompt, negative: settings.negative ?? '', checkpoint, sourceImage: name,
      ...(opts.denoise !== undefined ? { denoise: opts.denoise } : {}),
      ...(settings.steps !== undefined ? { steps: settings.steps } : {}),
      ...(settings.cfg !== undefined ? { cfg: settings.cfg } : {}),
      ...(settings.seed !== undefined ? { seed: settings.seed } : {}),
      prefix: `studio/img2img-${this.stamp(job)}`,
    });
    const promptId = await this.client.submit(graph, `studio-${job.id}`);
    const files = await this.pollAndSave(job, promptId, this.dirs.image, IMAGE_DEADLINE_MS, 1500);
    return { files, log: [`img2img: ${files.length} file(s), denoise ${(opts.denoise ?? 0.6)} ← "${prompt.slice(0, 80)}"`] };
  }

  private async renderUpscale(job: Job, opts: RunOptions): Promise<{ files: string[]; log: string[] }> {
    if ((opts.sourceImage ?? '').trim() === '') throw new StudioBadRequest('upscale requires a source image');
    if (!(await this.client.hasNode('UpscaleModelLoader'))) throw new Error('Upscale not installed on the ComfyUI server (an upscale model + the UpscaleModelLoader node are required).');
    const model = (opts.upscaleModel ?? '').trim() || (await this.client.nodeOptions('UpscaleModelLoader', 'model_name'))[0];
    if (model === undefined || model === '') throw new Error('no upscale model available on the ComfyUI server (install e.g. 4x-UltraSharp).');
    const name = await this.uploadSource(opts.sourceImage!);
    job.progress = 'felskálázás…';
    const graph = buildUpscaleGraph({ sourceImage: name, upscaleModel: model, prefix: `studio/upscale-${this.stamp(job)}` });
    const promptId = await this.client.submit(graph, `studio-${job.id}`);
    const files = await this.pollAndSave(job, promptId, this.dirs.image, IMAGE_DEADLINE_MS, 1500);
    return { files, log: [`upscale: ${files.length} file(s), model ${model}`] };
  }

  private async renderInpaint(job: Job, prompt: string, settings: StudioSettings, opts: RunOptions): Promise<{ files: string[]; log: string[] }> {
    if ((opts.sourceImage ?? '').trim() === '') throw new StudioBadRequest('inpaint requires a source image');
    const outpaint = opts.outpaintPad !== undefined && opts.outpaintPad > 0;
    if (!outpaint && (opts.maskImage ?? '').trim() === '') throw new StudioBadRequest('inpaint requires a mask image (or set outpaintPad for outpaint)');
    const checkpoint = await this.resolveCheckpoint(settings.checkpoint ?? this.comfy().checkpoint);
    const srcName = await this.uploadSource(opts.sourceImage!);
    const maskName = outpaint ? srcName : await this.uploadSource(opts.maskImage!);
    job.progress = outpaint ? 'outpaint renderelése…' : 'inpaint renderelése…';
    const graph = buildInpaintGraph({
      prompt, negative: settings.negative ?? '', checkpoint, sourceImage: srcName, maskImage: maskName,
      ...(opts.denoise !== undefined ? { denoise: opts.denoise } : {}),
      ...(settings.steps !== undefined ? { steps: settings.steps } : {}),
      ...(settings.cfg !== undefined ? { cfg: settings.cfg } : {}),
      ...(settings.seed !== undefined ? { seed: settings.seed } : {}),
      ...(outpaint ? { outpaintPad: opts.outpaintPad } : {}),
      prefix: `studio/inpaint-${this.stamp(job)}`,
    });
    const promptId = await this.client.submit(graph, `studio-${job.id}`);
    const files = await this.pollAndSave(job, promptId, this.dirs.image, IMAGE_DEADLINE_MS, 1500);
    return { files, log: [`${outpaint ? 'outpaint' : 'inpaint'}: ${files.length} file(s) ← "${prompt.slice(0, 80)}"`] };
  }

  private async renderBgRemoval(job: Job, opts: RunOptions): Promise<{ files: string[]; log: string[] }> {
    if ((opts.sourceImage ?? '').trim() === '') throw new StudioBadRequest('background removal requires a source image');
    if (!(await this.client.hasNode('RMBG'))) throw new Error('Background removal not installed on the ComfyUI server (an RMBG custom node, e.g. ComfyUI-RMBG / BRIA-RMBG, is required).');
    const name = await this.uploadSource(opts.sourceImage!);
    job.progress = 'háttér eltávolítása…';
    const graph = buildBgRemovalGraph({ sourceImage: name, prefix: `studio/cutout-${this.stamp(job)}` });
    const promptId = await this.client.submit(graph, `studio-${job.id}`);
    const files = await this.pollAndSave(job, promptId, this.dirs.image, IMAGE_DEADLINE_MS, 1500);
    return { files, log: [`background removal: ${files.length} transparent PNG(s)`] };
  }

  private async renderControlNetPose(job: Job, prompt: string, settings: StudioSettings, opts: RunOptions): Promise<{ files: string[]; log: string[] }> {
    if ((opts.poseImage ?? '').trim() === '') throw new StudioBadRequest('controlnet-pose requires a reference pose image');
    if (!(await this.client.hasNode('ControlNetLoader')) || !(await this.client.hasNode('DWPreprocessor'))) {
      throw new Error('ControlNet pose not installed on the ComfyUI server (ControlNetLoader + a DWPose/OpenPose preprocessor custom node are required).');
    }
    const cnName = (opts.controlNetName ?? '').trim() || (await this.client.nodeOptions('ControlNetLoader', 'control_net_name'))[0];
    if (cnName === undefined || cnName === '') throw new Error('no ControlNet model available on the ComfyUI server (install an SDXL OpenPose ControlNet).');
    const checkpoint = await this.resolveCheckpoint(settings.checkpoint ?? this.comfy().checkpoint);
    const poseName = await this.uploadSource(opts.poseImage!);
    job.progress = 'ControlNet póz renderelése…';
    const graph = buildControlNetPoseGraph({
      prompt, negative: settings.negative ?? '', checkpoint, controlNetName: cnName, poseImage: poseName,
      ...(opts.strength !== undefined ? { strength: opts.strength } : {}),
      ...(settings.width !== undefined ? { width: settings.width } : {}),
      ...(settings.height !== undefined ? { height: settings.height } : {}),
      ...(settings.steps !== undefined ? { steps: settings.steps } : {}),
      ...(settings.cfg !== undefined ? { cfg: settings.cfg } : {}),
      ...(settings.seed !== undefined ? { seed: settings.seed } : {}),
      prefix: `studio/pose-${this.stamp(job)}`,
    });
    const promptId = await this.client.submit(graph, `studio-${job.id}`);
    const files = await this.pollAndSave(job, promptId, this.dirs.image, IMAGE_DEADLINE_MS, 1500);
    return { files, log: [`controlnet-pose: ${files.length} file(s), strength ${(opts.strength ?? 0.8)} ← "${prompt.slice(0, 80)}"`] };
  }

  // --- the ollama brain (FIX-studio-brain, README §6) -------------------------

  /**
   * Route through the local ollama brain when configured + reachable (HU→EN prompt
   * expansion + tool pick). Returns true if it produced a result (finishJob called);
   * false → the caller runs the raw-prompt path. An UNREACHABLE ollama falls back
   * gracefully; a configured-but-MISSING model is a hard, clear error (lists models).
   */
  private async tryBrain(job: Job, request: string, settings: StudioSettings, mode: Mode, opts: RunOptions): Promise<boolean> {
    const cfg = this.comfy();
    const url = (cfg.ollamaUrl ?? '').trim();
    const model = (cfg.ollamaModel ?? '').trim();
    if (url === '' || model === '') {
      // brain not configured → raw path, with a one-line hint (FIX-studio-brain §B4)
      job.pendingNote = 'Tipp: állíts be egy helyi ollama agyat (ollama_url + ollama_model) a HU→EN prompt-bővítéshez — most a nyers prompt megy a modellbe.';
      return false;
    }
    job.progress = 'prompt bővítése (ollama agy)…';
    const models = await ollamaModels(url, this.fetchImpl);
    if (models === null) {
      job.pendingNote = `Ollama nem elérhető (${url}) — a nyers prompt megy. Ellenőrizd a hostot/tunnelt a HU→EN bővítéshez.`;
      return false;
    }
    if (!models.includes(model)) {
      throw new Error(`Ollama model "${model}" not found at ${url}. Available: ${models.join(', ') || '(none)'}`);
    }
    let genCalls = 0;
    const result = await runBrain(request, {
      ollamaUrl: url, model, fetchImpl: this.fetchImpl,
      system: studioBrainSystem(mode), tools: studioBrainTools(mode),
      now: () => this.clock.now().getTime(),
      execute: async (name, args) => {
        if (!toolAllowed(mode, name)) throw new Error(`tool "${name}" is not available in ${mode} mode`);
        if (GEN_TOOLS.has(name)) { genCalls += 1; if (genCalls > 5) throw new Error('generation cap reached (max 5 heavy tools per request)'); }
        return this.execBrainTool(job, name, args, settings, opts);
      },
    });
    if (result.files.length === 0) return false; // brain produced nothing → raw fallback
    this.finishJob(job, result.files, ['Brain (ollama) prompt-expansion + tools:', ...result.log], result.reply !== '' ? result.reply : `Kész: ${result.files.length} fájl.`);
    return true;
  }

  /** Map a brain tool call to a render primitive; UI settings OVERRIDE the model's args. */
  private async execBrainTool(job: Job, name: string, args: Record<string, unknown>, ui: StudioSettings, opts: RunOptions): Promise<{ files: string[]; log: string[] }> {
    const prompt = String(args.prompt ?? '').trim();
    const merged = this.mergeSettings(ui, args);
    const w = numOf(args.weight);
    const sec = numOf(args.seconds_per_image);
    switch (name) {
      case 'generate_image': return this.renderImage(job, prompt, merged);
      case 'generate_image_with_face': return this.renderFace(job, prompt, merged, { referenceImage: String(args.reference_image ?? ''), ...(w !== undefined ? { weight: w } : {}) });
      case 'generate_video': return (await this.renderVideo(job, prompt, merged, { ...(opts.model !== undefined ? { model: opts.model } : {}) }));
      case 'animate_image': return (await this.renderVideo(job, prompt, merged, { ...(opts.model !== undefined ? { model: opts.model } : {}), sourceImage: String(args.source_image ?? '') }));
      case 'images_to_video': return this.runTool('images_to_video', { images: strArr(args.images), ...(sec !== undefined ? { secondsPerImage: sec } : {}) });
      case 'concat_videos': return this.runTool('concat_videos', { videos: strArr(args.videos) });
      case 'trim_video': return this.runTool('trim_video', { video: String(args.video ?? ''), start: numOf(args.start) ?? 0, duration: numOf(args.duration) ?? 5 });
      case 'extract_frame': return this.runTool('extract_frame', { video: String(args.video ?? ''), at: numOf(args.at) ?? 0 });
      default: throw new Error(`unknown tool "${name}"`);
    }
  }

  /** Merge UI settings OVER the model's proposed args (the operator's preset is authoritative). */
  private mergeSettings(ui: StudioSettings, args: Record<string, unknown>): StudioSettings {
    const model = clampSettings({ width: args.width, height: args.height, seconds: args.seconds, frames: args.frames, steps: args.steps, cfg: args.cfg, seed: args.seed, negative: args.negative });
    return { ...model, ...ui };
  }

  /** explicit param → comfy_checkpoint → first reported (README §3). */
  private async resolveCheckpoint(explicit: string | undefined): Promise<string> {
    if (explicit !== undefined && explicit.trim() !== '') return explicit.trim();
    const available = await this.client.checkpoints().catch(() => [] as string[]);
    if (available.length > 0) return available[0]!;
    throw new Error('No image checkpoint available — install a model or set comfy_checkpoint.');
  }

  /** Resolve a source path (absolute, OR relative to a media root) under the allow-list (README §9). */
  private resolveSource(p: string): string | null {
    const roots = [this.dirs.image, this.dirs.video, this.dirs.uploads].filter((r): r is string => r !== undefined);
    if (isAbsolute(p)) return this.underRoots(p, roots);
    for (const root of roots) {
      const abs = join(root, p);
      if (existsSync(abs)) { const r = this.underRoots(abs, roots); if (r !== null) return r; }
    }
    return null;
  }

  private async uploadSource(sourceImage: string): Promise<string> {
    const real = this.resolveSource(sourceImage);
    if (real === null) throw new Error('source image must live under the generated-images / generated-videos / uploads roots');
    const bytes = readFileSync(real);
    const up = await this.client.uploadImage(real.split('/').pop() ?? 'source.png', bytes);
    return ComfyClient.ref(up);
  }

  private async pollAndSave(job: Job, promptId: string, dir: string, deadlineMs: number, intervalMs: number): Promise<string[]> {
    const cap = Math.min(MAX_JOB_MS, deadlineMs);
    for (;;) {
      if (job.status !== 'running') return []; // capped/closed elsewhere
      if (this.clock.now().getTime() - job.startedAt > cap) throw new Error('Generation timed out.');
      const hist = await this.client.history(promptId);
      if (hist !== null) {
        if (hist.error) throw new Error('ComfyUI reported an execution error.');
        if (hist.done) {
          if (hist.outputs.length === 0) throw new Error('ComfyUI finished but produced no output file.');
          return this.saveOutputs(job, hist.outputs, dir);
        }
      }
      await this.sleep(intervalMs);
    }
  }

  private async saveOutputs(job: Job, outputs: ComfyOutputFile[], dir: string): Promise<string[]> {
    const saved: string[] = [];
    for (const o of outputs) {
      if (this.clock.now().getTime() - job.startedAt > MAX_JOB_MS) throw new Error('Generation timed out during download.');
      const bytes = await this.client.view(o);
      const safe = `${job.id}-${o.filename.replace(/[^A-Za-z0-9._-]/g, '_')}`;
      const dest = join(dir, safe);
      writeFileSync(dest, bytes);
      saved.push(dest);
    }
    return saved;
  }

  // --- GPU wake + VRAM (README §7) -------------------------------------------

  private async ensureComfyUp(job: Job): Promise<void> {
    if (await this.client.reachable()) return;
    const ssh = (this.comfy().ssh ?? '').trim();
    if (ssh === '') throw new ComfyUnavailable('ComfyUI not running and no comfy_ssh configured for auto-start.');
    job.progress = 'GPU ébresztése…';
    const { host, port } = this.parseSsh(ssh);
    // the remote wake command is operator-configurable (a buyer's box may use a
    // different script/mechanism); default to the documented helper.
    const wakeCmd = (this.comfy().wakeCmd ?? '').trim() || 'bash ~/comfyui-wake.sh';
    const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', ...(port !== undefined ? ['-p', String(port)] : []), host, wakeCmd];
    await this.runner('ssh', args); // best-effort; the poll below is the real gate
    const deadline = this.clock.now().getTime() + 150_000;
    while (this.clock.now().getTime() < deadline) {
      await this.sleep(3000);
      if (await this.client.reachable()) return;
    }
    throw new ComfyUnavailable('ComfyUI did not come up after wake.');
  }

  private parseSsh(ssh: string): { host: string; port?: number } {
    const m = /^(.*):(\d+)$/.exec(ssh);
    if (m !== null) return { host: m[1]!, port: Number(m[2]) };
    return { host: ssh };
  }

  /**
   * Evict any loaded ollama models so brain + gen model don't OOM the GPU.
   * Best-effort AND a safe no-op when ollama is unconfigured OR on a DIFFERENT
   * machine than ComfyUI (FIX-studio-brain §B5): it only ever dials the CONFIGURED
   * `ollama_url` (never a hardcoded localhost), and never fails the generation.
   */
  private async freeOllamaVram(): Promise<void> {
    const base = (this.comfy().ollamaUrl ?? '').trim().replace(/\/+$/, '');
    if (base === '') return; // ollama not configured → nothing to free
    try {
      const ps = await this.fetchImpl(`${base}/api/ps`, { signal: AbortSignal.timeout(3000) });
      if (!ps.ok) return;
      const j = (await ps.json()) as { models?: Array<{ name?: string; model?: string }> };
      for (const m of j.models ?? []) {
        const name = m.name ?? m.model;
        if (typeof name !== 'string') continue;
        await this.fetchImpl(`${base}/api/generate`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: name, keep_alive: 0 }), signal: AbortSignal.timeout(3000),
        }).catch(() => undefined);
      }
    } catch {
      /* ollama absent/unreachable: nothing to free */
    }
  }

  // --- ffmpeg post-process (README §4) ---------------------------------------

  private async interpolate(input: string): Promise<string> {
    const out = input.replace(/\.(\w+)$/, '.30fps.$1');
    const r = await this.runner('ffmpeg', ['-y', '-i', input, '-vf', 'minterpolate=fps=30:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1', out]);
    return r.code === 0 && existsSync(out) ? out : input; // never lose a render
  }

  private async probe(file: string): Promise<string | null> {
    const r = await this.runner('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', file]);
    if (r.code !== 0) return null;
    try {
      const j = JSON.parse(r.stdout) as { streams?: Array<{ codec_type?: string; width?: number; height?: number; nb_frames?: string; r_frame_rate?: string }>; format?: { duration?: string } };
      const v = (j.streams ?? []).find((s) => s.codec_type === 'video');
      if (v === undefined) return null;
      const fr = v.r_frame_rate ?? '';
      const m = /^(\d+)\/(\d+)$/.exec(fr);
      const fps = m !== null && Number(m[2]) !== 0 ? Math.round(Number(m[1]) / Number(m[2])) : undefined;
      const dur = j.format?.duration !== undefined ? Number(j.format.duration).toFixed(1) : undefined;
      return `${v.width ?? '?'}×${v.height ?? '?'}, ${v.nb_frames ?? '?'} frames${fps !== undefined ? ` @${fps}fps` : ''}${dur !== undefined ? `, ${dur}s` : ''}`;
    } catch {
      return null;
    }
  }

  // --- secondary media tools (README §6; ffmpeg edits, no GPU lock) -----------

  /** Dispatch an edit tool. Input paths are allow-listed via resolveSource. */
  async runTool(tool: string, args: ToolArgs): Promise<{ files: string[]; log: string[] }> {
    switch (tool) {
      case 'images_to_video': return this.imagesToVideo(args.images ?? [], args.secondsPerImage ?? 2);
      case 'concat_videos': return this.concatVideos(args.videos ?? []);
      case 'trim_video': return this.trimVideo(args.video ?? '', args.start ?? 0, args.duration ?? 5);
      case 'extract_frame': return this.extractFrame(args.video ?? '', args.at ?? 0);
      default: throw new StudioBadRequest(`unknown tool: ${tool}`);
    }
  }

  private srcOrThrow(p: string): string {
    const r = this.resolveSource(p);
    if (r === null) throw new StudioBadRequest(`source not under an allow-listed root: ${p}`);
    return r;
  }
  private ffEsc(p: string): string { return p.replace(/'/g, "'\\''"); }

  private async imagesToVideo(images: string[], secondsPerImage: number): Promise<{ files: string[]; log: string[] }> {
    const paths = images.map((p) => this.srcOrThrow(p));
    if (paths.length === 0) throw new StudioBadRequest('no source images');
    const sec = clampNum(secondsPerImage, 0.2, 30) ?? 2;
    const id = randomBytes(6).toString('hex');
    const listFile = join(this.dirs.video, `.slideshow-${id}.txt`);
    const lines = paths.flatMap((p) => [`file '${this.ffEsc(p)}'`, `duration ${sec}`]);
    lines.push(`file '${this.ffEsc(paths[paths.length - 1]!)}'`); // hold the last frame
    writeFileSync(listFile, lines.join('\n'));
    const out = join(this.dirs.video, `studio-${id}.mp4`);
    const r = await this.runner('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-vsync', 'vfr', '-pix_fmt', 'yuv420p', out]);
    try { unlinkSync(listFile); } catch { /* scratch */ }
    if (r.code !== 0 || !existsSync(out)) throw new Error('ffmpeg slideshow failed');
    return { files: [out], log: [`Slideshow: ${paths.length} image(s) @ ${sec}s → ${out}`] };
  }

  private async concatVideos(videos: string[]): Promise<{ files: string[]; log: string[] }> {
    const paths = videos.map((p) => this.srcOrThrow(p));
    if (paths.length < 2) throw new StudioBadRequest('need at least 2 videos');
    const id = randomBytes(6).toString('hex');
    const listFile = join(this.dirs.video, `.concat-${id}.txt`);
    writeFileSync(listFile, paths.map((p) => `file '${this.ffEsc(p)}'`).join('\n'));
    const out = join(this.dirs.video, `studio-${id}.mp4`);
    const r = await this.runner('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-pix_fmt', 'yuv420p', out]);
    try { unlinkSync(listFile); } catch { /* scratch */ }
    if (r.code !== 0 || !existsSync(out)) throw new Error('ffmpeg concat failed');
    return { files: [out], log: [`Concat: ${paths.length} clips → ${out}`] };
  }

  private async trimVideo(video: string, start: number, duration: number): Promise<{ files: string[]; log: string[] }> {
    const src = this.srcOrThrow(video);
    const s = clampNum(start, 0, 100000) ?? 0;
    const d = clampNum(duration, 0.1, 3600) ?? 5;
    const out = join(this.dirs.video, `studio-${randomBytes(6).toString('hex')}.mp4`);
    const r = await this.runner('ffmpeg', ['-y', '-ss', String(s), '-i', src, '-t', String(d), '-c', 'copy', out]);
    if (r.code !== 0 || !existsSync(out)) throw new Error('ffmpeg trim failed');
    return { files: [out], log: [`Trim: ${s}s +${d}s → ${out}`] };
  }

  private async extractFrame(video: string, at: number): Promise<{ files: string[]; log: string[] }> {
    const src = this.srcOrThrow(video);
    const s = clampNum(at, 0, 100000) ?? 0;
    const out = join(this.dirs.image, `studio-${randomBytes(6).toString('hex')}.png`);
    const r = await this.runner('ffmpeg', ['-y', '-ss', String(s), '-i', src, '-frames:v', '1', out]);
    if (r.code !== 0 || !existsSync(out)) throw new Error('ffmpeg frame extract failed');
    return { files: [out], log: [`Frame @ ${s}s → ${out}`] };
  }

  // --- synthetic (fake adapter) ----------------------------------------------

  private runSynthetic(job: Job, request: string, settings: StudioSettings, mode: Mode): void {
    if (job.status !== 'running') return;
    try {
      const file = join(this.dirs.image, `studio-${job.id}.png`);
      writeFileSync(file, PLACEHOLDER_PNG);
      job.files = [file];
      job.log = [`Planned: ${request.slice(0, 60)}`, mode === 'video' ? `Video ready: ${file}` : `Image ready: ${file} — ${settings.width ?? 1024}×${settings.height ?? 1024}`];
      job.reply = mode === 'video' ? 'Kész: 1 videó renderelve.' : 'Kész: 1 kép renderelve.';
      job.status = 'done';
    } catch (err) {
      job.status = 'error'; job.error = String(err);
    } finally {
      job.finishedAt = this.clock.now().getTime();
      this.lockHeld = false;
    }
  }

  // --- job state helpers -----------------------------------------------------

  private finishJob(job: Job, files: string[], logLines: string[], reply: string): void {
    if (job.status !== 'running') return; // a cap fired — don't reopen a terminal job
    job.files = files;
    job.log = [...(job.pendingNote !== undefined ? [job.pendingNote] : []), ...logLines]; // surface a brain-fallback hint
    delete job.pendingNote;
    job.reply = reply;
    job.status = 'done';
    job.finishedAt = this.clock.now().getTime();
    log.info('studio generation complete', { job: job.id, files: files.length });
  }

  private failJob(job: Job, message: string): void {
    if (job.status !== 'running') return;
    job.status = 'error';
    job.error = message;
    job.finishedAt = this.clock.now().getTime();
    this.lockHeld = false;
    log.warn('studio generation failed', { job: job.id, error: message });
  }

  private stamp(job: Job): string {
    return job.id;
  }
  private sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

  private prune(): void {
    const now = this.clock.now().getTime();
    for (const [id, j] of this.jobs) if (j.finishedAt !== undefined && now - j.finishedAt > ONE_HOUR) this.jobs.delete(id);
  }
}

export const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
export const VIDEO_EXTS = new Set(['.mp4', '.webm']);
export function mediaContentType(path: string): string {
  const ext = extname(path).toLowerCase();
  const map: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm' };
  return map[ext] ?? 'application/octet-stream';
}
