import { describe, it, expect } from 'vitest'
import {
  evaluateTriage,
  DEFAULT_TRIAGE_CONFIG,
  type TriageSignals,
} from '../heartbeat-triage.js'

// Base = a fully calm signal set inside the active window on a weekday.
// Each test overrides only the field it exercises so the heuristic's
// behavior is isolated.
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

const sig = (over: Partial<TriageSignals>): TriageSignals => ({ ...calm, ...over })

describe('evaluateTriage', () => {
  it('calm signals do not escalate', () => {
    const r = evaluateTriage(calm)
    expect(r.shouldEscalate).toBe(false)
    expect(r.score).toBe(0)
  })

  it('quiet hours suppress routine signals', () => {
    // 02:00, lots of stuck kanban -- routine only, so no escalation at night.
    const r = evaluateTriage(sig({ hour: 2, kanbanStuck: 10 }))
    expect(r.shouldEscalate).toBe(false)
  })

  it('quiet hours still escalate an urgent signal (homelab unhealthy)', () => {
    const r = evaluateTriage(sig({ hour: 2, homelabUnhealthy: 1 }))
    expect(r.shouldEscalate).toBe(true)
    expect(r.reasons.join(' ')).toMatch(/homelab/)
  })

  it('due-soon kanban escalates inside the active window', () => {
    const r = evaluateTriage(sig({ hour: 14, kanbanDueSoon: 1 }))
    expect(r.shouldEscalate).toBe(true)
    expect(r.reasons.join(' ')).toMatch(/due soon/)
  })

  it('due-soon kanban escalates even at night (urgent tier)', () => {
    const r = evaluateTriage(sig({ hour: 3, kanbanDueSoon: 1 }))
    expect(r.shouldEscalate).toBe(true)
  })

  it('stuck kanban escalates inside the active window when it accumulates', () => {
    // weight 1 each, threshold 3 -> need 3 to clear.
    expect(evaluateTriage(sig({ hour: 12, kanbanStuck: 3 })).shouldEscalate).toBe(true)
    expect(evaluateTriage(sig({ hour: 12, kanbanStuck: 2 })).shouldEscalate).toBe(false)
  })

  it('urgent keyword bumps the score and escalates even at night', () => {
    const r = evaluateTriage(sig({ hour: 1, keywords: ['deployment failed on prod'] }))
    expect(r.shouldEscalate).toBe(true)
    expect(r.reasons.join(' ')).toMatch(/urgent keyword/)
  })

  it('non-urgent keywords do not trigger the urgent bump', () => {
    const r = evaluateTriage(sig({ hour: 1, keywords: ['weekly review notes'] }))
    expect(r.shouldEscalate).toBe(false)
  })

  it('weekend dampening raises the routine bar', () => {
    // Two calendar events = routine 4. Weekday -> escalates; weekend halved
    // to 2 -> does not.
    expect(evaluateTriage(sig({ hour: 11, calendarEventsSoon: 2 })).shouldEscalate).toBe(true)
    expect(
      evaluateTriage(sig({ hour: 11, calendarEventsSoon: 2, isWeekend: true })).shouldEscalate,
    ).toBe(false)
  })

  it('weekend does NOT dampen urgent signals', () => {
    const r = evaluateTriage(sig({ hour: 11, isWeekend: true, homelabUnhealthy: 1 }))
    expect(r.shouldEscalate).toBe(true)
  })

  it('threshold boundary is inclusive (score == threshold escalates)', () => {
    const r = evaluateTriage(sig({ hour: 12, kanbanStuck: DEFAULT_TRIAGE_CONFIG.threshold }))
    expect(r.score).toBe(DEFAULT_TRIAGE_CONFIG.threshold)
    expect(r.shouldEscalate).toBe(true)
  })

  it('urgentThreshold boundary is inclusive at night', () => {
    // kanbanDueSoon weight 3 == urgentThreshold 3.
    const r = evaluateTriage(sig({ hour: 4, kanbanDueSoon: 1 }))
    expect(r.score).toBe(DEFAULT_TRIAGE_CONFIG.urgentThreshold)
    expect(r.shouldEscalate).toBe(true)
  })

  it('endHour boundary: at endHour quiet rules apply (routine suppressed)', () => {
    // endHour = 23 -> hour 23 is OUTSIDE the active window.
    const r = evaluateTriage(sig({ hour: 23, calendarEventsSoon: 5 }))
    expect(r.shouldEscalate).toBe(false)
  })

  it('startHour boundary: at startHour the active window is open', () => {
    const r = evaluateTriage(sig({ hour: 9, calendarEventsSoon: 2 }))
    expect(r.shouldEscalate).toBe(true)
  })

  it('respects an overriding config', () => {
    // Make the threshold unreachable -> routine never escalates.
    const r = evaluateTriage(sig({ hour: 12, kanbanStuck: 5 }), {
      ...DEFAULT_TRIAGE_CONFIG,
      threshold: 100,
    })
    expect(r.shouldEscalate).toBe(false)
  })
})
