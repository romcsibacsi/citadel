// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * PROMO showcase screenshots (card #53). Boots the real app from the SEED roster
 * on the FAKE adapter (15 neutral codename agents, no secrets, no live channels),
 * seeds a little neutral demo content over the API, then captures curated FULLPAGE
 * high-resolution PNGs of seven views in BOTH themes (arcane-forge + light/daylight).
 *
 * No secrets reach the images: the fake adapter has no real tokens/chat-ids, the
 * vault is metadata-only, the seeded content uses neutral example names, and a
 * fullPage screenshot captures the DOM only (never the browser address bar, so the
 * ?token= used to authenticate is not in frame).
 *
 * Locale: defaults to the seed install-default (hu) -> media/promo/. Set
 * PROMO_LOCALE=en to render the dashboard in English (ui.lang) -> media/promo-en/.
 *
 * Run: node --import tsx scripts/shots-promo.ts            (HU -> media/promo/)
 *      PROMO_LOCALE=en node --import tsx scripts/shots-promo.ts  (EN -> media/promo-en/)
 * Output: media/<promo|promo-en>/<view>-<theme>.png + a manifest.json with the paths.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/database.js';
import { PanelStore } from '../src/judge/store.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCALE = process.env.PROMO_LOCALE ?? 'hu';
const outDir = join(repoRoot, 'media', LOCALE === 'en' ? 'promo-en' : 'promo');
const { chromium } = await import('playwright');

if (!existsSync(join(repoRoot, 'web', 'dist', 'assets', 'app.js'))) {
  execFileSync('node', ['scripts/build-web.mjs'], { cwd: repoRoot, stdio: 'pipe' });
}
mkdirSync(outDir, { recursive: true });

// ---- boot the seeded app on the fake adapter ----
const stateDir = mkdtempSync(join(tmpdir(), 'orch-promo-'));
const port = 19700 + Math.floor(Math.random() * 200);
const base = `http://127.0.0.1:${port}`;
const seed = JSON.parse(readFileSync(join(repoRoot, 'seed', 'seed.config.json'), 'utf8')) as Record<string, unknown>;
seed.server = { host: '127.0.0.1', port, allowedOrigins: [] };
seed.runtime = { adapter: 'fake', claude: { command: 'claude', staggerSeconds: 1, sessionPrefix: 'promo' } };
writeFileSync(join(stateDir, 'config.json'), JSON.stringify(seed), { mode: 0o600 });
process.env.ORCHESTRATOR_STATE_DIR = stateDir;

const { boot } = await import(join(repoRoot, 'src', 'app', 'main.js'));
const handle = await boot();
const shutdown: (() => Promise<void>) | undefined = handle?.shutdown;
const bearer = readFileSync(join(stateDir, 'dashboard-token'), 'utf8').trim();

// ---- seed a little neutral demo content (no secrets) over the API ----
async function api(method: string, path: string, body?: unknown): Promise<void> {
  try {
    await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    /* best-effort seeding — a missing endpoint must not abort the run */
  }
}

async function seedDemo(): Promise<void> {
  const cards = [
    { title: 'Design the onboarding flow', assignee: 'prism', priority: 'high' },
    { title: 'Harden the upload validator', assignee: 'forge', priority: 'normal' },
    { title: 'Weekly metrics digest', assignee: 'sigma', priority: 'low' },
    { title: 'Draft the release notes', assignee: 'archivist', priority: 'normal' },
  ];
  for (const c of cards) await api('POST', '/api/kanban/cards', { ...c, description: 'Example card for the showcase.' });
  await api('POST', '/api/ideas', { title: 'Add a dark-mode export', description: 'Let the operator export reports honoring the active theme.' });
  const mems = [
    { agentId: 'forge', category: 'warm', content: 'Build pipeline uses esbuild for the web bundle; keep cold-start under one second.' },
    { agentId: 'oracle', category: 'shared', content: 'Prefer recursive setTimeout over setInterval for drift-free countdowns.' },
    { agentId: 'prism', category: 'warm', content: 'Accent on light themes must clear AA (4.5:1) for normal text.' },
  ];
  for (const m of mems) await api('POST', '/api/memories', m);
}
await seedDemo();

