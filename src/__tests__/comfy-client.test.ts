import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// getSystemSetting drives the base URL; mock it so no vault/.env is touched.
let SETTINGS: Record<string, string> = {}
vi.mock('../web/system-settings.js', () => ({
  getSystemSetting: (k: string) => SETTINGS[k] ?? '',
}))

import {
  comfyBaseUrl, queuePrompt, listCheckpoints, waitForImages, fetchImage, ComfyError,
} from '../mcp/comfy-client.js'

function jsonRes(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body), arrayBuffer: async () => new ArrayBuffer(0) } as any
}

describe('comfyBaseUrl', () => {
  beforeEach(() => { SETTINGS = {} })

  it('throws a clear error when comfy_url is unset', () => {
    expect(() => comfyBaseUrl()).toThrow(ComfyError)
    expect(() => comfyBaseUrl()).toThrow(/comfy_url|nincs beállítva/i)
  })

  it('strips trailing slashes', () => {
    SETTINGS.comfy_url = 'http://192.168.1.50:8188///'
    expect(comfyBaseUrl()).toBe('http://192.168.1.50:8188')
  })
})

describe('comfy client HTTP', () => {
  beforeEach(() => { SETTINGS = { comfy_url: 'http://gpu:8188' } })
  afterEach(() => vi.unstubAllGlobals())

  it('queuePrompt POSTs to /prompt and returns prompt_id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes({ prompt_id: 'abc-123' }))
    vi.stubGlobal('fetch', fetchMock)
    const id = await queuePrompt({ '4': {} }, 'client-1')
    expect(id).toBe('abc-123')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://gpu:8188/prompt')
    expect(init.method).toBe('POST')
    const body = JSON.parse(init.body)
    expect(body.client_id).toBe('client-1')
    expect(body.prompt).toEqual({ '4': {} })
  })

  it('queuePrompt throws on non-ok with the server text', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRes('bad node', false, 400)))
    await expect(queuePrompt({}, 'c')).rejects.toThrow(/400/)
  })

  it('listCheckpoints parses the /object_info shape', async () => {
    const objInfo = { CheckpointLoaderSimple: { input: { required: { ckpt_name: [['a.safetensors', 'b.safetensors'], {}] } } } }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRes(objInfo)))
    expect(await listCheckpoints()).toEqual(['a.safetensors', 'b.safetensors'])
  })

  it('listCheckpoints returns [] when the shape is empty', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRes({ CheckpointLoaderSimple: { input: { required: {} } } })))
    expect(await listCheckpoints()).toEqual([])
  })

  it('waitForImages polls /history and returns produced images', async () => {
    const pending = jsonRes({}) // history empty on first poll
    const done = jsonRes({ 'pid': { status: { completed: true }, outputs: { '9': { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } } } })
    const fetchMock = vi.fn().mockResolvedValueOnce(pending).mockResolvedValueOnce(done)
    vi.stubGlobal('fetch', fetchMock)
    const imgs = await waitForImages('pid', { intervalMs: 1, sleep: async () => {} })
    expect(imgs).toEqual([{ filename: 'out.png', subfolder: '', type: 'output' }])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('waitForImages throws ComfyError when the run errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRes({ 'pid': { status: { status_str: 'error' }, outputs: {} } })))
    await expect(waitForImages('pid', { sleep: async () => {} })).rejects.toThrow(/hibára/i)
  })

  it('waitForImages times out', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRes({})))
    await expect(waitForImages('pid', { timeoutMs: -1, sleep: async () => {} })).rejects.toThrow(/időtúllépés/i)
  })

  it('fetchImage builds the /view query and returns bytes', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes('', true, 200))
    vi.stubGlobal('fetch', fetchMock)
    const buf = await fetchImage({ filename: 'a b.png', subfolder: 'sub', type: 'output' })
    expect(Buffer.isBuffer(buf)).toBe(true)
    const url = fetchMock.mock.calls[0][0] as string
    expect(url).toContain('/view?')
    expect(url).toContain('filename=a+b.png')
    expect(url).toContain('subfolder=sub')
    expect(url).toContain('type=output')
  })

  it('wraps a network error in ComfyError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    await expect(queuePrompt({}, 'c')).rejects.toThrow(/nem elérhető/i)
  })
})
