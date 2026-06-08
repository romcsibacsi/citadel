import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'

// Resolved lazily (per call), not at module load, so PROJECT_ROOT can be
// overridden in tests and we never cache a stale path.
function envPath(): string { return join(PROJECT_ROOT, '.env') }

// A value needs quoting in .env when it contains whitespace, '#', or quotes.
// We use double quotes and escape any embedded double quote / backslash so the
// readEnvFile parser (which strips a single matched surrounding quote pair)
// round-trips it. Tokens (ghp_..., xoxb-...) never need quoting, but be safe.
function formatEnvValue(value: string): string {
  if (/^[A-Za-z0-9_./:@+-]*$/.test(value)) return value
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * Upsert one or more KEY=value pairs in the project .env, preserving every
 * other line (comments, blanks, ordering). Existing keys are replaced in place;
 * new keys are appended. Atomic write, mode 0600 (the file holds plaintext
 * tokens, same as the channel tokens already there).
 *
 * An empty-string value REMOVES the key's line (so "clear a secret" works).
 */
export function upsertEnvVars(updates: Record<string, string>): void {
  const keys = Object.keys(updates)
  if (keys.length === 0) return

  const original = existsSync(envPath()) ? readFileSync(envPath(), 'utf-8') : ''
  const lines = original.length ? original.split('\n') : []
  const seen = new Set<string>()

  const out: string[] = []
  for (const line of lines) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/)
    if (m && Object.prototype.hasOwnProperty.call(updates, m[1])) {
      const key = m[1]
      seen.add(key)
      const val = updates[key]
      if (val === '') continue // removal: drop the line
      out.push(`${key}=${formatEnvValue(val)}`)
    } else {
      out.push(line)
    }
  }
  // Append keys not already present.
  for (const key of keys) {
    if (seen.has(key)) continue
    if (updates[key] === '') continue
    out.push(`${key}=${formatEnvValue(updates[key])}`)
  }

  let content = out.join('\n')
  if (!content.endsWith('\n')) content += '\n'
  atomicWriteFileSync(envPath(), content, { mode: 0o600 })
}

/** Read a single key's current value straight from .env (live, not the
 *  process-start config snapshot). Returns '' if absent. */
export function readEnvVar(key: string): string {
  if (!existsSync(envPath())) return ''
  for (const line of readFileSync(envPath(), 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/)
    if (m && m[1] === key) {
      let v = m[2].trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
      }
      return v
    }
  }
  return ''
}
