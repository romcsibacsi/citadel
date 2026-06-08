import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockExecFileSync = vi.fn()
vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
  execSync: vi.fn(),
}))

vi.mock('../platform.js', () => ({
  resolveFromPath: (name: string) => `/usr/local/bin/${name}`,
}))

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('../config.js', () => ({
  MAIN_AGENT_ID: 'nexus',
  CHANNEL_PROVIDER: 'telegram',
  PROJECT_ROOT: '/tmp/test-citadel',
}))

vi.mock('../web/agent-config.js', () => ({
  readAgentChannelProvider: (name: string) => name === 'discorder' ? 'discord' : '',
  AGENTS_BASE_DIR: '/tmp/test-citadel/agents',
}))

const mockCapturePane = vi.fn<(session: string) => string | null>()
vi.mock('../web/agent-process.js', () => ({
  agentSessionName: (name: string) => `agent-${name}`,
  capturePane: (session: string) => mockCapturePane(session),
}))

vi.mock('../web/main-agent.js', () => ({
  MAIN_CHANNELS_SESSION: 'nexus-channels',
}))

vi.mock('../channel-provider.js', () => ({
  getProvider: (type: string) => ({
    pluginId: type === 'discord'
      ? 'discord@claude-plugins-official'
      : 'telegram@claude-plugins-official',
    pluginPaneId: type === 'discord'
      ? 'plugin:discord:discord'
      : 'plugin:telegram:telegram',
  }),
}))

import {
  attemptChannelMcpReconnect,
  resolveAgentSession,
  resolveAgentProviderType,
  selectedSubmenuLine,
  chooseSubmenuTarget,
} from '../web/channel-mcp-reconnect.js'

// Submenu panes Claude Code renders for each plugin state. The `❯` marks the
// row the cursor sits on when the submenu first opens (top row).
const SUBMENU_CONNECTED_TOP = [
  'plugin:telegram:telegram',
  '❯ View tools',
  '  Reconnect',
  '  Disable',
].join('\n')
const SUBMENU_CONNECTED_ON_RECONNECT = [
  'plugin:telegram:telegram',
  '  View tools',
  '❯ Reconnect',
  '  Disable',
].join('\n')
const SUBMENU_FAILED_TOP = [
  'plugin:telegram:telegram',
  '❯ Reconnect',
  '  Disable',
].join('\n')
const SUBMENU_DISABLED_TOP = [
  'plugin:telegram:telegram',
  '❯ Enable',
].join('\n')

describe('resolveAgentSession', () => {
  it('returns main channels session for main agent', () => {
    expect(resolveAgentSession('nexus')).toBe('nexus-channels')
  })

  it('returns agent-NAME for sub-agents', () => {
    expect(resolveAgentSession('samu')).toBe('agent-samu')
    expect(resolveAgentSession('zara')).toBe('agent-zara')
  })
})

describe('resolveAgentProviderType', () => {
  it('returns configured provider for agent with explicit config', () => {
    expect(resolveAgentProviderType('discorder')).toBe('discord')
  })

  it('falls back to CHANNEL_PROVIDER for unconfigured agents', () => {
    expect(resolveAgentProviderType('samu')).toBe('telegram')
  })
})

describe('selectedSubmenuLine', () => {
  it('returns the row marked with the cursor', () => {
    expect(selectedSubmenuLine(SUBMENU_CONNECTED_TOP)).toBe('❯ View tools')
    expect(selectedSubmenuLine(SUBMENU_FAILED_TOP)).toBe('❯ Reconnect')
  })

  it('returns null when no cursor is present', () => {
    expect(selectedSubmenuLine('  View tools\n  Reconnect')).toBeNull()
  })

  it('picks the dialog cursor (LAST ❯), not transcript echoes above the dialog', () => {
    // 2026-06-07 22:53 incident: the pane contains echoes of past prompts
    // ("❯ /rename NEXUS", "❯ /mcp") above the dialog overlay. First-match
    // returned the echo line, so the stepping loop never saw the cursor
    // reach Reconnect -> "could not place cursor on target option".
    const paneWithEchoes = [
      '❯ /rename NEXUS',
      '  ⎿  Session renamed to: NEXUS',
      '❯ /mcp',
      '  Plugin:discord:discord MCP Server',
      '  Status:           ✘ failed',
      '  ❯ 1. Reconnect',
      '    2. Disable',
    ].join('\n')
    expect(selectedSubmenuLine(paneWithEchoes)).toBe('  ❯ 1. Reconnect')
  })
})

