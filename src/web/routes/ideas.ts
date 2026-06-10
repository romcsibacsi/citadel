import { randomUUID } from 'node:crypto'
import { listIdeas, createIdea, updateIdea, deleteIdea, listIdeaCategories, createKanbanCard, getDb, archiveIdea, reconcileArchivedIdeas } from '../../db.js'
import { logger } from '../../logger.js'
import { readBody, json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

type IdeaRow = import('../../db.js').IdeaBoxRow

function getIdea(id: string): IdeaRow | undefined {
  return getDb().prepare('SELECT * FROM idea_box WHERE id = ?').get(id) as IdeaRow | undefined
}

const VALID_PRIORITIES = new Set(['low', 'normal', 'high', 'urgent'])

// Heuristic assignee routing for generated subtasks: match the subtask text to the
// agent whose lane it falls in. First match wins; default 'nexus'. Leading-only word
// boundary (no trailing \b) so Hungarian suffixes still match (pl. "tesztet"->teszt).
const ASSIGNEE_HINTS: Array<[RegExp, string]> = [
  [/\b(teszt|test|qa|regresszi|bug)/i, 'probe'],
  [/\b(deploy|release|ci\/?cd|pipeline|csomagol|kiadás|verzió)/i, 'harbor'],
  [/\b(design|ux|wireframe|mockup|layout|vizuál)/i, 'prism'],
  [/\b(homelab|netops|infra|szerver|telepít)/i, 'relay'],
  [/\b(kutat|research|intel|biztonság|security|felderít)/i, 'oracle'],
  [/\b(adat|data|elemz|spreadsheet|statisztik)/i, 'sigma'],
  [/\b(kép|image|comfy|illusztr)/i, 'creative'],
  [/\b(videó|video|klip|anim)/i, 'reel'],
  [/\b(kód|code|build|implement|fejleszt|refaktor|feature|endpoint|api|fix)/i, 'forge'],
]
function guessAssignee(text: string): string {
  for (const [rx, who] of ASSIGNEE_HINTS) if (rx.test(text)) return who
  return 'nexus'
}

// Deterministic breakdown of an idea into actionable subtasks (no LLM -- subscription
// OAuth only, never ANTHROPIC_API_KEY). Split the description into bullet/numbered/
// newline items, strip the markers, dedupe, cap, and heuristically assign each. Falls
// back to a single subtask from the title when the description is empty or not
// splittable. The operator edits these in the breakdown modal before promote-breakdown
// creates the cards.
export function breakdownIdea(
  idea: Pick<IdeaRow, 'title' | 'description'>,
): Array<{ title: string; description: string; assignee: string; priority: string }> {
  const desc = (idea.description ?? '').trim()
  const items = desc
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*([-*•■▪◦·]|\d+[.)])\s*/, '').trim())
    .filter((l) => l.length > 0)
  const seen = new Set<string>()
  const unique = items
    .filter((l) => { const k = l.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true })
    .slice(0, 12)
  if (unique.length >= 2) {
    return unique.map((l) => ({
      title: l.slice(0, 120),
      description: l.length > 120 ? l : '',
      assignee: guessAssignee(l),
      priority: 'normal',
    }))
  }
  return [{
    title: String(idea.title).slice(0, 120),
    description: desc.slice(0, 500),
    assignee: guessAssignee(`${idea.title} ${desc}`),
    priority: 'normal',
  }]
}

