import { describe, it, expect, vi, beforeEach } from 'vitest'

// execFileSync is the only side-effecting dependency for the pure git helpers;
// fetch is only reached once a repo resolves, which these tests avoid.
const mockExecFileSync = vi.fn()
vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}))

// UPDATE_GITHUB_REPO empty => exercise auto-detect + disabled paths (the
// realistic default until the operator sets the env or adds a github remote).
vi.mock('../config.js', () => ({
  PROJECT_ROOT: '/tmp/test-citadel',
  UPDATE_GITHUB_REPO: '',
  GITHUB_TOKEN: '',
}))

// The web-managed settings layer is exercised in its own test; here it returns
// nothing so resolveGitHubRepo falls through to env / git-remote auto-detect.
vi.mock('../web/system-settings.js', () => ({
  getSystemSetting: () => '',
}))

import { resolveGitHubRepo, currentGitBranch, refreshUpdateStatus } from '../web/update-checker.js'

// Route a git invocation by its subcommand to a canned stdout.
function gitRouter(map: { head?: string; branch?: string; remotes?: string }) {
  return (_bin: string, args: string[]) => {
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return map.head ?? 'abc123\n'
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return map.branch ?? 'citadel-build\n'
    if (args[0] === 'remote' && args[1] === '-v') return map.remotes ?? ''
    return ''
  }
}

describe('resolveGitHubRepo (env empty -> auto-detect)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns "" when only a non-GitHub (Gitea) remote exists', () => {
    mockExecFileSync.mockImplementation(gitRouter({
      remotes: 'origin\thttps://git.uplinkfather.com/romeo/citadel.git (fetch)\norigin\thttps://git.uplinkfather.com/romeo/citadel.git (push)',
    }))
    expect(resolveGitHubRepo()).toBe('')
  })

  it('detects a github.com remote and returns owner/name', () => {
    mockExecFileSync.mockImplementation(gitRouter({
      remotes: 'origin\thttps://git.uplinkfather.com/romeo/citadel.git (fetch)\ngithub\thttps://github.com/romeo/citadel.git (fetch)\ngithub\thttps://github.com/romeo/citadel.git (push)',
    }))
    expect(resolveGitHubRepo()).toBe('romeo/citadel')
  })

  it('prefers a remote literally named "github" over another github.com remote', () => {
    mockExecFileSync.mockImplementation(gitRouter({
      remotes: 'fork\thttps://github.com/someoneelse/citadel.git (fetch)\ngithub\tgit@github.com:romeo/citadel.git (fetch)',
    }))
    expect(resolveGitHubRepo()).toBe('romeo/citadel')
  })

  it('handles the scp-style git@github.com:owner/repo.git form', () => {
    mockExecFileSync.mockImplementation(gitRouter({
      remotes: 'github\tgit@github.com:romeo/citadel.git (fetch)',
    }))
    expect(resolveGitHubRepo()).toBe('romeo/citadel')
  })
})

describe('currentGitBranch', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns the branch name', () => {
    mockExecFileSync.mockImplementation(gitRouter({ branch: 'citadel-build\n' }))
    expect(currentGitBranch()).toBe('citadel-build')
  })

  it('returns "" on detached HEAD', () => {
    mockExecFileSync.mockImplementation(gitRouter({ branch: 'HEAD\n' }))
    expect(currentGitBranch()).toBe('')
  })
})

describe('refreshUpdateStatus (no upstream-CITADEL fallback)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('reports a graceful error (no fetch) when no GitHub repo resolves', async () => {
    mockExecFileSync.mockImplementation(gitRouter({
      head: 'abc123\n',
      branch: 'citadel-build\n',
      remotes: 'origin\thttps://git.uplinkfather.com/romeo/citadel.git (fetch)', // Gitea only
    }))
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const status = await refreshUpdateStatus()

    expect(status.remote).toBe('')          // never falls back to romcsibacsi/citadel
    expect(status.branch).toBe('citadel-build')
    expect(status.error).toMatch(/Nincs GitHub repo|UPDATE_GITHUB_REPO/)
    expect(fetchSpy).not.toHaveBeenCalled() // bails out before any network call
    vi.unstubAllGlobals()
  })
})
