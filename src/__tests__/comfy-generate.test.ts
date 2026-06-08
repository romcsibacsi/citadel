import { describe, it, expect, vi } from 'vitest'

// Isolate the pure workflow builder from config/.env + client side effects.
vi.mock('../config.js', () => ({ PROJECT_ROOT: '/tmp/test-citadel' }))
vi.mock('../web/system-settings.js', () => ({ getSystemSetting: () => '' }))

import { buildTxt2ImgWorkflow } from '../mcp/comfy-generate.js'

describe('buildTxt2ImgWorkflow', () => {
  const base = {
    prompt: 'a castle', negative: 'blurry', checkpoint: 'sdxl.safetensors',
    width: 768, height: 512, steps: 30, cfg: 7, sampler: 'euler', scheduler: 'normal',
    seed: 42, batch: 2, filenamePrefix: 'citadel/x',
  }

  it('produces a valid ComfyUI txt2img graph wired end to end', () => {
    const g = buildTxt2ImgWorkflow(base) as any
    // checkpoint -> model/clip/vae fan-out
    expect(g['4'].class_type).toBe('CheckpointLoaderSimple')
    expect(g['4'].inputs.ckpt_name).toBe('sdxl.safetensors')
    // positive/negative encode off the checkpoint clip
    expect(g['6'].inputs.text).toBe('a castle')
    expect(g['7'].inputs.text).toBe('blurry')
    expect(g['6'].inputs.clip).toEqual(['4', 1])
    // latent size + batch
    expect(g['5'].inputs).toMatchObject({ width: 768, height: 512, batch_size: 2 })
    // sampler wired to model/positive/negative/latent with our params
    expect(g['3'].class_type).toBe('KSampler')
    expect(g['3'].inputs).toMatchObject({ seed: 42, steps: 30, cfg: 7, sampler_name: 'euler', scheduler: 'normal', denoise: 1 })
    expect(g['3'].inputs.model).toEqual(['4', 0])
    expect(g['3'].inputs.positive).toEqual(['6', 0])
    expect(g['3'].inputs.negative).toEqual(['7', 0])
    expect(g['3'].inputs.latent_image).toEqual(['5', 0])
    // decode + save
    expect(g['8'].inputs.samples).toEqual(['3', 0])
    expect(g['9'].class_type).toBe('SaveImage')
    expect(g['9'].inputs.filename_prefix).toBe('citadel/x')
    expect(g['9'].inputs.images).toEqual(['8', 0])
  })

  it('is valid JSON-serialisable (what gets POSTed to /prompt)', () => {
    expect(() => JSON.stringify(buildTxt2ImgWorkflow(base))).not.toThrow()
  })
})
