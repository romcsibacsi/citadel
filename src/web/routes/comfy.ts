import { json } from '../http-helpers.js'
import { getSystemSetting } from '../system-settings.js'
import { comfyStatus, listCheckpoints } from '../../mcp/comfy-client.js'
import { triggerComfyWake } from '../../mcp/comfy-wake.js'
import type { RouteContext } from './types.js'

// ComfyUI status + wake for the dashboard indicator. Cheap reachability probe
// + the configured URL/SSH so the UI can show running / down / not-configured.
export async function tryHandleComfy(ctx: RouteContext): Promise<boolean> {
  const { res, path, method } = ctx

  if (path === '/api/comfy/status' && method === 'GET') {
    const url = getSystemSetting('comfy_url').trim()
    const ssh = getSystemSetting('comfy_ssh').trim()
    if (!url) { json(res, { configured: false, reachable: false, url: '', canWake: !!ssh }); return true }
    try {
      const s = await comfyStatus() as any
      let checkpoints: string[] = []
      try { checkpoints = await listCheckpoints() } catch { /* status ok but object_info may differ */ }
      json(res, {
        configured: true,
        reachable: true,
        url,
        canWake: !!ssh,
        version: s?.system?.comfyui_version || '',
        device: s?.devices?.[0]?.name || '',
        checkpoints,
      })
    } catch (err) {
      json(res, { configured: true, reachable: false, url, canWake: !!ssh, error: err instanceof Error ? err.message : String(err) })
    }
    return true
  }

  if (path === '/api/comfy/wake' && method === 'POST') {
    try {
      const r = await triggerComfyWake()
      json(res, { ok: true, ...r })
    } catch (err) {
      json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, 502)
    }
    return true
  }

  return false
}