export async function tryHandleIdeas(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  if (path === '/api/ideas' && method === 'GET') {
    const status = url.searchParams.get('status') || undefined
    const category = url.searchParams.get('category') || undefined
    json(res, listIdeas({ status, category }))
    return true
  }

  if (path === '/api/ideas/categories' && method === 'GET') {
    json(res, listIdeaCategories())
    return true
  }

  // Fallback / first-use sweep: archive every idea whose linked card is 'done'.
  // (Belt-and-suspenders to the kanban move -> done auto-archive hook.)
  if (path === '/api/ideas/reconcile-archived' && method === 'POST') {
    const archived = reconcileArchivedIdeas()
    json(res, { ok: true, archived })
    return true
  }

  if (path === '/api/ideas' && method === 'POST') {
    const body = await readBody(req)
    const data = JSON.parse(body.toString()) as {
      title: string
      description?: string
      category?: string
      source?: string
    }
    if (!data.title) { json(res, { error: 'title required' }, 400); return true }
    const id = randomUUID().slice(0, 8)
    createIdea({
      id,
      title: data.title,
      description: data.description ?? null,
      category: data.category ?? 'Egyéb',
      status: 'new',
      source: data.source ?? 'manual',
      kanban_id: null,
    })
    json(res, { ok: true, id })
    return true
  }

  const ideaMatch = path.match(/^\/api\/ideas\/([^/]+)$/)

  if (ideaMatch && method === 'PUT') {
    const id = decodeURIComponent(ideaMatch[1])
    const body = await readBody(req)
    const data = JSON.parse(body.toString())
    if (updateIdea(id, data)) { json(res, { ok: true }); return true }
    json(res, { error: 'Ötlet nem található' }, 404)
    return true
  }

  if (ideaMatch && method === 'DELETE') {
    const id = decodeURIComponent(ideaMatch[1])
    if (deleteIdea(id)) { json(res, { ok: true }); return true }
    json(res, { error: 'Ötlet nem található' }, 404)
    return true
  }

  // Manual archive (for ideas resolved without a kanban card): status=archived +
  // archived_at. Archive, never delete -- the row is preserved.
  const archiveMatch = path.match(/^\/api\/ideas\/([^/]+)\/archive$/)
  if (archiveMatch && method === 'POST') {
    const id = decodeURIComponent(archiveMatch[1])
    if (!getIdea(id)) { json(res, { error: 'Ötlet nem található' }, 404); return true }
    archiveIdea(id)
    json(res, { ok: true })
    return true
  }

  // Promote idea to kanban card
  const promoteMatch = path.match(/^\/api\/ideas\/([^/]+)\/promote$/)
  if (promoteMatch && method === 'POST') {
    const ideaId = decodeURIComponent(promoteMatch[1])
    const body = await readBody(req)
    const data = JSON.parse(body.toString()) as { phase?: 'detail' | 'plan' }
    const phase = data.phase ?? 'detail'

    const idea = (getDb().prepare('SELECT * FROM idea_box WHERE id = ?').get(ideaId) as import('../../db.js').IdeaBoxRow | undefined)
    if (!idea) { json(res, { error: 'Ötlet nem található' }, 404); return true }

    const cardId = randomUUID().slice(0, 8)
    const status = phase === 'plan' ? 'planned' : 'waiting'
    const title = phase === 'plan' ? idea.title : `[Részlet kidolgozás] ${idea.title}`
    createKanbanCard({
      id: cardId,
      title,
      description: idea.description ?? '',
      status,
      priority: 'normal',
      assignee: 'nexus',
      project: 'Fejlesztési ötletek',
    })
    updateIdea(ideaId, { status: 'kanban', kanban_id: cardId })
    json(res, { ok: true, kanban_id: cardId })
    return true
  }

  // Generate a DRAFT breakdown of an idea into subtasks (deterministic, no LLM). The
  // frontend's "Kanbanra (AI)" button POSTs here; without this endpoint it 404'd. The
  // returned {subtasks} populate the breakdown modal, where the operator edits/approves
  // before POST .../promote-breakdown creates the parent + child cards.
  const breakdownMatch = path.match(/^\/api\/ideas\/([^/]+)\/breakdown$/)
  if (breakdownMatch && method === 'POST') {
    const ideaId = decodeURIComponent(breakdownMatch[1])
    const idea = getIdea(ideaId)
    if (!idea) { json(res, { error: 'Ötlet nem található' }, 404); return true }
    json(res, { subtasks: breakdownIdea(idea) })
    return true
  }

  // Promote an idea via approved breakdown: create a parent card from the idea +
  // one child card per approved subtask (assignee + priority), mark idea 'kanban'.
  const promoteBreakdownMatch = path.match(/^\/api\/ideas\/([^/]+)\/promote-breakdown$/)
  if (promoteBreakdownMatch && method === 'POST') {
    const ideaId = decodeURIComponent(promoteBreakdownMatch[1])
    const idea = getIdea(ideaId)
    if (!idea) { json(res, { error: 'Ötlet nem található' }, 404); return true }
    const body = await readBody(req)
    const { subtasks } = JSON.parse(body.toString()) as {
      subtasks: Array<{ title: string; description?: string; assignee?: string | null; priority?: string }>
    }
    if (!Array.isArray(subtasks) || subtasks.length === 0) {
      json(res, { error: 'Legalább egy jóváhagyott alfeladat kötelező' }, 400)
      return true
    }
    const parentId = randomUUID().slice(0, 8)
    createKanbanCard({
      id: parentId,
      title: idea.title,
      description: idea.description ?? '',
      status: 'planned',
      priority: 'normal',
      assignee: 'nexus',
      project: 'Fejlesztési ötletek',
    })
    const childIds: string[] = []
    for (const st of subtasks) {
      if (!st.title) continue
      const childId = randomUUID().slice(0, 8)
      createKanbanCard({
        id: childId,
        title: String(st.title).slice(0, 120),
        description: (st.description ?? '').slice(0, 500),
        status: 'planned',
        priority: (st.priority && VALID_PRIORITIES.has(st.priority) ? st.priority : 'normal') as 'low' | 'normal' | 'high' | 'urgent',
        assignee: st.assignee || 'nexus',
        project: 'Fejlesztési ötletek',
        parent_id: parentId,
      })
      childIds.push(childId)
    }
    updateIdea(ideaId, { status: 'kanban', kanban_id: parentId })
    json(res, { ok: true, parent_id: parentId, child_count: childIds.length })
    return true
  }

  return false
}
