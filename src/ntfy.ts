import { NTFY_URL, NTFY_TOPIC, NTFY_TOKEN, NTFY_PRIORITY } from './config.js'
import { logger } from './logger.js'

// One-way push notifications via ntfy (https://ntfy.sh or self-hosted).
// Used for heartbeat escalations, task completions, and alerts. Push is a
// no-op unless both NTFY_URL and NTFY_TOPIC are configured.

export type NtfyPriority = 'min' | 'low' | 'default' | 'high' | 'urgent'

export interface NtfyOptions {
  title?: string
  priority?: NtfyPriority
  tags?: string[] // ntfy tags: emoji shortcodes (e.g. "warning") or words
  click?: string // URL opened when the notification is tapped
}

export interface NtfyConfig {
  url: string
  topic: string
  token: string
  priority: string
}

const defaultConfig = (): NtfyConfig => ({
  url: NTFY_URL,
  topic: NTFY_TOPIC,
  token: NTFY_TOKEN,
  priority: NTFY_PRIORITY,
})

// ntfy passes metadata in HTTP headers, which are single-line ASCII. Strip
// CR/LF to prevent header injection and trim surrounding whitespace.
function sanitizeHeader(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim()
}

// Pure builder so the request shape is unit-testable without network I/O.
// Returns null when ntfy is not configured (url/topic missing).
export function buildNtfyRequest(
  message: string,
  opts: NtfyOptions = {},
  cfg: NtfyConfig = defaultConfig(),
): { url: string; init: { method: string; headers: Record<string, string>; body: string } } | null {
  if (!cfg.url || !cfg.topic) return null

  const headers: Record<string, string> = {}
  if (opts.title) headers['Title'] = sanitizeHeader(opts.title)
  const priority = opts.priority ?? cfg.priority
  if (priority) headers['Priority'] = sanitizeHeader(priority)
  if (opts.tags && opts.tags.length > 0) {
    headers['Tags'] = opts.tags.map(sanitizeHeader).filter(Boolean).join(',')
  }
  if (opts.click) headers['Click'] = sanitizeHeader(opts.click)
  if (cfg.token) headers['Authorization'] = `Bearer ${cfg.token}`

  return {
    url: `${cfg.url}/${cfg.topic}`,
    init: { method: 'POST', headers, body: message },
  }
}

export function isNtfyEnabled(cfg: NtfyConfig = defaultConfig()): boolean {
  return Boolean(cfg.url && cfg.topic)
}

// Fire a push. Resolves true on success, false if disabled or on any error
// (push must never throw into the caller's control flow).
export async function pushNtfy(message: string, opts: NtfyOptions = {}): Promise<boolean> {
  const req = buildNtfyRequest(message, opts)
  if (!req) return false
  try {
    const res = await fetch(req.url, req.init)
    if (!res.ok) {
      logger.warn(`ntfy push failed: HTTP ${res.status}`)
      return false
    }
    return true
  } catch (err) {
    logger.warn(`ntfy push error: ${(err as Error).message}`)
    return false
  }
}
