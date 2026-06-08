import { existsSync, readFileSync, mkdirSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync, copyFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join, extname } from 'node:path'
import { homedir, platform } from 'node:os'
import { execSync } from 'node:child_process'
import { logger } from '../../logger.js'
import { MAIN_AGENT_ID, BOT_NAME } from '../../config.js'
import { createAgentMessage } from '../../db.js'
import { atomicWriteFileSync } from '../atomic-write.js'
import { getSecret, setSecret, deleteSecret, listSecrets } from '../vault.js'
import {
  agentDir,
  agentConfigRoot,
  DEFAULT_MODEL,
  readFileOr,
  extractDescriptionFromClaudeMd,
  findAvatarForAgent,
  resolveModelId,
  readAgentModel,
  writeAgentModel,
  readAgentDisplayName,
  writeAgentDisplayName,
  readAgentSecurityProfile,
  writeAgentSecurityProfile,
  readAgentAccent,
  listAgentNames,
  isKnownAgent,
  readAgentChannelProvider,
  writeAgentChannelProvider,
  readAgentAuthMode,
  writeAgentAuthMode,
  readAgentClaudeConfigDir,
  writeAgentInternal,
  type AuthMode,
} from '../agent-config.js'
import {
  planSpawn,
  addSpawnRequest,
  listSpawnRequests,
  getSpawnRequest,
  removeSpawnRequest,
} from '../spawn-requests.js'
import { suggestAgentNames } from '../agent-naming.js'
import { reapAgent } from '../reaper.js'
import { notifyAlert } from '../../notify.js'
import {
  readAgentTeam,
  writeAgentTeam,
  sanitizeTeamConfig,
  cleanupTeamReferences,
  type TeamConfig,
} from '../agent-team.js'
import {
  readAgentTelegramConfig,
  readAgentDiscordConfig,
  sendAvatarChangeMessage,
  sendWelcomeMessage,
  validateTelegramToken,
  parseTelegramToken,
} from '../telegram.js'
import { hardRestartNexusChannels } from '../channel-monitor.js'
import { isMainChannelsAgent, MAIN_CHANNELS_SESSION } from '../main-agent.js'
import {
  getProvider,
  channelStateDir,
  readChannelToken,
  type ChannelProviderType,
} from '../../channel-provider.js'
import {
  writeAgentSettingsFromProfile,
  scaffoldAgentDir,
  generateClaudeMd,
  generateSoulMd,
} from '../agent-scaffold.js'
import {
  isAgentRunning,
  startAgentProcess,
  stopAgentProcess,
  restartAgentProcess,
  getAgentRunningSince,
  getAgentProcessInfo,
  agentSessionName,
  sendPromptToSession,
  capturePane,
} from '../agent-process.js'
import { addDesiredAgent, removeDesiredAgent } from '../agent-desired-state.js'
import { readActiveModelFromProjectDir, readContextTokensFromProjectDir } from '../active-model.js'
import { detectPaneState } from '../../pane-state.js'
import { detectReauthNeeded } from '../reauth-detect.js'
import { readAutoRestartConfig, writeAutoRestartConfig } from '../auto-restart-store.js'
import type { AutoRestartConfig } from '../../auto-restart.js'
import { attemptChannelMcpReconnect } from '../channel-mcp-reconnect.js'
import { getChannelHealth } from '../channel-health-monitor.js'
import {
  loadProfileTemplate,
  resolveProfilePlaceholders,
} from '../profiles.js'
import { sanitizeAgentName } from '../sanitize.js'
import { parseMultipart } from '../multipart.js'
import { readBody, json, serveFile } from '../http-helpers.js'
import type { RouteContext } from './types.js'

const VALID_PROVIDERS = new Set<ChannelProviderType>(['telegram', 'discord'])

// Discord channel ids are snowflakes — base-10 numeric ids, 17 to 20 digits
// long in practice (current Discord scheme is 64-bit, with the leading bit
// always 0). Rejects empty, whitespace-only, non-numeric, or wrong-length
// values before any state write so a typo in the dashboard cannot bounce the
// live Nexus session through hardRestartNexusChannels().
export function validateDiscordChannelId(cid: string | undefined): { ok: boolean; error?: string } {
  const trimmed = cid?.trim()
  if (!trimmed || !/^[0-9]{17,20}$/.test(trimmed)) {
    return { ok: false, error: 'Discord channelId is required and must be a numeric snowflake (17-20 digits).' }
  }
  return { ok: true }
}

function parseChannelProvider(raw: string): ChannelProviderType | null {
  if (VALID_PROVIDERS.has(raw as ChannelProviderType)) return raw as ChannelProviderType
  return null
}

// Match both new /channels/:provider/ and legacy /telegram/ URL patterns.
// Returns [agentName, provider] or null. Legacy routes always resolve to 'telegram'.
function matchChannelRoute(path: string, suffix: string): [string, ChannelProviderType] | null {
  const newPattern = new RegExp(`^/api/agents/([^/]+)/channels/(telegram|discord)${suffix}$`)
  const newMatch = path.match(newPattern)
  if (newMatch) {
    const provider = parseChannelProvider(newMatch[2])
    if (provider) return [decodeURIComponent(newMatch[1]), provider]
  }
  const legacyPattern = new RegExp(`^/api/agents/([^/]+)/telegram${suffix}$`)
  const legacyMatch = path.match(legacyPattern)
  if (legacyMatch) return [decodeURIComponent(legacyMatch[1]), 'telegram']
  return null
}

const MANAGED_SETTINGS_PATH = platform() === 'darwin'
  ? '/Library/Application Support/ClaudeCode/managed-settings.json'
  : '/etc/claude-code/managed-settings.json'
// Channel plugins CITADEL allows for inbound (telegram + discord). Listed in
// /etc/claude-code/managed-settings.json -- without it Claude Code silently
// drops inbound channel notifications.
const ALLOWED_CHANNEL_PLUGINS = [
  { plugin: 'telegram', marketplace: 'claude-plugins-official' },
  { plugin: 'discord', marketplace: 'claude-plugins-official' },
]

export function isManagedSettingsReady(): boolean {
  if (!existsSync(MANAGED_SETTINGS_PATH)) return false
  try {
    const data = JSON.parse(readFileSync(MANAGED_SETTINGS_PATH, 'utf-8')) as {
      channelsEnabled?: boolean
      allowedChannelPlugins?: Array<{ plugin: string; marketplace: string }>
    }
    if (!data.channelsEnabled) return false
    const plugins = data.allowedChannelPlugins ?? []
    // Ready if at least one CITADEL channel plugin is allowlisted.
    return ALLOWED_CHANNEL_PLUGINS.some(
      e => plugins.some(p => p.plugin === e.plugin && p.marketplace === e.marketplace)
    )
  } catch {
    return false
  }
}

