// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * Headless screenshots for the FIX-five-features web batch:
 *   - Skills view with the scope/search/documented toolbar + an opened SKILL.md
 *   - Connectors view with the bilingual how-to panel expanded
 *   - Plugins view: per-agent checklist (Part A) + extensions multi-enable (Part B)
 * Boots the real app from the SEED roster on the fake adapter (so the seeded
 * skills + 15 agents are present), drives a real Chromium, writes PNGs to artifacts/ui/.
 * Run: node --import tsx scripts/shots-five.ts
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

const stateDir = mkdtempSync(join(tmpdir(), 'orch-shots5-'));
const port = 19200 + Math.floor(Math.random() * 500);
const base = `http://127.0.0.1:${port}`;
const seed = JSON.parse(readFileSync(join(repoRoot, 'seed', 'seed.config.json'), 'utf8')) as Record<string, unknown>;
seed.server = { host: '127.0.0.1', port, allowedOrigins: [] };
seed.runtime = { adapter: 'fake', claude: { command: 'claude', staggerSeconds: 1, sessionPrefix: 'shot5' } };
writeFileSync(join(stateDir, 'config.json'), JSON.stringify(seed), { mode: 0o600 });
process.env.ORCHESTRATOR_STATE_DIR = stateDir;

const { boot } = await import(join(repoRoot, 'src', 'app', 'main.js'));
const handle = await boot();
const shutdown: (() => Promise<void>) | undefined = handle?.shutdown;
const bearer = readFileSync(join(stateDir, 'dashboard-token'), 'utf8').trim();

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1320, height: 980 } });
const shot = (name: string) => page.screenshot({ path: join(artifactsDir, name), fullPage: true });
try {
  await page.goto(`${base}/?token=${bearer}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.brand-name', { timeout: 15_000 });

  // --- Skills: toolbar (scope chips + search + documented) + an opened doc ---
  await page.evaluate(() => { window.location.hash = '#skills'; });
  await page.waitForSelector('.skills-toolbar', { timeout: 15_000 });
  await page.waitForSelector('.skill-card', { timeout: 10_000 });
  await page.waitForTimeout(300);
  await shot('five-skills-filters.png');
  await page.click('.skill-card'); // open the first skill's SKILL.md viewer
  await page.waitForSelector('.skill-detail-modal .skill-manifest', { timeout: 10_000 });
  await page.waitForTimeout(300);
  await shot('five-skills-doc.png');
  await page.keyboard.press('Escape');

  // --- Connectors: expand the how-to panel ---
  await page.evaluate(() => { window.location.hash = '#mcp'; });
  await page.waitForSelector('.conn-howto, .disclosure', { timeout: 15_000 });
  // expand the first disclosure (the how-to is the first one rendered after the info-box)
  await page.click('.disclosure-head');
  await page.waitForTimeout(300);
  await shot('five-connectors-howto.png');
  // open the Add-custom-MCP form (shows the Test button)
  await page.click('.mcp-header-actions .primary');
  await page.waitForSelector('.conn-add-modal', { timeout: 10_000 });
  await page.waitForTimeout(300);
  await shot('five-connectors-add.png');
  await page.keyboard.press('Escape');

  // --- Plugins: Part A per-agent checklist, then Part B extensions multi-enable ---
  await page.evaluate(() => { window.location.hash = '#plugins'; });
  await page.waitForSelector('.plugin-tabs', { timeout: 15_000 });
  await page.waitForSelector('.plugin-agent-bar', { timeout: 10_000 });
  await page.waitForTimeout(400);
  await shot('five-plugins-agents.png');
  await page.click('.plugin-tabs .tab >> nth=1'); // Extensions tab
  await page.waitForSelector('.plugin-bulk-bar', { timeout: 10_000 });
  await page.waitForTimeout(400);
  await shot('five-plugins-extensions.png');

  console.log('SHOTS5 OK');
} finally {
  await browser.close();
  await shutdown?.();
  rmSync(stateDir, { recursive: true, force: true });
  delete process.env.ORCHESTRATOR_STATE_DIR;
}
