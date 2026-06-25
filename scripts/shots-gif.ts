// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * PROMO demo GIF (card #54). Records the REAL flow on the seeded dashboard with
 * Playwright recordVideo, then ffmpeg renders an optimized GIF (+ MP4) into
 * media/promo/. Story (~18s, arcane theme): overview/constellation -> kanban
 * (a card moves planned -> in_progress -> done) -> the judge-panel decision view
 * -> back to overview.
 *
 * Neutral seeded content, fake adapter, no secrets (the ?token= is in the URL
 * the video never frames — recordVideo captures the page viewport only).
 *
 * Locale: defaults to the seed install-default (hu) -> media/promo/. Set
 * PROMO_LOCALE=en to record the flow in English (ui.lang) -> media/promo-en/.
 *
 * Run: node --import tsx scripts/shots-gif.ts                      (HU -> media/promo/)
 *      PROMO_LOCALE=en node --import tsx scripts/shots-gif.ts      (EN -> media/promo-en/)
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

const stateDir = mkdtempSync(join(tmpdir(), 'orch-gif-'));
const videoDir = mkdtempSync(join(tmpdir(), 'orch-gif-vid-'));
const port = 19500 + Math.floor(Math.random() * 200);
const base = `http://127.0.0.1:${port}`;
const seed = JSON.parse(readFileSync(join(repoRoot, 'seed', 'seed.config.json'), 'utf8')) as Record<string, unknown>;
seed.server = { host: '127.0.0.1', port, allowedOrigins: [] };
seed.runtime = { adapter: 'fake', claude: { command: 'claude', staggerSeconds: 1, sessionPrefix: 'gif' } };
writeFileSync(join(stateDir, 'config.json'), JSON.stringify(seed), { mode: 0o600 });
process.env.ORCHESTRATOR_STATE_DIR = stateDir;

const { boot } = await import(join(repoRoot, 'src', 'app', 'main.js'));
const handle = await boot();
const shutdown: (() => Promise<void>) | undefined = handle?.shutdown;
const bearer = readFileSync(join(stateDir, 'dashboard-token'), 'utf8').trim();

async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T | undefined> {
  try {
    const r = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return (await r.json()) as T;
  } catch {
    return undefined;
  }
}

// neutral demo cards + a fully-decided panel (same shapes the screenshots use)
const CARDS = [
  { title: 'Refactor the auth middleware', assignee: 'forge', priority: 'high' },
  { title: 'Design the onboarding flow', assignee: 'prism', priority: 'normal' },
  { title: 'Weekly metrics digest', assignee: 'sigma', priority: 'low' },
];
for (const c of CARDS) await api('POST', '/api/kanban/cards', { ...c, description: 'Example card for the showcase.' });
for (const m of [
  { agentId: 'forge', category: 'warm', content: 'Build pipeline uses esbuild for the web bundle.' },
  { agentId: 'oracle', category: 'shared', content: 'Prefer recursive setTimeout over setInterval for drift-free timers.' },
]) await api('POST', '/api/memories', m);

