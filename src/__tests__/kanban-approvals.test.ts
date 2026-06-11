// Contract tests for the kanban requires_approval flag + countApprovalsNeeded
// (#a0011592: the dashboard "needs operator approval" signal). The flag marks a
// card as parked waiting on the OPERATOR's decision; countApprovalsNeeded drives
// the sidebar badge. Runs against an in-memory DB seeded with the prod schema.
import { describe, it, expect, beforeEach } from 'vitest'
import {
  initDatabase, createKanbanCard, getKanbanCard, updateKanbanCard,
  archiveKanbanCard, countApprovalsNeeded, getKanbanComments, listAgentMessages,
} from '../db.js'
import { tryHandleKanban } from '../web/routes/kanban.js'

// Minimal http mock to exercise the real route handler (mirrors ideas-archive.test.ts).
function mockRes(): any {
  const r: any = { statusCode: 0, body: undefined }
  r.writeHead = (status: number) => { r.statusCode = status; return r }
  r.end = (chunk?: any) => { if (chunk !== undefined) r.body = chunk.toString() }
  return r
}
function ctx(path: string, method: string, res: any): any {
  return { req: {}, res, path, method, url: new URL(`http://localhost${path}`) }
}

beforeEach(() => {
  initDatabase(':memory:')
})

describe('kanban requires_approval', () => {
  it('defaults to NULL (not blocked) and counts as zero', () => {
    createKanbanCard({ id: 'c1', title: 'no flag' })
    expect(getKanbanCard('c1')!.requires_approval ?? null).toBeNull()
    expect(countApprovalsNeeded()).toBe(0)
  })

  it('round-trips requires_approval set at creation', () => {
    createKanbanCard({ id: 'c2', title: 'flagged', requires_approval: 1 })
    expect(getKanbanCard('c2')!.requires_approval).toBe(1)
    expect(countApprovalsNeeded()).toBe(1)
  })

  it('updateKanbanCard flips the flag on and off', () => {
    createKanbanCard({ id: 'c3', title: 'flip' })
    expect(countApprovalsNeeded()).toBe(0)
    updateKanbanCard('c3', { requires_approval: 1 })
    expect(getKanbanCard('c3')!.requires_approval).toBe(1)
    expect(countApprovalsNeeded()).toBe(1)
    updateKanbanCard('c3', { requires_approval: 0 })
    expect(getKanbanCard('c3')!.requires_approval).toBe(0)
    expect(countApprovalsNeeded()).toBe(0)
  })

  it('counts only flagged, non-archived cards', () => {
    createKanbanCard({ id: 'a', title: 'A', requires_approval: 1 })
    createKanbanCard({ id: 'b', title: 'B', requires_approval: 1 })
    createKanbanCard({ id: 'c', title: 'C' })
    expect(countApprovalsNeeded()).toBe(2)
    archiveKanbanCard('a')
    expect(countApprovalsNeeded()).toBe(1)
  })
})

describe('needs-approval v2: approve/reject endpoints (#ec737f86)', () => {
  it('POST /api/kanban/:id/approve clears the flag, comments, and signals NEXUS', async () => {
    createKanbanCard({ id: 'apv', title: 'needs op', requires_approval: 1 })
    const res = mockRes()
    const handled = await tryHandleKanban(ctx('/api/kanban/apv/approve', 'POST', res))
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(getKanbanCard('apv')!.requires_approval).toBe(0)
    expect(countApprovalsNeeded()).toBe(0)
    expect(getKanbanComments('apv').some((c) => c.content.includes('Jóváhagyva'))).toBe(true)
    expect(listAgentMessages(10).some((m) => /JÓVÁHAGYTA/.test(m.content))).toBe(true)
  })

  it('POST /api/kanban/:id/reject clears the flag and records rejection', async () => {
    createKanbanCard({ id: 'rej', title: 'needs op', requires_approval: 1 })
    const res = mockRes()
    await tryHandleKanban(ctx('/api/kanban/rej/reject', 'POST', res))
    expect(res.statusCode).toBe(200)
    expect(getKanbanCard('rej')!.requires_approval).toBe(0)
    expect(getKanbanComments('rej').some((c) => c.content.includes('Elutasítva'))).toBe(true)
    expect(listAgentMessages(10).some((m) => /ELUTASÍTOTTA/.test(m.content))).toBe(true)
  })

  it('approve on a missing card -> 404', async () => {
    const res = mockRes()
    await tryHandleKanban(ctx('/api/kanban/nope/approve', 'POST', res))
    expect(res.statusCode).toBe(404)
  })
})
