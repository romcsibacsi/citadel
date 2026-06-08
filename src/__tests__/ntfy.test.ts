import { describe, it, expect } from 'vitest'
import { buildNtfyRequest, isNtfyEnabled, type NtfyConfig } from '../ntfy.js'

const cfg = (over: Partial<NtfyConfig> = {}): NtfyConfig => ({
  url: 'https://ntfy.example.com',
  topic: 'citadel-alerts',
  token: '',
  priority: '',
  ...over,
})

describe('buildNtfyRequest', () => {
  it('returns null when not configured (no url or topic)', () => {
    expect(buildNtfyRequest('hi', {}, cfg({ url: '' }))).toBeNull()
    expect(buildNtfyRequest('hi', {}, cfg({ topic: '' }))).toBeNull()
  })

  it('builds the topic URL and POST body', () => {
    const req = buildNtfyRequest('task done', {}, cfg())
    expect(req).not.toBeNull()
    expect(req!.url).toBe('https://ntfy.example.com/citadel-alerts')
    expect(req!.init.method).toBe('POST')
    expect(req!.init.body).toBe('task done')
  })

  it('maps options to ntfy headers', () => {
    const req = buildNtfyRequest('msg', {
      title: 'Heartbeat',
      priority: 'high',
      tags: ['warning', 'robot'],
      click: 'https://citadel.local/',
    }, cfg())
    const h = req!.init.headers
    expect(h['Title']).toBe('Heartbeat')
    expect(h['Priority']).toBe('high')
    expect(h['Tags']).toBe('warning,robot')
    expect(h['Click']).toBe('https://citadel.local/')
  })

  it('falls back to the config default priority', () => {
    const req = buildNtfyRequest('msg', {}, cfg({ priority: 'low' }))
    expect(req!.init.headers['Priority']).toBe('low')
    // explicit option overrides the default
    const req2 = buildNtfyRequest('msg', { priority: 'urgent' }, cfg({ priority: 'low' }))
    expect(req2!.init.headers['Priority']).toBe('urgent')
  })

  it('adds bearer auth only when a token is set', () => {
    expect(buildNtfyRequest('m', {}, cfg())!.init.headers['Authorization']).toBeUndefined()
    expect(buildNtfyRequest('m', {}, cfg({ token: 'tk_secret' }))!.init.headers['Authorization'])
      .toBe('Bearer tk_secret')
  })

  it('strips CR/LF from header values (no header injection)', () => {
    const req = buildNtfyRequest('body', { title: 'evil\r\nX-Injected: 1' }, cfg())
    expect(req!.init.headers['Title']).toBe('evil X-Injected: 1')
    expect(req!.init.headers['Title']).not.toMatch(/[\r\n]/)
  })
})

describe('isNtfyEnabled', () => {
  it('requires both url and topic', () => {
    expect(isNtfyEnabled(cfg())).toBe(true)
    expect(isNtfyEnabled(cfg({ url: '' }))).toBe(false)
    expect(isNtfyEnabled(cfg({ topic: '' }))).toBe(false)
  })
})