function seedPanel(): void {
  const db = openDatabase(join(stateDir, 'orchestrator.db'));
  try {
    const store = new PanelStore(db);
    const created = store.createPanel({
      goal: 'Add input validation to the upload form',
      solvers: [
        { agentId: 'forge', angle: 'Robust schema validation with clear field errors', prompt: 'Validate the upload form fields.' },
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
    store.recordSolution(win.id, { commitSha: 'b0f0923d85c7', tailSummary: 'Per-field validation + tests.' });
    store.recordSolution(run.id, { commitSha: 'a17c4e9f2b10', tailSummary: 'Required-field guard only.' });
    store.addVerdict(pid, { solutionId: win.id, judge: 'probe', scores: { correctness: 5, robustness: 4, simplicity: 4 }, refutations: [], recommendation: 'accept', fatalDefect: false });
    store.addVerdict(pid, { solutionId: win.id, judge: 'oracle', scores: { correctness: 5, robustness: 5, simplicity: 4 }, refutations: [], recommendation: 'accept', fatalDefect: false });
    store.addVerdict(pid, { solutionId: run.id, judge: 'probe', scores: { correctness: 4, robustness: 3, simplicity: 5 }, refutations: [{ claim: 'Misses the empty-file edge case', severity: 'minor' }], recommendation: 'revise', fatalDefect: false });
    store.addVerdict(pid, { solutionId: run.id, judge: 'oracle', scores: { correctness: 4, robustness: 4, simplicity: 5 }, refutations: [], recommendation: 'accept', fatalDefect: false });
    for (const j of created.judges) store.setJudgeStatus(j.id, 'verdicts_in');
    store.setStatus(pid, 'judging');
    store.setStatus(pid, 'deciding');
    store.recordDecision(pid, {
      winningSolutionId: win.id, decidedBy: 'weighted-veto',
      ruleOutput: {
        winningSolutionId: win.id, decidedBy: 'weighted-veto',
        ranked: [
          { solutionId: win.id, composite: 9, majorDefects: 0, minorDefects: 0, oracleCorrectness: 5, vetoed: false },
          { solutionId: run.id, composite: 7, majorDefects: 0, minorDefects: 1, oracleCorrectness: 4, vetoed: false },
        ],
        trace: ['veto-on-fatal: none', `score → #${win.id}=9, #${run.id}=7`, `winner: #${win.id}`],
      },
      snapshot: { rubric: 'frozen' },
    });
    store.setStatus(pid, 'gated_review');
    for (const [st, status] of [['branch', 'passed'], ['test', 'passed'], ['review', 'passed'], ['approve', 'passed'], ['apply', 'pending']] as const) {
      store.setGate(pid, st, status, status === 'passed' ? 'evidence recorded' : null);
    }
  } finally {
    db.close();
  }
}
seedPanel();

// ---- record the flow ----
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  recordVideo: { dir: videoDir, size: { width: 1280, height: 800 } },
});
await context.addInitScript(`try { localStorage.setItem('ui.theme', 'arcane-forge'); localStorage.setItem('ui.glow', '0.5'); localStorage.setItem('ui.lang', ${JSON.stringify(LOCALE)}); } catch (e) {}`);
const page = await context.newPage();
const go = async (hash: string, sel: string, settle = 1200): Promise<void> => {
  await page.evaluate((h) => { window.location.hash = '#' + h; }, hash);
  await page.waitForSelector(sel, { timeout: 8_000 }).catch(() => undefined);
  await page.waitForTimeout(settle);
};

await page.goto(`${base}/?token=${bearer}`, { waitUntil: 'networkidle' });
await page.waitForSelector('.brand-name', { timeout: 20_000 });

const board = (await api<{ planned: Array<{ id: number }> }>('GET', '/api/kanban/board')) ?? { planned: [] };
const moveId = board.planned?.[0]?.id;

try {
  const reloadKanban = async (settle: number): Promise<void> => {
    // a same-hash set does NOT re-fire the router, so reload to show the moved card
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('.kanban-toolbar', { timeout: 8_000 }).catch(() => undefined);
    await page.waitForTimeout(settle);
  };
  await go('overview', '.stat-value', 2500);                 // the constellation
  await go('kanban', '.kanban-toolbar', 2200);               // the board (cards in planned)
  if (moveId !== undefined) {
    await api('POST', `/api/kanban/cards/${moveId}/move`, { status: 'in_progress' });
    await reloadKanban(2000);                                // card now IN PROGRESS
    await api('POST', `/api/kanban/cards/${moveId}/move`, { status: 'done' });
    await reloadKanban(2000);                                // card DONE
  }
  await go('panels', '.panel-rail, .page-header', 1500);     // judge-panel decision
  for (let y = 0; y <= 1400; y += 350) {                     // smooth scroll through the decision
    await page.evaluate((yy) => window.scrollTo({ top: yy, behavior: 'smooth' }), y);
    await page.waitForTimeout(600);
  }
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
  await go('overview', '.stat-value', 1500);                 // back home
} finally {
  await context.close();   // finalizes the .webm
  await browser.close();
  if (shutdown) await shutdown();
}

const webm = readdirSync(videoDir).filter((f) => f.endsWith('.webm')).map((f) => join(videoDir, f))[0];
if (webm === undefined) throw new Error('no video recorded');

// ---- ffmpeg: optimized GIF (palette) + MP4 ----
const gif = join(outDir, 'flow-demo.gif');
const mp4 = join(outDir, 'flow-demo.mp4');
const palette = join(videoDir, 'palette.png');
// trim the initial white page-load frame (-ss before -i seeks the input) so the
// first GIF frame is the painted dashboard, not a blank white flash (PROBE #56).
const trim = '0.5';
const vf = 'fps=13,scale=760:-1:flags=lanczos';
execFileSync('ffmpeg', ['-y', '-ss', trim, '-i', webm, '-vf', `${vf},palettegen=stats_mode=diff`, palette], { stdio: 'pipe' });
execFileSync('ffmpeg', ['-y', '-ss', trim, '-i', webm, '-i', palette, '-lavfi', `${vf} [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=3`, gif], { stdio: 'pipe' });
execFileSync('ffmpeg', ['-y', '-ss', trim, '-i', webm, '-vf', 'scale=1280:-2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', mp4], { stdio: 'pipe' });

rmSync(stateDir, { recursive: true, force: true });
rmSync(videoDir, { recursive: true, force: true });
process.stdout.write(`GIF: ${gif}\nMP4: ${mp4}\n`);
