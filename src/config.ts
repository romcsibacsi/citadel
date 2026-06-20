import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readEnvFile } from './env.js'
import { getProviderType, getChannelToken, getChannelChatId, type ChannelProviderType } from './channel-provider.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

export const PROJECT_ROOT = join(__dirname, '..')
export const STORE_DIR = join(PROJECT_ROOT, 'store')
export const DB_FILENAME = 'citadel.db'
export const PID_FILENAME = 'citadel.pid'

const env = readEnvFile()

export const TELEGRAM_BOT_TOKEN = env['TELEGRAM_BOT_TOKEN'] ?? ''
export const ALLOWED_CHAT_ID = env['ALLOWED_CHAT_ID'] ?? ''

export const OWNER_NAME = env['OWNER_NAME'] ?? ''
export const BOT_NAME = env['BOT_NAME'] ?? 'NEXUS'

// Canonical identifier for the main agent in the DB, tmux sessions, plist
// labels, API routing, etc. The installer derives this from BOT_NAME
// (NFKD + ASCII + lowercase dashes). Older installs without this env var
// fall back to "nexus" so nothing breaks when upgrading in place.
export const MAIN_AGENT_ID = env['MAIN_AGENT_ID'] ?? 'nexus'

// The human operator's principal id for the dashboard chat. Messages FROM this
// id are the operator writing through the (bearer-token-gated) dashboard, so
// the router delivers them reply-expected (an agent should answer, not treat
// them as inert data) -- see message-router + prompt-safety wrapOperator.
// Messages TO this id are terminal: they surface in the dashboard "Te" thread
// and are never routed to a tmux session. This id is reserved: the public
// /api/messages POST rejects it (routes/messages.ts), so a token-holding
// sub-agent cannot trivially forge the operator; the dashboard sends via the
// dedicated /api/operator/message route instead.
export const OPERATOR_AGENT_ID = 'operator'

export const WEB_PORT = parseInt(env['WEB_PORT'] ?? '3420', 10)

// Auto-compact: proactively inject /compact into a heavy-but-idle session before
// its context window fills and the session wedges (halting dispatch when it is the
// hub). Window-relative threshold (fraction of the model's own window) so it works
// across the mixed 1M/200k fleet. See src/auto-compact.ts for the decision logic.
export const AUTO_COMPACT_ENABLED = (env['AUTO_COMPACT_ENABLED'] ?? 'true') !== 'false'
export const AUTO_COMPACT_THRESHOLD_FRACTION = Number(env['AUTO_COMPACT_THRESHOLD_FRACTION'] ?? '0.8')
export const AUTO_COMPACT_INTERVAL_MS = parseInt(env['AUTO_COMPACT_INTERVAL_MS'] ?? '0', 10)
export const AUTO_COMPACT_MIN_INTERVAL_MS = parseInt(env['AUTO_COMPACT_MIN_INTERVAL_MS'] ?? '600000', 10)

export const WEB_HOST = env['WEB_HOST'] ?? '127.0.0.1'
export const DASHBOARD_PUBLIC_URL = env['DASHBOARD_PUBLIC_URL'] ?? ''
export const OLLAMA_URL = env['OLLAMA_URL'] ?? 'http://localhost:11434'

// Update-checker target: the GitHub repo (owner/name) whose default-equivalent
// branch the dashboard polls for "new version available". Empty => auto-detect
// from a github.com remote (a remote named `github` wins, else any github.com
// remote); still empty => update-checking is disabled (no upstream tracking).
// Point this at YOUR OWN mirror, e.g. "romeo/citadel" -- this fork no longer
// follows the original upstream project.
export const UPDATE_GITHUB_REPO = env['UPDATE_GITHUB_REPO'] ?? ''

// Optional GitHub PAT (repo:read) for the update-checker. Required only when
// UPDATE_GITHUB_REPO points at a PRIVATE repo -- unauthenticated GitHub API
// calls 404 on private repos. Empty => unauthenticated (public repos only).
// Lives in .env (gitignored); never committed.
export const GITHUB_TOKEN = env['GITHUB_TOKEN'] ?? ''

export const CHANNEL_PROVIDER: ChannelProviderType = getProviderType(env['CHANNEL_PROVIDER'])
export const CHANNEL_TOKEN = getChannelToken(CHANNEL_PROVIDER, env)
export const CHANNEL_CHAT_ID = getChannelChatId(CHANNEL_PROVIDER, env)