describe('chooseSubmenuTarget', () => {
  it('prefers Reconnect when present', () => {
    expect(chooseSubmenuTarget(SUBMENU_CONNECTED_TOP)?.source).toBe('reconnect')
    expect(chooseSubmenuTarget(SUBMENU_FAILED_TOP)?.source).toBe('reconnect')
  })

  it('falls back to Enable in the disabled state', () => {
    const t = chooseSubmenuTarget(SUBMENU_DISABLED_TOP)
    expect(t?.test('❯ Enable')).toBe(true)
    expect(t?.source).not.toBe('reconnect')
  })

  it('never targets Disable when no Reconnect/Enable exists', () => {
    expect(chooseSubmenuTarget('plugin:x\n❯ View tools\n  Disable')).toBeNull()
  })

  it('does not mistake "Disable" for an Enable target', () => {
    // \benable\b must not match the "Disable" row.
    expect(chooseSubmenuTarget('plugin:x\n❯ View tools\n  Disable')).toBeNull()
  })

  it('uses status header as ground truth: disabled status -> Enable even if pane contains the word "reconnect"', () => {
    // 2026-06-01 20:02 incident: stage 1 logged
    //   "could not place cursor on target option ... target: reconnect"
    // while the plugin was actually `◯ disabled`. Cause was a stray
    // "reconnect" substring elsewhere in the pane (Claude Code's own
    // footer / scrollback). Status header is now authoritative.
    const paneWithDisabledStatusAndFooterText = [
      'Plugin:telegram:telegram MCP Server',
      '',
      'Status:           ◯ disabled',
      '',
      '❯ 1. Enable',
      '',
      '↑/↓ to navigate · Enter to select · Esc to back',
      '※ Run claude --debug to see error logs / use /mcp to reconnect',
    ].join('\n')
    const t = chooseSubmenuTarget(paneWithDisabledStatusAndFooterText)
    expect(t?.test('Enable')).toBe(true)
    expect(t?.source).not.toBe('reconnect')
  })

  it('uses status header: failed status -> Reconnect', () => {
    const failedPane = [
      'Plugin:telegram:telegram MCP Server',
      'Status:           ✗ failed',
      '❯ 1. Reconnect',
    ].join('\n')
    expect(chooseSubmenuTarget(failedPane)?.source).toBe('reconnect')
  })

  it('recognises the ✘ (U+2718) failed glyph CC 2.1.168 renders', () => {
    const failedPane = [
      'Plugin:discord:discord MCP Server',
      'Status:           ✘ failed',
      '❯ 1. Reconnect',
      '  2. Disable',
    ].join('\n')
    expect(chooseSubmenuTarget(failedPane)?.source).toBe('reconnect')
  })

  it('handles the ◯/○ glyph variants Claude Code has shipped', () => {
    const withHollow = 'Status: ○ disabled\n❯ Enable'
    const withCircled = 'Status: ◯ disabled\n❯ Enable'
    expect(chooseSubmenuTarget(withHollow)?.source).toBe(ENABLE_RX.source)
    expect(chooseSubmenuTarget(withCircled)?.source).toBe(ENABLE_RX.source)
  })
})

// Re-export the regex for the glyph-variant test (defined in helper file)
const ENABLE_RX = /\benable\b/i

