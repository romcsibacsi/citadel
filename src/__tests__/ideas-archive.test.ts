// Adversarial QA + regression coverage for the idea-box ARCHIVER feature
// (kártya #fa296c5f, tested under PROBE kártya #832b6e73).
//
// Feature surface under test:
//   1) DB layer: archiveIdea (idempotent, never deletes), getIdeaByKanbanId
//      (reverse lookup), reconcileArchivedIdeas (done-linked sweep), and the
//      listIdeas archived/active filter semantics.
//   2) POST /api/ideas/:id/archive  -> archive + 404 + idempotent.
//   3) AUTO-ARCHIVE-ON-DONE hook: a kanban /move to 'done' archives the linked
//      idea; non-done moves do not; no linked idea -> no-op; the move always
//      succeeds (the hook is error-tolerant and must never fail the move).
//   4) GET /api/ideas?status=archived filter (archived hidden by default,
//      archived still queryable -> NO data loss).
//   5) Backward-compatible MIGRATION: an OLD-schema idea_box (no archived_at,
//      pre-archived CHECK) is rebuilt with every row preserved.
//
// All tests run the REAL route handlers / db functions on an isolated DB.
// PROBE rule: this file PROVES behaviour; it does not patch prod code. Any
// failing assertion = a bug handed back to NEXUS -> FORGE.

import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import {
  initDatabase, createIdea, listIdeas, archiveIdea, getIdeaByKanbanId,
  reconcileArchivedIdeas, createKanbanCard, updateIdea, getDb,
} from '../db.js'
import { tryHandleIdeas } from '../web/routes/ideas.js'
import { tryHandleKanban } from '../web/routes/kanban.js'

// --- mock http plumbing -----------------------------------------------------
function mockRes(): any {
  const r: any = { statusCode: 0, body: undefined }
  r.writeHead = (status: number) => { r.statusCode = status; return r }
  r.end = (chunk?: any) => { if (chunk !== undefined) r.body = chunk.toString() }
  return r
}
// readBody() consumes req as a stream, so body-carrying POSTs need a real
// Readable. GET/no-body routes get a bare {} (never read).
function bodyReq(obj: unknown): any {
  return Readable.from([Buffer.from(JSON.stringify(obj))])
}
function ctx(path: string, method: string, res: any, opts: { req?: any; query?: string } = {}): any {
  const qs = opts.query ? `?${opts.query}` : ''
  return { req: opts.req ?? {}, res, path, method, url: new URL(`http://localhost${path}${qs}`) }
}
function parse(res: any): any { return JSON.parse(res.body) }

// Seed one idea directly at DB layer (createIdea omits archived_at by contract).
function seedIdea(id: string, over: Partial<Parameters<typeof createIdea>[0]> = {}) {
  createIdea({
    id, title: `idea ${id}`, description: null, category: 'Egyéb',
    status: 'new', source: 'manual', kanban_id: null, ...over,
  })
}

beforeEach(() => {
  initDatabase(':memory:')
})

// ---------------------------------------------------------------------------
describe('db: archiveIdea (archive, never delete; idempotent)', () => {
  it('archives a non-archived idea: status=archived + numeric archived_at, row preserved', () => {
    seedIdea('a1')
    expect(archiveIdea('a1')).toBe(true)
    const rows = listIdeas({ status: 'archived' })
    expect(rows.length).toBe(1)
    expect(rows[0].id).toBe('a1')
    expect(rows[0].status).toBe('archived')
    expect(typeof rows[0].archived_at).toBe('number') // stamped, not null
  })

  it('a freshly created idea has archived_at === null (nullable, not 0/empty)', () => {
    seedIdea('a2')
    const [row] = listIdeas({ status: 'new' })
    expect(row.archived_at).toBeNull()
  })

  it('is idempotent: re-archiving returns false and does NOT re-stamp archived_at', () => {
    seedIdea('a3')
    expect(archiveIdea('a3')).toBe(true)
    const first = listIdeas({ status: 'archived' })[0].archived_at
    expect(archiveIdea('a3')).toBe(false) // WHERE status != 'archived' -> no change
    const second = listIdeas({ status: 'archived' })[0].archived_at
    expect(second).toBe(first) // archived_at preserved, no data churn
  })

  it('returns false for an unknown id (no phantom row created)', () => {
    expect(archiveIdea('nope')).toBe(false)
    expect(listIdeas({ status: 'archived' }).length).toBe(0)
  })
})

