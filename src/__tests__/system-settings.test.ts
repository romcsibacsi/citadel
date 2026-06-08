import { describe, it, expect, vi, beforeEach } from 'vitest'

const vault: Record<string, string> = {}
const envFile: Record<string, string> = {}

vi.mock('../web/vault.js', () => ({
  getSecret: (id: string) => (id in vault ? vault[id] : null),
  setSecret: (id: string, _label: string, value: string) => { vault[id] = value },
  deleteSecret: (id: string) => { const had = id in vault; delete vault[id]; return had },
}))

vi.mock('../web/env-writer.js', () => ({
  upsertEnvVars: (updates: Record<string, string>) => {
    for (const [k, v] of Object.entries(updates)) {
      if (v === '') delete envFile[k]; else envFile[k] = v
    }
  },
  readEnvVar: (key: string) => envFile[key] ?? '',
}))

import { getSystemSetting, setSystemSetting, listSystemSettings } from '../web/system-settings.js'

describe('system-settings', () => {
  beforeEach(() => {
    for (const k of Object.keys(vault)) delete vault[k]
    for (const k of Object.keys(envFile)) delete envFile[k]
  })

  it('stores a SECRET in the vault AND mirrors it to .env', () => {
    setSystemSetting('github_token', 'ghp_secret')
    expect(vault['GITHUB_TOKEN']).toBe('ghp_secret')   // encrypted vault (canonical)
    expect(envFile['GITHUB_TOKEN']).toBe('ghp_secret') // .env mirror
    expect(getSystemSetting('github_token')).toBe('ghp_secret')
  })

  it('stores a PLAIN setting only in .env (not the vault)', () => {
    setSystemSetting('github_repo', 'romcsibacsi/citadel')
    expect(vault['UPDATE_GITHUB_REPO']).toBeUndefined()
    expect(envFile['UPDATE_GITHUB_REPO']).toBe('romcsibacsi/citadel')
    expect(getSystemSetting('github_repo')).toBe('romcsibacsi/citadel')
  })

  it('clears a secret from BOTH vault and .env on empty value', () => {
    setSystemSetting('github_token', 'ghp_x')
    setSystemSetting('github_token', '')
    expect(vault['GITHUB_TOKEN']).toBeUndefined()
    expect(envFile['GITHUB_TOKEN']).toBeUndefined()
    expect(getSystemSetting('github_token')).toBe('')
  })

  it('listSystemSettings never leaks secret values, only a masked preview', () => {
    setSystemSetting('github_token', 'ghp_supersecret9999')
    setSystemSetting('github_repo', 'romcsibacsi/citadel')
    const list = listSystemSettings()
    const tok = list.find(s => s.key === 'github_token')!
    const repo = list.find(s => s.key === 'github_repo')!
    expect(tok.isSet).toBe(true)
    expect(tok.preview).toBe('••••9999')      // last 4 only
    expect(tok.preview).not.toContain('supersecret')
    expect(repo.preview).toBe('romcsibacsi/citadel') // plain shown as-is
  })

  it('throws on an unknown setting key', () => {
    expect(() => setSystemSetting('nope', 'x')).toThrow(/Unknown system setting/)
  })
})
