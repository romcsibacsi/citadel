import { existsSync, mkdirSync, renameSync, cpSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT, MAIN_AGENT_ID } from '../config.js'
import { logger } from '../logger.js'
import { atomicWriteFileSync } from './atomic-write.js'
import {
  agentDir,
  AGENTS_BASE_DIR,
  listAllAgentNames,
  readFileOr,
  readAgentSecurityProfile,
  readAgentDisplayName,
} from './agent-config.js'
import { stopAgentProcess } from './agent-process.js'
import { listScheduledTasks, SCHEDULED_TASKS_DIR } from './scheduled-tasks-io.js'
import { getDailyLogDates, getDailyLog, getAgentConversation, listKanbanCards } from '../db.js'
import { notifyAlert } from '../notify.js'

// --- ephemeral lifecycle metadata -------------------------------------------

export interface AgentLifecycle {
  ephemeral?: boolean
  doneWhen?: 'kanban-closed' | 'explicit' | 'deadline'
  deadline?: string // ISO timestamp
  kanbanProject?: string
  // Set explicitly (by an operator/agent) to mark the work finished. Only
  // meaningful for doneWhen === 'explicit' (or the fallback path).
  closed?: boolean
}

export function readAgentLifecycle(name: string): AgentLifecycle {
  try {
    const config = JSON.parse(readFileOr(join(agentDir(name), 'agent-config.json'), '{}'))
    const lc = config.lifecycle
    return lc && typeof lc === 'object' ? lc as AgentLifecycle : {}
  } catch {
    return {}
  }
}

// Pure done-ness decision. `hasOpenKanbanCards` is supplied by the caller so
// this stays I/O-free and exhaustively unit-testable.
export function lifecycleDone(lc: AgentLifecycle, nowMs: number, hasOpenKanbanCards: boolean): boolean {
  const deadlinePassed = !!lc.deadline && Number.isFinite(Date.parse(lc.deadline)) && Date.parse(lc.deadline) <= nowMs
  switch (lc.doneWhen) {
    case 'deadline':
      return deadlinePassed
    case 'explicit':
      return lc.closed === true
    case 'kanban-closed':
      return !hasOpenKanbanCards
    default:
      // No explicit policy: done if the deadline elapsed or it was closed.
      return deadlinePassed || lc.closed === true
  }
}

export function isAgentDone(name: string, nowMs: number = Date.now()): boolean {
  const lc = readAgentLifecycle(name)
  let hasOpen = true
  if (lc.doneWhen === 'kanban-closed' && lc.kanbanProject) {
    try {
      hasOpen = listKanbanCards().some(c => c.project === lc.kanbanProject && c.status !== 'done')
    } catch { hasOpen = true }
  }
  return lifecycleDone(lc, nowMs, hasOpen)
}

// --- base-roster guard ------------------------------------------------------

// The pre-seeded roster that may NEVER be reaped. The main orchestrator plus
// the six seed agents. Guarded hard in reapAgent().
const BASE_ROSTER = new Set<string>(['forge', 'spark', 'sigma', 'relay', 'screener', 'oracle'])

export function isBaseRosterAgent(name: string): boolean {
  if (!name) return true // empty id -> refuse, defensively
  const lower = name.toLowerCase()
  return lower === MAIN_AGENT_ID.toLowerCase() || BASE_ROSTER.has(lower)
}

// --- handoff summary --------------------------------------------------------

// No Obsidian/PARA vault path is configured anywhere in src/config.ts or the
// vault-bindings store (the only "vault" in this codebase is the MCP-secret
// vault), so the handoff lands in the gitignored runtime reports/ tree.
function handoffDir(): string {
  return join(PROJECT_ROOT, 'reports', 'handoffs')
}

function buildRecap(name: string): string {
  const lines: string[] = []
  try {
    for (const date of getDailyLogDates(name, 3)) {
      for (const entry of getDailyLog(name, date)) {
        lines.push(`- ${date}: ${entry.content.replace(/\s+/g, ' ').trim().slice(0, 200)}`)
      }
    }
  } catch { /* db unavailable -- fall through */ }
  if (lines.length === 0) {
    try {
      const msgs = getAgentConversation(name, 10).reverse()
      for (const m of msgs) {
        lines.push(`- ${m.from_agent} -> ${m.to_agent}: ${String(m.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 160)}`)
      }
    } catch { /* db unavailable */ }
  }
  return lines.slice(0, 12).join('\n')
}

