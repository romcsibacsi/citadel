import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// Resolve the repo root relative to this test file so the test is independent
// of CWD. src/__tests__/ -> repo root is two levels up.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SEED_DIR = join(REPO_ROOT, 'seed-agents')
const PROFILES_DIR = join(REPO_ROOT, 'templates', 'profiles')

// The fixed CITADEL sub-agent roster. NEXUS is the MAIN agent (repo root), so
// it is intentionally NOT a seed-agents/ entry. Each row is the contract the
// seed must satisfy on disk.
const EXPECTED = {
  forge: { profile: 'developer-senior', accent: '#f59e0b' },
  spark: { profile: 'developer-junior', accent: '#facc15' },
  sigma: { profile: 'data-analyst', accent: '#8b5cf6' },
  relay: { profile: 'homelab-full', accent: '#3b82f6' },
  screener: { profile: 'media', accent: '#22c55e' },
  oracle: { profile: 'researcher', accent: '#d4af37' },
  creative: { profile: 'media', accent: '#ec4899' },
  muse: { profile: 'media', accent: '#a855f7' },
  reel: { profile: 'media', accent: '#14b8a6' },
  argus: { profile: 'media', accent: '#f59e0b' },
  prism: { profile: 'researcher', accent: '#6366f1' },
  probe: { profile: 'developer-junior', accent: '#ef4444' },
  harbor: { profile: 'developer-senior', accent: '#0ea5e9' },
} as const

const MAIN_AGENT_ID = 'nexus'

function readConfig(name: string): Record<string, any> {
  return JSON.parse(readFileSync(join(SEED_DIR, name, 'agent-config.json'), 'utf-8'))
}

describe('seed-agents roster', () => {
  it('contains exactly the 13 expected sub-agent dirs (NEXUS excluded)', () => {
    const dirs = readdirSync(SEED_DIR).filter((f) => statSync(join(SEED_DIR, f)).isDirectory())
    expect(dirs.sort()).toEqual(Object.keys(EXPECTED).sort())
    expect(dirs).not.toContain(MAIN_AGENT_ID)
  })

  for (const name of Object.keys(EXPECTED)) {
    describe(name, () => {
      it('has SOUL.md + CLAUDE.md + agent-config.json', () => {
        expect(existsSync(join(SEED_DIR, name, 'SOUL.md'))).toBe(true)
        expect(existsSync(join(SEED_DIR, name, 'CLAUDE.md'))).toBe(true)
        expect(existsSync(join(SEED_DIR, name, 'agent-config.json'))).toBe(true)
      })

      it('agent-config.json has correct team, profile and accent', () => {
        const cfg = readConfig(name)
        const expected = EXPECTED[name as keyof typeof EXPECTED]
        expect(cfg.team.reportsTo).toBe(MAIN_AGENT_ID)
        expect(cfg.team.role).toBe('member')
        expect(cfg.securityProfile).toBe(expected.profile)
        expect(cfg.accent).toBe(expected.accent)
      })
    })
  }

  it('NEXUS-hub invariant: every sub-agent reportsTo the main agent id', () => {
    for (const name of Object.keys(EXPECTED)) {
      expect(readConfig(name).team.reportsTo).toBe(MAIN_AGENT_ID)
    }
  })
})

describe('new security profiles', () => {
  it('data-analyst.json parses, is strict, and denies .ssh', () => {
    const p = JSON.parse(readFileSync(join(PROFILES_DIR, 'data-analyst.json'), 'utf-8'))
    expect(p.permissionMode).toBeTypeOf('string')
    expect(Array.isArray(p.filesystem.deny)).toBe(true)
    expect(p.filesystem.deny.some((d: string) => d.includes('.ssh'))).toBe(true)
  })

  it('homelab-full.json parses, has a deny array, and does NOT deny sudo', () => {
    const p = JSON.parse(readFileSync(join(PROFILES_DIR, 'homelab-full.json'), 'utf-8'))
    expect(p.permissionMode).toBeTypeOf('string')
    expect(Array.isArray(p.filesystem.deny)).toBe(true)
    expect(p.filesystem.deny.some((d: string) => /sudo/.test(d))).toBe(false)
  })

  // Regression for the permission-prompt wedge (kártya #40c0cf1d): agents run with
  // cwd = their own dir and write RELATIVE paths (e.g. "memory/x"), which do NOT
  // match an absolute Write(${AGENT_DIR}/**) rule -> a prompt wedges the agent. Every
  // profile that scopes Read/Write/Edit to ${AGENT_DIR} must ALSO allow the relative
  // form (Write(**) etc.), which gitignore-anchors to the agent's dir (cannot escape
  // to a parent, so per-agent filesystem isolation is preserved).
  it('every ${AGENT_DIR}-scoped profile also allows the relative form (no relative-path wedge)', () => {
    for (const f of readdirSync(PROFILES_DIR).filter((x) => x.endsWith('.json'))) {
      const p = JSON.parse(readFileSync(join(PROFILES_DIR, f), 'utf-8'))
      const allow: string[] = p.filesystem?.allow ?? []
      for (const verb of ['Read', 'Write', 'Edit']) {
        if (allow.some((a) => a.startsWith(`${verb}(\${AGENT_DIR}`))) {
          expect(allow).toContain(`${verb}(**)`)
        }
      }
    }
  })
})