// A fully-decided demo judge-panel so the Panels view renders the real DECISION
// view (solvers + per-judge verdicts + ranked decision trace + gates), not an
// empty state. Seeded via the PanelStore methods; neutral demo content only.
// The decision.ruleOutput MUST match the shape panels.ts renders:
//   { winningSolutionId, decidedBy, ranked:[{solutionId,composite,majorDefects,
//     minorDefects,oracleCorrectness,vetoed}], trace:[string] }
function seedDecidedPanel(): void {
  const db = openDatabase(join(stateDir, 'orchestrator.db'));
  try {
    const store = new PanelStore(db);
    const created = store.createPanel({
      goal: 'Add input validation to the upload form',
      solvers: [
        { agentId: 'forge', angle: 'Robust schema validation with clear field errors', prompt: 'Validate the upload form fields with explicit per-field errors.' },
        { agentId: 'spark', angle: 'Minimal happy-path guard', prompt: 'Add a lean required-field guard.' },
      ],
      judges: [
        { role: 'probe', agentId: 'probe', prompt: 'Score correctness / robustness / simplicity.' },
        { role: 'oracle', agentId: 'oracle', prompt: 'Score correctness / robustness / simplicity.' },
      ],
      rubric: { correctness: { weight: 2 }, robustness: { weight: 1 }, simplicity: { weight: 1 } },
      decisionRule: { kind: 'weighted-veto' },
      testCommand: 'npm run typecheck && npm test',
      branchPrefix: 'panel/upload-validation',
      category: 'code_change',
      createdBy: 'operator',
    });
    const pid = created.panel.id;
    const [win, run] = created.solutions;
    store.recordSolution(win.id, { commitSha: 'b0f0923d85c7', tailSummary: 'Per-field validation + tests; full coverage of the edge cases.' });
    store.recordSolution(run.id, { commitSha: 'a17c4e9f2b10', tailSummary: 'Required-field guard only; thinner coverage.' });
    store.addVerdict(pid, { solutionId: win.id, judge: 'probe', scores: { correctness: 5, robustness: 4, simplicity: 4 }, refutations: [], recommendation: 'accept', fatalDefect: false });
    store.addVerdict(pid, { solutionId: win.id, judge: 'oracle', scores: { correctness: 5, robustness: 5, simplicity: 4 }, refutations: [], recommendation: 'accept', fatalDefect: false });
    store.addVerdict(pid, { solutionId: run.id, judge: 'probe', scores: { correctness: 4, robustness: 3, simplicity: 5 }, refutations: [{ claim: 'Misses the empty-file edge case', severity: 'minor' }], recommendation: 'revise', fatalDefect: false });
    store.addVerdict(pid, { solutionId: run.id, judge: 'oracle', scores: { correctness: 4, robustness: 4, simplicity: 5 }, refutations: [], recommendation: 'accept', fatalDefect: false });
    for (const j of created.judges) store.setJudgeStatus(j.id, 'verdicts_in'); // judges done (verdicts are in)
    store.setStatus(pid, 'judging');
    store.setStatus(pid, 'deciding');
    store.recordDecision(pid, {
      winningSolutionId: win.id,
      decidedBy: 'weighted-veto',
      ruleOutput: {
        winningSolutionId: win.id,
        decidedBy: 'weighted-veto',
        ranked: [
          { solutionId: win.id, composite: 9, majorDefects: 0, minorDefects: 0, oracleCorrectness: 5, vetoed: false },
          { solutionId: run.id, composite: 7, majorDefects: 0, minorDefects: 1, oracleCorrectness: 4, vetoed: false },
        ],
        trace: [
          'veto-on-fatal: no fatal defects on either solution',
          `score = correctness×2 + robustness − majorDefects → #${win.id}=9, #${run.id}=7`,
          `winner: #${win.id} (higher composite, no veto)`,
        ],
      },
      snapshot: { rubric: { correctness: { weight: 2 }, robustness: { weight: 1 }, simplicity: { weight: 1 } } },
    });
    store.setStatus(pid, 'gated_review');
    store.setGate(pid, 'branch', 'passed', 'git ls-tree confirms the file on the winner branch');
    store.setGate(pid, 'test', 'passed', 'typecheck + 1066/1066 green');
    store.setGate(pid, 'review', 'passed', 'no blocking findings');
    store.setGate(pid, 'approve', 'passed', 'operator approved');
    store.setGate(pid, 'apply', 'pending', null);
  } finally {
    db.close();
  }
}
try {
  seedDecidedPanel();
  process.stdout.write('  seeded decided demo panel\n');
} catch (err) {
  process.stdout.write(`  panel seed skipped (${String(err).slice(0, 120)})\n`);
}

