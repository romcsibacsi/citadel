import { logger } from '../logger.js'
import {
  MAIN_AGENT_ID,
  PROJECT_ROOT,
  AUTO_COMPACT_ENABLED,
  AUTO_COMPACT_THRESHOLD_FRACTION,
  AUTO_COMPACT_INTERVAL_MS,
  AUTO_COMPACT_MIN_INTERVAL_MS,
} from '../config.js'
import { listAgentNames, agentDir, readAgentClaudeConfigDir } from './agent-config.js'
import {
  isAgentRunning,
  agentSessionName,
  capturePane,
  sendPromptToSession,
} from './agent-process.js'
import { MAIN_CHANNELS_SESSION } from './main-agent.js'
import { detectPaneState } from '../pane-state.js'
import { readContextTokensFromProjectDir, readActiveModelFromProjectDir } from './active-model.js'
import {
  compactDue,
  contextWindowForModel,
  type AutoCompactConfig,
} from '../auto-compact.js'

// Drives proactive /compact injection (see src/auto-compact.ts for the why and
// the pure due-logic). Mirrors the auto-restart runner: a periodic sweep over
// the hub + every sub-agent, reading each session's live context and injecting
// "/compact" when it nears the model's window, BEFORE it wedges.
//
// Two hard safety rules (same as auto-restart):
//   - IDLE-GUARD: never inject mid-turn (a busy pane) -- that would corrupt the
//     in-flight reply. We defer to the next tick until the pane is idle. /compact
//     itself is safe (the PreCompact/SessionStart hooks preserve task state).
//   - SEED-ON-FIRST-SIGHT: on the first sweep we record "last compact = now" for
//     each agent without acting, so the scheduled trigger measures from boot and
//     a single noisy first read cannot fire a spurious compact.

const INITIAL_DELAY_MS = 50_000
const INTERVAL_MS = 120_000

// agent name -> last ACTUAL auto-compact time (ms); absent until the first real compaction, so the
// anti-thrash floor never suppresses on a re-seed. In-memory: a dashboard restart clears it (correct -- the
// floor must not carry across a restart, and the threshold must fire if the hub is over-threshold then).
const lastCompact = new Map<string, number>()
// agent name -> first-sight time (ms): the SCHEDULED-trigger base only (NOT the anti-thrash floor). Re-seeded
// at a dashboard restart (at worst shifts one scheduled slot).
const firstSeen = new Map<string, number>()

function cfg(): AutoCompactConfig {
  return {
    enabled: AUTO_COMPACT_ENABLED,
    thresholdFraction: AUTO_COMPACT_THRESHOLD_FRACTION,
    intervalMs: AUTO_COMPACT_INTERVAL_MS,
    minIntervalMs: AUTO_COMPACT_MIN_INTERVAL_MS,
  }
}

interface Target {
  session: string
  /** working dir + claude config dir to read this session's transcript. */
  dir: string
  configDir: string | undefined
}

function targetFor(name: string): Target {
  if (name === MAIN_AGENT_ID) {
    // The hub runs in the citadel install dir under the launchd channels session.
    return { session: MAIN_CHANNELS_SESSION, dir: PROJECT_ROOT, configDir: undefined }
  }
  return {
    session: agentSessionName(name),
    dir: agentDir(name),
    configDir: readAgentClaudeConfigDir(name) ?? undefined,
  }
}

function windowFor(t: Target): number {
  const model = readActiveModelFromProjectDir(t.dir, undefined, t.configDir)
  return contextWindowForModel(model)
}

function paneIsIdle(session: string): boolean {
  const pane = capturePane(session)
  if (pane == null) return false
  return detectPaneState(pane) === 'idle'
}

function checkAgent(name: string, nowMs: number): void {
  const c = cfg()
  if (!c.enabled) return
  // Sub-agents must be up; the hub is launchd-managed (always considered present).
  if (name !== MAIN_AGENT_ID && !isAgentRunning(name)) return

  // Seed first-sight so the SCHEDULED trigger measures from boot, not 1970. This does NOT gate the threshold
  // trigger -- the threshold must be able to fire on the very first sight (e.g. a hub already over-threshold
  // when the runner re-seeds at a dashboard restart), which the previous seed-then-return suppressed.
  if (!firstSeen.has(name)) firstSeen.set(name, nowMs)

  const t = targetFor(name)
  const contextTokens = readContextTokensFromProjectDir(t.dir, t.configDir)
  const windowTokens = windowFor(t)
  if (!compactDue({
    contextTokens,
    windowTokens,
    lastCompactAtMs: lastCompact.get(name) ?? null,
    firstSeenAtMs: firstSeen.get(name) ?? null,
    nowMs,
    cfg: c,
  })) {
    return
  }

  // Due, but never interrupt a live turn -- defer until the pane is idle.
  if (!paneIsIdle(t.session)) {
    logger.info({ name, session: t.session, contextTokens, windowTokens }, 'auto-compact: due but pane is busy, deferring')
    return
  }

  try {
    sendPromptToSession(t.session, '/compact')
    lastCompact.set(name, nowMs)
    logger.warn(
      { name, session: t.session, contextTokens, windowTokens, fraction: c.thresholdFraction },
      'auto-compact: injected /compact (context near window) to prevent a wedge',
    )
  } catch (err) {
    logger.warn({ err, name }, 'auto-compact: /compact injection failed')
  }
}

export function startAutoCompactRunner(): NodeJS.Timeout {
  function sweep() {
    const now = Date.now()
    try { checkAgent(MAIN_AGENT_ID, now) } catch (err) { logger.debug({ err }, 'auto-compact: main check error') }
    for (const name of listAgentNames()) {
      try { checkAgent(name, now) } catch (err) { logger.debug({ err, agent: name }, 'auto-compact: agent check error') }
    }
  }
  setTimeout(sweep, INITIAL_DELAY_MS)
  return setInterval(sweep, INTERVAL_MS)
}