describe('db: listIdeas filter semantics (archived hidden by default; queryable on demand)', () => {
  beforeEach(() => {
    seedIdea('act', { status: 'new' })
    seedIdea('arc', { status: 'new' })
    archiveIdea('arc')
  })

  it('no status -> active only (archived hidden)', () => {
    const ids = listIdeas().map((r) => r.id)
    expect(ids).toContain('act')
    expect(ids).not.toContain('arc')
  })

  it("status='active' -> same as default (archived hidden)", () => {
    const ids = listIdeas({ status: 'active' }).map((r) => r.id)
    expect(ids).toEqual(['act'])
  })

  it("status='archived' -> archived only", () => {
    const ids = listIdeas({ status: 'archived' }).map((r) => r.id)
    expect(ids).toEqual(['arc'])
  })

  it("a specific status (e.g. 'new') is an exact match and excludes archived", () => {
    const ids = listIdeas({ status: 'new' }).map((r) => r.id)
    expect(ids).toContain('act')
    expect(ids).not.toContain('arc') // arc is now 'archived', not 'new'
  })

  it('NO data loss: an archived idea is never deleted, always retrievable', () => {
    const all = getDb().prepare('SELECT COUNT(*) c FROM idea_box').get() as { c: number }
    expect(all.c).toBe(2) // both rows physically present
  })
})

describe('db: getIdeaByKanbanId + reconcileArchivedIdeas', () => {
  it('getIdeaByKanbanId reverse-looks up the linked idea, undefined when unlinked', () => {
    seedIdea('i1', { kanban_id: 'card1' })
    expect(getIdeaByKanbanId('card1')?.id).toBe('i1')
    expect(getIdeaByKanbanId('absent')).toBeUndefined()
  })

  it('reconcile archives ONLY ideas whose linked card is done; idempotent', () => {
    createKanbanCard({ id: 'cDone', title: 'done card', status: 'done' })
    createKanbanCard({ id: 'cProg', title: 'wip card', status: 'in_progress' })
    seedIdea('iDone', { status: 'kanban', kanban_id: 'cDone' })
    seedIdea('iProg', { status: 'kanban', kanban_id: 'cProg' })
    seedIdea('iLoose', { status: 'kanban', kanban_id: null }) // no link -> untouched

    expect(reconcileArchivedIdeas()).toBe(1) // only iDone
    expect(getDb().prepare("SELECT status FROM idea_box WHERE id='iDone'").get()).toEqual({ status: 'archived' })
    expect(getDb().prepare("SELECT status FROM idea_box WHERE id='iProg'").get()).toEqual({ status: 'kanban' })
    expect(getDb().prepare("SELECT status FROM idea_box WHERE id='iLoose'").get()).toEqual({ status: 'kanban' })

    expect(reconcileArchivedIdeas()).toBe(0) // second sweep is a no-op
  })
})

