// Contract tests for the kanban requires_approval flag + countApprovalsNeeded
// (#a0011592: the dashboard "needs operator approval" signal). The flag marks a
// card as parked waiting on the OPERATOR's decision; countApprovalsNeeded drives
// the sidebar badge. Runs against an in-memory DB seeded with the prod schema.
import { describe, it, expect, beforeEach } from 'vitest'
import {
  initDatabase, createKanbanCard, getKanbanCard, updateKanbanCard,
  archiveKanbanCard, countApprovalsNeeded,
} from '../db.js'

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
