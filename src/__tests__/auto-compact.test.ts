import { describe, it, expect } from 'vitest'
import {
  contextWindowForModel,
  normalizeAutoCompactConfig,
  compactDue,
  DEFAULT_AUTO_COMPACT,
  type AutoCompactConfig,
} from '../auto-compact.js'

describe('contextWindowForModel', () => {
  it('maps the 1M-context Opus variants to 1,000,000', () => {
    expect(contextWindowForModel('claude-opus-4-8[1m]')).toBe(1_000_000)
    expect(contextWindowForModel('claude-opus-4-8 1m')).toBe(1_000_000)
    expect(contextWindowForModel('CLAUDE-OPUS-4-8[1M]')).toBe(1_000_000)
  })
  it('maps everything else (and unknown/empty) to the standard 200k window', () => {
    expect(contextWindowForModel('claude-sonnet-4-6')).toBe(200_000)
    expect(contextWindowForModel('claude-opus-4-8')).toBe(200_000)
    expect(contextWindowForModel('')).toBe(200_000)
    expect(contextWindowForModel(null)).toBe(200_000)
    expect(contextWindowForModel(undefined)).toBe(200_000)
  })
})

describe('normalizeAutoCompactConfig', () => {
  it('returns safe defaults for junk input', () => {
    expect(normalizeAutoCompactConfig(null)).toEqual(DEFAULT_AUTO_COMPACT)
    expect(normalizeAutoCompactConfig('nope')).toEqual(DEFAULT_AUTO_COMPACT)
    expect(normalizeAutoCompactConfig({})).toEqual(DEFAULT_AUTO_COMPACT)
  })
  it('clamps the fraction to [0,1] and keeps a positive anti-thrash floor', () => {
    expect(normalizeAutoCompactConfig({ thresholdFraction: 1.5 }).thresholdFraction).toBe(1)
    expect(normalizeAutoCompactConfig({ thresholdFraction: -0.3 }).thresholdFraction).toBe(0)
    expect(normalizeAutoCompactConfig({ minIntervalMs: 0 }).minIntervalMs).toBe(DEFAULT_AUTO_COMPACT.minIntervalMs)
    expect(normalizeAutoCompactConfig({ minIntervalMs: -5 }).minIntervalMs).toBe(DEFAULT_AUTO_COMPACT.minIntervalMs)
  })
  it('enabled is true unless explicitly false', () => {
    expect(normalizeAutoCompactConfig({ enabled: false }).enabled).toBe(false)
    expect(normalizeAutoCompactConfig({ enabled: 'yes' }).enabled).toBe(true)
    expect(normalizeAutoCompactConfig({}).enabled).toBe(true)
  })
})

const BASE: AutoCompactConfig = { enabled: true, thresholdFraction: 0.8, intervalMs: 0, minIntervalMs: 600_000 }

describe('compactDue - threshold trigger', () => {
  it('fires when live context reaches the fraction of the window (1M model)', () => {
    // 800k of a 1M window == 80% -> fire.
    expect(compactDue({ contextTokens: 800_000, windowTokens: 1_000_000, lastCompactAtMs: null, nowMs: 0, cfg: BASE })).toBe(true)
  })
  it('does NOT fire below the fraction', () => {
    expect(compactDue({ contextTokens: 700_000, windowTokens: 1_000_000, lastCompactAtMs: null, nowMs: 0, cfg: BASE })).toBe(false)
  })
  it('scales to the 200k window (160k == 80%)', () => {
    expect(compactDue({ contextTokens: 160_000, windowTokens: 200_000, lastCompactAtMs: null, nowMs: 0, cfg: BASE })).toBe(true)
    expect(compactDue({ contextTokens: 150_000, windowTokens: 200_000, lastCompactAtMs: null, nowMs: 0, cfg: BASE })).toBe(false)
  })
  it('does NOT fire when context could not be read (null)', () => {
    expect(compactDue({ contextTokens: null, windowTokens: 1_000_000, lastCompactAtMs: null, nowMs: 0, cfg: BASE })).toBe(false)
  })
})

describe('compactDue - anti-thrash floor', () => {
  it('suppresses a second compact inside minIntervalMs even when over threshold', () => {
    expect(compactDue({ contextTokens: 900_000, windowTokens: 1_000_000, lastCompactAtMs: 1_000, nowMs: 1_000 + 60_000, cfg: BASE })).toBe(false)
  })
  it('allows it again once the floor has elapsed', () => {
    expect(compactDue({ contextTokens: 900_000, windowTokens: 1_000_000, lastCompactAtMs: 1_000, nowMs: 1_000 + 700_000, cfg: BASE })).toBe(true)
  })
})

describe('compactDue - scheduled trigger (window-independent fallback)', () => {
  const sched: AutoCompactConfig = { ...BASE, thresholdFraction: 0, intervalMs: 12 * 3_600_000 }
  it('fires after intervalMs since the last compact, regardless of context', () => {
    expect(compactDue({ contextTokens: null, windowTokens: 1_000_000, lastCompactAtMs: 0, nowMs: 13 * 3_600_000, cfg: sched })).toBe(true)
  })
  it('does NOT fire before the interval elapses', () => {
    expect(compactDue({ contextTokens: null, windowTokens: 1_000_000, lastCompactAtMs: 0, nowMs: 6 * 3_600_000, cfg: sched })).toBe(false)
  })
  it('never fires before the seed (lastCompactAtMs null)', () => {
    expect(compactDue({ contextTokens: null, windowTokens: 1_000_000, lastCompactAtMs: null, nowMs: 999 * 3_600_000, cfg: sched })).toBe(false)
  })
})

describe('compactDue - master toggle', () => {
  it('never fires when disabled, even far over threshold', () => {
    const off: AutoCompactConfig = { ...BASE, enabled: false }
    expect(compactDue({ contextTokens: 999_999, windowTokens: 1_000_000, lastCompactAtMs: null, nowMs: 0, cfg: off })).toBe(false)
  })
  it('thresholdFraction=0 disables the threshold trigger', () => {
    const noThresh: AutoCompactConfig = { ...BASE, thresholdFraction: 0 }
    expect(compactDue({ contextTokens: 999_999, windowTokens: 1_000_000, lastCompactAtMs: null, nowMs: 0, cfg: noThresh })).toBe(false)
  })
})