// ---------------------------------------------------------------------------
describe('POST /api/ideas/:id/archive', () => {
  it('archives an existing idea (200 {ok}) and it leaves the active view', async () => {
    seedIdea('m1')
    const res = mockRes()
    const handled = await tryHandleIdeas(ctx('/api/ideas/m1/archive', 'POST', res))
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(parse(res).ok).toBe(true)
    expect(listIdeas().map((r) => r.id)).not.toContain('m1')
    expect(listIdeas({ status: 'archived' }).map((r) => r.id)).toContain('m1')
  })

  it('returns 404 for an unknown idea (handled, not a fall-through)', async () => {
    const res = mockRes()
    const handled = await tryHandleIdeas(ctx('/api/ideas/ghost/archive', 'POST', res))
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(404)
    expect(listIdeas({ status: 'archived' }).length).toBe(0) // no phantom row
  })

  it('is idempotent at the API layer: archiving twice both return 200 (no throw)', async () => {
    seedIdea('m2')
    const r1 = mockRes(); await tryHandleIdeas(ctx('/api/ideas/m2/archive', 'POST', r1))
    const stamp = listIdeas({ status: 'archived' })[0].archived_at
    const r2 = mockRes(); await tryHandleIdeas(ctx('/api/ideas/m2/archive', 'POST', r2))
    expect(r1.statusCode).toBe(200)
    expect(r2.statusCode).toBe(200) // already-archived -> still ok, no error
    expect(listIdeas({ status: 'archived' })[0].archived_at).toBe(stamp) // not re-stamped
  })

  it('does not shadow /reconcile-archived (exact route wins)', async () => {
    seedIdea('keep')
    const res = mockRes()
    const handled = await tryHandleIdeas(ctx('/api/ideas/reconcile-archived', 'POST', res))
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(parse(res)).toHaveProperty('archived') // the reconcile shape, not {ok} archive
  })
})

describe('GET /api/ideas?status=archived (route filter)', () => {
  it('returns archived only with the query, active only without it', async () => {
    seedIdea('g1'); seedIdea('g2'); archiveIdea('g2')

    const rArc = mockRes()
    await tryHandleIdeas(ctx('/api/ideas', 'GET', rArc, { query: 'status=archived' }))
    expect(parse(rArc).map((r: any) => r.id)).toEqual(['g2'])

    const rAct = mockRes()
    await tryHandleIdeas(ctx('/api/ideas', 'GET', rAct))
    const activeIds = parse(rAct).map((r: any) => r.id)
    expect(activeIds).toContain('g1')
    expect(activeIds).not.toContain('g2')
  })
})

// ---------------------------------------------------------------------------
describe('AUTO-ARCHIVE-ON-DONE hook (kanban /move -> done)', () => {
  // Helper: move a card via the real kanban route handler.
  async function move(cardId: string, status: string): Promise<any> {
    const res = mockRes()
    const handled = await tryHandleKanban(ctx(`/api/kanban/${cardId}/move`, 'POST', res, { req: bodyReq({ status }) }))
    expect(handled).toBe(true)
    return res
  }

  it("moving the linked card to 'done' archives the idea", async () => {
    createKanbanCard({ id: 'kc1', title: 'feature', status: 'planned' })
    seedIdea('ix1', { status: 'kanban', kanban_id: 'kc1' })
    const res = await move('kc1', 'done')
    expect(res.statusCode).toBe(200)
    expect(parse(res).ok).toBe(true)
    expect(getDb().prepare("SELECT status FROM idea_box WHERE id='ix1'").get()).toEqual({ status: 'archived' })
  })

  it.each(['planned', 'waiting'])("a non-done move ('%s') does NOT archive the idea", async (status) => {
    createKanbanCard({ id: 'kc2', title: 'feature', status: 'in_progress' })
    seedIdea('ix2', { status: 'kanban', kanban_id: 'kc2' })
    await move('kc2', status)
    expect(getDb().prepare("SELECT status FROM idea_box WHERE id='ix2'").get()).toEqual({ status: 'kanban' })
  })

  it("moving a card with NO linked idea to 'done' is a no-op and the move still succeeds", async () => {
    createKanbanCard({ id: 'kc3', title: 'orphan', status: 'planned' })
    const res = await move('kc3', 'done')
    expect(res.statusCode).toBe(200)
    expect(parse(res).ok).toBe(true)
  })

  it('the hook is idempotent: re-moving an already-done card does not re-stamp archived_at', async () => {
    createKanbanCard({ id: 'kc4', title: 'feature', status: 'planned' })
    seedIdea('ix4', { status: 'kanban', kanban_id: 'kc4' })
    await move('kc4', 'done')
    const stamp = listIdeas({ status: 'archived' }).find((r) => r.id === 'ix4')!.archived_at
    await move('kc4', 'done') // again
    const stamp2 = listIdeas({ status: 'archived' }).find((r) => r.id === 'ix4')!.archived_at
    expect(stamp2).toBe(stamp)
  })

  it('manual-archive then card-done does not double-process (archived_at preserved)', async () => {
    createKanbanCard({ id: 'kc5', title: 'feature', status: 'planned' })
    seedIdea('ix5', { status: 'kanban', kanban_id: 'kc5' })
    archiveIdea('ix5') // archived first, out of band
    const stamp = listIdeas({ status: 'archived' }).find((r) => r.id === 'ix5')!.archived_at
    await move('kc5', 'done') // hook sees status==='archived' -> early return
    const stamp2 = listIdeas({ status: 'archived' }).find((r) => r.id === 'ix5')!.archived_at
    expect(stamp2).toBe(stamp)
  })

  it("moving a NON-EXISTENT card returns 404 and touches no idea", async () => {
    seedIdea('ix6', { status: 'kanban', kanban_id: 'ghostcard' })
    const res = await move('ghostcard', 'done') // no such card row
    expect(res.statusCode).toBe(404)
    expect(getDb().prepare("SELECT status FROM idea_box WHERE id='ix6'").get()).toEqual({ status: 'kanban' })
  })
})

