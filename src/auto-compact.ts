// Pure logic for the auto-compact feature: proactively inject "/compact" into an
// agent session BEFORE its context window fills and the session wedges
// ("No response from API · Retrying"). When the hub (NEXUS) wedges, dispatch
// halts and the whole fleet stalls (2026-06-20 incident, freed by a manual
// /compact), so the durable prevention is to compact heavy sessions while they
// are still idle and healthy.
//
// The trigger is window-relative, not an absolute token count: the fleet mixes
// 1M-context models (claude-opus-4-8[1m]) with 200k ones (claude-sonnet-4-6),
// so a fixed token threshold would fire constantly on one and never on the
// other. We compact when the live context reaches a FRACTION of the model's
// own window. A scheduled fallback (compact every N ms) is an optional
// belt-and-suspenders for when the live context cannot be read.
//
// This module is dependency-free so the decision is unit-testable without a
// clock, tmux, or the filesystem. The I/O (reading context tokens, checking the
// pane is idle, injecting /compact) lives in src/web/auto-compact-runner.ts.

export interface AutoCompactConfig {
  /** Master toggle. When false no session is ever auto-compacted. */
  enabled: boolean
  /** Compact when contextTokens >= fraction * contextWindow. 0 disables the
   *  threshold trigger. ~0.80 fires well before the wedge with headroom for a turn. */
  thresholdFraction: number
  /** Scheduled fallback: compact every N ms regardless of measured context
   *  (window-independent safety net). 0 disables the scheduled trigger. */
  intervalMs: number
  /** Anti-thrash floor: never compact twice within this window. A compaction
   *  drops the context, so this guards against rapid re-fire and against a
   *  read that is stale right after a compact. */
  minIntervalMs: number
}

export const DEFAULT_AUTO_COMPACT: AutoCompactConfig = {
  enabled: true,
  thresholdFraction: 0.8,
  intervalMs: 0,
  minIntervalMs: 10 * 60_000,
}

/**
 * Context window (tokens) for a model id. The 1M-context Opus variants carry a
 * '1m' / '[1m]' marker (e.g. 'claude-opus-4-8[1m]'); everything else is the
 * standard 200k window. Unknown/empty -> the conservative 200k so the threshold
 * fires sooner rather than never.
 */
export function contextWindowForModel(model: string | null | undefined): number {
  if (typeof model === 'string' && /(\[1m\]|\b1m\b)/i.test(model)) return 1_000_000
  return 200_000
}

/**
 * Coerce arbitrary parsed/env-derived input into a safe, fully-populated config.
 * Out-of-range fields fall back to defaults so a hand-edited value can never
 * disable the anti-thrash floor or set a nonsensical fraction.
 */
export function normalizeAutoCompactConfig(raw: unknown): AutoCompactConfig {
  const o = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {}
  const frac = typeof o.thresholdFraction === 'number' && Number.isFinite(o.thresholdFraction)
    ? Math.min(Math.max(o.thresholdFraction, 0), 1)
    : DEFAULT_AUTO_COMPACT.thresholdFraction
  const interval = typeof o.intervalMs === 'number' && Number.isFinite(o.intervalMs) && o.intervalMs >= 0
    ? o.intervalMs
    : DEFAULT_AUTO_COMPACT.intervalMs
  const minInterval = typeof o.minIntervalMs === 'number' && Number.isFinite(o.minIntervalMs) && o.minIntervalMs > 0
    ? o.minIntervalMs
    : DEFAULT_AUTO_COMPACT.minIntervalMs
  return {
    enabled: o.enabled !== false,
    thresholdFraction: frac,
    intervalMs: interval,
    minIntervalMs: minInterval,
  }
}

/**
 * Pure decision: should we inject /compact into this session *now*?
 *
 * Fires when EITHER the live context has reached the configured fraction of the
 * model's window (precise, early) OR the scheduled interval has elapsed since
 * the last compact (window-independent safety net) -- but never within
 * minIntervalMs of the previous compact (anti-thrash).
 *
 * The scheduled trigger requires a non-null lastCompactAtMs, so the runner's
 * seed-on-first-sight means it fires `intervalMs` after the seed, not at boot.
 *
 * @param contextTokens   Live context size, or null if it could not be read.
 * @param windowTokens    The model's context window (contextWindowForModel).
 * @param lastCompactAtMs When this session was last auto-compacted, or null.
 * @param nowMs           Current clock (ms).
 * @param cfg             The resolved config.
 */
export function compactDue(args: {
  contextTokens: number | null
  windowTokens: number
  lastCompactAtMs: number | null
  nowMs: number
  cfg: AutoCompactConfig
}): boolean {
  const { contextTokens, windowTokens, lastCompactAtMs, nowMs, cfg } = args
  if (!cfg.enabled) return false
  // Anti-thrash: never compact twice inside the floor window.
  if (lastCompactAtMs !== null && nowMs - lastCompactAtMs < cfg.minIntervalMs) return false
  // Threshold trigger: context crossed the fraction of its own window.
  if (cfg.thresholdFraction > 0 && contextTokens !== null && windowTokens > 0) {
    if (contextTokens >= cfg.thresholdFraction * windowTokens) return true
  }
  // Scheduled trigger: window-independent fallback (only after the seed).
  if (cfg.intervalMs > 0 && lastCompactAtMs !== null && nowMs - lastCompactAtMs >= cfg.intervalMs) return true
  return false
}
