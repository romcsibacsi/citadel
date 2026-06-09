import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { OLLAMA_URL } from '../config.js'
import { getSystemSetting } from '../web/system-settings.js'
import { comfyStatus, ComfyError } from './comfy-client.js'

// Free GPU VRAM before a (large) ComfyUI generation by evicting any loaded
// ollama models. The 5090's 32GB is shared by the agent brain and the gen
// models; a big brain (e.g. a 32B at ~24GB) + SDXL/Wan would OOM and drop the
// card off the bus. Best-effort: failures are ignored. Returns true if it
// evicted anything. Every generate* path calls this first.
export async function freeOllamaVram(): Promise<boolean> {
  // Per-request timeouts so a hung ollama host (same wedge class as the ComfyUI
  // fetches) cannot stall this BEFORE the studio loop's ollamaChat timeout and
  // hang the GPU lock. Best-effort: any failure just returns false and the gen
  // proceeds.
  const EVICT_TIMEOUT_MS = 30_000
  try {
    const base = OLLAMA_URL.replace(/\/+$/, '')
    const res = await fetch(`${base}/api/ps`, { signal: AbortSignal.timeout(EVICT_TIMEOUT_MS) })
    if (!res.ok) return false
    const data = await res.json() as { models?: Array<{ name?: string }> }
    const names = (data.models || []).map(m => m.name).filter((n): n is string => !!n)
    for (const name of names) {
      await fetch(`${base}/api/generate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: name, keep_alive: 0 }),
        signal: AbortSignal.timeout(EVICT_TIMEOUT_MS),
      }).catch(() => {})
    }
    return names.length > 0
  } catch {
    return false
  }
}

// SSH key generated on uplinkserver; its pubkey lives in the WSL user's
// ~/.ssh/authorized_keys. Wake = SSH straight into the WSL Ubuntu sshd (exposed
// on the LAN via WSL2 mirrored networking) and run the idempotent start script.
const SSH_KEY = join(homedir(), '.ssh', 'comfy_wake')
const REMOTE_WAKE = 'bash ~/comfyui-wake.sh'

export interface WakeResult { state: 'already-up' | 'woke' | 'no-ssh'; detail?: string }

function sshTarget(): { target: string; port: string } | null {
  const raw = getSystemSetting('comfy_ssh').trim() // "user@host" or "user@host:port"
  if (!raw) return null
  const m = raw.match(/^(.+@[^:]+)(?::(\d+))?$/)
  if (!m) return null
  return { target: m[1], port: m[2] || '22' }
}

function runSshWake(t: { target: string; port: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('ssh', [
      '-i', SSH_KEY,
      '-p', t.port,
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=10',
      t.target,
      REMOTE_WAKE,
    ], { timeout: 30_000 }, (err, _stdout, stderr) => {
      if (err) reject(new ComfyError(`SSH wake sikertelen (${t.target}): ${stderr?.trim() || err.message}`))
      else resolve()
    })
  })
}

async function isUp(): Promise<boolean> {
  try { await comfyStatus(); return true } catch { return false }
}

/** Ensure ComfyUI is reachable: if down and an SSH target is configured, wake
 *  it and poll until /system_stats answers. Idempotent. */
export async function ensureComfyUp(
  opts: { timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<WakeResult> {
  if (await isUp()) return { state: 'already-up' }

  const t = sshTarget()
  if (!t) {
    throw new ComfyError('A ComfyUI nem fut, és nincs comfy_ssh beállítva az automatikus indításhoz (Vault → Rendszer-integrációk).')
  }

  await runSshWake(t)

  const timeoutMs = opts.timeoutMs ?? 150_000
  const intervalMs = opts.intervalMs ?? 3000
  const sleep = opts.sleep ?? ((ms: number) => new Promise(r => setTimeout(r, ms)))
  const deadline = Date.now() + timeoutMs
  for (;;) {
    await sleep(intervalMs)
    if (await isUp()) return { state: 'woke' }
    if (Date.now() > deadline) {
      throw new ComfyError(`ComfyUI nem jött fel ${Math.round(timeoutMs / 1000)}s alatt a wake után (${t.target}).`)
    }
  }
}

/** Just trigger the wake (for a manual "Wake" button). Does not wait. */
export async function triggerComfyWake(): Promise<WakeResult> {
  if (await isUp()) return { state: 'already-up' }
  const t = sshTarget()
  if (!t) return { state: 'no-ssh' }
  await runSshWake(t)
  return { state: 'woke', detail: 'indítás elküldve, a felállás ~10-60s' }
}
