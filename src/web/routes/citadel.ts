import { existsSync, unlinkSync, copyFileSync, writeFileSync } from 'node:fs'
import { join, extname } from 'node:path'
import { PROJECT_ROOT, OWNER_NAME, BOT_NAME, MAIN_AGENT_ID, CHANNEL_PROVIDER } from '../../config.js'
import { readNexusTelegramConfig, readNexusDiscordConfig, sendNexusAvatarChange } from '../telegram.js'
import { hardRestartNexusChannels } from '../channel-monitor.js'
import { readFileOr } from '../agent-config.js'
import { parseMultipart } from '../multipart.js'
import { readBody, json, serveFile } from '../http-helpers.js'
import { MAIN_CHANNELS_SESSION } from '../main-agent.js'
import { readActiveModelFromProjectDir, readContextTokensFromProjectDir } from '../active-model.js'
import { readAutoRestartConfig } from '../auto-restart-store.js'
import type { RouteContext } from './types.js'

function getActiveNexusModel(): string {
  return readActiveModelFromProjectDir(PROJECT_ROOT) ?? 'unknown'
}

export async function tryHandleCitadel(ctx: RouteContext, webDir: string): Promise<boolean> {
  const { req, res, path, method } = ctx

  if (path === '/api/nexus' && method === 'GET') {
    const claudeMd = readFileOr(join(PROJECT_ROOT, 'CLAUDE.md'), '')
    const soulMd = readFileOr(join(PROJECT_ROOT, 'SOUL.md'), '')
    const mcpJson = readFileOr(join(PROJECT_ROOT, '.mcp.json'), '')
    const soulSection = claudeMd.match(/## Személyiség\n\n([\s\S]*?)(?=\n## )/)?.[1]?.trim()
      || claudeMd.match(/## Szemelyiseg\n\n([\s\S]*?)(?=\n## )/)?.[1]?.trim()
      || ''
    const firstLine = claudeMd.match(/^Te .+$/m)?.[0]?.trim() || ''
    const descFromPersonality = soulSection.split('\n').filter(l => l.trim()).slice(0, 2).join(' ').slice(0, 200)
    const description = firstLine || descFromPersonality || `${OWNER_NAME} AI asszisztense`
    const tg = readNexusTelegramConfig()
    const dc = readNexusDiscordConfig()
    // Phase 7B: does an explicit operator-uploaded main-agent avatar exist? If
    // not, the dashboard falls back to the NEXUS base-agent portrait/glyph as
    // the default identity (an upload still wins over the base portrait).
    const hasAvatar = ['.png', '.jpg', '.jpeg', '.webp']
      .some((ext) => existsSync(join(PROJECT_ROOT, 'store', `nexus-avatar${ext}`)))
    json(res, {
      name: BOT_NAME,
      // Per-agent UI accent for the framed avatar ring (--ac). NEXUS = cyan.
      accent: '#22d3ee',
      hasAvatar,
      // Canonical agent id (MAIN_AGENT_ID, e.g. "gorcsevivan") so the dashboard
      // can hit /api/agents/<id>/skills for the main agent -- the display name
      // (BOT_NAME) is not a valid agent-dir id.
      agentId: MAIN_AGENT_ID,
      description,
      model: getActiveNexusModel(),
      tmuxSession: MAIN_CHANNELS_SESSION,
      running: true,
      // Auto-restart applies to the main channels session too; key it by the
      // orchestrator id (autoRestartId) so the UI PUTs to the right store entry.
      autoRestart: readAutoRestartConfig(MAIN_AGENT_ID),
      autoRestartId: MAIN_AGENT_ID,
      contextTokens: readContextTokensFromProjectDir(PROJECT_ROOT),
      hasTelegram: tg.hasTelegram,
      hasDiscord: dc.hasDiscord,
      telegramBotUsername: tg.botUsername,
      role: 'main',
      personality: soulSection,
      claudeMd,
      soulMd,
      mcpJson,
      readonly: true,
      // Dashboard kliens defaultja a provider-dropdown-hoz: a backend
      // CHANNEL_PROVIDER env-jébe pinneljük, hogy a UI ne hardcode-olt
      // 'telegram'-mal induljon.
      channelProvider: CHANNEL_PROVIDER,
    })
    return true
  }

  // Intentionally read-only: Nexus's CLAUDE.md / SOUL.md / .mcp.json must be
  // edited from the filesystem or via a Telegram request to Nexus herself,
  // not through the dashboard. A leaked dashboard token would otherwise allow
  // remote identity rewrite of the live agent.
  if (path === '/api/nexus' && method === 'PUT') {
    json(res, { ok: true, readonly: true })
    return true
  }

  if (path === '/api/nexus/restart' && method === 'POST') {
    const result = hardRestartNexusChannels()
    if (!result.ok) { json(res, { error: result.error || 'Restart failed' }, 500); return true }
    json(res, { ok: true })
    return true
  }

  if (path === '/api/nexus/avatar' && method === 'GET') {
    for (const ext of ['.png', '.jpg', '.jpeg', '.webp']) {
      const p = join(PROJECT_ROOT, 'store', `nexus-avatar${ext}`)
      if (existsSync(p)) { serveFile(req, res, p); return true }
    }
    // Default identity = the provided NEXUS portrait (not the old cartoon robot).
    const fallback = join(webDir, 'portraits', 'nexus.png')
    if (existsSync(fallback)) { serveFile(req, res, fallback); return true }
    res.writeHead(404); res.end()
    return true
  }

  if (path === '/api/nexus/avatar' && method === 'POST') {
    const body = await readBody(req)
    const contentType = req.headers['content-type'] || ''

    for (const ext of ['.png', '.jpg', '.jpeg', '.webp']) {
      const p = join(PROJECT_ROOT, 'store', `nexus-avatar${ext}`)
      if (existsSync(p)) unlinkSync(p)
    }

    if (contentType.includes('application/json')) {
      const { galleryAvatar } = JSON.parse(body.toString()) as { galleryAvatar: string }
      if (!galleryAvatar) { json(res, { error: 'No avatar specified' }, 400); return true }
      if (galleryAvatar.includes('..') || galleryAvatar.includes('/') || galleryAvatar.includes('\\')) {
        json(res, { error: 'Invalid avatar name' }, 400)
        return true
      }
      const srcPath = join(webDir, 'avatars', galleryAvatar)
      if (!existsSync(srcPath)) { json(res, { error: 'Avatar not found' }, 404); return true }
      const destPath = join(PROJECT_ROOT, 'store', `nexus-avatar${extname(galleryAvatar) || '.png'}`)
      copyFileSync(srcPath, destPath)
      sendNexusAvatarChange(destPath).catch(() => {})
    } else {
      const { file } = parseMultipart(body, contentType)
      if (!file) { json(res, { error: 'No file uploaded' }, 400); return true }
      const destPath = join(PROJECT_ROOT, 'store', `nexus-avatar${extname(file.name) || '.png'}`)
      writeFileSync(destPath, file.data)
      sendNexusAvatarChange(destPath).catch(() => {})
    }
    json(res, { ok: true })
    return true
  }

  return false
}
