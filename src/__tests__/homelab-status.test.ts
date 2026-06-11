// Pure-function tests for the /api/homelab/status backend (#df4429da): the Kuma
// /metrics parser + the map-join/normalize. The I/O (fetch, docker, cache) is thin
// and verified post-deploy; these pin the normalization the PRISM-spec UI consumes.
import { describe, it, expect } from 'vitest'
import {
  parseKumaMetrics, statusFromValue, buildUserMonitors, dockerStateToStatus,
  userFacingTokens, mappedDockerNames, slug,
} from '../web/routes/homelab.js'

const METRICS = [
  '# HELP monitor_status Monitor Status (1=UP,0=DOWN,2=PENDING,3=MAINTENANCE)',
  '# TYPE monitor_status gauge',
  'monitor_status{monitor_name="Radarr",monitor_type="http"} 1',
  'monitor_status{monitor_name="Sonarr"} 0',
  'monitor_status{monitor_name="Vaultwarden"} 2',
  'monitor_status{monitor_name="Obsidian"} 3',
  'monitor_response_time{monitor_name="Radarr"} 42',
  'monitor_response_time{monitor_name="Sonarr"} 88.7',
  '',
].join('\n')

const MAP = {
  Radarr: { display: 'Radarr', group: 'media', webui_url: 'http://192.168.1.105:7878/', port: 7878 },
  'Mailcow SMTP': { display: 'Mailcow SMTP', group: 'mail', webui_url: null, port: 25 },
} as any

describe('parseKumaMetrics', () => {
  it('parses status + response time keyed by monitor_name', () => {
    const p = parseKumaMetrics(METRICS)
    expect(p.status.get('Radarr')).toBe(1)
    expect(p.status.get('Sonarr')).toBe(0)
    expect(p.status.get('Vaultwarden')).toBe(2)
    expect(p.status.get('Obsidian')).toBe(3)
    expect(p.latency.get('Radarr')).toBe(42)
    expect(p.latency.get('Sonarr')).toBeCloseTo(88.7)
  })
  it('ignores comments and lines without a monitor_name', () => {
    const p = parseKumaMetrics('# c\ngarbage\nmonitor_status{} 1\n')
    expect(p.status.size).toBe(0)
  })
})

describe('statusFromValue', () => {
  it('maps 1/0/2 and treats 3/missing as unknown', () => {
    expect(statusFromValue(1)).toBe('up')
    expect(statusFromValue(0)).toBe('down')
    expect(statusFromValue(2)).toBe('restarting')
    expect(statusFromValue(3)).toBe('unknown')
    expect(statusFromValue(undefined)).toBe('unknown')
  })
})

describe('buildUserMonitors', () => {
  it('joins map + status, flags has_webui, adds synthetic Uptime Kuma', () => {
    const mons = buildUserMonitors(MAP, parseKumaMetrics(METRICS), true)
    const radarr = mons.find((m) => m.name === 'Radarr')!
    expect(radarr.status).toBe('up')
    expect(radarr.has_webui).toBe(true)
    expect(radarr.url).toBe('http://192.168.1.105:7878/')
    expect(radarr.latency_ms).toBe(42)
    const smtp = mons.find((m) => m.name === 'Mailcow SMTP')!
    expect(smtp.has_webui).toBe(false)
    expect(smtp.url).toBeNull()
    expect(smtp.status).toBe('unknown') // not in metrics
    const kuma = mons.find((m) => m.name === 'Uptime Kuma')!
    expect(kuma.group).toBe('monitoring')
    expect(kuma.status).toBe('up')
    expect(kuma.has_webui).toBe(true)
  })
  it('kumaOk=false -> all unknown, synthetic Kuma down', () => {
    const mons = buildUserMonitors(MAP, { status: new Map(), latency: new Map() }, false)
    expect(mons.find((m) => m.name === 'Radarr')!.status).toBe('unknown')
    expect(mons.find((m) => m.name === 'Uptime Kuma')!.status).toBe('down')
  })
})

describe('dockerStateToStatus', () => {
  it('maps docker State to normalized status', () => {
    expect(dockerStateToStatus('running')).toBe('up')
    expect(dockerStateToStatus('restarting')).toBe('restarting')
    expect(dockerStateToStatus('exited')).toBe('down')
    expect(dockerStateToStatus('created')).toBe('down')
    expect(dockerStateToStatus('paused')).toBe('unknown')
  })
})

describe('userFacingTokens / slug', () => {
  it('extracts >=3-char tokens from display names (internal-dedup)', () => {
    const t = userFacingTokens(MAP)
    expect(t.has('radarr')).toBe(true)
    expect(t.has('mailcow')).toBe(true)
    expect(t.has('smtp')).toBe(true)
  })
  it('slug normalizes a monitor name to an id', () => {
    expect(slug('Mailcow SMTP')).toBe('mailcow-smtp')
    expect(slug('Serviio (DLNA)')).toBe('serviio-dlna')
  })
})

describe('mappedDockerNames', () => {
  it('collects lowercased docker_name fields for precise internal dedup', () => {
    const m = {
      Plex: { display: 'Plex', group: 'media', webui_url: null, port: 1, docker_name: 'Plex-Server' },
      NPM: { display: 'NPM', group: 'infra', webui_url: null, port: 2, docker_name: 'nginx-proxy-manager-app-1' },
      Dash: { display: 'Dash', group: 'monitoring', webui_url: null, port: 3, docker_name: null },
    } as any
    const s = mappedDockerNames(m)
    expect(s.has('plex-server')).toBe(true)
    expect(s.has('nginx-proxy-manager-app-1')).toBe(true)
    expect(s.size).toBe(2) // the null docker_name (host node-process) is excluded
  })
  it('is empty when the map predates docker_name (caller uses token fallback)', () => {
    expect(mappedDockerNames(MAP).size).toBe(0)
  })
})
