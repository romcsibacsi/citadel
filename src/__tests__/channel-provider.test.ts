import { describe, it, expect } from 'vitest'
import {
  getProvider,
  getProviderType,
  getChannelToken,
  getChannelChatId,
  channelStateDir,
  type ChannelProviderType,
} from '../channel-provider.js'

describe('getProviderType', () => {
  it('returns telegram by default', () => {
    expect(getProviderType(undefined)).toBe('telegram')
    expect(getProviderType('')).toBe('telegram')
    expect(getProviderType('anything')).toBe('telegram')
  })

  it('returns discord when explicitly set', () => {
    expect(getProviderType('discord')).toBe('discord')
  })
})

describe('getProvider', () => {
  it('returns telegram provider with correct pluginId', () => {
    const p = getProvider('telegram')
    expect(p.type).toBe('telegram')
    expect(p.pluginId).toBe('telegram@claude-plugins-official')
    expect(p.envKeys).toContain('TELEGRAM_BOT_TOKEN')
    expect(p.stateDir).toBe('telegram')
  })

  it('returns discord provider with correct pluginId', () => {
    const p = getProvider('discord')
    expect(p.type).toBe('discord')
    expect(p.pluginId).toBe('discord@claude-plugins-official')
    expect(p.envKeys).toContain('DISCORD_BOT_TOKEN')
    expect(p.stateDir).toBe('discord')
  })
})

describe('getChannelToken', () => {
  it('reads TELEGRAM_BOT_TOKEN for telegram', () => {
    const env = { TELEGRAM_BOT_TOKEN: 'tg-tok-123' }
    expect(getChannelToken('telegram', env)).toBe('tg-tok-123')
  })

  it('reads DISCORD_BOT_TOKEN for discord', () => {
    const env = { DISCORD_BOT_TOKEN: 'discord-123' }
    expect(getChannelToken('discord', env)).toBe('discord-123')
  })

  it('returns empty string when key is missing', () => {
    expect(getChannelToken('telegram', {})).toBe('')
    expect(getChannelToken('discord', {})).toBe('')
  })
})

describe('getChannelChatId', () => {
  it('reads ALLOWED_CHAT_ID for telegram', () => {
    const env = { ALLOWED_CHAT_ID: '1268077055' }
    expect(getChannelChatId('telegram', env)).toBe('1268077055')
  })

  it('reads DISCORD_CHANNEL_ID for discord', () => {
    const env = { DISCORD_CHANNEL_ID: '1234567890123456789' }
    expect(getChannelChatId('discord', env)).toBe('1234567890123456789')
  })

  it('returns empty string when key is missing', () => {
    expect(getChannelChatId('telegram', {})).toBe('')
    expect(getChannelChatId('discord', {})).toBe('')
  })
})

describe('channelStateDir', () => {
  it('uses telegram subdirectory for telegram', () => {
    const dir = channelStateDir('telegram')
    expect(dir).toMatch(/\.claude\/channels\/telegram$/)
  })

  it('uses discord subdirectory for discord', () => {
    const dir = channelStateDir('discord')
    expect(dir).toMatch(/\.claude\/channels\/discord$/)
  })

  it('uses agent dir when provided', () => {
    const dir = channelStateDir('telegram', '/tmp/agents/test-agent')
    expect(dir).toBe('/tmp/agents/test-agent/.claude/channels/telegram')
  })
})

describe('formatMessage per provider', () => {
  it('telegram: converts markdown headers to bold', () => {
    const p = getProvider('telegram')
    expect(p.formatMessage('# Hello')).toContain('<b>Hello</b>')
  })

  it('telegram: converts **bold** to HTML', () => {
    const p = getProvider('telegram')
    expect(p.formatMessage('**bold**')).toBe('<b>bold</b>')
  })

  it('discord: converts checkboxes', () => {
    const p = getProvider('discord')
    expect(p.formatMessage('- [ ] todo')).toContain('☐')
    expect(p.formatMessage('- [x] done')).toContain('☑')
  })
})

describe('splitMessage per provider', () => {
  it('telegram: uses 4096 char limit', () => {
    const p = getProvider('telegram')
    const text = 'A '.repeat(2500)
    const chunks = p.splitMessage(text)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4096)
    }
  })

  it('discord: uses 2000 char limit', () => {
    const p = getProvider('discord')
    const text = 'A '.repeat(2500)
    const chunks = p.splitMessage(text)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(2000)
    }
  })
})