// ---- capture ----
const VIEWS: Array<{ hash: string; sel: string; name: string }> = [
  { hash: 'overview', sel: '.stat-value', name: 'overview' },
  { hash: 'team', sel: '.team-constellation, .constellation, .team-grid, .agents-grid', name: 'constellation' },
  { hash: 'agents', sel: '.agents-grid, .card-term', name: 'agents' },
  { hash: 'kanban', sel: '.kanban-toolbar', name: 'kanban' },
  { hash: 'panels', sel: '.panel-rail, .panels-empty, .page-header', name: 'panels' },
  { hash: 'studio', sel: '.studio-prompt, .page-header', name: 'studio' },
  { hash: 'memories', sel: '.mem-toolbar', name: 'memories' },
  { hash: 'channels', sel: '.channel-page, .page-header', name: 'channels' },
];
const THEMES: Array<{ id: string; label: string }> = [
  { id: 'arcane-forge', label: 'arcane' },
  { id: 'light', label: 'daylight' },
];

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const manifest: Array<{ file: string; view: string; theme: string }> = [];

try {
  for (const theme of THEMES) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    await context.addInitScript(`try { localStorage.setItem('ui.theme', ${JSON.stringify(theme.id)}); localStorage.setItem('ui.glow', '0.5'); localStorage.setItem('ui.lang', ${JSON.stringify(LOCALE)}); } catch (e) {}`);
    const page = await context.newPage();
    page.on('pageerror', (e) => process.stdout.write(`  [pageerror ${theme.label}] ${String(e).slice(0, 140)}\n`));
    await page.goto(`${base}/?token=${bearer}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.brand-name', { timeout: 20_000 });

    for (const v of VIEWS) {
      try {
        await page.evaluate((h) => { window.location.hash = '#' + h; }, v.hash);
        await page.waitForSelector(v.sel, { timeout: 8_000 }).catch(() => undefined);
        await page.waitForTimeout(500); // let charts/graph settle
        const file = `${v.name}-${theme.label}.png`;
        await page.screenshot({ path: join(outDir, file), fullPage: true });
        manifest.push({ file, view: v.name, theme: theme.label });
        process.stdout.write(`  ✓ ${file}\n`);
      } catch (err) {
        process.stdout.write(`  ✗ ${v.name}-${theme.label}: ${String(err).slice(0, 80)}\n`);
      }
    }
    await context.close();
  }
} finally {
  await browser.close();
  if (shutdown) await shutdown();
  rmSync(stateDir, { recursive: true, force: true });
}

writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
process.stdout.write(`\n${manifest.length} screenshots in ${outDir}\n`);
for (const f of readdirSync(outDir).sort()) process.stdout.write(`  media/promo/${f}\n`);
