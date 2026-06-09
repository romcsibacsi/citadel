// Kanban board collaboration test.
//
// Verifies the board end-to-end with REAL multi-agent collaboration (no GPU):
//   1) start the non-GPU agents (forge, oracle, sigma; creative + NEXUS already up)
//   2) open a "Kanban teszt" project: 1 NEXUS coordination card + 4 agent subtasks
//   3) move each card to in_progress -> the dashboard dispatches a wake-message to
//      the assigned agent (kanban -> agent dispatch, "option D")
//   4) each agent comments on its card + moves it to done
//   5) poll the board and report who did what
//
// The task is tiny + text-only: each agent writes 1 line about itself + 1
// non-GPU improvement idea, then drags its card to done. Self-contained: every
// card description carries the exact curl recipe + its own card id.
import { readFileSync } from 'node:fs'

const ROOT = '/home/uplinkfather/CITADEL/citadel'
const BASE = 'http://127.0.0.1:3420'
const TOKEN = readFileSync(`${ROOT}/store/.dashboard-token`, 'utf-8').trim()
const H = { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a)

async function api(method, path, body) {
  const r = await fetch(`${BASE}${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined })
  const txt = await r.text()
  let j = null; try { j = txt ? JSON.parse(txt) : null } catch {}
  return { status: r.status, ok: r.ok, body: j ?? txt }
}

const PROJECT = 'Kanban teszt'
// assignee must match the dispatch resolver: sub-agents by lowercase name, the
// hub by "NEXUS". Only RUNNING agents actually receive the dispatch.
const TEAM = [
  { assignee: 'forge', display: 'FORGE', role: 'senior fejlesztő' },
  { assignee: 'oracle', display: 'ORACLE', role: 'kutató / intel' },
  { assignee: 'sigma', display: 'SIGMA', role: 'adat/elemzés' },
  { assignee: 'creative', display: 'CREATIVE', role: 'kép-stúdió' },
]
const TO_START = ['forge', 'oracle', 'sigma'] // creative + NEXUS already running

function subtaskDesc(display, cardId) {
  return [
    `Feladat (GPU NEM kell, csak szöveg!):`,
    `1) Írj egy RÖVID kommentet erre a kártyára: egy mondat magadról (${display}) + egy konkrét, GPU-mentes ötlet a CITADEL/homelab fejlesztésére.`,
    `2) Aztán húzd ezt a kártyát "done"-ra.`,
    ``,
    `Pontosan ezekkel a parancsokkal (a TE kártyád ID-ja: ${cardId}):`,
    ``,
    `# 1) komment:`,
    `curl -s -X POST ${BASE}/api/kanban/${cardId}/comments -H "Authorization: Bearer $(cat ${ROOT}/store/.dashboard-token)" -H "Content-Type: application/json" -d '{"author":"${display}","content":"IDE_A_SZÖVEGED"}'`,
    ``,
    `# 2) done-ra húzás:`,
    `curl -s -X POST ${BASE}/api/kanban/${cardId}/move -H "Authorization: Bearer $(cat ${ROOT}/store/.dashboard-token)" -H "Content-Type: application/json" -d '{"status":"done"}'`,
  ].join('\n')
}

function nexusDesc(cardId) {
  return [
    `Te vagy a koordinátor (NEXUS). GPU NEM kell.`,
    `1) Írj egy rövid üdvözlő/kickoff kommentet erre a kártyára, hogy elindult a "Kanban teszt" projekt és a csapat (FORGE, ORACLE, SIGMA, CREATIVE) dolgozik az alfeladatokon.`,
    `2) Aztán húzd ezt a kártyát "done"-ra.`,
    ``,
    `Parancsok (a kártyád ID-ja: ${cardId}):`,
    `curl -s -X POST ${BASE}/api/kanban/${cardId}/comments -H "Authorization: Bearer $(cat ${ROOT}/store/.dashboard-token)" -H "Content-Type: application/json" -d '{"author":"NEXUS","content":"IDE_A_SZÖVEGED"}'`,
    `curl -s -X POST ${BASE}/api/kanban/${cardId}/move -H "Authorization: Bearer $(cat ${ROOT}/store/.dashboard-token)" -H "Content-Type: application/json" -d '{"status":"done"}'`,
  ].join('\n')
}

async function createCard(fields) {
  const r = await api('POST', '/api/kanban', fields)
  if (!r.ok || !r.body?.id) throw new Error(`createCard failed: ${r.status} ${JSON.stringify(r.body)}`)
  return r.body.id
}