describe('attemptChannelMcpReconnect', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('connected state: steps Down onto Reconnect, then activates it', () => {
    mockCapturePane
      .mockReturnValueOnce('/mcp menu content')            // after /mcp
      .mockReturnValueOnce('plugin:telegram:telegram')     // first loop: matched on Up x1
      .mockReturnValueOnce(SUBMENU_CONNECTED_TOP)          // submenu capture: cursor on View tools
      .mockReturnValueOnce(SUBMENU_CONNECTED_ON_RECONNECT) // after one Down: cursor on Reconnect

    const result = attemptChannelMcpReconnect('nexus')

    expect(result.ok).toBe(true)
    expect(result.message).toContain('Reconnect')
    expect(result.message).toContain('Up x1')
    // Exactly one Enter is sent inside the submenu (the activation).
    const submenuEnters = mockExecFileSync.mock.calls.filter(
      (c) => Array.isArray(c[1]) && c[1].includes('Enter') && !c[1].includes('/mcp'),
    )
    expect(submenuEnters.length).toBeGreaterThanOrEqual(2) // open submenu + activate
  })

  it('failed state: Reconnect is already selected, activates WITHOUT pressing Down', () => {
    mockCapturePane
      .mockReturnValueOnce('/mcp menu')
      .mockReturnValueOnce('plugin:telegram:telegram')
      .mockReturnValueOnce(SUBMENU_FAILED_TOP) // cursor already on Reconnect

    const result = attemptChannelMcpReconnect('nexus')

    expect(result.ok).toBe(true)
    expect(result.message).toContain('Reconnect')
    // Regression guard: the old code blindly pressed Down here and landed on
    // "Disable", killing the plugin. No Down may be sent in the submenu.
    const downCalls = mockExecFileSync.mock.calls.filter(
      (c) => Array.isArray(c[1]) && c[1].includes('Down'),
    )
    expect(downCalls.length).toBe(0)
  })

  it('disabled state: activates Enable', () => {
    mockCapturePane
      .mockReturnValueOnce('/mcp menu')
      .mockReturnValueOnce('plugin:telegram:telegram')
      .mockReturnValueOnce(SUBMENU_DISABLED_TOP)

    const result = attemptChannelMcpReconnect('nexus')

    expect(result.ok).toBe(true)
    expect(result.message).toContain('Enable')
  })

  it('never activates when only unsafe options exist (no Reconnect/Enable)', () => {
    mockCapturePane
      .mockReturnValueOnce('/mcp menu')
      .mockReturnValueOnce('plugin:telegram:telegram')
      .mockReturnValueOnce('plugin:telegram:telegram\n❯ View tools\n  Disable')

    const result = attemptChannelMcpReconnect('nexus')

    expect(result.ok).toBe(false)
    expect(result.message).toContain('No Reconnect/Enable')
    // No Enter is pressed inside the submenu -> Disable can never be triggered.
    const downCalls = mockExecFileSync.mock.calls.filter(
      (c) => Array.isArray(c[1]) && c[1].includes('Down'),
    )
    expect(downCalls.length).toBe(0)
  })

  it('finds the plugin on the third Up before opening the submenu', () => {
    mockCapturePane
      .mockReturnValueOnce('/mcp menu')
      .mockReturnValueOnce('no match')
      .mockReturnValueOnce('no match')
      .mockReturnValueOnce('plugin:telegram:telegram here') // matched on Up x3
      .mockReturnValueOnce(SUBMENU_FAILED_TOP)              // submenu: Reconnect selected

    const result = attemptChannelMcpReconnect('nexus')

    expect(result.ok).toBe(true)
    expect(result.message).toContain('Up x3')
  })

  it('returns ok:false when capture fails after /mcp', () => {
    mockCapturePane.mockReturnValueOnce(null)

    const result = attemptChannelMcpReconnect('nexus')

    expect(result.ok).toBe(false)
    expect(result.message).toContain('capture')
  })

  it('returns ok:false when plugin not found within max attempts', () => {
    mockCapturePane.mockReturnValueOnce('/mcp menu')
    for (let i = 0; i < 8; i++) {
      mockCapturePane.mockReturnValueOnce('no match here')
    }

    const result = attemptChannelMcpReconnect('nexus')

    expect(result.ok).toBe(false)
    expect(result.message).toContain('not found')
  })

  it('uses correct session for sub-agents', () => {
    mockCapturePane
      .mockReturnValueOnce('/mcp')
      .mockReturnValueOnce('plugin:discord:discord found')
      .mockReturnValueOnce('plugin:discord:discord\n❯ Reconnect\n  Disable')

    attemptChannelMcpReconnect('discorder')

    expect(mockExecFileSync).toHaveBeenCalledWith(
      '/usr/local/bin/tmux',
      ['send-keys', '-t', 'agent-discorder', 'Escape'],
      expect.any(Object),
    )
  })

  it('2026-06-07 regression: transcript echoes + ✘ glyph do not derail the failed-state reconnect', () => {
    // Real CC 2.1.168 pane shape from the incident: prompt echoes above the
    // dialog, `Status: ✘ failed`, cursor already on "1. Reconnect".
    const realSubmenu = [
      '❯ /rename NEXUS',
      '  ⎿  Session renamed to: NEXUS',
      '❯ /mcp',
      '  Plugin:discord:discord MCP Server',
      '  Status:           ✘ failed',
      '  ❯ 1. Reconnect',
      '    2. Disable',
    ].join('\n')
    mockCapturePane
      .mockReturnValueOnce('/mcp menu')
      .mockReturnValueOnce('plugin:discord:discord here')
      .mockReturnValueOnce(realSubmenu)

    const result = attemptChannelMcpReconnect('discorder')

    expect(result.ok).toBe(true)
    expect(result.message).toContain('Reconnect')
    // Cursor is already on Reconnect -- no Down may be pressed (Down would
    // step onto "2. Disable").
    const downCalls = mockExecFileSync.mock.calls.filter(
      (c) => Array.isArray(c[1]) && c[1].includes('Down'),
    )
    expect(downCalls.length).toBe(0)
  })

  it('sends Escape on error to clean up menu state', () => {
    mockExecFileSync.mockImplementationOnce(() => { /* Escape */ })
    mockExecFileSync.mockImplementationOnce(() => { /* sleep */ })
    mockExecFileSync.mockImplementationOnce(() => { throw new Error('tmux dead') })

    const result = attemptChannelMcpReconnect('nexus')

    expect(result.ok).toBe(false)
    const escapeCalls = mockExecFileSync.mock.calls.filter(
      (c) => Array.isArray(c[1]) && c[1].includes('Escape'),
    )
    expect(escapeCalls.length).toBeGreaterThan(0)
  })
})
