// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * Headless screenshots for the NEXUS Judge-Panel view (BUILD-judge-panel Phase 5),
 * in HU and EN: the panel board (solver/judge rows), per-solution verdicts with
 * refutation severities, the ranked decision trace + which step decided, and the
 * four-stage gate with evidence.
 *
 * Boots the real app on the fake adapter, then seeds ONE fully-progressed panel
 * (gated_review with branch+test+review passed, approve pending) via a second WAL
 * connection to the same DB file, so the view renders a rich, realistic state.
 * Run: node --import tsx scripts/shots-panels.ts
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

const stateDir = mkdtempSync(join(tmpdir(), 'orch-shotsP-'));
const port = 19700 + Math.floor(Math.random() * 400);
const base = `http://127.0.0.1:${port}`;
const agent = (id: string) => ({
  id, displayName: id.toUpperCase(), role: 'Agent', securityProfile: 'draft', accentColor: '#888',
  authMode: 'shared-subscription', team: { role: 'member', reportsTo: 'nexus', delegatesTo: [], trustFrom: ['nexus'] },
});
writeFileSync(join(stateDir, 'config.json'), JSON.stringify({
  branding: { productName: 'PanelShots' },
  locale: { default: 'hu', agentProse: 'hu' },
  timezone: 'Europe/Budapest',
  server: { host: '127.0.0.1', port, allowedOrigins: [] },
  hubId: 'nexus',
  agents: [
    { id: 'nexus', displayName: 'NEXUS', role: 'Hub', securityProfile: 'full-host', accentColor: '#7c5cff', authMode: 'shared-subscription', team: { role: 'hub', delegatesTo: ['forge'], trustFrom: [] } },
    agent('forge'), agent('spark'), agent('probe'), agent('oracle'),
  ],
  lanes: [],
  channels: {},
  runtime: { adapter: 'fake', claude: { command: 'claude', staggerSeconds: 1, sessionPrefix: 'pnl' } },
}), { mode: 0o600 });
process.env.ORCHESTRATOR_STATE_DIR = stateDir;

const { boot } = await import(join(repoRoot, 'src', 'app', 'main.js'));
const handle = await boot();
const shutdown: (() => Promise<void>) | undefined = handle?.shutdown;
const bearer = readFileSync(join(stateDir, 'dashboard-token'), 'utf8').trim();

// --- seed a rich panel via a second WAL connection to the same DB file ---
const { openDatabase } = await import(join(repoRoot, 'src', 'db', 'database.js'));
const { PanelStore } = await import(join(repoRoot, 'src', 'judge', 'store.js'));
const { decideWinner } = await import(join(repoRoot, 'src', 'judge', 'decisionRule.js'));
const seedDb = openDatabase(join(stateDir, 'orchestrator.db'));
const store = new PanelStore(seedDb);
const created = store.createPanel({
  goal: 'Fix the flaky retry test',
  context: 'It fails ~5 times per full run on CI.',
  rubric: { criteria: [{ id: 'correctness', description: 'Achieves the goal', type: 'score', weight: 2 }, { id: 'robustness', description: 'Edge cases', type: 'score', weight: 1 }] },
  decisionRule: { weights: { correctness: 2, robustness: 1, majorDefectPenalty: 1 }, lanePriority: ['forge', 'spark'], noWinnerIfAllVetoed: true },
  testCommand: 'npm run typecheck && npm test',
  branchPrefix: 'panel/flaky',
  solvers: [
    { agentId: 'forge', angle: 'minimal — make the timer deterministic', prompt: 'solver forge' },
    { agentId: 'spark', angle: 'experimental — retries + jitter', prompt: 'solver spark' },
  ],
  judges: [{ role: 'probe', agentId: 'probe', prompt: 'probe' }, { role: 'oracle', agentId: 'oracle', prompt: 'oracle' }],
});
const pid = created.panel.id;
const [s1, s2] = created.solutions;
store.recordSolution(s1!.id, { tailSummary: 'Rewrote the timer onto a deterministic clock; full suite green.', commitSha: 'a1b2c3d4' });
store.recordSolution(s2!.id, { tailSummary: 'Added bounded retries + jitter; flakiness reduced, not eliminated.', commitSha: 'e5f6a7b8' });
store.setStatus(pid, 'judging');
store.addVerdict(pid, { solutionId: s1!.id, judge: 'probe', scores: { correctness: 3, robustness: 2 }, refutations: [{ claim: 'No explicit zero-length input case', severity: 'minor' }], recommendation: 'accept', fatalDefect: false });
store.addVerdict(pid, { solutionId: s1!.id, judge: 'oracle', scores: { correctness: 3 }, refutations: [], recommendation: 'accept', fatalDefect: false });
store.addVerdict(pid, { solutionId: s2!.id, judge: 'probe', scores: { correctness: 2, robustness: 1 }, refutations: [{ claim: 'Retries mask the race, they do not fix it', severity: 'major' }], recommendation: 'revise', fatalDefect: false });
store.addVerdict(pid, { solutionId: s2!.id, judge: 'oracle', scores: { correctness: 2 }, refutations: [], recommendation: 'accept', fatalDefect: false });
store.setStatus(pid, 'deciding');
const snapshot = {
  solutions: [
    { solutionId: s1!.id, lanePriorityIndex: 0, correctness: 6, oracleCorrectness: 3, majorDefects: 0, minorDefects: 1, fatal: false },
    { solutionId: s2!.id, lanePriorityIndex: 1, correctness: 4, oracleCorrectness: 2, majorDefects: 1, minorDefects: 0, fatal: false },
  ],
  config: { weights: { correctness: 2, robustness: 1, majorDefectPenalty: 1 }, noWinnerIfAllVetoed: true },
};
const output = decideWinner(snapshot);
store.recordDecision(pid, { winningSolutionId: output.winningSolutionId, decidedBy: output.decidedBy, ruleOutput: output, snapshot });
store.setStatus(pid, 'gated_review');
store.setGate(pid, 'branch', 'passed', 'panel/flaky/sol-forge is 3 commits ahead of main (branch-isolated)');
store.setGate(pid, 'test', 'passed', '$ npm run typecheck && npm test → exit 0 (suite green)');
store.setGate(pid, 'review', 'passed', 'PROBE re-refute accepted winner #' + String(output.winningSolutionId));
store.setGate(pid, 'approve', 'pending', null);
seedDb.prepare('UPDATE kanban_cards SET requires_approval = 1 WHERE id = ?').run(created.panel.parentCardId);
seedDb.close();

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1320, height: 1100 } });
const shot = (name: string) => page.screenshot({ path: join(artifactsDir, name), fullPage: true });
try {
  for (const lang of ['hu', 'en'] as const) {
    await page.goto(`${base}/?token=${bearer}`, { waitUntil: 'networkidle' });
    await page.evaluate((l) => { try { localStorage.setItem('ui.lang', l); } catch { /* ignore */ } }, lang);
    await page.goto(`${base}/?token=${bearer}#panels`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.panel-detail-head', { timeout: 15_000 });
    await page.waitForSelector('.panel-rank-row', { timeout: 10_000 });
    await page.waitForTimeout(350);
    await shot(`panels-board-${lang}.png`);
  }
  console.log('SHOTS-PANELS OK');
} finally {
  await browser.close();
  await shutdown?.();
  rmSync(stateDir, { recursive: true, force: true });
  delete process.env.ORCHESTRATOR_STATE_DIR;
}