async function main() {
  // ── Phase 1: start the non-GPU agents ───────────────────────────────────
  log('Phase 1: agents indítása', TO_START.join(', '))
  for (const a of TO_START) {
    const r = await api('POST', `/api/agents/${a}/start`)
    log(`  start ${a}: ${r.status} ${JSON.stringify(r.body)}`)
  }
  log('várok 30s-ot, hogy a Claude Code sessionök felálljanak…')
  await sleep(30000)

  // ── Phase 2: open the project + cards ────────────────────────────────────
  log('Phase 2: projekt + kártyák létrehozása')
  const parentId = await createCard({ title: 'Kanban teszt — csapat-koordináció', description: 'ideiglenes', assignee: 'NEXUS', priority: 'high', project: PROJECT })
  await api('PUT', `/api/kanban/${parentId}`, { description: nexusDesc(parentId) })
  log(`  parent (NEXUS): ${parentId}`)

  const cards = [{ id: parentId, assignee: 'NEXUS', display: 'NEXUS' }]
  for (const m of TEAM) {
    const id = await createCard({ title: `Bemutatkozás + ötlet — ${m.display}`, description: 'ideiglenes', assignee: m.assignee, priority: 'normal', project: PROJECT, parent_id: parentId })
    await api('PUT', `/api/kanban/${id}`, { description: subtaskDesc(m.display, id) })
    cards.push({ id, assignee: m.assignee, display: m.display })
    log(`  subtask ${m.display} (${m.assignee}): ${id}`)
  }

  // ── Phase 3: dispatch (move to in_progress) ──────────────────────────────
  log('Phase 3: kártyák in_progress-re mozgatása → dispatch az ügynököknek')
  for (const c of cards) {
    const r = await api('POST', `/api/kanban/${c.id}/move`, { status: 'in_progress' })
    log(`  move ${c.display} -> in_progress: ${r.status}`)
  }

  // ── Phase 4: verify dispatch fired (dispatched_at set) ───────────────────
  await sleep(2000)
  const after = await api('GET', '/api/kanban')
  const byId = new Map((after.body || []).map(c => [c.id, c]))
  log('Phase 4: dispatch-ellenőrzés (dispatched_at):')
  for (const c of cards) {
    const card = byId.get(c.id)
    log(`  ${c.display}: dispatched_at=${card?.dispatched_at ? 'IGEN' : 'nincs'} status=${card?.status}`)
  }

  // ── Phase 5: observe collaboration ───────────────────────────────────────
  log('Phase 5: kollaboráció figyelése (max ~8 perc, korábban kilép ha minden done)…')
  const ids = cards.map(c => c.id)
  for (let cycle = 0; cycle < 32; cycle++) {
    await sleep(15000)
    const list = await api('GET', '/api/kanban')
    const map = new Map((list.body || []).map(c => [c.id, c]))
    const rows = []
    let doneCount = 0, commentedCount = 0
    for (const c of cards) {
      const card = map.get(c.id)
      const cm = await api('GET', `/api/kanban/${c.id}/comments`)
      const comments = Array.isArray(cm.body) ? cm.body : []
      if (card?.status === 'done') doneCount++
      if (comments.length) commentedCount++
      rows.push(`${c.display}:${card?.status || '?'}${comments.length ? `(💬${comments.length})` : ''}`)
    }
    log(`  [${cycle}] ${rows.join('  ')}  — done ${doneCount}/${cards.length}, kommentelt ${commentedCount}/${cards.length}`)
    if (doneCount === cards.length) { log('✅ Minden kártya DONE.'); break }
  }

  // ── Phase 6: final report ────────────────────────────────────────────────
  log('Phase 6: végeredmény')
  for (const c of cards) {
    const cm = await api('GET', `/api/kanban/${c.id}/comments`)
    const comments = Array.isArray(cm.body) ? cm.body : []
    const list = await api('GET', '/api/kanban')
    const card = (list.body || []).find(x => x.id === c.id)
    log(`  ${c.display} [${card?.status}] — ${comments.length} komment:`)
    for (const k of comments) log(`     • (${k.author}) ${String(k.content).slice(0, 100)}`)
  }
  log('KÉSZ. A "Kanban teszt" projekt a dashboard Kanban tábláján látható.')
}

main().catch(e => { console.error('FATAL', e); process.exit(1) })
