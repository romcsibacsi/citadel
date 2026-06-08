import { describe, it, expect } from 'vitest'
import { planSpawn } from '../web/spawn-requests.js'

// Route-level decision mapping: planSpawn() composes the pure privilege gate
// (evaluateSpawn) with the dashboard-vs-programmatic provenance rule and maps
// the result to the create / pending / forbidden outcome the endpoint acts on.
const MAIN = 'nexus'

describe('spawn-gate wiring: planSpawn outcome mapping', () => {
  it('dashboard (no requestedBy) up to the ceiling => create', () => {
    const plan = planSpawn({ requestedProfile: 'developer-senior', mainAgentId: MAIN })
    expect(plan.viaDashboard).toBe(true)
    expect(plan.outcome).toBe('create')
  })

  it('dashboard above the hard ceiling => forbidden (even the operator)', () => {
    const plan = planSpawn({ requestedProfile: 'homelab-full', mainAgentId: MAIN })
    expect(plan.outcome).toBe('forbidden')
  })

  it('programmatic NEXUS sandbox spawn => create (auto, no approval)', () => {
    const plan = planSpawn({ requestedBy: MAIN, requestedProfile: 'developer-junior', mainAgentId: MAIN })
    expect(plan.viaDashboard).toBe(false)
    expect(plan.outcome).toBe('create')
  })

  it('programmatic NEXUS above the sandbox cap => pending (requires approval, not created)', () => {
    const plan = planSpawn({ requestedBy: MAIN, requestedProfile: 'developer-senior', mainAgentId: MAIN })
    expect(plan.outcome).toBe('pending')
    expect(plan.decision.allowed).toBe(false)
    expect(plan.decision.requiresApproval).toBe(true)
  })

  it('programmatic NEXUS above the hard ceiling => forbidden (not even approvable)', () => {
    const plan = planSpawn({ requestedBy: MAIN, requestedProfile: 'homelab-full', mainAgentId: MAIN })
    expect(plan.outcome).toBe('forbidden')
    expect(plan.decision.requiresApproval).toBe(false)
  })

  it('a sub-agent requester is forbidden (only the orchestrator may spawn)', () => {
    const plan = planSpawn({ requestedBy: 'spark', requestedProfile: 'developer-junior', mainAgentId: MAIN })
    expect(plan.outcome).toBe('forbidden')
    expect(plan.decision.reason).toMatch(/only the orchestrator/i)
  })

  it('no self-escalation: a sandbox-pinned requester cannot make a higher-priv child', () => {
    const plan = planSpawn({
      requestedBy: MAIN,
      requestedProfile: 'researcher',
      mainAgentId: MAIN,
      requesterProfile: 'developer-junior',
    })
    expect(plan.outcome).toBe('forbidden')
  })

  it('empty requestedBy is treated as the dashboard operator', () => {
    const plan = planSpawn({ requestedBy: '', requestedProfile: 'developer-senior', mainAgentId: MAIN })
    expect(plan.viaDashboard).toBe(true)
    expect(plan.outcome).toBe('create')
  })
})
