import { describe, it, expect, vi } from 'vitest'
import { judgeWithOllama, triageDecision } from '../heartbeat-ollama.js'
import type { TriageSignals } from '../heartbeat-triage.js'

const calm: TriageSignals = {
  hour: 11,
  isWeekend: false,
  calendarEventsSoon: 0,
  importantUnread: 0,
  kanbanStuck: 0,
  kanbanDueSoon: 0,
  homelabUnhealthy: 0,
  keywords: [],
}

const baseOpts = { url: 'http://wsl:11434', model: 'llama3.2:1b', timeoutMs: 4000 }

// Minimal fetch Response stub.
function okJson(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response
}

describe('judgeWithOllama', () => {
  it('returns null when no URL is configured (boost off)', async () => {
    const fetchImpl = vi.fn()
    const r = await judgeWithOllama(calm, { ...baseOpts, url: '', fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(r).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('returns null when the endpoint is unreachable', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    const r = await judgeWithOllama(calm, { ...baseOpts, fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(r).toBeNull()
  })

  it('returns null on timeout (abort) and never throws', async () => {
    // Hang until aborted, then reject as fetch does on abort.
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          )
        }),
    )
    const r = await judgeWithOllama(calm, {
      ...baseOpts,
      timeoutMs: 10,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(r).toBeNull()
  })

  it('returns null on a non-OK response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500 } as Response)
    const r = await judgeWithOllama(calm, { ...baseOpts, fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(r).toBeNull()
  })

  it('returns null on bad JSON in the response field', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okJson({ response: 'definitely not json' }))
    const r = await judgeWithOllama(calm, { ...baseOpts, fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(r).toBeNull()
  })

  it('returns null when the parsed shape lacks a boolean escalate', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okJson({ response: '{"reason":"x"}' }))
    const r = await judgeWithOllama(calm, { ...baseOpts, fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(r).toBeNull()
  })

  it('parses a valid verdict', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(okJson({ response: '{"escalate": true, "reason": "deadline at 5pm"}' }))
    const r = await judgeWithOllama(calm, { ...baseOpts, fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(r).toEqual({ shouldEscalate: true, reason: 'deadline at 5pm' })
  })
})

describe('triageDecision', () => {
  it('uses the heuristic when no Ollama config is supplied', async () => {
    const r = await triageDecision(calm)
    expect(r.source).toBe('heuristic')
    expect(r.shouldEscalate).toBe(false)
  })

  it('falls back to the heuristic when Ollama returns null', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('down'))
    // Calm signals -> heuristic says no escalate; Ollama unreachable -> null.
    const r = await triageDecision(calm, {
      ollama: { ...baseOpts, fetchImpl: fetchImpl as unknown as typeof fetch },
    })
    expect(r.source).toBe('heuristic')
    expect(r.shouldEscalate).toBe(false)
    expect(fetchImpl).toHaveBeenCalled()
  })

  it('uses the Ollama verdict when it returns a value (overriding the heuristic)', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(okJson({ response: '{"escalate": true, "reason": "model says so"}' }))
    // Heuristic on calm signals = no escalate, but Ollama overrides to true.
    const r = await triageDecision(calm, {
      ollama: { ...baseOpts, fetchImpl: fetchImpl as unknown as typeof fetch },
    })
    expect(r.source).toBe('ollama')
    expect(r.shouldEscalate).toBe(true)
    expect(r.reasons).toEqual(['model says so'])
  })
})