function writeHandoff(name: string, reason: string): string {
  const display = readAgentDisplayName(name)
  const profile = readAgentSecurityProfile(name)
  const lc = readAgentLifecycle(name)
  const reapedAt = new Date().toISOString()
  const recap = buildRecap(name)
  const md = [
    `# Handoff — ${display} (${name})`,
    '',
    `- Profile: ${profile}`,
    `- Reason: ${reason}`,
    `- Reaped at: ${reapedAt}`,
    `- Lifecycle: ${JSON.stringify(lc)}`,
    '',
    '## Recent activity',
    '',
    recap || '_No recent activity recorded._',
    '',
  ].join('\n')
  const dir = handoffDir()
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${name}-${reapedAt.replace(/[:.]/g, '-')}.md`)
  atomicWriteFileSync(file, md)
  return file
}

function removeAgentScheduledTasks(name: string): void {
  try {
    for (const task of listScheduledTasks()) {
      if (task.agent === name) {
        rmSync(join(SCHEDULED_TASKS_DIR, task.name), { recursive: true, force: true })
      }
    }
  } catch (err) {
    logger.warn({ err, name }, 'reaper: failed to remove scheduled tasks')
  }
}

// Tear down an ephemeral agent. Order: handoff -> stop session -> archive dir
// -> remove scheduled tasks. Idempotent (a no-op + ok when already gone) and
// refuses base-roster agents outright.
export function reapAgent(name: string, reason: string): { ok: boolean; handoffPath?: string; error?: string } {
  if (isBaseRosterAgent(name)) {
    return { ok: false, error: `refusing to reap base-roster agent '${name}'` }
  }

  let dir: string
  try {
    dir = agentDir(name)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'invalid agent name' }
  }

  if (!existsSync(dir)) {
    // Already gone -- idempotent success. Still drop any stray scheduled tasks.
    removeAgentScheduledTasks(name)
    return { ok: true }
  }

  // 1. handoff summary (best-effort; a handoff failure must not block teardown)
  let handoffPath: string | undefined
  try {
    handoffPath = writeHandoff(name, reason)
  } catch (err) {
    logger.warn({ err, name }, 'reaper: handoff write failed, continuing teardown')
  }

  // 2. stop the tmux session
  try {
    stopAgentProcess(name)
  } catch (err) {
    logger.warn({ err, name }, 'reaper: stopAgentProcess failed, continuing')
  }

  // 3. archive the agent dir
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const archiveRoot = join(AGENTS_BASE_DIR, '.archived')
  const dest = join(archiveRoot, `${name}-${stamp}`)
  try {
    mkdirSync(archiveRoot, { recursive: true })
    try {
      renameSync(dir, dest)
    } catch {
      // Cross-device or busy: copy then remove.
      cpSync(dir, dest, { recursive: true })
      rmSync(dir, { recursive: true, force: true })
    }
  } catch (err) {
    logger.error({ err, name }, 'reaper: failed to archive agent dir')
    return { ok: false, handoffPath, error: 'failed to archive agent directory' }
  }

  // 4. remove the agent's scheduled tasks
  removeAgentScheduledTasks(name)

  logger.info({ name, reason, handoffPath, dest }, 'reaper: agent reaped')
  return { ok: true, handoffPath }
}

// --- runner -----------------------------------------------------------------

// Mirrors auto-restart-runner.ts: a periodic sweep, started after the others to
// avoid piling work onto one tick. Conservative -- only ephemeral agents whose
// isAgentDone() is true, never the base roster.
const INITIAL_DELAY_MS = 50_000
const INTERVAL_MS = 5 * 60_000

export function startReaperRunner(): NodeJS.Timeout {
  function sweep() {
    const now = Date.now()
    for (const name of listAllAgentNames()) {
      try {
        if (isBaseRosterAgent(name)) continue
        const lc = readAgentLifecycle(name)
        if (lc.ephemeral !== true) continue
        if (!isAgentDone(name, now)) continue
        const result = reapAgent(name, `ephemeral lifecycle done (${lc.doneWhen ?? 'deadline/explicit'})`)
        if (result.ok) {
          notifyAlert(
            `[CITADEL] Ephemeral agent '${name}' reaped. Handoff: ${result.handoffPath ?? 'n/a'}`,
          ).catch(() => {})
        } else {
          logger.warn({ name, error: result.error }, 'reaper: reap failed')
        }
      } catch (err) {
        logger.debug({ err, agent: name }, 'reaper: agent check error')
      }
    }
  }
  setTimeout(sweep, INITIAL_DELAY_MS)
  return setInterval(sweep, INTERVAL_MS)
}
