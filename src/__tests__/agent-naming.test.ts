import { describe, it, expect, vi } from 'vitest'

// Control which agents "already exist" so the suggestions/availability checks
// are deterministic regardless of the host's agents/ directory.
vi.mock('../web/agent-config.js', () => ({
  listAllAgentNames: () => ['vesper', 'somethingelse'],
}))

import { suggestAgentNames, isNameAvailable } from '../web/agent-naming.js'

const RESERVED = ['nexus', 'forge', 'spark', 'sigma', 'relay', 'screener', 'oracle', 'heartbeat', 'system']

describe('agent-naming: suggestAgentNames', () => {
  it('returns exactly `count` non-empty names', () => {
    const out = suggestAgentNames(undefined, 3)
    expect(out).toHaveLength(3)
    for (const n of out) expect(n.length).toBeGreaterThan(0)
  })

  it('excludes reserved ids and already-existing agents', () => {
    const out = suggestAgentNames('research', 5)
    const lower = out.map(n => n.toLowerCase())
    for (const r of RESERVED) expect(lower).not.toContain(r)
    expect(lower).not.toContain('vesper') // taken (mocked existing)
    expect(new Set(lower).size).toBe(lower.length) // no case-insensitive dupes
  })

  it('biases toward the requested role', () => {
    // The research-tagged pool names should appear when role hints research.
    const out = suggestAgentNames('security researcher / intel', 3)
    expect(out.length).toBe(3)
    // At least one of the first results is a known research-themed name.
    const researchThemed = ['umbra', 'cipher', 'rune', 'sable', 'wraith', 'oracle-ii', 'augur', 'warden']
    expect(out.some(n => researchThemed.includes(n))).toBe(true)
  })
})

describe('agent-naming: isNameAvailable', () => {
  it('rejects reserved ids', () => {
    for (const r of RESERVED) expect(isNameAvailable(r)).toBe(false)
  })
  it('rejects already-taken names (case-insensitive)', () => {
    expect(isNameAvailable('vesper')).toBe(false)
    expect(isNameAvailable('VESPER')).toBe(false)
  })
  it('rejects empty / unsanitizable input', () => {
    expect(isNameAvailable('')).toBe(false)
    expect(isNameAvailable('---')).toBe(false)
  })
  it('accepts a fresh, sanitizable name', () => {
    expect(isNameAvailable('brandnewworker')).toBe(true)
  })
})
