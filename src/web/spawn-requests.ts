import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { PROJECT_ROOT } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { evaluateSpawn, type SpawnDecision } from './agent-privilege.js'

// Persisted pending spawn-requests: a programmatic spawn that the privilege
// gate said requires a human operator's approval is parked here (not created)
// until the operator approves or denies it from the dashboard.
const STORE_PATH = join(PROJECT_ROOT, 'store', 'spawn-requests.json')

export interface SpawnRequestRecord {
  id: string
  requestedBy: string
  name: string
  profile: string
  displayName?: string
  description: string
  model: string
  internal: boolean
  createdAt: number
}

interface SpawnRequestStore {
  requests: SpawnRequestRecord[]
}

function readStore(): SpawnRequestStore {
  try {
    const parsed = JSON.parse(readFileSync(STORE_PATH, 'utf-8'))
    if (parsed && Array.isArray(parsed.requests)) return parsed as SpawnRequestStore
  } catch { /* no file yet / unreadable -- start empty */ }
  return { requests: [] }
}

function writeStore(store: SpawnRequestStore): void {
  mkdirSync(join(PROJECT_ROOT, 'store'), { recursive: true })
  atomicWriteFileSync(STORE_PATH, JSON.stringify(store, null, 2) + '\n')
}

export function listSpawnRequests(): SpawnRequestRecord[] {
  return readStore().requests
}

export function getSpawnRequest(id: string): SpawnRequestRecord | undefined {
  return readStore().requests.find(r => r.id === id)
}

export function addSpawnRequest(
  rec: Omit<SpawnRequestRecord, 'id' | 'createdAt'>,
): SpawnRequestRecord {
  const store = readStore()
  const full: SpawnRequestRecord = {
    ...rec,
    id: `spawn-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`,
    createdAt: Date.now(),
  }
  store.requests.push(full)
  writeStore(store)
  return full
}

export function removeSpawnRequest(id: string): boolean {
  const store = readStore()
  const before = store.requests.length
  store.requests = store.requests.filter(r => r.id !== id)
  if (store.requests.length === before) return false
  writeStore(store)
  return true
}

// --- pure decision/branch mapping (testable without I/O) ---

export type SpawnOutcome = 'create' | 'pending' | 'forbidden'

export interface SpawnPlanInput {
  // undefined/empty => the dashboard operator is acting directly.
  requestedBy?: string
  requestedProfile: string
  mainAgentId: string
  // Only resolved for a non-main programmatic requester. Leave undefined for
  // the main agent so the gate treats it as the hard ceiling.
  requesterProfile?: string
}

export interface SpawnPlan {
  viaDashboard: boolean
  requester: string
  decision: SpawnDecision
  outcome: SpawnOutcome
}

// Decide what the create endpoint should do with a spawn request, mapping the
// pure privilege gate's decision to a route-level outcome:
//   create    -> proceed with the scaffold flow now
//   pending   -> park a pending record + alert the operator (HTTP 202)
//   forbidden -> reject outright (HTTP 403)
export function planSpawn(input: SpawnPlanInput): SpawnPlan {
  const viaDashboard = !input.requestedBy
  const requester = viaDashboard ? 'operator' : input.requestedBy!
  const decision = evaluateSpawn(
    { requester, requestedProfile: input.requestedProfile, viaDashboard },
    { mainAgentId: input.mainAgentId, requesterProfile: input.requesterProfile },
  )
  const outcome: SpawnOutcome = decision.allowed
    ? 'create'
    : decision.requiresApproval
      ? 'pending'
      : 'forbidden'
  return { viaDashboard, requester, decision, outcome }
}
