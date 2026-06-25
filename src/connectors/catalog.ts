// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * Shipped MCP connector catalog (PROMPT-13 §6 "Browse catalog"). A committed
 * list of well-known servers, overlaid at read time by the operator's
 * user-local customs (which override by id). Required env carries var NAMES
 * only — values are never shipped.
 */

export type CatalogType = 'local' | 'remote';
export type AuthType = 'none' | 'apikey' | 'oauth';

export interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  type: CatalogType;
  category: string;
  icon: string;
  command?: string;
  args?: string;
  url?: string;
  env: string[];
  authType: AuthType;
  authNote?: string;
  infoUrl?: string;
}

export const CATALOG: CatalogEntry[] = [
  {
    id: 'filesystem',
    name: 'Filesystem',
    description: 'Read and write files within allowed directories.',
    type: 'local',
    category: 'system',
    icon: '📁',
    command: 'npx',
    args: '-y @modelcontextprotocol/server-filesystem',
    env: [],
    authType: 'none',
    infoUrl: 'https://modelcontextprotocol.io/',
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'Browse repositories, issues, and pull requests.',
    type: 'local',
    category: 'development',
    icon: '🐙',
    command: 'npx',
    args: '-y @modelcontextprotocol/server-github',
    env: ['GITHUB_TOKEN'],
    authType: 'apikey',
    authNote: 'Create a token at github.com/settings/tokens (repo scope).',
    infoUrl: 'https://github.com/',
  },
  {
    id: 'brave-search',
    name: 'Brave Search',
    description: 'Web search via the Brave Search API.',
    type: 'local',
    category: 'search',
    icon: '🔎',
    command: 'npx',
    args: '-y @modelcontextprotocol/server-brave-search',
    env: ['BRAVE_API_KEY'],
    authType: 'apikey',
    authNote: 'Get a key at brave.com/search/api.',
    infoUrl: 'https://brave.com/search/api/',
  },
  {
    id: 'slack',
    name: 'Slack',
    description: 'Post and read messages in Slack channels.',
    type: 'local',
    category: 'communication',
    icon: '💬',
    command: 'npx',
    args: '-y @modelcontextprotocol/server-slack',
    env: ['SLACK_BOT_TOKEN'],
    authType: 'apikey',
    authNote: 'Create a Slack app and copy its bot token.',
    infoUrl: 'https://api.slack.com/',
  },
  {
    id: 'notion',
    name: 'Notion',
    description: 'Read and update Notion pages and databases.',
    type: 'remote',
    category: 'productivity',
    icon: '📝',
    url: 'https://mcp.notion.com/mcp',
    env: [],
    authType: 'oauth',
    authNote: 'Browser login required on first use.',
    infoUrl: 'https://notion.so/',
  },
  {
    id: 'google-drive',
    name: 'Google Drive',
    description: 'Search and read files from Google Drive.',
    type: 'remote',
    category: 'productivity',
    icon: '📄',
    url: 'https://mcp.google.com/drive',
    env: [],
    authType: 'oauth',
    authNote: 'Browser login required on first use.',
    infoUrl: 'https://drive.google.com/',
  },
  {
    id: 'postgres',
    name: 'PostgreSQL',
    description: 'Query a PostgreSQL database read-only.',
    type: 'local',
    category: 'development',
    icon: '🐘',
    command: 'npx',
    args: '-y @modelcontextprotocol/server-postgres',
    env: ['DATABASE_URL'],
    authType: 'apikey',
    authNote: 'Provide a connection string (postgres://...).',
    infoUrl: 'https://www.postgresql.org/',
  },
  {
    id: 'stripe',
    name: 'Stripe',
    description: 'Inspect customers, charges, and invoices.',
    type: 'local',
    category: 'finance',
    icon: '💳',
    command: 'npx',
    args: '-y @stripe/mcp',
    env: ['STRIPE_API_KEY'],
    authType: 'apikey',
    authNote: 'Use a restricted, read-only key from the Stripe dashboard.',
    infoUrl: 'https://stripe.com/',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    description: 'Call OpenAI models as a tool.',
    type: 'local',
    category: 'ai',
    icon: '🤖',
    command: 'npx',
    args: '-y @mcp/openai',
    env: ['OPENAI_API_KEY'],
    authType: 'apikey',
    authNote: 'Get a key at platform.openai.com/api-keys.',
    infoUrl: 'https://platform.openai.com/',
  },
  {
    id: 'sequential-thinking',
    name: 'Sequential Thinking',
    description: 'A scratchpad for structured multi-step reasoning.',
    type: 'local',
    category: 'productivity',
    icon: '🧠',
    command: 'npx',
    args: '-y @modelcontextprotocol/server-sequential-thinking',
    env: [],
    authType: 'none',
    infoUrl: 'https://modelcontextprotocol.io/',
  },
];

/** Built-in runtime capabilities — not health-checked, not manageable MCP. */
export interface BuiltinCapability {
  id: string;
  label: string;
  description: string;
}

export const BUILTINS: BuiltinCapability[] = [
  { id: 'computer-use', label: 'computer-use', description: 'screen / computer control' },
  { id: 'browser', label: 'browser', description: 'browser control' },
];
