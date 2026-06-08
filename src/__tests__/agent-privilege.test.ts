import { describe, it, expect } from 'vitest'
import {
  evaluateSpawn,
  profilePrivilege,
  AUTO_APPROVE_MAX_PRIV,
  HARD_CEILING_PRIV,
} from '../web/agent-privilege.js'

const ctx = { mainAgentId: 'nexus' }

describe('agent-privilege: evaluateSpawn (hard invariant)', () => {
  it('orchestrator may auto-spawn a sandbox agent', () => {
    const d = evaluateSpawn({ requester: 'nexus', requestedProfile: 'developer-junior', viaDashboard: false }, ctx)
    expect(d).toEqual({ allowed: true, requiresApproval: false, reason: expect.any(String) })
  })

  it('orchestrator spawning above sandbox requires human approval (not auto)', () => {
    const d = evaluateSpawn({ requester: 'nexus', requestedProfile: 'developer-senior', viaDashboard: false }, ctx)
    expect(d.allowed).toBe(false)
    expect(d.requiresApproval).toBe(true)
  })

  it('NEVER spawns above the hard ceiling, even programmatically by the orchestrator', () => {
    const d = evaluateSpawn({ requester: 'nexus', requestedProfile: 'homelab-full', viaDashboard: false }, ctx)
    expect(d.allowed).toBe(false)
    expect(d.requiresApproval).toBe(false) // not even approvable
  })

  it('NEVER spawns above the hard ceiling, even via the dashboard/operator', () => {
    const d = evaluateSpawn({ requester: 'nexus', requestedProfile: 'homelab-full', viaDashboard: true }, ctx)
    expect(d.allowed).toBe(false)
    expect(d.requiresApproval).toBe(false)
  })

  // --- adversarial: privilege escalation attempts ---
  it('a sub-agent cannot spawn anything (only the orchestrator may)', () => {
    for (const profile of ['developer-junior', 'researcher', 'developer-senior']) {
      const d = evaluateSpawn({ requester: 'spark', requestedProfile: profile, viaDashboard: false }, ctx)
      expect(d.allowed).toBe(false)
      expect(d.requiresApproval).toBe(false)
      expect(d.reason).toMatch(/only the orchestrator/i)
    }
  })

  it('a forged requester claiming to be main but not equal to mainAgentId is denied', () => {
    // (Upstream sanitize+trust prevents forging; the gate is also defensive.)
    const d = evaluateSpawn({ requester: 'nexus-evil', requestedProfile: 'developer-junior', viaDashboard: false }, ctx)
    expect(d.allowed).toBe(false)
  })

  it('no self-escalation: a requester cannot create a child more privileged than itself', () => {
    // Even if (hypothetically) a non-main were allowed, a lower-priv requester
    // cannot exceed its own privilege. Here the orchestrator is pinned to a
    // sandbox profile and tries to make a senior child.
    const d = evaluateSpawn(
      { requester: 'nexus', requestedProfile: 'developer-senior', viaDashboard: false },
      { mainAgentId: 'nexus', requesterProfile: 'developer-junior' },
    )
    expect(d.allowed).toBe(false)
    expect(d.reason).toMatch(/more privileged than itself|exceeds/i)
  })

  it('unknown profile is denied', () => {
    const d = evaluateSpawn({ requester: 'nexus', requestedProfile: 'root-god', viaDashboard: false }, ctx)
    expect(d.allowed).toBe(false)
    expect(d.reason).toMatch(/unknown/i)
  })

  it('operator (dashboard) may create up to the hard ceiling without a second approval step', () => {
    for (const profile of ['developer-junior', 'data-analyst', 'developer-senior']) {
      const d = evaluateSpawn({ requester: 'operator', requestedProfile: profile, viaDashboard: true }, ctx)
      expect(d.allowed).toBe(true)
      expect(d.requiresApproval).toBe(false)
    }
  })
})

describe('agent-privilege: ranking sanity', () => {
  it('sandbox < draft < trusted < full', () => {
    expect(profilePrivilege('developer-junior')!).toBeLessThan(profilePrivilege('researcher')!)
    expect(profilePrivilege('researcher')!).toBeLessThan(profilePrivilege('developer-senior')!)
    expect(profilePrivilege('developer-senior')!).toBeLessThan(profilePrivilege('homelab-full')!)
  })
  it('the cap is sandbox-level and the ceiling is below full host control', () => {
    expect(AUTO_APPROVE_MAX_PRIV).toBe(profilePrivilege('developer-junior'))
    expect(HARD_CEILING_PRIV).toBe(profilePrivilege('developer-senior'))
    expect(profilePrivilege('homelab-full')!).toBeGreaterThan(HARD_CEILING_PRIV)
  })
})
