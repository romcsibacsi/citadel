// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Claude Code per-agent plugin management (FIX-plugins Part A). Reads/writes the
 * agent's native plugin config in its config-root so the operator can manage
 * marketplaces + enabled plugins from the dashboard instead of shelling into each
 * agent. Pure file helpers (no network): a marketplace is just a name + source
 * (git URL or local path); enabledPlugins is a name→bool map in `.claude.json`.
 * Install/enable is a DELIBERATE operator action (the routes are bearer-gated) and
 * never grants an agent more than its security profile — Claude Code still applies
 * the agent's permission rules to any plugin-bundled hook/command/MCP.
 */

export interface Marketplace { name: string; source: string }

function marketplacesFile(configRoot: string): string {
  return join(configRoot, 'plugins', 'known_marketplaces.json');
}
function claudeJsonFile(configRoot: string): string {
  return join(configRoot, '.claude.json');
}
function readJson<T>(file: string, fallback: T): T {
  try { return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as T) : fallback; } catch { return fallback; }
}
function writeJson(file: string, value: unknown): void {
  mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}

export function listMarketplaces(configRoot: string): Marketplace[] {
  const raw = readJson<{ marketplaces?: unknown }>(marketplacesFile(configRoot), {});
  if (!Array.isArray(raw.marketplaces)) return [];
  return raw.marketplaces
    .filter((m): m is Marketplace => m !== null && typeof m === 'object' && typeof (m as Marketplace).name === 'string' && typeof (m as Marketplace).source === 'string')
    .map((m) => ({ name: m.name, source: m.source }));
}

export function addMarketplace(configRoot: string, m: Marketplace): Marketplace[] {
  const name = m.name.trim();
  const source = m.source.trim();
  if (name === '' || source === '') throw new Error('marketplace name and source are required');
  const list = listMarketplaces(configRoot).filter((x) => x.name !== name);
  list.push({ name, source });
  writeJson(marketplacesFile(configRoot), { marketplaces: list });
  return list;
}

export function removeMarketplace(configRoot: string, name: string): Marketplace[] {
  const list = listMarketplaces(configRoot).filter((x) => x.name !== name);
  writeJson(marketplacesFile(configRoot), { marketplaces: list });
  return list;
}

export function readEnabledPlugins(configRoot: string): Record<string, boolean> {
  const raw = readJson<{ enabledPlugins?: unknown }>(claudeJsonFile(configRoot), {});
  const out: Record<string, boolean> = {};
  if (raw.enabledPlugins !== null && typeof raw.enabledPlugins === 'object') {
    for (const [k, v] of Object.entries(raw.enabledPlugins as Record<string, unknown>)) out[k] = v === true;
  }
  return out;
}

/** Enable/disable a plugin for one agent (writes the agent's .claude.json). */
export function setEnabledPlugin(configRoot: string, plugin: string, on: boolean): Record<string, boolean> {
  const name = plugin.trim();
  if (name === '') throw new Error('plugin name is required');
  const file = claudeJsonFile(configRoot);
  const data = readJson<Record<string, unknown>>(file, {});
  const enabled = (data.enabledPlugins !== null && typeof data.enabledPlugins === 'object' ? { ...(data.enabledPlugins as Record<string, boolean>) } : {}) as Record<string, boolean>;
  if (on) enabled[name] = true; else delete enabled[name];
  data.enabledPlugins = enabled;
  writeJson(file, data);
  return readEnabledPlugins(configRoot);
}

export interface BrowsePlugin { name: string; description?: string; bundles?: string[] }
/**
 * Browse result (FIX-hardening C): an EXPLICIT browsable verdict, so the UI can tell
 * "no marketplace" from "this marketplace can't be enumerated here". `browsable` is
 * true only for a readable LOCAL `marketplace.json` (possibly with an empty plugins
 * list); false for a git/remote source AND for a missing/unreadable/malformed local
 * file. No git cloning is attempted — an honest "cannot browse here" is the bar.
 */
export interface BrowseResult { browsable: boolean; plugins: BrowsePlugin[] }

/** Best-effort browse of a LOCAL marketplace's offered plugins (a marketplace.json
 *  array). A git/remote source is NOT browsable here (no clone) — honest, not a guess. */
export function browseMarketplace(source: string): BrowseResult {
  const trimmed = source.trim();
  if (!trimmed.startsWith('/') && !trimmed.startsWith('.')) return { browsable: false, plugins: [] }; // git/remote: cannot browse here
  for (const rel of ['.claude-plugin/marketplace.json', 'marketplace.json']) {
    const file = join(trimmed, rel);
    if (!existsSync(file)) continue;
    let parsed: { plugins?: unknown };
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8')) as { plugins?: unknown };
    } catch {
      return { browsable: false, plugins: [] }; // present but malformed → cannot browse
    }
    const plugins = Array.isArray(parsed.plugins)
      ? parsed.plugins
          .filter((p): p is { name: string } => p !== null && typeof p === 'object' && typeof (p as { name?: unknown }).name === 'string')
          .map((p) => {
            const e = p as { name: string; description?: unknown; bundles?: unknown };
            return { name: e.name, ...(typeof e.description === 'string' ? { description: e.description } : {}), ...(Array.isArray(e.bundles) ? { bundles: e.bundles.filter((b): b is string => typeof b === 'string') } : {}) };
          })
      : [];
    return { browsable: true, plugins }; // readable local marketplace (possibly empty)
  }
  return { browsable: false, plugins: [] }; // local dir but no marketplace.json
}
