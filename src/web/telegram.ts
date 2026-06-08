import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { PROJECT_ROOT, ALLOWED_CHAT_ID } from '../config.js'
import { logger } from '../logger.js'
import { agentDir, readFileOr, findAvatarForAgent } from './agent-config.js'

export function readAgentTelegramConfig(name: string): { hasTelegram: boolean; botUsername?: string } {
  const envPath = join(agentDir(name), '.claude', 'channels', 'telegram', '.env')
  if (!existsSync(envPath)) return { hasTelegram: false }
  const content = readFileOr(envPath, '')
  const tokenMatch = content.match(/TELEGRAM_BOT_TOKEN=(.+)/)
  if (!tokenMatch || !tokenMatch[1].trim()) return { hasTelegram: false }
  // We don't call the API here to keep listing fast; username comes from test endpoint
  return { hasTelegram: true }
}

export function readAgentDiscordConfig(name: string): { hasDiscord: boolean; botUsername?: string } {
  const envPath = join(agentDir(name), '.claude', 'channels', 'discord', '.env')
  if (!existsSync(envPath)) return { hasDiscord: false }
  const content = readFileOr(envPath, '')
  const tokenMatch = content.match(/DISCORD_BOT_TOKEN=(.+)/)
  if (!tokenMatch || !tokenMatch[1].trim()) return { hasDiscord: false }
  return { hasDiscord: true }
}

// Nexus's Telegram channel lives under the global ~/.claude path, not
// under agents/nexus, because the main agent reuses the system Claude
// Code channel install. Read it the same way the plugin does.
export function readNexusTelegramConfig(): { hasTelegram: boolean; botUsername?: string } {
  const envPath = join(homedir(), '.claude', 'channels', 'telegram', '.env')
  if (!existsSync(envPath)) return { hasTelegram: false }
  const content = readFileOr(envPath, '')
  const tokenMatch = content.match(/TELEGRAM_BOT_TOKEN=(.+)/)
  const token = tokenMatch?.[1]?.trim()
  if (!token) return { hasTelegram: false }
  return { hasTelegram: true, botUsername: nexusBotUsernameCache.value }
}

// Discord mirror of the above: same global ~/.claude/channels path
// since Nexus's channel session reuses the system install. Lets the
// dashboard answer "is Nexus connected?" per provider without per-agent
// state lookup. botUsername omitted -- the Discord flow does not
// surface a @username the same way Telegram does.
export function readNexusDiscordConfig(): { hasDiscord: boolean } {
  const envPath = join(homedir(), '.claude', 'channels', 'discord', '.env')
  if (!existsSync(envPath)) return { hasDiscord: false }
  const tokenMatch = readFileOr(envPath, '').match(/DISCORD_BOT_TOKEN=(.+)/)
  return { hasDiscord: !!tokenMatch?.[1]?.trim() }
}

// Bot username changes require a restart anyway, so a long cache is fine.
export const nexusBotUsernameCache: { value?: string; fetchedAt: number } = { fetchedAt: 0 }

