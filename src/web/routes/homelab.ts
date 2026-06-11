import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { STORE_DIR } from '../../config.js'
import { getSecret } from '../vault.js'
import { logger } from '../../logger.js'
import { json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

// GET /api/homelab/status (kártya #df4429da) -- the normalized model the Homelab
// status page (PRISM spec, Variant B) consumes. It JOINs the static container->UI
// map (store/homelab-map.json, RELAY maintains) with live status from Uptime Kuma
// /metrics (Prometheus), plus a best-effort `docker ps` for the collapsed internal
// group. 15s cache so a 15s-polling client never hammers Kuma; on a Kuma-fetch
// failure it serves the last good snapshot with source_ok=false (PRISM §5.5: never
// flip everything to unknown on one missed poll -- the UI shows last-known + a
// "stale" badge). The UI is source-independent: it only sees this normalized JSON.

export type HomelabState = 'up' | 'down' | 'restarting' | 'unknown'

export interface HomelabMonitor {
  id: string
  name: string        // the Kuma monitor_name (JOIN key)
  display: string
  group: string       // media|mail|monitoring|web|infra|internal
  status: HomelabState
  has_webui: boolean
  url: string | null  // null when no clickable UI (TCP/port-check) -> non-link
  host: string
  uptime_24h: number | null
  latency_ms: number | null
  description: string | null  // short blurb shown as a hover tooltip (from the map)
}

interface MapEntry { display: string; group: string; webui_url: string | null; port: number; docker_name?: string | null; description?: string | null }
interface HomelabMap {
  _meta?: { status_endpoint?: string; group_order?: string[] }
  monitors: Record<string, MapEntry>
}

export interface HomelabStatus {
  updated_at: number  // unix seconds
  source: string
  source_ok: boolean
  group_order: string[]
  monitors: HomelabMonitor[]
}

const MAP_PATH = join(STORE_DIR, 'homelab-map.json')
const LAN_IP = '192.168.1.105'
const KUMA_UI = `http://${LAN_IP}:8102/`
const CACHE_MS = 15_000
const DEFAULT_GROUP_ORDER = ['media', 'mail', 'monitoring', 'web', 'infra', 'internal']

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in homelab-status.test.ts; no I/O).
// ---------------------------------------------------------------------------

// Parse Uptime Kuma /metrics (Prometheus). Returns the status value and the
// response time keyed by monitor_name.
export function parseKumaMetrics(text: string): { status: Map<string, number>; latency: Map<string, number> } {
  const status = new Map<string, number>()
  const latency = new Map<string, number>()
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^(monitor_status|monitor_response_time)\{([^}]*)\}\s+([0-9.eE+-]+)\s*$/.exec(line)
    if (!m) continue
    const nameM = /monitor_name="((?:[^"\\]|\\.)*)"/.exec(m[2])
    if (!nameM) continue
    const name = nameM[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\')
    const val = Number(m[3])
    if (!Number.isFinite(val)) continue
    if (m[1] === 'monitor_status') status.set(name, val)
    else latency.set(name, val)
  }
  return { status, latency }
}

// Map a Kuma status value to the normalized state. 1=up, 0=down, 2=restarting
// (pending), 3 or missing = unknown.
export function statusFromValue(v: number | undefined): HomelabState {
  if (v === 1) return 'up'
  if (v === 0) return 'down'
  if (v === 2) return 'restarting'
  return 'unknown'
}

export function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

function hostFor(url: string | null, port: number): string {
  if (url) { try { return new URL(url).host } catch { /* fall through */ } }
  return `${LAN_IP}:${port}`
}

// Join the map's user-facing monitors with the parsed Kuma status. When the Kuma
// fetch failed (kumaOk=false) statuses are 'unknown' (callers prefer last-good).
// Adds a synthetic 'Uptime Kuma' monitor (Kuma has no reliable self-monitor) whose
// status is derived from whether the /metrics fetch itself succeeded.
export function buildUserMonitors(
  mapMonitors: Record<string, MapEntry>,
  parsed: { status: Map<string, number>; latency: Map<string, number> },
  kumaOk: boolean,
): HomelabMonitor[] {
  const out: HomelabMonitor[] = []
  for (const [name, e] of Object.entries(mapMonitors)) {
    const lat = parsed.latency.get(name)
    out.push({
      id: slug(name),
      name,
      display: e.display,
      group: e.group,
      status: kumaOk ? statusFromValue(parsed.status.get(name)) : 'unknown',
      has_webui: e.webui_url != null,
      url: e.webui_url,
      host: hostFor(e.webui_url, e.port),
      uptime_24h: null,
      latency_ms: lat != null && Number.isFinite(lat) ? Math.round(lat) : null,
      description: e.description ?? null,
    })
  }
  if (!mapMonitors['Uptime Kuma']) {
    out.push({
      id: 'uptime-kuma', name: 'Uptime Kuma', display: 'Uptime Kuma', group: 'monitoring',
      status: kumaOk ? 'up' : 'down', has_webui: true, url: KUMA_UI, host: `${LAN_IP}:8102`,
      uptime_24h: null, latency_ms: null, description: null,
    })
  }
  return out
}

export function dockerStateToStatus(state: string): HomelabState {
  const s = (state || '').toLowerCase()
  if (s === 'running') return 'up'
  if (s === 'restarting') return 'restarting'
  if (s === 'exited' || s === 'dead' || s === 'created') return 'down'
  return 'unknown'
}

