// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * One-off headless screenshots for the FIX-plugin-* batch DoD:
 *   - Channels view with the Slack and Discord provider panels (setup + token form)
 *   - Webhooks settings view
 *   - Cost / usage dashboard (plugin view, rendered in the Plugins surface)
 * Boots the real app on the fake adapter, drives a real Chromium, writes PNGs
 * into artifacts/ui/. Run: node --import tsx scripts/shots-plugins.ts
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const artifactsDir = join(repoRoot, 'artifacts', 'ui');
const { chromium } = await import('playwright');

if (!existsSync(join(repoRoot, 'web', 'dist', 'assets', 'app.js'))) {
  execFileSync('node', ['scripts/build-web.mjs'], { cwd: repoRoot, stdio: 'pipe' });
}
mkdirSync(artifactsDir, { recursive: true });

const stateDir = mkdtempSync(join(tmpdir(), 'orch-shots-'));
const port = 18600 + Math.floor(Math.random() * 600);
const base = `http://127.0.0.1:${port}`;
writeFileSync(
  join(stateDir, 'config.json'),
  JSON.stringify({
    branding: { productName: 'CITADEL' },
    locale: { default: 'hu', agentProse: 'hu' },
    timezone: 'Europe/Budapest',
    server: { host: '127.0.0.1', port, allowedOrigins: [] },
    hubId: 'nexus',
    agents: [
      { id: 'nexus', displayName: 'NEXUS', role: 'Hub', securityProfile: 'full-host', accentColor: '#7c5cff', authMode: 'shared-subscription', team: { role: 'hub', delegatesTo: ['forge'], trustFrom: [] } },
      { id: 'forge', displayName: 'FORGE', role: 'Development & build', securityProfile: 'draft', accentColor: '#ff6b35', authMode: 'shared-subscription', team: { role: 'specialist', reportsTo: 'nexus', delegatesTo: [], trustFrom: ['nexus'] } },
    ],
    runtime: { adapter: 'fake', claude: { command: 'claude', staggerSeconds: 1, sessionPrefix: 'shots' } },
  }),
  { mode: 0o600 },
);
process.env.ORCHESTRATOR_STATE_DIR = stateDir;

const { boot } = await import(join(repoRoot, 'src', 'app', 'main.js'));
const handle = await boot();
const shutdown: (() => Promise<void>) | undefined = handle?.shutdown;
const bearer = readFileSync(join(stateDir, 'dashboard-token'), 'utf8').trim();

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1320, height: 980 } });
try {
  await page.goto(`${base}/?token=${bearer}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.brand-name', { timeout: 15_000 });

  // --- Channels: Slack panel, then Discord panel (setup + token form) ---
  await page.evaluate(() => { window.location.hash = '#channels'; });
  await page.waitForSelector('.channel-panel select', { timeout: 15_000 });
  const provSel = 'select[aria-label]';
  await page.selectOption('.channel-panel select', 'slack');
  await page.waitForFunction(() => document.querySelector('.chan-notconnected, .chan-connected') !== null, { timeout: 10_000 });
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(artifactsDir, 'plugin-channels-slack.png'), fullPage: true });

  await page.selectOption('.channel-panel select', 'discord');
  await page.waitForFunction(() => document.querySelector('.chan-notconnected, .chan-connected') !== null, { timeout: 10_000 });
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(artifactsDir, 'plugin-channels-discord.png'), fullPage: true });
  void provSel;

  // --- Webhooks settings view ---
  await page.evaluate(() => { window.location.hash = '#webhooks'; });
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(artifactsDir, 'plugin-webhooks.png'), fullPage: true });

  // --- Cost dashboard (first-party plugin view under the Extensions tab) ---
  await page.evaluate(() => { window.location.hash = '#plugins'; });
  await page.waitForSelector('.plugin-tabs .tab', { timeout: 10_000 });
  // switch to the Extensions ("Bővítmények") tab
  await page.click('.plugin-tabs .tab >> nth=1');
  await page.waitForSelector('.plugin-ext-views .link-btn', { timeout: 10_000 });
  // open the cost view (its navLabel from the backend i18n)
  await page.click('.plugin-ext-views .link-btn');
  await page.waitForSelector('.plugin-view-frame', { timeout: 10_000 });
  await page.waitForTimeout(700);
  await page.screenshot({ path: join(artifactsDir, 'plugin-cost-dashboard.png'), fullPage: true });

  console.log('SHOTS OK');
} finally {
  await browser.close();
  await shutdown?.();
  rmSync(stateDir, { recursive: true, force: true });
}
