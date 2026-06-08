import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// env-writer targets PROJECT_ROOT/.env -- point PROJECT_ROOT at a temp dir.
let TMP = ''
vi.mock('../config.js', () => ({
  // getter so each test sees the current TMP value
  get PROJECT_ROOT() { return TMP },
}))

import { upsertEnvVars, readEnvVar } from '../web/env-writer.js'

const envPath = () => join(TMP, '.env')

describe('env-writer', () => {
  beforeEach(() => { TMP = mkdtempSync(join(tmpdir(), 'citadel-env-')) })
  afterEach(() => { rmSync(TMP, { recursive: true, force: true }) })

  it('creates .env and appends a new key', () => {
    upsertEnvVars({ GITHUB_TOKEN: 'ghp_abc123' })
    expect(readFileSync(envPath(), 'utf-8')).toContain('GITHUB_TOKEN=ghp_abc123')
    expect(readEnvVar('GITHUB_TOKEN')).toBe('ghp_abc123')
  })

  it('updates an existing key IN PLACE, preserving other lines + comments', () => {
    writeFileSync(envPath(), '# comment\nFOO=1\nGITHUB_TOKEN=old\nBAR=2\n')
    upsertEnvVars({ GITHUB_TOKEN: 'new' })
    const out = readFileSync(envPath(), 'utf-8')
    expect(out).toContain('# comment')
    expect(out).toContain('FOO=1')
    expect(out).toContain('BAR=2')
    expect(out).toContain('GITHUB_TOKEN=new')
    expect(out).not.toContain('GITHUB_TOKEN=old')
    // exactly one GITHUB_TOKEN line
    expect(out.match(/^GITHUB_TOKEN=/gm)?.length).toBe(1)
  })

  it('removes a key when value is empty string', () => {
    writeFileSync(envPath(), 'FOO=1\nGITHUB_TOKEN=secret\n')
    upsertEnvVars({ GITHUB_TOKEN: '' })
    const out = readFileSync(envPath(), 'utf-8')
    expect(out).toContain('FOO=1')
    expect(out).not.toMatch(/GITHUB_TOKEN/)
    expect(readEnvVar('GITHUB_TOKEN')).toBe('')
  })

  it('quotes values with whitespace/# and round-trips them', () => {
    upsertEnvVars({ NOTE: 'hello world # not-a-comment' })
    expect(readEnvVar('NOTE')).toBe('hello world # not-a-comment')
  })

  it('handles multiple keys at once', () => {
    upsertEnvVars({ UPDATE_GITHUB_REPO: 'romcsibacsi/citadel', GITHUB_TOKEN: 'ghp_x' })
    expect(readEnvVar('UPDATE_GITHUB_REPO')).toBe('romcsibacsi/citadel')
    expect(readEnvVar('GITHUB_TOKEN')).toBe('ghp_x')
  })

  it('writes the .env with 0600 permissions', () => {
    upsertEnvVars({ GITHUB_TOKEN: 'ghp_x' })
    expect(existsSync(envPath())).toBe(true)
    expect(statSync(envPath()).mode & 0o777).toBe(0o600)
  })

  it('does not corrupt a key whose name is a prefix of another', () => {
    writeFileSync(envPath(), 'GITHUB_TOKEN=keep\nGITHUB_TOKEN_EXTRA=also\n')
    upsertEnvVars({ GITHUB_TOKEN: 'changed' })
    const out = readFileSync(envPath(), 'utf-8')
    expect(out).toContain('GITHUB_TOKEN=changed')
    expect(out).toContain('GITHUB_TOKEN_EXTRA=also')
  })
})
