// Regression test for the missing POST /api/ideas/:id/breakdown endpoint.
//
// Bug: the dashboard idea-box "Kanbanra (AI)" button POSTed to
// /api/ideas/<id>/breakdown, which did not exist in the backend -> 404 ->
// the UI showed "Breakdown hiba". The RECEIVER (.../promote-breakdown) existed,
// but the GENERATOR endpoint was missing.
//
// Fix: implement POST /api/ideas/:id/breakdown — it deterministically generates
// {subtasks:[{title,description,assignee,priority}]} from the idea's title +
// description (no LLM; subscription-OAuth invariant, never ANTHROPIC_API_KEY).
//
// These tests exercise the real route handler on an in-memory DB, plus the pure
// breakdownIdea generator.

import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, createIdea } from '../db.js'
import { tryHandleIdeas, breakdownIdea } from '../web/routes/ideas.js'

function mockRes(): any {
  const r: any = { statusCode: 0, body: undefined }
  r.writeHead = (status: number) => { r.statusCode = status; return r }
  r.end = (chunk?: any) => { if (chunk !== undefined) r.body = chunk.toString() }
  return r
}
function ctx(path: string, method: string, res: any): any {
  return { req: {} as any, res, path, method, url: new URL('http://localhost' + path) }
}

beforeEach(() => {
  initDatabase(':memory:')
})

describe('POST /api/ideas/:id/breakdown (regression: endpoint was missing -> 404)', () => {
  it('handles the route and returns {subtasks} (no longer falls through to 404)', async () => {
    createIdea({
      id: 'idea1',
      title: 'Dashboard breakdown javítás',
      description: '- Írj tesztet a bughoz\n- Javítsd a kód endpointot\n- Release a fixet',
      category: 'Egyéb', status: 'new', source: 'manual', kanban_id: null,
    })
    const res = mockRes()
    const handled = await tryHandleIdeas(ctx('/api/ideas/idea1/breakdown', 'POST', res))
    expect(handled).toBe(true) // route is wired; pre-fix it fell through (server -> 404)
    expect(res.statusCode).toBe(200)
    const data = JSON.parse(res.body)
    expect(Array.isArray(data.subtasks)).toBe(true)
    expect(data.subtasks.length).toBe(3)
    for (const st of data.subtasks) {
      expect(typeof st.title).toBe('string')
      expect(st.title.length).toBeGreaterThan(0)
      expect(typeof st.assignee).toBe('string')
      expect(['low', 'normal', 'high', 'urgent']).toContain(st.priority)
    }
  })

  it('returns 404 for an unknown idea (handled, not a fall-through)', async () => {
    const res = mockRes()
    const handled = await tryHandleIdeas(ctx('/api/ideas/nope/breakdown', 'POST', res))
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(404)
  })

  it('does NOT shadow the existing promote-breakdown route', async () => {
    // /promote-breakdown must not be captured by the new /breakdown matcher.
    const res = mockRes()
    const handled = await tryHandleIdeas(ctx('/api/ideas/idea1/promote-breakdown', 'POST', res))
    // handled true and NOT a 200 {subtasks} (it's the promote receiver, which 404s
    // for a missing idea here) — proving the breakdown matcher didn't swallow it.
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(404) // idea1 not created in this test
  })
})

describe('breakdownIdea (deterministic generation)', () => {
  it('splits a bulleted description into one subtask per line, markers stripped', () => {
    const out = breakdownIdea({ title: 'X', description: '- első\n- második\n- harmadik' })
    expect(out.map((s) => s.title)).toEqual(['első', 'második', 'harmadik'])
    expect(out.every((s) => s.priority === 'normal')).toBe(true)
  })

  it('routes subtasks to the right agent by content heuristic (HU suffixes ok)', () => {
    const out = breakdownIdea({
      title: 'X',
      description: '- Írj tesztet a regresszióra\n- Deploy/release a kiadáshoz\n- Készíts wireframe mockupot',
    })
    expect(out[0].assignee).toBe('probe')
    expect(out[1].assignee).toBe('harbor')
    expect(out[2].assignee).toBe('prism')
  })

  it('falls back to a single subtask from the title when not splittable', () => {
    const out = breakdownIdea({ title: 'Egyetlen feladat', description: '' })
    expect(out.length).toBe(1)
    expect(out[0].title).toBe('Egyetlen feladat')
  })

  it('dedupes repeated lines and caps the count', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `- feladat ${i % 3}`).join('\n')
    const out = breakdownIdea({ title: 'X', description: lines })
    expect(out.length).toBe(3) // only 3 unique lines
  })
})
