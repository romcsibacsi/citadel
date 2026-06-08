import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

// Build a deterministic temp PROJECT_ROOT path (string-only, safe inside the
// hoisted factory). agent-config derives AGENTS_BASE_DIR from this, and the
// reaper writes handoffs under <root>/reports/handoffs.
const H = vi.hoisted(() => {
  const root = `/tmp/citadel-reaper-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  return { root, agents: `${root}/agents` }
})

vi.mock('../config.js', () => ({ PROJECT_ROOT: H.root, MAIN_AGENT_ID: 'nexus' }))
vi.mock('../web/agent-process.js', () => ({ stopAgentProcess: vi.fn(() => ({ ok: true })) }))
vi.mock('../web/scheduled-tasks-io.js', () => ({
  listScheduledTasks: () => [],
  SCHEDULED_TASKS_DIR: `${H.root}/tasks`,
}))
vi.mock('../db.js', () => ({
  getDailyLogDates: () => [],
  getDailyLog: () => [],
  getAgentConversation: () => [],
  listKanbanCards: () => [],
}))
vi.mock('../notify.js', () => ({ notifyAlert: vi.fn(async () => {}) }))

import { reapAgent, lifecycleDone, isAgentDone, isBaseRosterAgent } from '../web/reaper.js'

function makeAgent(name: string, lifecycle?: Record<string, unknown>): void {
  const dir = join(H.agents, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'agent-config.json'),
    JSON.stringify({ securityProfile: 'internal', displayName: name, lifecycle: lifecycle ?? {} }, null, 2),
  )
}

beforeEach(() => {
  mkdirSync(H.agents, { recursive: true })
})

afterEach(() => {
  rmSync(H.root, { recursive: true, force: true })
})

describe('reaper: lifecycleDone (pure)', () => {
  const now = Date.parse('2026-06-07T12:00:00Z')

  it('deadline policy: done only once the deadline has passed', () => {
    expect(lifecycleDone({ doneWhen: 'deadline', deadline: '2026-06-07T11:00:00Z' }, now, true)).toBe(true)
    expect(lifecycleDone({ doneWhen: 'deadline', deadline: '2026-06-07T13:00:00Z' }, now, true)).toBe(false)
  })

  it('explicit policy: done only when closed === true', () => {
    expect(lifecycleDone({ doneWhen: 'explicit', closed: true }, now, true)).toBe(true)
    expect(lifecycleDone({ doneWhen: 'explicit', closed: false }, now, true)).toBe(false)
    expect(lifecycleDone({ doneWhen: 'explicit' }, now, true)).toBe(false)
  })

  it('kanban-closed policy: done when no open cards remain', () => {
    expect(lifecycleDone({ doneWhen: 'kanban-closed' }, now, false)).toBe(true)
    expect(lifecycleDone({ doneWhen: 'kanban-closed' }, now, true)).toBe(false)
  })

  it('no explicit policy: done on a passed deadline or an explicit close', () => {
    expect(lifecycleDone({ deadline: '2026-06-07T11:00:00Z' }, now, true)).toBe(true)
    expect(lifecycleDone({ closed: true }, now, true)).toBe(true)
    expect(lifecycleDone({}, now, true)).toBe(false)
  })
})

describe('reaper: isAgentDone (reads lifecycle from config)', () => {
  const now = Date.parse('2026-06-07T12:00:00Z')

  it('deadline in the past => done', () => {
    makeAgent('depl', { ephemeral: true, doneWhen: 'deadline', deadline: '2026-06-07T11:00:00Z' })
    expect(isAgentDone('depl', now)).toBe(true)
  })

  it('explicit not closed => not done', () => {
    makeAgent('expl', { ephemeral: true, doneWhen: 'explicit', closed: false })
    expect(isAgentDone('expl', now)).toBe(false)
  })
})

describe('reaper: base-roster guard', () => {
  it('flags the main agent and every seed agent', () => {
    for (const n of ['nexus', 'forge', 'spark', 'sigma', 'relay', 'screener', 'oracle']) {
      expect(isBaseRosterAgent(n)).toBe(true)
    }
    expect(isBaseRosterAgent('ephemeral-worker')).toBe(false)
  })

  it('reapAgent refuses base-roster agents without touching disk', () => {
    makeAgent('forge')
    const r = reapAgent('forge', 'should not happen')
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/base-roster/i)
    expect(existsSync(join(H.agents, 'forge'))).toBe(true) // untouched
  })

  it('reapAgent refuses the main agent', () => {
    const r = reapAgent('nexus', 'nope')
    expect(r.ok).toBe(false)
  })
})

describe('reaper: reapAgent teardown', () => {
  it('writes a handoff and archives the agent dir', () => {
    makeAgent('victim', { ephemeral: true, doneWhen: 'explicit', closed: true })
    const r = reapAgent('victim', 'work complete')

    expect(r.ok).toBe(true)
    // handoff written under reports/handoffs
    expect(r.handoffPath).toBeTruthy()
    expect(existsSync(r.handoffPath!)).toBe(true)
    // original dir gone, archived copy present
    expect(existsSync(join(H.agents, 'victim'))).toBe(false)
    const archived = readdirSync(join(H.agents, '.archived'))
    expect(archived.some(d => d.startsWith('victim-'))).toBe(true)
  })

  it('is idempotent when the agent is already gone', () => {
    const r = reapAgent('ghost', 'already gone')
    expect(r.ok).toBe(true)
  })
})