// Tokens (>=3 chars) from the map display names -- used to best-effort exclude a
// user-facing container from the collapsed internal list (so it is not listed twice).
export function userFacingTokens(mapMonitors: Record<string, MapEntry>): Set<string> {
  const t = new Set<string>()
  for (const e of Object.values(mapMonitors)) {
    for (const w of e.display.toLowerCase().split(/[^a-z0-9]+/)) {
      if (w.length >= 3) t.add(w)
    }
  }
  return t
}

// Exact docker-container names the map associates with a user-facing monitor
// (RELAY's optional docker_name field). When present this gives a PRECISE internal
// dedup (docker ps minus the 31 docker_names); empty when the map predates the
// field, in which case the caller falls back to the fuzzy token match above.
export function mappedDockerNames(mapMonitors: Record<string, MapEntry>): Set<string> {
  const s = new Set<string>()
  for (const e of Object.values(mapMonitors)) {
    if (e.docker_name) s.add(String(e.docker_name).toLowerCase())
  }
  return s
}

// ---------------------------------------------------------------------------
// I/O + cache.
// ---------------------------------------------------------------------------

let mapCache: { at: number; data: HomelabMap } | null = null
function loadMap(): HomelabMap {
  // Re-read at most once a minute; the map is a small, rarely-changed config.
  if (mapCache && Date.now() - mapCache.at < 60_000) return mapCache.data
  const data = JSON.parse(readFileSync(MAP_PATH, 'utf-8')) as HomelabMap
  mapCache = { at: Date.now(), data }
  return data
}

async function fetchKuma(endpoint: string): Promise<string | null> {
  const key = getSecret('Api') ?? ''
  try {
    const res = await fetch(endpoint, {
      signal: AbortSignal.timeout(8000),
      headers: { Authorization: 'Basic ' + Buffer.from(':' + key).toString('base64') },
    })
    if (!res.ok) return null
    return await res.text()
  } catch {
    return null
  }
}

function dockerInternal(mapMonitors: Record<string, MapEntry>): HomelabMonitor[] {
  let out: string
  try {
    out = execFileSync('docker', ['ps', '-a', '--format', '{{.Names}}\t{{.State}}\t{{.Status}}'],
      { timeout: 4000, encoding: 'utf-8' })
  } catch {
    return []  // docker unavailable / no perms -> simply no internal group
  }
  // Precise dedup when the map carries docker_name (RELAY); else fuzzy token match.
  const dockerNames = mappedDockerNames(mapMonitors)
  const tokens = dockerNames.size > 0 ? null : userFacingTokens(mapMonitors)
  const monitors: HomelabMonitor[] = []
  for (const line of out.split('\n')) {
    if (!line.trim()) continue
    const [name, state] = line.split('\t')
    if (!name) continue
    const lname = name.toLowerCase()
    if (dockerNames.has(lname)) continue
    if (tokens) {
      let mapped = false
      for (const t of tokens) { if (lname.includes(t)) { mapped = true; break } }
      if (mapped) continue
    }
    monitors.push({
      id: 'internal-' + slug(name), name, display: name, group: 'internal',
      status: dockerStateToStatus(state), has_webui: false, url: null, host: name,
      uptime_24h: null, latency_ms: null, description: null,
    })
  }
  return monitors
}

let cache: { at: number; data: HomelabStatus } | null = null
let lastGood: HomelabStatus | null = null

async function buildStatus(): Promise<HomelabStatus> {
  const map = loadMap()
  const endpoint = map._meta?.status_endpoint ?? `http://${LAN_IP}:8102/metrics`
  const groupOrder = map._meta?.group_order
    ? [...map._meta.group_order, 'internal']
    : DEFAULT_GROUP_ORDER

  const metricsText = await fetchKuma(endpoint)
  const kumaOk = metricsText != null

  if (!kumaOk && lastGood) {
    // PRISM §5.5: a missed poll must not flip everything to unknown. Serve the
    // last good snapshot, marked stale, so the UI keeps the last-known render.
    return { ...lastGood, source_ok: false }
  }

  const parsed = kumaOk ? parseKumaMetrics(metricsText) : { status: new Map(), latency: new Map() }
  const monitors = [
    ...buildUserMonitors(map.monitors, parsed, kumaOk),
    ...dockerInternal(map.monitors),
  ]
  const data: HomelabStatus = {
    updated_at: Math.floor(Date.now() / 1000),
    source: 'uptime-kuma',
    source_ok: kumaOk,
    group_order: groupOrder,
    monitors,
  }
  if (kumaOk) lastGood = data
  return data
}

export async function tryHandleHomelab(ctx: RouteContext): Promise<boolean> {
  const { res, path, method } = ctx
  if (path !== '/api/homelab/status' || method !== 'GET') return false
  try {
    if (cache && Date.now() - cache.at < CACHE_MS) {
      json(res, cache.data)
      return true
    }
    const data = await buildStatus()
    cache = { at: Date.now(), data }
    json(res, data)
  } catch (err) {
    logger.warn({ err }, 'homelab status build failed')
    // Last resort: serve last good if we have it, else a minimal error shape.
    if (lastGood) json(res, { ...lastGood, source_ok: false })
    else json(res, { updated_at: Math.floor(Date.now() / 1000), source: 'uptime-kuma', source_ok: false, group_order: DEFAULT_GROUP_ORDER, monitors: [] })
  }
  return true
}