export function getManagedSettingsSudoCommand(): string {
  const mergeScript = [
    'import json, sys',
    'new_data = json.loads(sys.stdin.read())',
    'try:\n  with open("' + MANAGED_SETTINGS_PATH + '") as f: data = json.load(f)',
    'except:\n  data = {}',
    'data["channelsEnabled"] = True',
    'existing = data.get("allowedChannelPlugins", [])',
    'for e in new_data["allowedChannelPlugins"]:\n  if not any(p.get("plugin")==e["plugin"] and p.get("marketplace")==e["marketplace"] for p in existing):\n    existing.append(e)',
    'data["allowedChannelPlugins"] = existing',
    'print(json.dumps(data, indent=2))',
  ].join('\n')
  const payload = JSON.stringify({
    allowedChannelPlugins: [
      ...ALLOWED_CHANNEL_PLUGINS,
    ],
  })
  const escapedScript = mergeScript.replace(/'/g, "'\\''")
  return `echo '${payload}' | sudo python3 -c '${escapedScript}' | sudo tee "${MANAGED_SETTINGS_PATH}" > /dev/null`
}

export function setAgentEnabledPlugins(name: string, provider: ChannelProviderType): void {
  const settingsDir = join(agentDir(name), '.claude')
  const settingsPath = join(settingsDir, 'settings.json')
  mkdirSync(settingsDir, { recursive: true })
  let existing: Record<string, unknown> = {}
  if (existsSync(settingsPath)) {
    try { existing = JSON.parse(readFileSync(settingsPath, 'utf-8')) } catch { /* overwrite */ }
  }
  const plugins = (existing.enabledPlugins ?? {}) as Record<string, boolean>
  const allPlugins: Record<ChannelProviderType, string> = {
    telegram: 'telegram@claude-plugins-official',
    discord: 'discord@claude-plugins-official',
  }
  for (const [p, pluginKey] of Object.entries(allPlugins)) {
    plugins[pluginKey] = p === provider
  }
  existing.enabledPlugins = plugins
  atomicWriteFileSync(settingsPath, JSON.stringify(existing, null, 2))
}

export function resetAgentEnabledPlugins(name: string): void {
  const settingsPath = join(agentDir(name), '.claude', 'settings.json')
  if (!existsSync(settingsPath)) return
  try {
    const existing = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>
    delete existing.enabledPlugins
    atomicWriteFileSync(settingsPath, JSON.stringify(existing, null, 2))
  } catch { /* settings corrupt, nothing to reset */ }
}

function resolveAccessPath(name: string, provider: ChannelProviderType): string {
  const dir = name === MAIN_AGENT_ID
    ? channelStateDir(provider)
    : channelStateDir(provider, agentDir(name))
  return join(dir, 'access.json')
}

function extractBotId(token: string): string | null {
  const colon = token.indexOf(':')
  if (colon < 1) return null
  const id = token.slice(0, colon)
  return /^\d+$/.test(id) ? id : null
}

function findBotTokenDuplicate(
  provider: ChannelProviderType,
  token: string,
  excludeAgent: string,
): string | null {
  const botId = extractBotId(token)
  if (!botId) return null

  const candidates: Array<{ name: string; envPath: string }> = []

  // Main agent's channel .env
  if (excludeAgent !== MAIN_AGENT_ID) {
    const mainEnv = join(channelStateDir(provider), '.env')
    candidates.push({ name: MAIN_AGENT_ID, envPath: mainEnv })
  }

  // All sub-agents
  for (const agentName of listAgentNames()) {
    if (agentName === excludeAgent) continue
    const envPath = join(channelStateDir(provider, agentDir(agentName)), '.env')
    candidates.push({ name: agentName, envPath })
  }

  for (const { name, envPath } of candidates) {
    const existing = readChannelToken(provider, envPath)
    if (!existing) continue
    const existingBotId = extractBotId(existing)
    if (existingBotId === botId) return name
  }

  return null
}

interface AgentSummary {
  name: string
  displayName: string
  description: string
  model: string
  activeModel: string | null
  runningSince: number | null
  authMode: AuthMode
  securityProfile: string
  team: TeamConfig
  hasTelegram: boolean
  telegramBotUsername?: string
  hasDiscord: boolean
  status: 'configured' | 'draft'
  running: boolean
  session?: string
  hasAvatar: boolean
  /** Per-agent UI accent (hex) from agent-config.json, or null when unset.
   *  Drives the framed-avatar ring (--ac) for non-base agents. */
  accent: string | null
  autoRestart: AutoRestartConfig
  /** Live context size in tokens (input+cache_read+cache_creation of the last
   *  turn), or null when not running / no transcript yet. */
  contextTokens: number | null
  /** True when the running session's pane shows a login/401 auth failure --
   *  drives the dashboard "reauth needed" badge + one-click /login button. */
  needsReauth: boolean
  reauthReason?: string
}

interface AgentDetail extends AgentSummary {
  claudeMd: string
  soulMd: string
  mcpJson: string
  skills: { name: string; hasSkillMd: boolean }[]
  hasAvatar: boolean
  hasApiKey: boolean
}

function getAgentSummary(name: string): AgentSummary {
  const dir = agentDir(name)
  const configRoot = agentConfigRoot(name)
  const claudeMd = readFileOr(join(configRoot, 'CLAUDE.md'), '')
  const soulMd = readFileOr(join(dir, 'SOUL.md'), '')
  const tg = readAgentTelegramConfig(name)
  const dc = readAgentDiscordConfig(name)
  const hasClaudeMd = claudeMd.trim().length > 0
  const hasSoulMd = soulMd.trim().length > 0

  const proc = getAgentProcessInfo(name)
  const runningSince = proc.running ? getAgentRunningSince(name) : null

  // Reauth badge: only meaningful for a running session (a stopped agent has
  // no pane to inspect). One capture-pane per running agent on the list poll.
  const reauth = proc.running ? detectReauthNeeded(capturePane(agentSessionName(name))) : { needsReauth: false }

  return {
    name,
    displayName: readAgentDisplayName(name),
    description: extractDescriptionFromClaudeMd(claudeMd),
    model: readAgentModel(name),
    activeModel: proc.running ? readActiveModelFromProjectDir(dir, runningSince ?? undefined, readAgentClaudeConfigDir(name) ?? undefined) : null,
    runningSince,
    authMode: readAgentAuthMode(name),
    securityProfile: readAgentSecurityProfile(name),
    team: readAgentTeam(name),
    hasTelegram: tg.hasTelegram,
    telegramBotUsername: tg.botUsername,
    hasDiscord: dc.hasDiscord,
    status: hasClaudeMd && hasSoulMd ? 'configured' : 'draft',
    running: proc.running,
    session: proc.session,
    hasAvatar: findAvatarForAgent(name) !== null,
    accent: readAgentAccent(name),
    autoRestart: readAutoRestartConfig(name),
    contextTokens: proc.running ? readContextTokensFromProjectDir(dir, readAgentClaudeConfigDir(name) ?? undefined) : null,
    needsReauth: reauth.needsReauth,
    reauthReason: reauth.reason,
  }
}

function getAgentDetail(name: string): AgentDetail {
  const dir = agentDir(name)
  const configRoot = agentConfigRoot(name)
  const summary = getAgentSummary(name)
  const claudeMd = readFileOr(join(configRoot, 'CLAUDE.md'), '')
  const soulMd = readFileOr(join(dir, 'SOUL.md'), '')
  const mcpJson = readFileOr(join(dir, '.mcp.json'), '{}')

  const skillsDir = join(dir, '.claude', 'skills')
  let skills: { name: string; hasSkillMd: boolean }[] = []
  if (existsSync(skillsDir)) {
    skills = readdirSync(skillsDir)
      .filter((f) => {
        try { return statSync(join(skillsDir, f)).isDirectory() } catch { return false }
      })
      .map((f) => ({
        name: f,
        hasSkillMd: existsSync(join(skillsDir, f, 'SKILL.md')),
      }))
  }

  return {
    ...summary,
    claudeMd,
    soulMd,
    mcpJson,
    skills,
    hasAvatar: findAvatarForAgent(name) !== null,
    hasApiKey: getSecret(`agent-${name}-api-key`) !== null,
  }
}

function listAgentSummaries(): AgentSummary[] {
  return listAgentNames().map(getAgentSummary)
}

// Shared scaffold/generate flow used by both the direct create endpoint and the
// spawn-request approval endpoint. Generates CLAUDE.md/SOUL.md, applies the
// security profile, and (for internal/project agents) hides the agent from the
// dashboard roster + channel routing via the sentinel. Returns a structured
// result so the caller maps it to the right HTTP status.
async function performAgentCreate(opts: {
  name: string
  description: string
  model: string
  profileId: string
  displayName?: string
  internal: boolean
}): Promise<{ ok: boolean; error?: string; detail?: string }> {
  const { name, description, model, profileId, displayName, internal } = opts
  scaffoldAgentDir(name)
  writeAgentModel(name, model)
  writeAgentSecurityProfile(name, profileId)
  writeAgentSettingsFromProfile(name, loadProfileTemplate(profileId))
  if (displayName) writeAgentDisplayName(name, displayName)
  // Internal/project agents are technical workers: write the config flag +
  // sentinel so they stay out of the roster and skip channel registration.
  if (internal) writeAgentInternal(name, true)

  logger.info({ name, description, internal }, 'Generating agent CLAUDE.md and SOUL.md...')
  try {
    const [claudeMd, soulMd] = await Promise.all([
      generateClaudeMd(name, description, model),
      generateSoulMd(name, description),
    ])
    atomicWriteFileSync(join(agentDir(name), 'CLAUDE.md'), claudeMd)
    atomicWriteFileSync(join(agentDir(name), 'SOUL.md'), soulMd)
    logger.info({ name }, 'Agent created successfully')

    // Internal agents are hidden from routing, so don't broadcast a "new
    // teammate" announcement for them.
    if (!internal) {
      const allAgents = listAgentNames()
      const runningAgents = allAgents.filter(a => a !== name && isAgentRunning(a))
      const notifyTargets = [MAIN_AGENT_ID, ...runningAgents]
      for (const target of notifyTargets) {
        createAgentMessage('system', target, `Uj csapattag erkezett: ${name}. Leirasa: ${description}. Udv neki ha legkozelebb beszeltek!`)
      }
    }
  } catch (err) {
    rmSync(agentDir(name), { recursive: true, force: true })
    logger.error({ err, name }, 'Failed to generate agent files')
    const detail = err instanceof Error ? err.message : 'Unknown error'
    return { ok: false, error: 'Failed to generate agent files', detail }
  }
  return { ok: true }
}

export async function tryHandleAgents(ctx: RouteContext, webDir: string): Promise<boolean> {
  const { req, res, path, method } = ctx

  // Lists every model the dashboard is willing to serve up to an agent.
  // Claude IDs are static. DeepSeek is gated behind a vault secret because
  // the agent-process launcher reads the key from there at start time --
  // surfacing the option in the UI without the key would let the operator
  // pick a model that 401s on first prompt. The frontend renders this list
  // both in the "new agent" wizard and the agent edit panel.
  if (path === '/api/models/available' && method === 'GET') {
    const hasDeepseek = getSecret('DEEPSEEK_API_KEY') !== null
    json(res, {
      claude: [
        { id: 'claude-opus-4-8[1m]', label: 'Opus 4.8 (1M kontextus)' },
        { id: 'claude-opus-4-7', label: 'Opus 4.7' },
        { id: 'claude-opus-4-6', label: 'Opus 4.6' },
        { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6 (alapértelmezett)' },
        { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5 (leggyorsabb)' },
      ],
      deepseek: hasDeepseek
        ? [
            { id: 'deepseek-v4-pro', label: 'DeepSeek-V4-Pro (1M kontextus, erősebb)' },
            { id: 'deepseek-v4-flash', label: 'DeepSeek-V4-Flash (1M kontextus, gyorsabb/olcsóbb)' },
          ]
        : [],
      deepseekConfigured: hasDeepseek,
    })
    return true
  }

  if (path === '/api/agents' && method === 'GET') {
    json(res, listAgentSummaries())
    return true
  }

  // Live activity panel: per-agent "what is it doing right now". Read-only,
  // polled by the dashboard every 3s; uses the same pane-state detector as the
  // scheduler (detectPaneState) and returns the last few output lines as a tail.
  // Includes the main agent's channels session so the operator sees the whole
  // fleet, not just sub-agents. Restored after #226 dropped this route while the
  // frontend kept calling /api/agents/activity (which then 404'd the panel).
  if (path === '/api/agents/activity' && method === 'GET') {
    const label = (running: boolean, pane: string | null): string => {
      if (!running) return 'stopped'
      if (pane === null) return 'unknown'
      const s = detectPaneState(pane)
      if (s === 'busy' || s === 'typing') return 'working'
      if (s === 'idle') return 'idle'
      return s // 'unknown' | 'error'
    }
    const tailOf = (pane: string | null): string[] =>
      pane === null
        ? []
        : pane
            .split('\n')
            .map(l => l.replace(/\s+$/, ''))
            .filter(l => l.trim().length > 0)
            .slice(-8)

    const entries: Array<{ name: string; isMain: boolean; running: boolean; state: string; tail: string[] }> = []

    // Main agent runs in the --channels session, not agent-<name>.
    {
      const mainPane = capturePane(MAIN_CHANNELS_SESSION)
      const running = mainPane !== null
      entries.push({
        name: MAIN_AGENT_ID,
        isMain: true,
        running,
        state: label(running, mainPane),
        tail: tailOf(mainPane),
      })
    }

    for (const name of listAgentNames()) {
      const running = isAgentRunning(name)
      const pane = running ? capturePane(agentSessionName(name)) : null
      entries.push({ name, isMain: false, running, state: label(running, pane), tail: tailOf(pane) })
    }

    json(res, entries)
    return true
  }

  // GET /api/agents/name-suggestions?role=... -- themed, collision-safe name
  // ideas for the create wizard. Must precede the generic /api/agents/:name
  // route below.
  if (path === '/api/agents/name-suggestions' && method === 'GET') {
    const role = ctx.url.searchParams.get('role') || undefined
    json(res, { suggestions: suggestAgentNames(role, 3) })
    return true
  }

  // GET /api/agents/spawn-requests -- pending programmatic spawns awaiting the
  // operator's approval. Must precede the generic /api/agents/:name route.
  if (path === '/api/agents/spawn-requests' && method === 'GET') {
    json(res, listSpawnRequests())
    return true
  }

  const spawnApproveMatch = path.match(/^\/api\/agents\/spawn-requests\/([^/]+)\/approve$/)
  if (spawnApproveMatch && method === 'POST') {
    const id = decodeURIComponent(spawnApproveMatch[1])
    const rec = getSpawnRequest(id)
    if (!rec) { json(res, { error: 'Spawn request not found' }, 404); return true }
    if (existsSync(agentDir(rec.name))) {
      removeSpawnRequest(id)
      json(res, { error: 'Agent already exists' }, 409)
      return true
    }
    const result = await performAgentCreate({
      name: rec.name,
      description: rec.description,
      model: rec.model,
      profileId: rec.profile,
      displayName: rec.displayName,
      internal: rec.internal,
    })
    if (!result.ok) { json(res, { error: result.error, detail: result.detail }, 500); return true }
    removeSpawnRequest(id)
    json(res, { ok: true, name: rec.name })
    return true
  }

  const spawnDenyMatch = path.match(/^\/api\/agents\/spawn-requests\/([^/]+)\/deny$/)
  if (spawnDenyMatch && method === 'POST') {
    const id = decodeURIComponent(spawnDenyMatch[1])
    const removed = removeSpawnRequest(id)
    if (!removed) { json(res, { error: 'Spawn request not found' }, 404); return true }
    json(res, { ok: true })
    return true
  }

  if (path === '/api/agents' && method === 'POST') {
    const body = await readBody(req)
    const data = JSON.parse(body.toString())
    const { description, model: rawModel, profile: rawProfile } = data as { name: string; description: string; model?: string; profile?: string }
    const rawName = typeof data.name === 'string' ? data.name.trim() : ''
    const name = sanitizeAgentName(rawName)
    const model = resolveModelId(rawModel || DEFAULT_MODEL)
    const profileId = (rawProfile || 'default').trim() || 'default'
    const displayName = rawName && rawName !== name ? rawName : undefined

    // Spawn provenance. No requestedBy => the dashboard operator is acting
    // directly (viaDashboard). A present requestedBy => a programmatic spawn
    // initiated by an agent (only NEXUS may, enforced by the privilege gate).
    const rawRequestedBy = typeof data.requestedBy === 'string' ? data.requestedBy.trim() : ''
    const requestedBy = rawRequestedBy ? sanitizeAgentName(rawRequestedBy) : undefined

    if (!name) { json(res, { error: 'Name is required' }, 400); return true }
    if (!description) { json(res, { error: 'Description is required' }, 400); return true }
    if (existsSync(agentDir(name))) { json(res, { error: 'Agent already exists' }, 409); return true }

    // Resolve the requester's own profile only for a non-main programmatic
    // requester; the main agent is left undefined so the gate treats it as the
    // hard ceiling (it is the orchestrator).
    const requesterProfile = requestedBy && requestedBy !== MAIN_AGENT_ID
      ? readAgentSecurityProfile(requestedBy)
      : undefined

    const plan = planSpawn({
      requestedBy,
      requestedProfile: profileId,
      mainAgentId: MAIN_AGENT_ID,
      requesterProfile,
    })

    // Internal vs channel agent. Programmatic (NEXUS-spawned) project agents
    // default to internal/hidden; dashboard-created agents default to visible.
    const internal = typeof data.internal === 'boolean' ? data.internal : requestedBy !== undefined

    if (plan.outcome === 'forbidden') {
      json(res, { error: plan.decision.reason }, 403)
      return true
    }

    if (plan.outcome === 'pending') {
      const rec = addSpawnRequest({
        requestedBy: requestedBy ?? '',
        name,
        profile: profileId,
        displayName,
        description,
        model,
        internal,
      })
      notifyAlert(
        `[CITADEL] Spawn approval needed: '${requestedBy ?? 'operator'}' wants to create agent '${name}' (profile ${profileId}). ${plan.decision.reason}. Approve/deny in the dashboard.`,
      ).catch(() => {})
      json(res, { ok: false, pending: true, requestId: rec.id, reason: plan.decision.reason }, 202)
      return true
    }

    // outcome === 'create'
    const result = await performAgentCreate({ name, description, model, profileId, displayName, internal })
    if (!result.ok) {
      // Propagate the underlying message so the dashboard surfaces the actual
      // cause (auth not configured, Claude Code CLI missing, etc.) — Issue #179.
      json(res, { error: result.error, detail: result.detail }, 500)
      return true
    }

    json(res, { ok: true, name })
    return true
  }

  const avatarUploadMatch = path.match(/^\/api\/agents\/([^/]+)\/avatar$/)
  if (avatarUploadMatch && method === 'POST') {
    const name = decodeURIComponent(avatarUploadMatch[1])
    if (!existsSync(agentDir(name))) { json(res, { error: 'Agent not found' }, 404); return true }

    const body = await readBody(req)
    const contentType = req.headers['content-type'] || ''

    for (const ext of ['.png', '.jpg', '.jpeg', '.webp']) {
      const p = join(agentDir(name), `avatar${ext}`)
      if (existsSync(p)) unlinkSync(p)
    }

    if (contentType.includes('application/json')) {
      const { galleryAvatar } = JSON.parse(body.toString()) as { galleryAvatar: string }
      if (!galleryAvatar) { json(res, { error: 'No avatar specified' }, 400); return true }
      if (galleryAvatar.includes('..') || galleryAvatar.includes('/') || galleryAvatar.includes('\\')) {
        json(res, { error: 'Invalid avatar name' }, 400); return true
      }
      const srcPath = join(webDir, 'avatars', galleryAvatar)
      if (!existsSync(srcPath)) { json(res, { error: 'Avatar not found' }, 404); return true }
      const ext = extname(galleryAvatar) || '.png'
      const destPath = join(agentDir(name), `avatar${ext}`)
      copyFileSync(srcPath, destPath)
      sendAvatarChangeMessage(name, destPath).catch(() => {})
      json(res, { ok: true })
      return true
    } else {
      const { file } = parseMultipart(body, contentType)
      if (!file) { json(res, { error: 'No file uploaded' }, 400); return true }
      const ext = extname(file.name) || '.png'
      const destPath = join(agentDir(name), `avatar${ext}`)
      writeFileSync(destPath, file.data)
      sendAvatarChangeMessage(name, destPath).catch(() => {})
      json(res, { ok: true })
      return true
    }
  }

  if (avatarUploadMatch && method === 'GET') {
    const name = decodeURIComponent(avatarUploadMatch[1])
    const avatarPath = findAvatarForAgent(name)
    if (avatarPath) { serveFile(req, res, avatarPath); return true }
    res.writeHead(404); res.end()
    return true
  }

  // POST /api/agents/:name/channel/reconnect
  const reconnectMatch = path.match(/^\/api\/agents\/([^/]+)\/channel\/reconnect$/)
  if (reconnectMatch && method === 'POST') {
    const name = decodeURIComponent(reconnectMatch[1])
    if (name !== MAIN_AGENT_ID && !existsSync(agentDir(name))) {
      json(res, { error: 'Agent not found' }, 404); return true
    }
    if (name !== MAIN_AGENT_ID && !isAgentRunning(name)) {
      json(res, { error: 'Agent is not running' }, 400); return true
    }
    const result = attemptChannelMcpReconnect(name)
    json(res, result)
    return true
  }

  // GET /api/agents/:name/channel/health
  const healthMatch = path.match(/^\/api\/agents\/([^/]+)\/channel\/health$/)
  if (healthMatch && method === 'GET') {
    const name = decodeURIComponent(healthMatch[1])
    if (name !== MAIN_AGENT_ID && !existsSync(agentDir(name))) {
      json(res, { error: 'Agent not found' }, 404); return true
    }
    json(res, getChannelHealth(name))
    return true
  }

  // POST /api/agents/:name/channels/:provider/test (legacy: /telegram/test)
  const testMatch = matchChannelRoute(path, '/test')
  if (testMatch && method === 'POST') {
    const [name, provider] = testMatch
    if (!existsSync(agentDir(name))) { json(res, { error: 'Agent not found' }, 404); return true }
    const stateDir = channelStateDir(provider, agentDir(name))
    const envPath = join(stateDir, '.env')
    const token = readChannelToken(provider, envPath) || (provider === 'telegram' ? parseTelegramToken(name) : null)
    if (!token) { json(res, { error: `${provider} not configured for this agent` }, 404); return true }
    const channelProvider = getProvider(provider)
    const result = await channelProvider.validateToken(token)
    if (result.ok) { json(res, { ok: true, botName: result.botName }); return true }
    json(res, { error: result.error }, 400)
    return true
  }

  // POST /api/agents/:name/channels/:provider (legacy: /telegram) -- setup
  const setupMatch = matchChannelRoute(path, '')
  if (setupMatch && method === 'POST') {
    const [name, provider] = setupMatch
    const isMain = name === MAIN_AGENT_ID
    // Nexus lives at PROJECT_ROOT, not under agents/nexus/ -- skip the
    // dir check for the main agent and route writes to ~/.claude/channels/.
    if (!isMain && !existsSync(agentDir(name))) { json(res, { error: 'Agent not found' }, 404); return true }

    const body = await readBody(req)
    const { botToken, channelId } = JSON.parse(body.toString()) as { botToken: string; appToken?: string; channelId?: string }
    if (!botToken?.trim()) { json(res, { error: 'botToken is required' }, 400); return true }

    // Discord-specific channelId guard: the dashboard ships the channel where
    // the bot will post by default; without it the plugin spins up but cannot
    // resolve a default channel, and on the main Nexus agent the missing
    // value would still trigger hardRestartNexusChannels and bounce the
    // live session for no useful reason. Reject before any state write.
    if (provider === 'discord') {
      const cidCheck = validateDiscordChannelId(channelId)
      if (!cidCheck.ok) { json(res, { error: cidCheck.error }, 400); return true }
    }

    const channelProvider = getProvider(provider)
    const validation = await channelProvider.validateToken(botToken.trim())
    if (!validation.ok) { json(res, { error: validation.error || 'Invalid token' }, 400); return true }

    const dupeOwner = findBotTokenDuplicate(provider, botToken.trim(), name)
    if (dupeOwner) {
      json(res, { error: `This bot token is already used by agent "${dupeOwner}". Each agent needs its own bot token to avoid getUpdates conflicts.` }, 409)
      return true
    }

    // Main agent's channel state lives under ~/.claude/channels/<provider>,
    // sub-agents under agents/<name>/.claude/channels/<provider>.
    const stateDir = isMain ? channelStateDir(provider) : channelStateDir(provider, agentDir(name))
    mkdirSync(stateDir, { recursive: true })
    const tokenKey = provider === 'discord' ? 'DISCORD_BOT_TOKEN'
      : 'TELEGRAM_BOT_TOKEN'
    let envContent = `${tokenKey}=${botToken.trim()}\n`
    if (provider === 'discord' && channelId?.trim()) {
      envContent += `DISCORD_CHANNEL_ID=${channelId.trim()}\n`
    }
    atomicWriteFileSync(join(stateDir, '.env'), envContent, { mode: 0o600 })
    atomicWriteFileSync(join(stateDir, 'access.json'), JSON.stringify({
      dmPolicy: 'pairing',
      allowFrom: [],
      groups: {},
      pending: {},
    }, null, 2))

    // Main agent doesn't have an agent-config.json or enabled-plugins entry
    // (the channels session reuses the system claude install), so skip the
    // sub-agent-specific bookkeeping. Restart goes through the dedicated
    // nexus-channels helper instead of the agent process lifecycle.
    let restarted = false
    let wasRunning = false
    if (isMain) {
      const r = hardRestartNexusChannels()
      restarted = r.ok
      wasRunning = true
    } else {
      writeAgentChannelProvider(name, provider)
      setAgentEnabledPlugins(name, provider)
      if (provider === 'telegram') sendWelcomeMessage(name, botToken.trim()).catch(() => {})
      wasRunning = isAgentRunning(name)
      if (wasRunning) {
        const stopRes = stopAgentProcess(name)
        if (stopRes.ok) {
          try { execSync('sleep 2', { timeout: 4000 }) } catch {}
          const startRes = startAgentProcess(name)
          restarted = startRes.ok
        }
      }
    }

    json(res, { ok: true, botName: validation.botName, restarted, wasRunning })
    return true
  }

  // DELETE /api/agents/:name/channels/:provider (legacy: /telegram) -- remove
  if (setupMatch && method === 'DELETE') {
    const [name, provider] = setupMatch
    if (!existsSync(agentDir(name))) { json(res, { error: 'Agent not found' }, 404); return true }
    const stateDir = channelStateDir(provider, agentDir(name))
    const envFile = join(stateDir, '.env')
    const accessFile = join(stateDir, 'access.json')
    if (existsSync(envFile)) unlinkSync(envFile)
    if (existsSync(accessFile)) unlinkSync(accessFile)
    writeAgentChannelProvider(name, '')
    resetAgentEnabledPlugins(name)
    json(res, { ok: true })
    return true
  }

  const secGetMatch = path.match(/^\/api\/agents\/([^/]+)\/security$/)
  if (secGetMatch && method === 'GET') {
    const name = decodeURIComponent(secGetMatch[1])
    if (!existsSync(agentDir(name))) { json(res, { error: 'Agent not found' }, 404); return true }
    const profileId = readAgentSecurityProfile(name)
    const profile = loadProfileTemplate(profileId)
    const placeholders = { HOME: homedir(), AGENT_DIR: agentDir(name) }
    json(res, {
      profile: profileId,
      label: profile.label,
      description: profile.description,
      permissionMode: profile.permissionMode,
      allow: profile.filesystem.allow.map(p => resolveProfilePlaceholders(p, placeholders)),
      deny: profile.filesystem.deny.map(p => resolveProfilePlaceholders(p, placeholders)),
    })
    return true
  }

  if (secGetMatch && method === 'PUT') {
    const name = decodeURIComponent(secGetMatch[1])
    if (!existsSync(agentDir(name))) { json(res, { error: 'Agent not found' }, 404); return true }
    const body = await readBody(req)
    const data = JSON.parse(body.toString()) as { profile?: string }
    const requested = (data.profile || '').trim()
    if (!requested) { json(res, { error: 'profile is required' }, 400); return true }
    const profile = loadProfileTemplate(requested)
    if (profile.id !== requested) { json(res, { error: `Unknown profile: ${requested}` }, 400); return true }
    writeAgentSecurityProfile(name, requested)
    writeAgentSettingsFromProfile(name, profile)
    json(res, { ok: true, requiresRestart: isAgentRunning(name) })
    return true
  }

  // PUT /api/agents/:name/auto-restart -- set the per-agent auto-restart config.
  // Accepts the main orchestrator id too (auto-restart applies to it as well).
  // The body is normalized server-side, so a partial/garbled payload is coerced
  // to a safe config rather than rejected.
  const autoRestartMatch = path.match(/^\/api\/agents\/([^/]+)\/auto-restart$/)
  if (autoRestartMatch && method === 'PUT') {
    const name = decodeURIComponent(autoRestartMatch[1])
    if (name !== MAIN_AGENT_ID && !existsSync(agentDir(name))) { json(res, { error: 'Agent not found' }, 404); return true }
    const body = await readBody(req)
    let data: unknown
    try { data = JSON.parse(body.toString()) } catch { json(res, { error: 'invalid JSON' }, 400); return true }
    const saved = writeAutoRestartConfig(name, data)
    json(res, { ok: true, autoRestart: saved })
    return true
  }

  if (path === '/api/team/graph' && method === 'GET') {
    const nodes: Array<{
      id: string
      label: string
      role: 'main' | 'leader' | 'member'
      reportsTo: string | null
      delegatesTo: string[]
      running?: boolean
      securityProfile?: string
      hasAvatar?: boolean
    }> = []
    nodes.push({
      id: MAIN_AGENT_ID,
      label: BOT_NAME,
      role: 'main',
      reportsTo: null,
      delegatesTo: [],
      running: true,
      // The main agent always resolves an avatar (operator upload or the NEXUS
      // portrait fallback) via /api/nexus/avatar, so flag it true.
      hasAvatar: true,
    })
    for (const agentName of listAgentNames()) {
      const team = readAgentTeam(agentName)
      nodes.push({
        id: agentName,
        label: readAgentDisplayName(agentName),
        role: team.role,
        reportsTo: team.reportsTo,
        delegatesTo: team.delegatesTo,
        running: isAgentRunning(agentName),
        securityProfile: readAgentSecurityProfile(agentName),
        // Whether an operator-uploaded avatar exists. The dashboard uses this to
        // choose between the /api/agents/<id>/avatar endpoint and the base-agent
        // portrait fallback, so it never requests an avatar URL that 404s.
        hasAvatar: findAvatarForAgent(agentName) !== null,
      })
    }
    const knownIds = new Set(nodes.map(n => n.id))
    const edges: Array<{ from: string; to: string }> = []
    for (const n of nodes) {
      const reports = n.reportsTo && knownIds.has(n.reportsTo)
        ? n.reportsTo
        : (n.id === MAIN_AGENT_ID ? null : MAIN_AGENT_ID)
      if (reports) edges.push({ from: reports, to: n.id })
    }
    json(res, { nodes, edges, mainAgentId: MAIN_AGENT_ID })
    return true
  }

  const teamMatch = path.match(/^\/api\/agents\/([^/]+)\/team$/)
  if (teamMatch && method === 'GET') {
    const name = decodeURIComponent(teamMatch[1])
    if (!existsSync(agentDir(name))) { json(res, { error: 'Agent not found' }, 404); return true }
    json(res, readAgentTeam(name))
    return true
  }

  if (teamMatch && method === 'PUT') {
    const name = decodeURIComponent(teamMatch[1])
    if (!existsSync(agentDir(name))) { json(res, { error: 'Agent not found' }, 404); return true }
    const body = await readBody(req)
    const data = JSON.parse(body.toString())
    const current = readAgentTeam(name)
    const proposed: TeamConfig = {
      role: data.role === 'leader' ? 'leader' : (data.role === 'member' ? 'member' : current.role),
      reportsTo: typeof data.reportsTo === 'string'
        ? (data.reportsTo.trim() || null)
        : (data.reportsTo === null ? null : current.reportsTo),
      delegatesTo: Array.isArray(data.delegatesTo)
        ? data.delegatesTo.filter((x: unknown) => typeof x === 'string')
        : current.delegatesTo,
      autoDelegation: typeof data.autoDelegation === 'boolean' ? data.autoDelegation : current.autoDelegation,
      trustFrom: Array.isArray(data.trustFrom)
        ? data.trustFrom.filter((x: unknown) => typeof x === 'string')
        : (current.trustFrom ?? []),
    }
    const { team: next, warnings } = sanitizeTeamConfig(name, proposed)
    writeAgentTeam(name, next)
    json(res, { ok: true, team: next, warnings })
    return true
  }

  // GET /api/agents/:name/channels/:provider/pending (legacy: /telegram/pending)
  const pendingMatch = matchChannelRoute(path, '/pending')
  if (pendingMatch && method === 'GET') {
    const [name, provider] = pendingMatch
    if (name !== MAIN_AGENT_ID && !existsSync(agentDir(name))) {
      json(res, { error: 'Agent not found' }, 404)
      return true
    }
    const accessPath = resolveAccessPath(name, provider)
    const accessContent = readFileOr(accessPath, '{}')
    try {
      const access = JSON.parse(accessContent)
      const pending = access.pending || {}
      const entries = Object.entries(pending).map(([code, entry]: [string, any]) => ({
        code,
        senderId: entry.senderId,
        chatId: entry.chatId,
        createdAt: entry.createdAt,
        expiresAt: entry.expiresAt,
      }))
      json(res, entries)
    } catch {
      json(res, [])
    }
    return true
  }

  // POST /api/agents/:name/channels/:provider/approve (legacy: /telegram/approve)
  const approveMatch = matchChannelRoute(path, '/approve')
  if (approveMatch && method === 'POST') {
    const [name, provider] = approveMatch
    if (name !== MAIN_AGENT_ID && !existsSync(agentDir(name))) {
      json(res, { error: 'Agent not found' }, 404)
      return true
    }

    const body = await readBody(req)
    const { code } = JSON.parse(body.toString()) as { code: string }
    if (!code?.trim()) { json(res, { error: 'Code is required' }, 400); return true }

    const chDir = name === MAIN_AGENT_ID
      ? channelStateDir(provider)
      : channelStateDir(provider, agentDir(name))
    const accessPath = join(chDir, 'access.json')
    const accessContent = readFileOr(accessPath, '{}')

    try {
      const access = JSON.parse(accessContent)
      const pending = access.pending || {}
      const entry = pending[code.trim()]

      if (!entry) { json(res, { error: 'Invalid or expired code' }, 404); return true }

      if (!access.allowFrom) access.allowFrom = []
      if (!access.allowFrom.includes(entry.senderId)) {
        access.allowFrom.push(entry.senderId)
      }

      delete access.pending[code.trim()]

      access.dmPolicy = 'allowlist'

      atomicWriteFileSync(accessPath, JSON.stringify(access, null, 2))

      const approvedDir = join(chDir, 'approved')
      mkdirSync(approvedDir, { recursive: true })
      writeFileSync(join(approvedDir, entry.senderId), '')

      logger.info({ name, provider, senderId: entry.senderId, code }, 'Channel pairing approved')
      json(res, { ok: true, senderId: entry.senderId })
    } catch (err) {
      logger.error({ err }, 'Failed to approve pairing')
      json(res, { error: 'Failed to approve pairing' }, 500)
    }
    return true
  }

  // -- One-click invite links (Telegram deep-link pairing) ------------------
  // A single-use, time-boxed link `https://t.me/<bot>?start=<token>`: the
  // person clicks it, Telegram opens a DM with the bot, and they appear in the
  // pending-pairing list for the operator to approve. Telegram-only: Discord
  // has no per-user DM deep link with a start payload, so these routes reject
  // non-Telegram providers and the UI hides the section there (audit O1, was a
  // 404 against a missing backend). Invites live in access.json under
  // `invites: { <token>: { createdAt, expiresAt, botUsername } }`.
  const INVITE_TTL_MS = 60 * 60 * 1000

  function readInvites(accessPath: string): Record<string, { createdAt: number; expiresAt: number; botUsername?: string }> {
    try {
      const access = JSON.parse(readFileOr(accessPath, '{}'))
      return (access && typeof access.invites === 'object' && access.invites) || {}
    } catch { return {} }
  }
  // Persist invites, dropping expired ones. Returns the surviving set.
  function pruneAndWriteInvites(accessPath: string, invites: Record<string, { createdAt: number; expiresAt: number; botUsername?: string }>, now: number) {
    const live: typeof invites = {}
    for (const [tok, inv] of Object.entries(invites)) {
      if (inv.expiresAt > now) live[tok] = inv
    }
    let access: Record<string, unknown>
    try { access = JSON.parse(readFileOr(accessPath, '{}')) } catch { access = {} }
    access.invites = live
    mkdirSync(join(accessPath, '..'), { recursive: true })
    atomicWriteFileSync(accessPath, JSON.stringify(access, null, 2))
    return live
  }
  function inviteDeepLink(botUsername: string | undefined, token: string): string | null {
    return botUsername ? `https://t.me/${botUsername}?start=${token}` : null
  }

  // GET /api/agents/:name/channels/:provider/invites -- list active invites.
  const invitesListMatch = matchChannelRoute(path, '/invites')
  if (invitesListMatch && method === 'GET') {
    const [name, provider] = invitesListMatch
    if (name !== MAIN_AGENT_ID && !existsSync(agentDir(name))) { json(res, { error: 'Agent not found' }, 404); return true }
    if (provider !== 'telegram') { json(res, []); return true }
    const accessPath = resolveAccessPath(name, provider)
    const now = Date.now()
    const live = pruneAndWriteInvites(accessPath, readInvites(accessPath), now)
    const items = Object.entries(live).map(([token, inv]) => ({
      token,
      deepLink: inviteDeepLink(inv.botUsername, token),
      expiresAt: inv.expiresAt,
      used: false,
    }))
    json(res, items)
    return true
  }

  // POST /api/agents/:name/channels/:provider/invites -- mint an invite.
  if (invitesListMatch && method === 'POST') {
    const [name, provider] = invitesListMatch
    if (name !== MAIN_AGENT_ID && !existsSync(agentDir(name))) { json(res, { error: 'Agent not found' }, 404); return true }
    if (provider !== 'telegram') { json(res, { error: 'Meghívó linkek csak Telegramnál támogatottak' }, 400); return true }
    const stateDir = name === MAIN_AGENT_ID ? channelStateDir(provider) : channelStateDir(provider, agentDir(name))
    const token = readChannelToken(provider, join(stateDir, '.env')) || parseTelegramToken(name)
    if (!token) { json(res, { error: 'Telegram nincs konfigurálva ehhez az ágenshez' }, 404); return true }
    // Resolve the bot username so the deep link is clickable. Best-effort: if
    // the API call fails the invite is still created (deepLink null, UI shows
    // "(bot username nélkül)").
    const validation = await validateTelegramToken(token)
    const inviteToken = randomBytes(8).toString('hex')
    const now = Date.now()
    const accessPath = resolveAccessPath(name, provider)
    const invites = readInvites(accessPath)
    invites[inviteToken] = { createdAt: now, expiresAt: now + INVITE_TTL_MS, botUsername: validation.botUsername }
    pruneAndWriteInvites(accessPath, invites, now)
    logger.info({ name, provider, inviteToken }, 'Channel invite link created')
    json(res, { token: inviteToken, deepLink: inviteDeepLink(validation.botUsername, inviteToken), expiresAt: now + INVITE_TTL_MS })
    return true
  }

  // DELETE /api/agents/:name/channels/:provider/invites/:token -- revoke.
  const inviteRevokeMatch = path.match(/^\/api\/agents\/([^/]+)\/channels\/(telegram|discord)\/invites\/(.+)$/)
  if (inviteRevokeMatch && method === 'DELETE') {
    const name = decodeURIComponent(inviteRevokeMatch[1])
    const provider = inviteRevokeMatch[2] as ChannelProviderType
    const revokeToken = decodeURIComponent(inviteRevokeMatch[3])
    if (name !== MAIN_AGENT_ID && !existsSync(agentDir(name))) { json(res, { error: 'Agent not found' }, 404); return true }
    const accessPath = resolveAccessPath(name, provider)
    const invites = readInvites(accessPath)
    delete invites[revokeToken]
    pruneAndWriteInvites(accessPath, invites, Date.now())
    json(res, { ok: true })
    return true
  }

  // GET /api/agents/:name/channels/:provider/allowed (legacy: /telegram/allowed)
  const allowedListMatch = matchChannelRoute(path, '/allowed')
  if (allowedListMatch && method === 'GET') {
    const [name, provider] = allowedListMatch
    if (name !== MAIN_AGENT_ID && !existsSync(agentDir(name))) {
      json(res, { error: 'Agent not found' }, 404)
      return true
    }
    const accessPath = resolveAccessPath(name, provider)
    const accessContent = readFileOr(accessPath, '{}')
    try {
      const access = JSON.parse(accessContent)
      const users: string[] = Array.isArray(access.allowFrom) ? access.allowFrom : []
      const groups = Object.entries(access.groups || {}).map(([id, policy]) => ({ id, policy }))
      json(res, { users, groups })
    } catch {
      json(res, { users: [], groups: [] })
    }
    return true
  }

  // DELETE /api/agents/:name/channels/:provider/allowed/:type/:id (legacy: /telegram/allowed/:type/:id)
  const allowedRemoveNewMatch = path.match(/^\/api\/agents\/([^/]+)\/channels\/(telegram|discord)\/allowed\/(user|group)\/(.+)$/)
  const allowedRemoveLegacyMatch = path.match(/^\/api\/agents\/([^/]+)\/telegram\/allowed\/(user|group)\/(.+)$/)
  const allowedRemoveMatch = allowedRemoveNewMatch
    ? { name: decodeURIComponent(allowedRemoveNewMatch[1]), provider: allowedRemoveNewMatch[2] as ChannelProviderType, kind: allowedRemoveNewMatch[3], id: decodeURIComponent(allowedRemoveNewMatch[4]) }
    : allowedRemoveLegacyMatch
      ? { name: decodeURIComponent(allowedRemoveLegacyMatch[1]), provider: 'telegram' as ChannelProviderType, kind: allowedRemoveLegacyMatch[2], id: decodeURIComponent(allowedRemoveLegacyMatch[3]) }
      : null
  if (allowedRemoveMatch && method === 'DELETE') {
    const { name, provider, kind, id } = allowedRemoveMatch
    if (name !== MAIN_AGENT_ID && !existsSync(agentDir(name))) {
      json(res, { error: 'Agent not found' }, 404)
      return true
    }
    const chDir = name === MAIN_AGENT_ID
      ? channelStateDir(provider)
      : channelStateDir(provider, agentDir(name))
    const accessPath = join(chDir, 'access.json')
    try {
      const access = JSON.parse(readFileOr(accessPath, '{}'))
      if (kind === 'user') {
        access.allowFrom = (access.allowFrom || []).filter((s: string) => s !== id)
        const approvedFile = join(chDir, 'approved', id)
        try { if (existsSync(approvedFile)) unlinkSync(approvedFile) } catch { /* ignore */ }
      } else {
        if (access.groups) delete access.groups[id]
      }
      atomicWriteFileSync(accessPath, JSON.stringify(access, null, 2))
      logger.info({ name, provider, kind, id }, 'Channel allowlist entry removed')
      json(res, { ok: true })
    } catch (err) {
      logger.error({ err }, 'Failed to remove allowlist entry')
      json(res, { error: 'Failed to remove allowlist entry' }, 500)
    }
    return true
  }

  // POST /api/agents/:name/auth/init -- trigger /login in the agent's tmux,
  // wait a few seconds for the auth URL to appear, then scrape it back.
  const authInitMatch = path.match(/^\/api\/agents\/([^/]+)\/auth\/init$/)
  if (authInitMatch && method === 'POST') {
    const name = decodeURIComponent(authInitMatch[1])
    if (!existsSync(agentDir(name))) { json(res, { error: 'Agent not found' }, 404); return true }
    if (!isAgentRunning(name)) { json(res, { error: 'Agent is not running' }, 400); return true }
    const session = agentSessionName(name)
    try {
      sendPromptToSession(session, '/login')
      // Wait for Claude Code to render the auth URL (typically 3-6s)
      let authUrl: string | null = null
      for (let i = 0; i < 12; i++) {
        execSync('sleep 1', { timeout: 3000 })
        const pane = capturePane(session)
        if (!pane) continue
        const urlMatch = pane.match(/https:\/\/console\.anthropic\.com\/[^\s"']+/)
          || pane.match(/https:\/\/auth\.anthropic\.com\/[^\s"']+/)
          || pane.match(/https:\/\/claude\.ai\/[^\s"']+login[^\s"']*/)
        if (urlMatch) {
          authUrl = urlMatch[0]
          break
        }
      }
      if (authUrl) {
        json(res, { ok: true, authUrl })
      } else {
        json(res, { ok: false, error: 'Auth URL nem jelent meg 12 masodpercen belul. Probald ujra, vagy nezd a tmux session-t.' })
      }
    } catch (err) {
      logger.error({ err, name }, 'Auth init failed')
      json(res, { error: 'Auth flow indítása sikertelen' }, 500)
    }
    return true
  }

  const startMatch = path.match(/^\/api\/agents\/([^/]+)\/start$/)
  if (startMatch && method === 'POST') {
    const name = decodeURIComponent(startMatch[1])
    if (!existsSync(agentDir(name))) { json(res, { error: 'Agent not found' }, 404); return true }
    const result = startAgentProcess(name)
    // Record operator intent so the monitor keeps this agent up across shared
    // tmux-server restarts / reboots (see agent-desired-state.ts).
    if (result.ok || result.error === 'Agent is already running') addDesiredAgent(name)
    if (result.ok) { json(res, { ok: true }); return true }
    json(res, { error: result.error }, 400)
    return true
  }

  const stopMatch = path.match(/^\/api\/agents\/([^/]+)\/stop$/)
  if (stopMatch && method === 'POST') {
    const name = decodeURIComponent(stopMatch[1])
    const result = stopAgentProcess(name)
    // Explicit stop clears intent so the monitor will not resurrect it.
    removeDesiredAgent(name)
    if (result.ok) { json(res, { ok: true }); return true }
    json(res, { error: result.error }, 400)
    return true
  }

  // POST /api/agents/:name/reap -- operator-triggered teardown of an agent
  // (handoff -> stop -> archive -> drop scheduled tasks). Refuses base-roster
  // agents inside reapAgent().
  const reapMatch = path.match(/^\/api\/agents\/([^/]+)\/reap$/)
  if (reapMatch && method === 'POST') {
    const name = decodeURIComponent(reapMatch[1])
    let reason = 'operator-triggered'
    try {
      const body = await readBody(req)
      const d = JSON.parse(body.toString() || '{}') as { reason?: string }
      if (typeof d.reason === 'string' && d.reason.trim()) reason = d.reason.trim()
    } catch { /* no/garbled body -- default reason */ }
    const result = reapAgent(name, reason)
    removeDesiredAgent(name)
    if (result.ok) { json(res, { ok: true, handoffPath: result.handoffPath }); return true }
    json(res, { error: result.error }, 400)
    return true
  }

  const restartMatch = path.match(/^\/api\/agents\/([^/]+)\/restart$/)
  if (restartMatch && method === 'POST') {
    const name = decodeURIComponent(restartMatch[1])
    // The main agent runs in the systemd/launchd-managed `<id>-channels` session,
    // not the `agent-<name>` template. Restart it through the channels helper --
    // the agent-process path would spawn a rogue duplicate session and fire
    // `/remote-control` (needs a full-scope login token the agent lacks). Mirror
    // the precedent in the channels-config handler above. Sub-agents unchanged.
    if (isMainChannelsAgent(name)) {
      const r = hardRestartNexusChannels()
      if (r.ok) { json(res, { ok: true }); return true }
      json(res, { error: r.error || 'Restart failed' }, 500)
      return true
    }
    if (!existsSync(agentDir(name))) { json(res, { error: 'Agent not found' }, 404); return true }
    const result = restartAgentProcess(name)
    if (result.ok) { json(res, { ok: true }); return true }
    json(res, { error: result.error }, 400)
    return true
  }

  const statusMatch = path.match(/^\/api\/agents\/([^/]+)\/status$/)
  if (statusMatch && method === 'GET') {
    const name = decodeURIComponent(statusMatch[1])
    if (!existsSync(agentDir(name))) { json(res, { error: 'Agent not found' }, 404); return true }
    json(res, getAgentProcessInfo(name))
    return true
  }

  const agentMatch = path.match(/^\/api\/agents\/([^/]+)$/)
  if (agentMatch && method === 'GET') {
    const name = decodeURIComponent(agentMatch[1])
    if (!isKnownAgent(name)) { json(res, { error: 'Agent not found' }, 404); return true }
    json(res, getAgentDetail(name))
    return true
  }

  if (agentMatch && method === 'PUT') {
    const name = decodeURIComponent(agentMatch[1])
    if (!isKnownAgent(name)) { json(res, { error: 'Agent not found' }, 404); return true }
    const body = await readBody(req)
    const configRoot = agentConfigRoot(name)
    const data = JSON.parse(body.toString()) as {
      claudeMd?: string; soulMd?: string; mcpJson?: string; model?: string
      authMode?: AuthMode; apiKey?: string
    }
    if (data.claudeMd !== undefined) atomicWriteFileSync(join(configRoot, 'CLAUDE.md'), data.claudeMd)
    if (data.soulMd !== undefined) atomicWriteFileSync(join(agentDir(name), 'SOUL.md'), data.soulMd)
    if (data.mcpJson !== undefined) atomicWriteFileSync(join(agentDir(name), '.mcp.json'), data.mcpJson)
    if (data.model !== undefined) writeAgentModel(name, data.model)
    if (data.authMode !== undefined) {
      writeAgentAuthMode(name, data.authMode)
      if (data.authMode === 'api' && typeof data.apiKey === 'string' && data.apiKey.trim()) {
        setSecret(`agent-${name}-api-key`, `API key for agent ${name}`, data.apiKey.trim())
      }
      if (data.authMode !== 'api') {
        deleteSecret(`agent-${name}-api-key`)
      }
    }
    json(res, { ok: true })
    return true
  }

  if (agentMatch && method === 'DELETE') {
    const name = decodeURIComponent(agentMatch[1])
    const dir = agentDir(name)
    if (!existsSync(dir)) { json(res, { error: 'Agent not found' }, 404); return true }
    rmSync(dir, { recursive: true, force: true })
    cleanupTeamReferences(name)
    json(res, { ok: true })
    return true
  }

  return false
}
