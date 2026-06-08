// Phase 6 -- pure, always-on CPU triage layer for the heartbeat.
//
// The heartbeat itself is an interactive tmux sub-agent on the
// subscription pool (src/web/heartbeat-agent-scaffold.ts). Escalating to
// it every hour wakes Claude even when nothing is noteworthy. This module
// is a cheap, deterministic pre-filter: given a handful of on-server
// signals, decide whether anything is worth surfacing BEFORE the heartbeat
// agent is woken. Everything here is PURE (no I/O, no clock, no config
// read) so it is fully unit-testable -- the caller supplies the signals
// and (optionally) an overriding config.

// What the cheap on-server heuristics can actually see. Every field maps
// to something collectTriageSignals() (src/heartbeat.ts) can produce from
// the calendar API + the kanban/system DB. `importantUnread` is kept in
// the shape for completeness/tunability but is collected as 0 server-side
// today (email is fetched by the heartbeat agent itself over MCP, not by
// the dashboard process).
export interface TriageSignals {
  hour: number // local hour 0-23
  isWeekend: boolean
  calendarEventsSoon: number // events within the next ~2h
  importantUnread: number // important unread emails (0 unless collected)
  kanbanStuck: number // cards in waiting/blocked state
  kanbanDueSoon: number // cards with a due date inside the soon-window
  homelabUnhealthy: number // unhealthy services / system warnings
  keywords: string[] // free-text from card titles + calendar summaries
}

export interface TriageWeights {
  calendarEventSoon: number
  importantUnread: number
  kanbanStuck: number
  kanbanDueSoon: number
  homelabUnhealthy: number
  keyword: number
}

export interface TriageConfig {
  // Active window mirrors HEARTBEAT_START_HOUR / HEARTBEAT_END_HOUR. Outside
  // it (quiet hours) ONLY urgent signals may escalate.
  startHour: number
  endHour: number
  // Inside the active window: escalate when the total score reaches this.
  threshold: number
  // In quiet hours (and as the urgent floor anytime): escalate when the
  // urgent-only score reaches this.
  urgentThreshold: number
  // Multiplier applied to ROUTINE score on weekends (urgent score is never
  // dampened) -- the operator is less reachable, so raise the routine bar.
  weekendDampening: number
  weights: TriageWeights
  urgentKeywords: string[]
}

// Default weights. Two tiers:
//   URGENT (escalate even at night / on weekends, undampened): unhealthy
//   homelab services, cards due soon, urgent keywords -- weighted so a
//   single occurrence clears urgentThreshold on its own.
//   ROUTINE (only inside the active window, weekend-dampened): upcoming
//   calendar events, important unread email, stuck kanban -- need to
//   accumulate to clear threshold.
export const DEFAULT_TRIAGE_CONFIG: TriageConfig = {
  startHour: 9,
  endHour: 23,
  threshold: 3,
  urgentThreshold: 3,
  weekendDampening: 0.5,
  weights: {
    calendarEventSoon: 2,
    importantUnread: 1,
    kanbanStuck: 1,
    kanbanDueSoon: 3,
    homelabUnhealthy: 4,
    keyword: 3,
  },
  urgentKeywords: ['urgent', 'deadline', 'down', 'failed', 'critical', 'outage', 'asap'],
}

export interface TriageResult {
  shouldEscalate: boolean
  score: number
  reasons: string[]
}

// Return the urgent keyword tokens that appear in any of the supplied
// strings. One match per input string (a card titled "deploy failed"
// counts once), so the count tracks how many distinct signals are urgent.
function matchUrgentKeywords(keywords: string[], urgent: string[]): string[] {
  const matched: string[] = []
  for (const k of keywords) {
    const lower = k.toLowerCase()
    for (const u of urgent) {
      if (lower.includes(u)) {
        matched.push(u)
        break
      }
    }
  }
  return matched
}

// Pure heuristic triage. Deterministic given (signals, cfg).
export function evaluateTriage(
  signals: TriageSignals,
  cfg: TriageConfig = DEFAULT_TRIAGE_CONFIG,
): TriageResult {
  const w = cfg.weights
  const reasons: string[] = []

  // --- Urgent signals: undampened, allowed to escalate during quiet hours.
  let urgentScore = 0
  if (signals.homelabUnhealthy > 0) {
    urgentScore += signals.homelabUnhealthy * w.homelabUnhealthy
    reasons.push(`${signals.homelabUnhealthy} homelab service(s) unhealthy`)
  }
  if (signals.kanbanDueSoon > 0) {
    urgentScore += signals.kanbanDueSoon * w.kanbanDueSoon
    reasons.push(`${signals.kanbanDueSoon} kanban card(s) due soon`)
  }
  const matchedKeywords = matchUrgentKeywords(signals.keywords, cfg.urgentKeywords)
  if (matchedKeywords.length > 0) {
    urgentScore += matchedKeywords.length * w.keyword
    reasons.push(`urgent keyword(s): ${matchedKeywords.join(', ')}`)
  }

  // --- Routine signals: only inside the active window, weekend-dampened.
  let routineScore = 0
  if (signals.calendarEventsSoon > 0) {
    routineScore += signals.calendarEventsSoon * w.calendarEventSoon
    reasons.push(`${signals.calendarEventsSoon} calendar event(s) within 2h`)
  }
  if (signals.importantUnread > 0) {
    routineScore += signals.importantUnread * w.importantUnread
    reasons.push(`${signals.importantUnread} important unread email(s)`)
  }
  if (signals.kanbanStuck > 0) {
    routineScore += signals.kanbanStuck * w.kanbanStuck
    reasons.push(`${signals.kanbanStuck} kanban card(s) stuck/waiting`)
  }

  const quietHours = signals.hour < cfg.startHour || signals.hour >= cfg.endHour

  let score: number
  let shouldEscalate: boolean
  if (quietHours) {
    // Outside the active window only urgent signals may wake anyone.
    score = urgentScore
    shouldEscalate = urgentScore >= cfg.urgentThreshold
  } else {
    const effectiveRoutine = signals.isWeekend ? routineScore * cfg.weekendDampening : routineScore
    score = urgentScore + effectiveRoutine
    shouldEscalate = score >= cfg.threshold
  }

  return { shouldEscalate, score, reasons }
}
