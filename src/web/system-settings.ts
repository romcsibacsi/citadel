import { getSecret, setSecret, deleteSecret } from './vault.js'
import { upsertEnvVars, readEnvVar } from './env-writer.js'

// Web-managed system settings (the "Rendszer-integrációk" Vault card). Each
// maps to an env var the backend reads. Secrets are stored encrypted in the
// Vault (canonical) AND mirrored to .env in plaintext (consistent with the
// channel tokens already there) so external processes + a fresh boot see them;
// the backend reads them at RUNTIME via getSystemSetting (vault/.env), so a
// save takes effect without a restart. Non-secret settings live only in .env.
//
// Adding a new web-managed secret/setting = one entry here + (if the backend
// consumes it) a getSystemSetting() read at the use site.
export interface SystemSettingDef {
  key: string          // stable UI/API id
  label: string        // shown in the UI
  description: string
  envVar: string       // the env var it writes to / the vault id (for secrets)
  secret: boolean      // true => encrypted vault + .env mirror; false => .env only
  placeholder?: string
}

export const SYSTEM_SETTINGS: SystemSettingDef[] = [
  {
    key: 'github_repo',
    label: 'GitHub repo (frissítés-forrás)',
    description: 'A saját GitHub-mirrorod, amit a frissítés-figyelő néz. Formátum: tulajdonos/repo, pl. romcsibacsi/citadel.',
    envVar: 'UPDATE_GITHUB_REPO',
    secret: false,
    placeholder: 'romcsibacsi/citadel',
  },
  {
    key: 'github_token',
    label: 'GitHub token (privát repóhoz)',
    description: 'Personal Access Token (repo:read) — csak privát mirrorhoz kell. Titkosítva a Vaultba kerül.',
    envVar: 'GITHUB_TOKEN',
    secret: true,
    placeholder: 'ghp_...',
  },
  {
    key: 'comfy_url',
    label: 'ComfyUI URL (kép-generálás)',
    description: 'A GPU-gépen futó ComfyUI elérhetősége, pl. http://192.168.1.50:8188 — a CREATIVE ügynök ezen át generál képet.',
    envVar: 'COMFY_URL',
    secret: false,
    placeholder: 'http://192.168.1.50:8188',
  },
  {
    key: 'comfy_checkpoint',
    label: 'ComfyUI checkpoint (opcionális)',
    description: 'Alapértelmezett modell-fájl neve (pl. sd_xl_base_1.0.safetensors). Üresen hagyva a ComfyUI első elérhető checkpointját használja.',
    envVar: 'COMFY_CHECKPOINT',
    secret: false,
    placeholder: 'sd_xl_base_1.0.safetensors',
  },
]

export function getSettingDef(key: string): SystemSettingDef | undefined {
  return SYSTEM_SETTINGS.find(s => s.key === key)
}

/** Live value (runtime), preferring the vault (secrets) / .env, with the
 *  process-env as a last resort. Empty string if unset. */
export function getSystemSetting(key: string): string {
  const def = getSettingDef(key)
  if (!def) return ''
  if (def.secret) {
    const v = getSecret(def.envVar)
    if (v !== null && v !== '') return v
  }
  const fromEnvFile = readEnvVar(def.envVar)
  if (fromEnvFile) return fromEnvFile
  return process.env[def.envVar]?.trim() || ''
}

/** Persist a setting from the web UI: secrets -> encrypted vault + .env mirror;
 *  plain -> .env only. An empty value clears it (vault entry + .env line). */
export function setSystemSetting(key: string, value: string): void {
  const def = getSettingDef(key)
  if (!def) throw new Error(`Unknown system setting: ${key}`)
  const trimmed = value.trim()
  if (def.secret) {
    if (trimmed) setSecret(def.envVar, def.label, trimmed)
    else deleteSecret(def.envVar)
  }
  upsertEnvVars({ [def.envVar]: trimmed })
}

/** Schema + redacted current state for the UI (never returns secret values). */
export function listSystemSettings(): Array<SystemSettingDef & { isSet: boolean; preview: string }> {
  return SYSTEM_SETTINGS.map(def => {
    const val = getSystemSetting(def.key)
    const isSet = val !== ''
    // Secrets: never expose the value, just a masked hint. Plain: show as-is.
    const preview = !isSet ? '' : def.secret ? `••••${val.slice(-4)}` : val
    return { ...def, isSet, preview }
  })
}
