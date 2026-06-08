// Minimal E2E boot harness for the CITADEL dashboard.
//
// This is intentionally NOT the full daemon (src/index.ts). It boots only the
// pieces a browser smoke test needs:
//   1. the SQLite database
//   2. the agents/ base dir
//   3. the 7-agent seed roster
//   4. the web server (which itself starts a handful of poll-based monitors;
//      those stay quiet because .env sets RESPAWN_ENABLED=0 and no channel
//      tokens are configured, so nothing spawns tmux/claude).
//
// Run: tsx scripts/e2e-web.ts   (reads .env at repo root for DASHBOARD_TOKEN etc.)

import { mkdirSync, copyFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readEnvFile } from '../src/env.js'

// dashboard-auth.loadOrCreateDashboardToken() reads process.env.DASHBOARD_TOKEN
// at call time (inside startWebServer), but readEnvFile only populates the
// config module's local copy -- it never writes to process.env. Bridge the
// .env file into process.env so the fixed E2E token is honored.
const fileEnv = readEnvFile()
for (const [k, v] of Object.entries(fileEnv)) {
  if (process.env[k] === undefined) process.env[k] = v
}

import { initDatabase } from '../src/db.js'
import { startWebServer } from '../src/web.js'
import { WEB_PORT } from '../src/config.js'
import { AGENTS_BASE_DIR } from '../src/web/agent-config.js'
import { ensureSeedRoster } from '../src/web/agent-scaffold.js'

initDatabase()
mkdirSync(AGENTS_BASE_DIR, { recursive: true })

// Seed store/ config files the installer normally copies from seed-config/.
// Without them, feature routes (e.g. /api/autonomy) 404 in a bare dev checkout.
const harnessDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(harnessDir, '..')
const seededAutonomy = join(repoRoot, 'store', 'autonomy-config.json')
if (!existsSync(seededAutonomy)) {
  const src = join(repoRoot, 'seed-config', 'autonomy-config.json')
  if (existsSync(src)) {
    copyFileSync(src, seededAutonomy)
    console.error('[e2e-web] seeded store/autonomy-config.json from seed-config')
  }
}

try {
  const seeded = ensureSeedRoster()
  console.error(`[e2e-web] seed roster ensured (${seeded.length} materialized)`)
} catch (err) {
  console.error('[e2e-web] ensureSeedRoster failed:', err)
}

startWebServer(WEB_PORT)
console.error(`[e2e-web] web server starting on 127.0.0.1:${WEB_PORT}`)

// Keep the process alive.
process.stdin.resume()