// ntfy one-way push (heartbeat escalations, task completions, alerts).
// Disabled (no-op) unless both NTFY_URL and NTFY_TOPIC are set. Works with
// ntfy.sh or a self-hosted server. NTFY_TOKEN is optional bearer auth.
export const NTFY_URL = (env['NTFY_URL'] ?? '').trim().replace(/\/+$/, '')
export const NTFY_TOPIC = (env['NTFY_TOPIC'] ?? '').trim()
export const NTFY_TOKEN = (env['NTFY_TOKEN'] ?? '').trim()
export const NTFY_PRIORITY = (env['NTFY_PRIORITY'] ?? '').trim()
export const NTFY_ENABLED = NTFY_URL !== '' && NTFY_TOPIC !== ''

// Respawn / keep-alive gate.
// The in-process channel-plugin monitor (main-agent respawn + sub-agent
// auto-restart) must run on exactly ONE machine. When the same checkout runs
// on more than one host (e.g. a dev box alongside the production host), each
// would independently respawn agents and the two would fight over the same bot
// tokens / getUpdates slot. Gate it so only the intended host keeps agents alive.
//   RESPAWN_ENABLED -- "1"/"true" forces on, "0"/"false" forces off
//   RESPAWN_HOST    -- optional substring matched against the OS hostname; when
//                      set, respawn is enabled only on a host whose name matches
// Default (neither set): enabled, so a single-host install needs no config.
const RESPAWN_HOST = (env['RESPAWN_HOST'] ?? '').toLowerCase()
const RESPAWN_OVERRIDE = (env['RESPAWN_ENABLED'] ?? '').toLowerCase()
export const RESPAWN_ENABLED =
  RESPAWN_OVERRIDE === '1' || RESPAWN_OVERRIDE === 'true'
    ? true
    : RESPAWN_OVERRIDE === '0' || RESPAWN_OVERRIDE === 'false'
      ? false
      : RESPAWN_HOST
        ? hostname().toLowerCase().includes(RESPAWN_HOST)
        : true

// Heartbeat
export const HEARTBEAT_INTERVAL_MS = 60 * 60 * 1000 // 1 hour
export const HEARTBEAT_START_HOUR = 9

// Dedicated channel-less `heartbeat` sub-agent (hourly summary worker).
// OFF by default: a fresh or upgrading install must NOT silently spawn a
// sub-agent that reads the operator's calendar and database. Opt in with
// HEARTBEAT_AGENT_ENABLED=1 (it additionally requires the respawn gate
// above, since the heartbeat has to run on exactly one host).
export const HEARTBEAT_AGENT_ENABLED =
  ['1', 'true', 'yes', 'on'].includes((env['HEARTBEAT_AGENT_ENABLED'] ?? '').trim().toLowerCase())

// Google Calendar account the heartbeat summarises (next 2h). Empty (the
// default) means the agent uses whatever calendar its MCP server is
// authenticated as, so no personal address is baked into the shipped
// scaffold.
export const HEARTBEAT_CALENDAR_ACCOUNT = (env['HEARTBEAT_CALENDAR_ACCOUNT'] ?? '').trim()
export const HEARTBEAT_END_HOUR = 23
export const HEARTBEAT_CALENDAR_ID = env['HEARTBEAT_CALENDAR_ID'] ?? ''

// --- Phase 6: hybrid heartbeat triage ---
// Always-on CPU pre-filter that decides whether anything is worth surfacing
// BEFORE the heartbeat escalates to the interactive Claude sub-agent. ON by
// default (only matters when the heartbeat agent itself is enabled). Set to
// 0/false/no/off to preserve the legacy "always escalate" behavior.
export const HEARTBEAT_TRIAGE_ENABLED =
  !['0', 'false', 'no', 'off'].includes((env['HEARTBEAT_TRIAGE_ENABLED'] ?? '').trim().toLowerCase())

// Optional, fallback-first WSL-GPU Ollama boost. Empty URL (the default)
// keeps the boost off and the gate runs heuristic-only. When set, the gate
// asks the model for a second opinion but NEVER blocks on it: any failure
// or timeout falls back to the heuristic decision.
export const HEARTBEAT_TRIAGE_OLLAMA_URL = (env['HEARTBEAT_TRIAGE_OLLAMA_URL'] ?? '').trim().replace(/\/+$/, '')
export const HEARTBEAT_TRIAGE_OLLAMA_MODEL = (env['HEARTBEAT_TRIAGE_OLLAMA_MODEL'] ?? 'llama3.2:1b').trim()
export const HEARTBEAT_TRIAGE_OLLAMA_TIMEOUT_MS = parseInt(env['HEARTBEAT_TRIAGE_OLLAMA_TIMEOUT_MS'] ?? '4000', 10)