// ---------------------------------------------------------------------------
describe('MIGRATION: old idea_box (no archived_at) -> rebuilt, every row preserved', () => {
  it('adds archived_at + the archived status without losing any existing row', () => {
    const dir = mkdtempSync(join(tmpdir(), 'probe-idea-mig-'))
    const dbPath = join(dir, 'old.db')
    try {
      // Build the PRE-FEATURE schema (no archived_at; CHECK lacks 'archived').
      const old = new Database(dbPath)
      old.exec(`
        CREATE TABLE idea_box (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          description TEXT,
          category TEXT NOT NULL DEFAULT 'Egyéb',
          status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','reviewed','kanban','rejected')),
          source TEXT NOT NULL DEFAULT 'nexus',
          kanban_id TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `)
      const ins = old.prepare(
        'INSERT INTO idea_box (id,title,description,category,status,source,kanban_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)'
      )
      ins.run('o1', 'első', 'd1', 'Egyéb', 'new', 'nexus', null, 100, 100)
      ins.run('o2', 'második', null, 'Ötlet', 'kanban', 'manual', 'cardX', 200, 200)
      ins.run('o3', 'harmadik', 'd3', 'Egyéb', 'rejected', 'nexus', null, 300, 300)
      old.close()

      // Trigger the migration by initialising over the existing file.
      initDatabase(dbPath)

      // archived_at column now exists.
      const cols = (getDb().prepare('PRAGMA table_info(idea_box)').all() as { name: string }[]).map((c) => c.name)
      expect(cols).toContain('archived_at')

      // Every original row preserved, values intact, archived_at defaulted to null.
      const rows = getDb().prepare('SELECT * FROM idea_box ORDER BY id').all() as any[]
      expect(rows.map((r) => r.id)).toEqual(['o1', 'o2', 'o3'])
      expect(rows.map((r) => r.status)).toEqual(['new', 'kanban', 'rejected'])
      expect(rows.find((r) => r.id === 'o2').kanban_id).toBe('cardX')
      expect(rows.every((r) => r.archived_at === null)).toBe(true)

      // The widened CHECK now accepts 'archived' (pre-migration it would throw).
      expect(archiveIdea('o1')).toBe(true)
      expect(listIdeas({ status: 'archived' }).map((r) => r.id)).toEqual(['o1'])
      // ...and the other rows still work normally (backward compatible).
      expect(updateIdea('o3', { status: 'reviewed' })).toBe(true)
    } finally {
      initDatabase(':memory:') // detach from the temp file before removing it
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
