// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * Headless screenshots for FIX-hardening Part C UI changes:
 *   - Plugins (Part A): the "this marketplace can't be browsed here" notice for a
 *     git marketplace (added via the API first), with the by-name field active.
 *   - Skills: the (now-debounced) search filtering the grid.
 * Boots the seed roster on the fake adapter, real Chromium → artifacts/ui/.
 * Run: node --import tsx scripts/shots-hardening.ts
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

const stateDir = mkdtempSync(join(tmpdir(), 'orch-shotsH-'));
const port = 19700 + Math.floor(Math.random() * 400);
const base = `http://127.0.0.1:${port}`;
const seed = JSON.parse(readFileSync(join(repoRoot, 'seed', 'seed.config.json'), 'utf8')) as Record<string, unknown>;
seed.server = { host: '127.0.0.1', port, allowedOrigins: [] };
seed.runtime = { adapter: 'fake', claude: { command: 'claude', staggerSeconds: 1, sessionPrefix: 'shotH' } };
writeFileSync(join(stateDir, 'config.json'), JSON.stringify(seed), { mode: 0o600 });
process.env.ORCHESTRATOR_STATE_DIR = stateDir;

const { boot } = await import(join(repoRoot, 'src', 'app', 'main.js'));
const handle = await boot();
const shutdown: (() => Promise<void>) | undefined = handle?.shutdown;
const bearer = readFileSync(join(stateDir, 'dashboard-token'), 'utf8').trim();

const addMarketplace = (agent: string, name: string, source: string): Promise<Response> =>
  fetch(`${base}/api/plugins/agent/${agent}/marketplaces`, {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name, source }),
  });
// forge: a GIT (unbrowsable) marketplace → the marketUnbrowsable notice.
await addMarketplace('forge', 'official', 'https://github.com/anthropics/claude-plugins');
// spark: a readable LOCAL marketplace that offers ZERO plugins → the marketEmpty
// notice (FIX-hardening C2 — must never be a silent empty checklist).
const emptyMarket = join(stateDir, 'empty-marketplace');
mkdirSync(join(emptyMarket, '.claude-plugin'), { recursive: true });
writeFileSync(join(emptyMarket, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: 'empty-mkt', plugins: [] }));
await addMarketplace('spark', 'empty-mkt', emptyMarket);

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1320, height: 980 } });
const shot = (name: string) => page.screenshot({ path: join(artifactsDir, name), fullPage: true });
try {
  await page.goto(`${base}/?token=${bearer}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.brand-name', { timeout: 15_000 });

  // --- Plugins Part A: the unbrowsable-marketplace notice on forge ---
  await page.evaluate(() => { window.location.hash = '#plugins'; });
  await page.waitForSelector('.plugin-agent-bar', { timeout: 15_000 });
  await page.selectOption('.plugin-agent-bar select', 'forge').catch(() => undefined);
  await page.waitForTimeout(600);
  await shot('hardening-plugins-unbrowsable.png');

  // spark: the browsable-but-empty marketplace → the marketEmpty notice (C2)
  await page.selectOption('.plugin-agent-bar select', 'spark').catch(() => undefined);
  await page.waitForTimeout(600);
  await shot('hardening-plugins-empty.png');

  // --- Skills: the debounced search filtering the grid ---
  await page.evaluate(() => { window.location.hash = '#skills'; });
  await page.waitForSelector('.skills-search', { timeout: 15_000 });
  await page.waitForSelector('.skill-card', { timeout: 10_000 });
  await page.fill('.skills-search', 'skill');
  await page.waitForTimeout(400); // > the 220ms debounce window
  await shot('hardening-skills-search.png');

  console.log('SHOTSH OK');
} finally {
  await browser.close();
  await shutdown?.();
  rmSync(stateDir, { recursive: true, force: true });
  delete process.env.ORCHESTRATOR_STATE_DIR;
}
