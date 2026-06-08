import { MAIN_AGENT_ID } from '../config.js'
import { sanitizeAgentName } from './sanitize.js'
import { listAllAgentNames } from './agent-config.js'

// Names that may never be taken by a spawned agent: the main orchestrator plus
// the base roster + the technical/system identifiers the runtime reserves.
const RESERVED = new Set<string>([
  'nexus', 'forge', 'spark', 'sigma', 'relay', 'screener', 'oracle',
  'heartbeat', 'system',
])

// Curated themed pool. Each name is a sanitized lowercase id with role tags so
// suggestions can be biased toward the requested role. Tags:
//   dev      = engineering / build / code
//   research = research / intel / security
//   data     = data / analysis
//   content  = content / video / writing / social
//   ops      = netops / homelab / infra
const NAME_POOL: ReadonlyArray<{ name: string; tags: string[] }> = [
  { name: 'vesper', tags: ['research'] },
  { name: 'umbra', tags: ['research'] },
  { name: 'cipher', tags: ['research', 'dev'] },
  { name: 'rune', tags: ['research'] },
  { name: 'sable', tags: ['research'] },
  { name: 'oracle-ii', tags: ['research'] },
  { name: 'wraith', tags: ['research', 'ops'] },
  { name: 'anvil', tags: ['dev'] },
  { name: 'forge-ii', tags: ['dev'] },
  { name: 'kindle', tags: ['dev'] },
  { name: 'cinder', tags: ['dev'] },
  { name: 'quill', tags: ['dev', 'content'] },
  { name: 'lathe', tags: ['dev'] },
  { name: 'tinker', tags: ['dev'] },
  { name: 'abacus', tags: ['data'] },
  { name: 'ledger', tags: ['data'] },
  { name: 'prism', tags: ['data'] },
  { name: 'tally', tags: ['data'] },
  { name: 'augur', tags: ['data', 'research'] },
  { name: 'scribe', tags: ['content'] },
  { name: 'lyric', tags: ['content'] },
  { name: 'muse', tags: ['content'] },
  { name: 'verse', tags: ['content'] },
  { name: 'echo', tags: ['content', 'ops'] },
  { name: 'beacon', tags: ['ops'] },
  { name: 'conduit', tags: ['ops'] },
  { name: 'pylon', tags: ['ops'] },
  { name: 'tether', tags: ['ops'] },
  { name: 'circuit', tags: ['ops', 'dev'] },
  { name: 'warden', tags: ['ops', 'research'] },
  { name: 'nova', tags: [] },
  { name: 'orbit', tags: [] },
  { name: 'comet', tags: [] },
  { name: 'pulsar', tags: [] },
  { name: 'quasar', tags: [] },
  { name: 'zenith', tags: [] },
  { name: 'vortex', tags: [] },
  { name: 'helix', tags: [] },
  { name: 'specter', tags: [] },
  { name: 'phantom', tags: [] },
]

function roleKeywords(role?: string): string[] {
  if (!role) return []
  const r = role.toLowerCase()
  const keys: string[] = []
  if (/(research|intel|security|recon|analyst.*threat)/.test(r)) keys.push('research')
  if (/(dev|build|code|engineer|program|software)/.test(r)) keys.push('dev')
  if (/(data|analy|spreadsheet|finance|stat)/.test(r)) keys.push('data')
  if (/(content|video|script|social|writ|market|copy)/.test(r)) keys.push('content')
  if (/(net|ops|homelab|infra|install|deploy|sysadmin)/.test(r)) keys.push('ops')
  return keys
}

function blockedNames(): Set<string> {
  const taken = new Set<string>()
  for (const n of listAllAgentNames()) taken.add(n.toLowerCase())
  for (const r of RESERVED) taken.add(r)
  taken.add(MAIN_AGENT_ID.toLowerCase())
  return taken
}

// Themed, role-hinting name suggestions, EXCLUDING reserved ids, the main
// agent, and any already-existing agent (case-insensitive). Collision-safe:
// the returned names are guaranteed available at call time.
export function suggestAgentNames(role?: string, count = 3): string[] {
  const blocked = blockedNames()
  const roleKeys = roleKeywords(role)
  const available = NAME_POOL.filter(p => !blocked.has(p.name.toLowerCase()))
  // Role-matching names first; stable original order within each group.
  const ordered = available
    .map((p, i) => ({
      p,
      i,
      match: roleKeys.length > 0 && p.tags.some(t => roleKeys.includes(t)) ? 0 : 1,
    }))
    .sort((a, b) => a.match - b.match || a.i - b.i)

  const out: string[] = []
  const seen = new Set<string>()
  for (const { p } of ordered) {
    const lower = p.name.toLowerCase()
    if (seen.has(lower)) continue
    seen.add(lower)
    out.push(p.name)
    if (out.length >= Math.max(1, count)) break
  }
  return out
}

// Is this name a valid, sanitized id that is not reserved and not already taken?
export function isNameAvailable(name: string): boolean {
  const sanitized = sanitizeAgentName(name)
  if (!sanitized) return false
  return !blockedNames().has(sanitized.toLowerCase())
}
