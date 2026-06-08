import { execFileSync } from 'node:child_process'
import { PROJECT_ROOT, UPDATE_GITHUB_REPO, GITHUB_TOKEN } from '../config.js'
import { getSystemSetting } from './system-settings.js'

// GitHub API headers, with optional PAT so a PRIVATE mirror is readable
// (unauthenticated calls 404 on private repos). Read at RUNTIME from the vault
// (web-managed), falling back to the process-start env, so saving a token in
// the dashboard takes effect without a restart.
function githubHeaders(): Record<string, string> {
  const h: Record<string, string> = { 'Accept': 'application/vnd.github+json', 'User-Agent': 'nexus-update-check' }
  const token = getSystemSetting('github_token') || GITHUB_TOKEN.trim()
  if (token) h['Authorization'] = `Bearer ${token}`
  return h
}

export interface UpdateCommit {
  sha: string
  short: string
  message: string
  author: string
  date: string
}

export interface UpdateStatus {
  current: string
  latest: string
  behind: number
  commits: UpdateCommit[]
  remote: string
  branch: string
  lastChecked: number
  error?: string
}

let updateStatusCache: UpdateStatus = {
  current: '',
  latest: '',
  behind: 0,
  commits: [],
  remote: '',
  branch: '',
  lastChecked: 0,
}

export function getUpdateStatus(): UpdateStatus {
  return updateStatusCache
}

export function currentGitHead(): string {
  try {
    return execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: PROJECT_ROOT, timeout: 3000, encoding: 'utf-8' }).trim()
  } catch {
    return ''
  }
}

// The local branch to compare against the remote. The checker tracks the SAME
// branch on the remote (this fork lives on citadel-build, not main), so polling
// a hardcoded `main` would always look "behind" or 404. Detached HEAD => ''.
export function currentGitBranch(): string {
  try {
    const b = execFileSync('/usr/bin/git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: PROJECT_ROOT, timeout: 3000, encoding: 'utf-8' }).trim()
    return b === 'HEAD' ? '' : b
  } catch {
    return ''
  }
}

// Resolve the GitHub repo (owner/name) to poll. Priority:
//   1. UPDATE_GITHUB_REPO env (explicit, wins).
//   2. A github.com remote in `git remote -v` -- a remote literally named
//      `github` is preferred, otherwise the first github.com remote found.
//   3. '' -- no GitHub repo configured => update-checking disabled. (There is
//      deliberately NO upstream-project fallback: this hardened fork tracks
//      only the operator's own mirror.)
export function resolveGitHubRepo(): string {
  // Web-managed value first (runtime, no restart), then process-start env,
  // then auto-detect from a github.com remote.
  const fromSetting = getSystemSetting('github_repo')
  if (fromSetting) return fromSetting
  const fromEnv = UPDATE_GITHUB_REPO.trim()
  if (fromEnv) return fromEnv
  try {
    const out = execFileSync('/usr/bin/git', ['remote', '-v'], { cwd: PROJECT_ROOT, timeout: 3000, encoding: 'utf-8' })
    // lines: "<name>\t<url> (fetch|push)"
    const rows = out.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
      const [name, rest] = l.split(/\s+/, 2)
      return { name, url: rest || '' }
    })
    const toRepo = (url: string): string => {
      const m = url.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?(?:\s|$)/i)
      return m ? m[1] : ''
    }
    // Prefer a remote named `github`.
    const named = rows.find(r => r.name === 'github' && toRepo(r.url))
    if (named) return toRepo(named.url)
    const anyGithub = rows.map(r => toRepo(r.url)).find(Boolean)
    if (anyGithub) return anyGithub
  } catch { /* fall through */ }
  return ''
}

export async function refreshUpdateStatus(): Promise<UpdateStatus> {
  const current = currentGitHead()
  const branch = currentGitBranch()
  const remote = resolveGitHubRepo()
  const status: UpdateStatus = {
    current,
    latest: '',
    behind: 0,
    commits: [],
    remote,
    branch,
    lastChecked: Date.now(),
  }
  if (!current) {
    status.error = 'Not a git checkout'
    updateStatusCache = status
    return status
  }
  if (!remote) {
    status.error = 'Nincs GitHub repo beállítva — állítsd be az UPDATE_GITHUB_REPO env-et (pl. romeo/citadel) vagy adj hozzá egy github.com remote-ot.'
    updateStatusCache = status
    return status
  }
  if (!branch) {
    status.error = 'Detached HEAD — nincs ág a frissítés-összehasonlításhoz.'
    updateStatusCache = status
    return status
  }
  try {
    // 1) HEAD of the tracked branch on the remote (same branch as local).
    const latestRes = await fetch(`https://api.github.com/repos/${remote}/commits/${encodeURIComponent(branch)}`, {
      headers: githubHeaders(),
    })
    if (latestRes.status === 404) throw new Error(`A(z) ${remote} repón nincs '${branch}' ág (vagy a repó privát és nincs hozzáférés).`)
    if (!latestRes.ok) throw new Error(`GitHub /commits/${branch} -> ${latestRes.status}`)
    const latestJson = await latestRes.json() as { sha?: string }
    if (!latestJson.sha) throw new Error('No sha on commits response')
    status.latest = latestJson.sha

    if (status.latest === current) {
      updateStatusCache = status
      return status
    }

    // 2) list commits between current and latest via the compare endpoint
    const cmpRes = await fetch(`https://api.github.com/repos/${remote}/compare/${current}...${status.latest}`, {
      headers: githubHeaders(),
    })
    if (cmpRes.ok) {
      const cmp = await cmpRes.json() as {
        ahead_by?: number
        commits?: { sha: string; commit: { message: string; author: { name: string; date: string } } }[]
      }
      status.behind = cmp.ahead_by ?? 0
      // GitHub returns commits oldest-first; flip to newest-first for the UI.
      const raw = (cmp.commits ?? []).slice().reverse()
      status.commits = raw.map(c => ({
        sha: c.sha,
        short: c.sha.slice(0, 7),
        message: (c.commit.message || '').split('\n')[0],
        author: c.commit.author?.name || '',
        date: c.commit.author?.date || '',
      }))
    } else if (cmpRes.status === 404) {
      // Local HEAD not on the remote (unpushed local commits / different base).
      status.error = 'A lokális HEAD nincs a GitHub repón — nincs pusholva, vagy eltérő bázis?'
    }
  } catch (err) {
    status.error = err instanceof Error ? err.message : String(err)
  }
  updateStatusCache = status
  return status
}

// Polls the operator's own GitHub repo's tracked branch for new commits and
// compares to the local HEAD. Lets the dashboard show a "new version available"
// badge without anyone having to SSH in and run update.sh. No-op (graceful
// error in the status) until a repo is configured.
export function startUpdateChecker(): NodeJS.Timeout {
  // First check shortly after startup; then every 15 minutes.
  setTimeout(() => { refreshUpdateStatus().catch(() => {}) }, 10_000)
  return setInterval(() => { refreshUpdateStatus().catch(() => {}) }, 15 * 60_000)
}