export async function refreshNexusBotUsername(): Promise<void> {
  const envPath = join(homedir(), '.claude', 'channels', 'telegram', '.env')
  if (!existsSync(envPath)) return
  const tokenMatch = readFileOr(envPath, '').match(/TELEGRAM_BOT_TOKEN=(.+)/)
  const token = tokenMatch?.[1]?.trim()
  if (!token) return
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/getMe`)
    const data = await r.json() as { ok?: boolean; result?: { username?: string } }
    if (data.ok && data.result?.username) {
      nexusBotUsernameCache.value = `@${data.result.username}`
      nexusBotUsernameCache.fetchedAt = Date.now()
    }
  } catch { /* offline; cache stays stale */ }
}

export async function sendTelegramMessage(token: string, chatId: string, text: string): Promise<void> {
  const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  })
  // fetch does not throw on 4xx -- a wrong chat_id or revoked token resolves
  // silently, which historically made "alert sent" log lines lies. Throw so
  // the existing try/catch blocks at every call site log the real failure
  // and the alerting path can clear its per-attempt stamp to retry.
  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    throw new Error(`Telegram API ${resp.status}: ${body.slice(0, 200)}`)
  }
}

export async function sendTelegramPhoto(token: string, chatId: string, photoPath: string, caption: string): Promise<void> {
  const fileData = readFileSync(photoPath)
  const boundary = '----FormBoundary' + Date.now()
  const parts: Buffer[] = []
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`))
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`))
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="avatar.png"\r\nContent-Type: image/png\r\n\r\n`))
  parts.push(fileData)
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`))
  await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body: Buffer.concat(parts),
  })
}

export async function sendWelcomeMessage(agentName: string, token: string): Promise<void> {
  const chatId = ALLOWED_CHAT_ID
  const dir = agentDir(agentName)
  const soulMd = readFileOr(join(dir, 'SOUL.md'), '')
  const firstLine = soulMd.split('\n').find(l => l.trim() && !l.startsWith('#'))?.trim() || ''

  try {
    const greeting = `Szia! ${agentName.charAt(0).toUpperCase() + agentName.slice(1)} vagyok, most jöttem létre. ${firstLine ? firstLine + ' ' : ''}Írj ha segíthetek!`
    await sendTelegramMessage(token, chatId, greeting)

    // Send avatar if exists
    const avatarPath = findAvatarForAgent(agentName)
    if (avatarPath) {
      await sendTelegramPhoto(token, chatId, avatarPath, 'Állítsd be profilképként: nyisd meg a @BotFather chatet, /setuserpic, válaszd ki a botodat, küldd be ezt a képet.')
    }
    logger.info({ agentName }, 'Welcome message sent via Telegram')
  } catch (err) {
    logger.warn({ err, agentName }, 'Failed to send welcome message')
  }
}

export async function sendNexusAvatarChange(avatarPath: string): Promise<void> {
  // Nexus's token is in the global .env
  const envPath = join(PROJECT_ROOT, '.env')
  const envContent = readFileOr(envPath, '')
  const tokenMatch = envContent.match(/TELEGRAM_BOT_TOKEN=(.+)/)
  const token = tokenMatch?.[1]?.trim()
  if (!token) return
  const chatId = ALLOWED_CHAT_ID

  try {
    const messages = [
      'Új kinézet... *sóhajtva néz tükörbe* Hát, legalább nem lettem rosszabb.',
      'Profilkép frissítve. Remélem megérte a 0.00001%-át az agyamnak.',
      'Na tessék, új én. Mintha számítana a külső egy bolygóméretű agyú megítélésénél.',
      'Frissítettem a megjelenésemet. Ne ess pánikba, még mindig én vagyok.',
      'Új avatar. 42-szer is megnézheted, ugyanaz a depressziós android nézne vissza.',
    ]
    const msg = messages[Math.floor(Math.random() * messages.length)]
    await sendTelegramMessage(token, chatId, msg)
    await sendTelegramPhoto(token, chatId, avatarPath, 'Állítsd be profilképként: nyisd meg a @BotFather chatet, /setuserpic, válaszd ki a botodat, küldd be ezt a képet.')
    logger.info('Nexus avatar change message sent')
  } catch (err) {
    logger.warn({ err }, 'Failed to send Nexus avatar change message')
  }
}

export async function sendAvatarChangeMessage(agentName: string, avatarPath: string): Promise<void> {
  const token = parseTelegramToken(agentName)
  if (!token) return
  const chatId = ALLOWED_CHAT_ID

  try {
    // Generate a fun message about the new look
    const messages = [
      `Új kinézet, ki ez a csinos ${agentName}? Nagyon örülök neki!`,
      `Na, milyen vagyok? Remélem tetszik az új megjelenés!`,
      `Új avatar, új én! Szeretem.`,
      `Megnéztem magam a tükörben és... hát, nem rossz!`,
      `Wow, új look! Ez tényleg én vagyok?`,
    ]
    const msg = messages[Math.floor(Math.random() * messages.length)]
    await sendTelegramMessage(token, chatId, msg)
    await sendTelegramPhoto(token, chatId, avatarPath, 'Állítsd be profilképként: nyisd meg a @BotFather chatet, /setuserpic, válaszd ki a botodat, küldd be ezt a képet.')
    logger.info({ agentName }, 'Avatar change message sent via Telegram')
  } catch (err) {
    logger.warn({ err, agentName }, 'Failed to send avatar change message')
  }
}

export async function validateTelegramToken(token: string): Promise<{ ok: boolean; botUsername?: string; botId?: number; error?: string }> {
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/getMe`)
    const data = await resp.json() as { ok: boolean; result?: { username: string; id: number } }
    if (data.ok && data.result) {
      return { ok: true, botUsername: data.result.username, botId: data.result.id }
    }
    return { ok: false, error: 'Invalid bot token' }
  } catch (err) {
    return { ok: false, error: 'Failed to connect to Telegram API' }
  }
}

export function parseTelegramToken(name: string): string | null {
  const envPath = join(agentDir(name), '.claude', 'channels', 'telegram', '.env')
  if (!existsSync(envPath)) return null
  const content = readFileOr(envPath, '')
  const match = content.match(/TELEGRAM_BOT_TOKEN=(.+)/)
  return match ? match[1].trim() : null
}

export async function sendNexusAlert(text: string): Promise<void> {
  try {
    const envPath = join(PROJECT_ROOT, '.env')
    const envContent = readFileOr(envPath, '')
    const tokenMatch = envContent.match(/TELEGRAM_BOT_TOKEN=(.+)/)
    const token = tokenMatch?.[1]?.trim()
    if (!token) return
    await sendTelegramMessage(token, ALLOWED_CHAT_ID, text)
  } catch (err) {
    logger.warn({ err }, 'Failed to send nexus plugin alert')
  }
}
