import { randomUUID } from 'node:crypto'
import {
  listKanbanCards, listArchivedKanbanCards, createKanbanCard, updateKanbanCard,
  deleteKanbanCard, moveKanbanCard, archiveKanbanCard, unarchiveKanbanCard,
  getKanbanComments, addKanbanComment, listKanbanProjects,
  getKanbanCard, getChildCards, getDb,
  createAgentMessage, markKanbanCardDispatched,
  getIdeaByKanbanId, archiveIdea, countApprovalsNeeded,
} from '../../db.js'
import { notifyAlert } from '../../notify.js'
import { OWNER_NAME, BOT_NAME, MAIN_AGENT_ID } from '../../config.js'
import { listAgentNames, readAgentDisplayName } from '../agent-config.js'
import { isAgentRunning } from '../agent-process.js'
import { resolveKanbanDispatchTarget } from '../../kanban-dispatch.js'
import { logger } from '../../logger.js'
import { readBody, json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

// Option D: kanban -> agent dispatch. When a card moves to in_progress, wake the
// assigned agent once via the inter-agent message router (createAgentMessage),
// which gives retry / dedup / trust-wrapping / busy-receiver handling for free.
// dispatched_at is the once-only guard; errors never block the card move.
function fireKanbanDispatch(id: string): void {
  try {
    const card = getKanbanCard(id)
    if (!card || card.dispatched_at) return
    const target = resolveKanbanDispatchTarget(card.assignee, {
      ownerName: OWNER_NAME,
      botName: BOT_NAME,
      mainAgentId: MAIN_AGENT_ID,
      agentNames: listAgentNames(),
      isRunning: isAgentRunning,
    })
    if (!target) return
    const desc = (card.description ?? '').trim()
    const content = `[Kanban feladat #${id}]: ${card.title}${desc ? ' — ' + desc : ''}\n\nA kártyát in_progress-re húzták. Ha kész vagy, húzd "done"-ra.`
    createAgentMessage(MAIN_AGENT_ID, target, content)
    markKanbanCardDispatched(id)
    logger.info({ id, target, assignee: card.assignee }, 'Kanban in_progress dispatch fired')
  } catch (err) {
    logger.warn({ err, id }, 'Kanban dispatch failed (card move still succeeded)')
  }
}

// When a card moves to 'done', archive the linked idea-box entry (if any) so the
// resolved idea leaves the active view but is preserved (never deleted). Error-
// tolerant: the card move must never fail because of this hook (mirrors dispatch).
function fireIdeaArchiveOnDone(cardId: string): void {
  try {
    const idea = getIdeaByKanbanId(cardId)
    if (!idea || idea.status === 'archived') return
    archiveIdea(idea.id)
    logger.info({ cardId, ideaId: idea.id }, 'Idea archived on card done')
  } catch (err) {
    logger.warn({ err, cardId }, 'Idea auto-archive failed (card move still succeeded)')
  }
}

export async function tryHandleKanban(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  if (path === '/api/kanban' && method === 'GET') {
    // ?archived=true -> archived history; default stays the active board (backward compat).
    if (url.searchParams.get('archived') === 'true') { json(res, listArchivedKanbanCards()); return true }
    json(res, listKanbanCards())
    return true
  }

  if (path === '/api/kanban-projects' && method === 'GET') {
    json(res, listKanbanProjects())
    return true
  }

  if (path === '/api/kanban/assignees' && method === 'GET') {
    const agents = listAgentNames().map((name) => ({ name, type: 'agent', displayName: readAgentDisplayName(name) || name }))
    json(res, [
      // OWNER_NAME defaults to '' (neutral operator, identity cleanup) -- an
      // empty name rendered a blank <option> in every assignee select. Fall
      // back to the neutral label the personas already use.
      { name: OWNER_NAME || 'Operátor', type: 'owner' },
      { name: BOT_NAME, type: 'bot' },
      ...agents,
    ])
    return true
  }

  // Count of cards parked waiting on the operator's approval (dashboard badge).
  // Exact-path GET, placed before the /api/kanban/:id regex routes.
  if (path === '/api/kanban/approvals' && method === 'GET') {
    json(res, { count: countApprovalsNeeded() })
    return true
  }

  if (path === '/api/kanban' && method === 'POST') {
    const body = await readBody(req)
    const data = JSON.parse(body.toString())
    const id = randomUUID().slice(0, 8)
    createKanbanCard({ id, ...data })
    if (data.requires_approval) {
      notifyAlert(`[CITADEL] Jóváhagyásra vár: "${data.title ?? id}" — a Kanban táblán döntésedre vár.`).catch(() => {})
    }
    json(res, { ok: true, id })
    return true
  }

  const kanbanCardMatch = path.match(/^\/api\/kanban\/([^/]+)$/)
  if (kanbanCardMatch && method === 'PUT') {
    const id = decodeURIComponent(kanbanCardMatch[1])
    const body = await readBody(req)
    const data = JSON.parse(body.toString())
    const before = getKanbanCard(id)
    if (updateKanbanCard(id, data)) {
      // One-shot ping only on the falsy->truthy transition into needs-approval.
      if (data.requires_approval && !before?.requires_approval) {
        notifyAlert(`[CITADEL] Jóváhagyásra vár: "${before?.title ?? id}" — a Kanban táblán döntésedre vár.`).catch(() => {})
      }
      json(res, { ok: true }); return true
    }
    json(res, { error: 'Kártya nem található' }, 404)
    return true
  }

  if (kanbanCardMatch && method === 'DELETE') {
    const id = decodeURIComponent(kanbanCardMatch[1])
    if (deleteKanbanCard(id)) { json(res, { ok: true }); return true }
    json(res, { error: 'Kártya nem található' }, 404)
    return true
  }

  const kanbanMoveMatch = path.match(/^\/api\/kanban\/([^/]+)\/move$/)
  if (kanbanMoveMatch && method === 'POST') {
    const id = decodeURIComponent(kanbanMoveMatch[1])
    const body = await readBody(req)
    const { status, sort_order } = JSON.parse(body.toString())
    if (moveKanbanCard(id, status, sort_order ?? 0)) {
      // Wake the assigned agent once when the card enters in_progress.
      if (status === 'in_progress') fireKanbanDispatch(id)
      // Archive the linked idea-box entry when the card is done (preserve, not delete).
      if (status === 'done') fireIdeaArchiveOnDone(id)
      json(res, { ok: true })
      return true
    }
    json(res, { error: 'Kártya nem található' }, 404)
    return true
  }

  // needs-approval v2 (#ec737f86): operator approves/rejects a card parked on
  // their decision. Lowers requires_approval (badge clears), records who/when as a
  // comment, and signals NEXUS so it can continue. The button ONLY lowers the flag
  // + signals -- it never starts the (possibly dangerous) work itself; the
  // responsible agent/NEXUS does that.
  const kanbanApprovalMatch = path.match(/^\/api\/kanban\/([^/]+)\/(approve|reject)$/)
  if (kanbanApprovalMatch && method === 'POST') {
    const id = decodeURIComponent(kanbanApprovalMatch[1])
    const decision = kanbanApprovalMatch[2]
    const card = getKanbanCard(id)
    if (!card) { json(res, { error: 'Kártya nem található' }, 404); return true }
    updateKanbanCard(id, { requires_approval: 0 })
    const who = OWNER_NAME || 'Operátor'
    if (decision === 'approve') {
      addKanbanComment(id, who, '✓ Jóváhagyva (dashboard).')
      createAgentMessage('operator', MAIN_AGENT_ID, `Az operátor JÓVÁHAGYTA a(z) "${card.title}" (#${id}) kártyát — folytatható.`)
    } else {
      addKanbanComment(id, who, '✗ Elutasítva (dashboard).')
      createAgentMessage('operator', MAIN_AGENT_ID, `Az operátor ELUTASÍTOTTA a(z) "${card.title}" (#${id}) kártyát — ne folytasd.`)
    }
    json(res, { ok: true })
    return true
  }

  const kanbanArchiveMatch = path.match(/^\/api\/kanban\/([^/]+)\/archive$/)
  if (kanbanArchiveMatch && method === 'POST') {
    const id = decodeURIComponent(kanbanArchiveMatch[1])
    if (archiveKanbanCard(id)) { json(res, { ok: true }); return true }
    json(res, { error: 'Kártya nem található' }, 404)
    return true
  }

  // Restore an archived card to the active board.
  const kanbanUnarchiveMatch = path.match(/^\/api\/kanban\/([^/]+)\/unarchive$/)
  if (kanbanUnarchiveMatch && method === 'POST') {
    const id = decodeURIComponent(kanbanUnarchiveMatch[1])
    if (unarchiveKanbanCard(id)) { json(res, { ok: true }); return true }
    json(res, { error: 'Archivált kártya nem található' }, 404)
    return true
  }

  const kanbanCommentsMatch = path.match(/^\/api\/kanban\/([^/]+)\/comments$/)
  if (kanbanCommentsMatch && method === 'GET') {
    const cardId = decodeURIComponent(kanbanCommentsMatch[1])
    json(res, getKanbanComments(cardId))
    return true
  }
  if (kanbanCommentsMatch && method === 'POST') {
    const cardId = decodeURIComponent(kanbanCommentsMatch[1])
    const body = await readBody(req)
    const { author, content } = JSON.parse(body.toString())
    if (!author || !content) { json(res, { error: 'Szerző és tartalom kötelező' }, 400); return true }
    json(res, addKanbanComment(cardId, author, content))
    return true
  }

  const acceptMatch = path.match(/^\/api\/kanban\/([^/]+)\/breakdown\/accept$/)
  if (acceptMatch && method === 'POST') {
    const parentId = decodeURIComponent(acceptMatch[1])
    const parent = getKanbanCard(parentId)
    if (!parent) { json(res, { error: 'Szülő kártya nem található' }, 404); return true }
    const body = await readBody(req)
    const { subtasks } = JSON.parse(body.toString()) as {
      subtasks: Array<{ title: string; description: string; assignee: string | null; priority: string }>
    }
    if (!Array.isArray(subtasks) || subtasks.length === 0) {
      json(res, { error: 'Subtask lista kötelező' }, 400)
      return true
    }
    const db = getDb()
    const created = db.transaction(() => {
      const ids: string[] = []
      for (const st of subtasks) {
        const id = randomUUID().slice(0, 8).toUpperCase()
        createKanbanCard({
          id,
          title: st.title,
          description: st.description,
          assignee: st.assignee ?? undefined,
          priority: (st.priority as any) ?? 'normal',
          project: parent.project ?? undefined,
          parent_id: parentId,
        })
        ids.push(id)
      }
      addKanbanComment(parentId, BOT_NAME, `Auto-breakdown: ${ids.length} subtask létrehozva (${ids.join(', ')})`)
      return ids
    })()
    json(res, { ok: true, created })
    return true
  }

  const childrenMatch = path.match(/^\/api\/kanban\/([^/]+)\/children$/)
  if (childrenMatch && method === 'GET') {
    const parentId = decodeURIComponent(childrenMatch[1])
    json(res, getChildCards(parentId))
    return true
  }

  return false
}
