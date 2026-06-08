// Phase 6 -- optional, fallback-first WSL-GPU Ollama boost for heartbeat
// triage.
//
// The deterministic heuristic (heartbeat-triage.ts) is always the source
// of truth. This module adds an OPTIONAL second opinion from a small local
// model running on a WSL GPU box. It is purely additive: if the Ollama
// endpoint is not configured, unreachable, slow, or returns garbage, we
// return null and the caller keeps the heuristic decision. judgeWithOllama
// MUST NEVER throw and MUST NEVER block the heartbeat.

import {
  evaluateTriage,
  type TriageSignals,
  type TriageConfig,
  type TriageResult,
} from './heartbeat-triage.js'
import { logger } from './logger.js'

export interface OllamaJudgeOpts {
  url: string // WSL Ollama base URL, e.g. http://172.x.x.x:11434 ; empty = boost off
  model: string
  timeoutMs: number
  // Injectable for tests; defaults to global fetch.
  fetchImpl?: typeof fetch
}

export interface OllamaVerdict {
  shouldEscalate: boolean
  reason: string
}

function buildOllamaPrompt(s: TriageSignals): string {
  return [
    'You decide whether a background status heartbeat is worth surfacing to a busy person right now.',
    'Signals (cheap on-server heuristics):',
    `- local hour: ${s.hour}`,
    `- weekend: ${s.isWeekend}`,
    `- calendar events within 2h: ${s.calendarEventsSoon}`,
    `- important unread emails: ${s.importantUnread}`,
    `- kanban cards stuck/waiting: ${s.kanbanStuck}`,
    `- kanban cards due soon: ${s.kanbanDueSoon}`,
    `- unhealthy homelab services: ${s.homelabUnhealthy}`,
    `- keywords: ${s.keywords.slice(0, 20).join(', ') || '(none)'}`,
    '',
    'Respond ONLY with compact JSON: {"escalate": true|false, "reason": "<short>"}.',
    'Escalate only when something is genuinely time-sensitive or actionable; stay quiet otherwise.',
  ].join('\n')
}

// POST the compact prompt to the WSL Ollama endpoint and parse a yes/no +
// reason. Returns null on ANY failure (not configured, unreachable,
// timeout, non-OK, bad JSON, wrong shape). Never throws.
export async function judgeWithOllama(
  signals: TriageSignals,
  opts: OllamaJudgeOpts,
): Promise<OllamaVerdict | null> {
  if (!opts.url) return null
  const fetchImpl = opts.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs)
  try {
    const res = await fetchImpl(`${opts.url.replace(/\/+$/, '')}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: opts.model,
        prompt: buildOllamaPrompt(signals),
        stream: false,
        format: 'json',
      }),
      signal: controller.signal,
    })
    if (!res.ok) {
      logger.debug({ status: res.status }, 'heartbeat-ollama: non-OK response, falling back to heuristic')
      return null
    }
    const data = (await res.json()) as { response?: string }
    const raw = (data.response ?? '').trim()
    const match = raw.match(/\{[\s\S]*\}/)
    if (!match) return null
    const parsed = JSON.parse(match[0]) as { escalate?: unknown; reason?: unknown }
    if (typeof parsed.escalate !== 'boolean') return null
    const reason =
      typeof parsed.reason === 'string' && parsed.reason.trim()
        ? parsed.reason.trim()
        : parsed.escalate
          ? 'ollama judged noteworthy'
          : 'ollama judged quiet'
    return { shouldEscalate: parsed.escalate, reason }
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'heartbeat-ollama: judge failed, falling back to heuristic',
    )
    return null
  } finally {
    clearTimeout(timer)
  }
}

export type TriageSource = 'heuristic' | 'ollama'

export interface TriageDecision extends TriageResult {
  source: TriageSource
}

export interface TriageDecisionConfig {
  triage?: TriageConfig
  ollama?: OllamaJudgeOpts // omit, or leave url empty, to keep the boost off
}

// Combined decision. ALWAYS computes the deterministic heuristic first
// (the fallback). Only if a WSL Ollama URL is configured does it try the
// boost, and even then it uses the verdict ONLY when judgeWithOllama
// returns non-null. The boost is additive; the heuristic is never skipped.
export async function triageDecision(
  signals: TriageSignals,
  cfg: TriageDecisionConfig = {},
): Promise<TriageDecision> {
  const heuristic = evaluateTriage(signals, cfg.triage)

  if (cfg.ollama?.url) {
    const verdict = await judgeWithOllama(signals, cfg.ollama)
    if (verdict) {
      return {
        shouldEscalate: verdict.shouldEscalate,
        score: heuristic.score,
        reasons: [verdict.reason],
        source: 'ollama',
      }
    }
  }
  return { ...heuristic, source: 'heuristic' }
}
