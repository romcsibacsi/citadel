import https from 'node:https'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { logger } from './logger.js'
import { formatForTelegram, splitMessage } from './format.js'

export type ChannelProviderType = 'telegram' | 'discord'

export interface ChannelProvider {
  readonly type: ChannelProviderType
  readonly pluginId: string
  readonly pluginPaneId: string
  readonly envKeys: string[]
  readonly stateDir: string
  readonly chatIdFormat: string
  sendMessage(token: string, chatId: string, text: string, parseMode?: string): Promise<void>
  sendPhoto(token: string, chatId: string, photoPath: string, caption: string): Promise<void>
  validateToken(token: string): Promise<{ ok: boolean; botName?: string; error?: string }>
  formatMessage(text: string): string
  splitMessage(text: string): string[]
}

// -- Telegram implementation --

function telegramHttpPost(token: string, method: string, body: string, contentType: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      `https://api.telegram.org/bot${token}/${method}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': contentType,
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        res.resume()
        if (res.statusCode === 200) {
          resolve()
        } else {
          reject(new Error(`Telegram API ${res.statusCode}`))
        }
      }
    )
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

const telegramProvider: ChannelProvider = {
  type: 'telegram',
  pluginId: 'telegram@claude-plugins-official',
  pluginPaneId: 'plugin:telegram:telegram',
  envKeys: ['TELEGRAM_BOT_TOKEN'],
  stateDir: 'telegram',
  chatIdFormat: 'numeric (e.g. 1268077055)',

  async sendMessage(token, chatId, text, parseMode) {
    const payload: Record<string, string> = { chat_id: chatId, text }
    if (parseMode) payload.parse_mode = parseMode
    const body = JSON.stringify(payload)
    await telegramHttpPost(token, 'sendMessage', body, 'application/json')
  },

  async sendPhoto(token, chatId, photoPath, caption) {
    const fileData = readFileSync(photoPath)
    const boundary = '----FormBoundary' + Date.now()
    const parts: Buffer[] = []
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`))
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`))
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="avatar.png"\r\nContent-Type: image/png\r\n\r\n`))
    parts.push(fileData)
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`))
    const body = Buffer.concat(parts)
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
    })
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new Error(`Telegram sendPhoto ${resp.status}: ${text.slice(0, 200)}`)
    }
  },

  async validateToken(token) {
    try {
      const resp = await fetch(`https://api.telegram.org/bot${token}/getMe`)
      const data = await resp.json() as { ok: boolean; result?: { username: string; id: number } }
      if (data.ok && data.result) {
        return { ok: true, botName: data.result.username }
      }
      return { ok: false, error: 'Invalid bot token' }
    } catch {
      return { ok: false, error: 'Failed to connect to Telegram API' }
    }
  },

  formatMessage: formatForTelegram,
  splitMessage: (text) => splitMessage(text),
}

// -- Discord implementation --

const DISCORD_MAX_MESSAGE_LENGTH = 2000

function formatForDiscord(text: string): string {
  // Discord natively renders GFM markdown (bold, italic, code blocks, links).
  // Only convert task-list checkboxes which Discord does not support.
  let result = text
  result = result.replace(/^- \[ \]/gm, '☐')
  result = result.replace(/^- \[x\]/gm, '☑')
  return result
}

const discordProvider: ChannelProvider = {
  type: 'discord',
  pluginId: 'discord@claude-plugins-official',
  pluginPaneId: 'plugin:discord:discord',
  envKeys: ['DISCORD_BOT_TOKEN'],
  stateDir: 'discord',
  chatIdFormat: 'Discord channel ID (e.g. 1234567890123456789)',

  async sendMessage(token, chatId, text) {
    const resp = await fetch(`https://discord.com/api/v10/channels/${chatId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bot ${token}`,
      },
      body: JSON.stringify({ content: text }),
    })
    if (!resp.ok) {
      const body = await resp.text().catch(() => '')
      throw new Error(`Discord API ${resp.status}: ${body.slice(0, 200)}`)
    }
  },

  async sendPhoto(token, chatId, photoPath, caption) {
    const fileData = readFileSync(photoPath)
    const filename = photoPath.split('/').pop() || 'image.png'
    const boundary = '----FormBoundary' + Date.now()
    const parts: Buffer[] = []
    const payloadJson = JSON.stringify({
      content: caption || undefined,
      attachments: [{ id: '0', filename }],
    })
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="payload_json"\r\nContent-Type: application/json\r\n\r\n${payloadJson}\r\n`))
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files[0]"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`))
    parts.push(fileData)
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`))
    const body = Buffer.concat(parts)
    const resp = await fetch(`https://discord.com/api/v10/channels/${chatId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Authorization': `Bot ${token}`,
      },
      body,
    })
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new Error(`Discord sendPhoto ${resp.status}: ${text.slice(0, 200)}`)
    }
  },

  async validateToken(token) {
    try {
      const resp = await fetch('https://discord.com/api/v10/users/@me', {
        headers: { 'Authorization': `Bot ${token}` },
      })
      const data = await resp.json() as { id?: string; username?: string }
      if (resp.ok && data.username) {
        return { ok: true, botName: data.username }
      }
      return { ok: false, error: 'Invalid bot token' }
    } catch {
      return { ok: false, error: 'Failed to connect to Discord API' }
    }
  },

  formatMessage: formatForDiscord,
  splitMessage: (text) => splitMessage(text, DISCORD_MAX_MESSAGE_LENGTH),
}

// -- Token resolution --

export function getChannelToken(provider: ChannelProviderType, env: Record<string, string>): string {
  if (provider === 'discord') return env['DISCORD_BOT_TOKEN'] ?? ''
  return env['TELEGRAM_BOT_TOKEN'] ?? ''
}

export function getChannelChatId(provider: ChannelProviderType, env: Record<string, string>): string {
  if (provider === 'discord') return env['DISCORD_CHANNEL_ID'] ?? ''
  return env['ALLOWED_CHAT_ID'] ?? ''
}

// -- Provider registry --

const providers: Record<ChannelProviderType, ChannelProvider> = {
  telegram: telegramProvider,
  discord: discordProvider,
}

export function getProvider(type: ChannelProviderType): ChannelProvider {
  return providers[type]
}

export function getProviderType(envValue: string | undefined): ChannelProviderType {
  if (envValue === 'discord') return 'discord'
  return 'telegram'
}

export function channelStateDir(provider: ChannelProviderType, agentDir?: string): string {
  const base = agentDir
    ? join(agentDir, '.claude', 'channels')
    : join(homedir(), '.claude', 'channels')
  const subdir = provider === 'discord' ? 'discord' : 'telegram'
  return join(base, subdir)
}

export function readChannelToken(provider: ChannelProviderType, envFilePath: string): string | null {
  if (!existsSync(envFilePath)) return null
  let content: string
  try {
    content = readFileSync(envFilePath, 'utf-8')
  } catch {
    return null
  }
  const key = provider === 'discord' ? 'DISCORD_BOT_TOKEN' : 'TELEGRAM_BOT_TOKEN'
  const match = content.match(new RegExp(`${key}=(.+)`))
  return match ? match[1].trim() : null
}
