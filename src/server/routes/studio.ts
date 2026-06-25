// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { createReadStream } from 'node:fs';
import type { Router } from '../router.js';
import { HttpError, requireOperator, sendJson } from '../router.js';
import type { AppContext } from '../../app/context.js';
import { StudioBadRequest, StudioBusy, mediaContentType, type Mode, type RunOptions } from '../../studio/service.js';

/**
 * Studio routes (PROMPT-19): the async run + poll contract (submit returns a job
 * id, render happens out-of-band) + a contained media server. The GPU lock (one
 * job at a time → 409) and the parameter clamp are server-authoritative.
 */
export function registerStudioRoutes(router: Router, ctx: AppContext): void {
  router.post('/api/studio/run', (c) => {
    requireOperator(c);
    const body = (c.body ?? {}) as { request?: string; settings?: Record<string, unknown>; mode?: string; model?: string; sourceImage?: string; referenceImage?: string; weight?: number; workflow?: string; maskImage?: string; poseImage?: string; denoise?: number; upscaleModel?: string; controlNetName?: string; strength?: number; outpaintPad?: number };
    const mode: Mode = body.mode === 'video' ? 'video' : 'image';
    const opts: RunOptions = {};
    if (body.model === '5b' || body.model === '14b') opts.model = body.model;
    if (typeof body.sourceImage === 'string' && body.sourceImage !== '') opts.sourceImage = body.sourceImage;
    // workflow pack (image mode only, FIX-plugin-comfy-workflows): a deterministic
    // ComfyUI workflow over an allow-listed source image — never the brain.
    const WORKFLOWS = new Set(['img2img', 'upscale', 'inpaint', 'bg-removal', 'controlnet-pose']);
    if (typeof body.workflow === 'string' && WORKFLOWS.has(body.workflow)) {
      if (mode === 'video') throw new HttpError(400, ctx.i18n.t('studio.error.requestRequired'));
      opts.workflow = body.workflow as RunOptions['workflow'];
      if (typeof body.maskImage === 'string' && body.maskImage !== '') opts.maskImage = body.maskImage;
      if (typeof body.poseImage === 'string' && body.poseImage !== '') opts.poseImage = body.poseImage;
      if (typeof body.denoise === 'number' && Number.isFinite(body.denoise)) opts.denoise = body.denoise;
      if (typeof body.upscaleModel === 'string' && body.upscaleModel !== '') opts.upscaleModel = body.upscaleModel;
      if (typeof body.controlNetName === 'string' && body.controlNetName !== '') opts.controlNetName = body.controlNetName;
      if (typeof body.strength === 'number' && Number.isFinite(body.strength)) opts.strength = body.strength;
      if (typeof body.outpaintPad === 'number' && Number.isFinite(body.outpaintPad)) opts.outpaintPad = body.outpaintPad;
    }
    // image-mode character-consistent generation (InstantID, FIX-studio-3): a
    // reference face + identity-strength route the run to the face graph. A
    // reference face only applies in image mode — reject the conflicting combo
    // rather than silently dropping it (a video start frame is `sourceImage`).
    if (typeof body.referenceImage === 'string' && body.referenceImage !== '') {
      if (mode === 'video') throw new HttpError(400, ctx.i18n.t('studio.error.faceImageOnly'));
      opts.referenceImage = body.referenceImage;
    }
    if (typeof body.weight === 'number' && Number.isFinite(body.weight)) opts.weight = body.weight;
    try {
      sendJson(c.res, 200, ctx.studio.run(body.request ?? '', body.settings ?? {}, mode, opts));
    } catch (err) {
      if (err instanceof StudioBadRequest) throw new HttpError(400, ctx.i18n.t('studio.error.requestRequired'));
      if (err instanceof StudioBusy) throw new HttpError(409, ctx.i18n.t('studio.error.busy'));
      throw err;
    }
  });

  // Secondary edit tools (README §6): ffmpeg slideshow / concat / trim / frame —
  // CPU-only (no GPU lock), operator-gated. Input paths are allow-listed in the service.
  router.post('/api/studio/tool', async (c) => {
    requireOperator(c);
    const body = (c.body ?? {}) as { tool?: string; args?: Record<string, unknown> };
    try {
      sendJson(c.res, 200, await ctx.studio.runTool(body.tool ?? '', (body.args ?? {}) as never));
    } catch (err) {
      if (err instanceof StudioBadRequest) throw new HttpError(400, err.message);
      throw new HttpError(502, err instanceof Error ? err.message : 'tool failed');
    }
  });

  router.get('/api/studio/job/:id', (c) => {
    requireOperator(c);
    const job = ctx.studio.job(c.params.id ?? '');
    if (job === undefined) throw new HttpError(404, ctx.i18n.t('studio.error.jobLost'));
    sendJson(c.res, 200, job);
  });

  // Contained media server. Operator-only, but — like /api/files/raw — it is the
  // documented exception that accepts ?token= in the query (AUTH_POLICY.allowTokenQuery)
  // so an <img>/<video> can load it without an Authorization header (FIX-polish §7).
  // requireOperator still rejects an agent bearer; realpath containment confines it.
  router.get('/api/studio/media', (c) => {
    requireOperator(c);
    const path = c.url.searchParams.get('path') ?? '';
    const real = ctx.studio.resolveMedia(path);
    if (real === null) throw new HttpError(404, 'not found');
    c.res.writeHead(200, { 'content-type': mediaContentType(real), 'cache-control': 'private, max-age=60', 'x-content-type-options': 'nosniff' });
    createReadStream(real).pipe(c.res);
  });
}
