// #386 FÁZIS-0 — FAIL-CLOSED LEAK GATE. Four checks; ANY violation exits 1 (run in CI before merge).
// Proves the public/private split is REAL: the core never imports the vertical (GATE 1), no private
// substance leaks into core source (GATE 2), the public BINARY is vertical-free (GATE 3), and the
// dbproject audit anchor is unperturbed (GATE 4). Mirror of the compile-time PolicyRegistry cut.
//
// Usage: node scripts/leak-gate.mjs   (npm run leak-gate)
import { readdirSync, readFileSync, statSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { build as esbuild } from 'esbuild';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'src');

// The vertical roots a vertical may import freely; the core must never reach into them.
const VERTICAL_ROOTS = ['cs', 'bookkeeper', 'portal', 'modules'];
// The SINGLE core-tree file allowed to name the vertical (the private KKV entry).
const KKV_MAIN = 'src/app/kkv-main.ts';

// #386 F0 KNOWN, BOUNDED LEAK DEBT (loud, reviewed — NOT silently passed). F1 cuts these.
//  - config/types.ts: still ships the vertical's PortalConfig/CsConfig + '/api/bk/' (gray#2, pending).
//  - #416 gray#1 PAID: src/db/migrations.ts no longer carries vertical DDL — the bk_/cs_/nav_/portal_
//    migrations (ids 0016-0025) moved to the accounting ModulePack's migrations slot, so the core file
//    is vertical-free and is removed from this allow-list (the gate now holds it to the strict standard).
const KNOWN_F0_DEBT = ['src/config/types.ts'];
//  - the privacy-core *.test.ts that carry HU substance AND import the compile-time PolicyRegistry
//    packs (modules/accounting/pack, modules/payroll/pack). They are TEST files — EXCLUDED from the
//    public BINARY (dist). For a public-REPO split they must relocate into the vertical, but that
//    touches the soak-FROZEN privacy-core tree (gate the move on a soak window + ORACLE/PROBE). The
//    public-REPO-vs-BINARY granularity is an unresolved open question (tracked to NEXUS).
const KNOWN_F0_TEST_DEBT = ['src/boundary/cut.test.ts', 'src/boundary/token/token.test.ts'];

const rel = (p) => relative(ROOT, p).replaceAll('\\', '/');
const isVerticalRoot = (r) => VERTICAL_ROOTS.some((v) => r === `src/${v}` || r.startsWith(`src/${v}/`));

function allTs(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...allTs(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

const failures = [];
const fail = (gate, msg) => failures.push(`[${gate}] ${msg}`);

// ---------------------------------------------------------------- GATE 1: import-direction
// Walk ALL of src/ MINUS the vertical roots MINUS *.test.ts MINUS kkv-main. Forbid static `from`,
// dynamic import() and require() that reach a vertical root, at ANY relative depth + the bare form.
// Type-only imports are NOT exempt (an `import type` still pulls vertical source into tsc).
{
  const v = VERTICAL_ROOTS.join('|');
  const FORBIDDEN_FROM = new RegExp(`from\\s+['"][^'"]*(?:\\.{1,3}/)+(${v})/`);
  const FORBIDDEN_DYN = new RegExp(`\\bimport\\s*\\(\\s*['"][^'"]*(?:\\.{1,3}/)+(${v})/`);
  const FORBIDDEN_REQ = new RegExp(`\\brequire\\s*\\(\\s*['"][^'"]*(?:\\.{1,3}/)+(${v})/`);
  const offenders = [];
  for (const f of allTs(SRC)) {
    const r = rel(f);
    if (isVerticalRoot(r) || r.endsWith('.test.ts') || r === KKV_MAIN) continue;
    const src = readFileSync(f, 'utf8');
    if (FORBIDDEN_FROM.test(src) || FORBIDDEN_DYN.test(src) || FORBIDDEN_REQ.test(src)) offenders.push(r);
  }
  if (offenders.length) for (const o of offenders) fail('GATE1', `core file imports a vertical: ${o}`);
  else console.log('GATE1 import-direction: OK (no core file imports cs/bookkeeper/portal/modules)');
}

// ---------------------------------------------------------------- GATE 2: content-denylist (substance)
// HIGH-CONFIDENCE substance that has NO legitimate place in core source. Fails for ANY non-vertical
// file EXCEPT the bounded, reviewed KNOWN_F0_DEBT / KNOWN_F0_TEST_DEBT. The broad table-name + COA
// literal sub-checks are REPORTED (not failed): they false-positive on legitimate core privacy logic
// (autonomy 'nav_submit', backupPartition classifyStore, router tests) and are the spec's explicit
// human-reviewed seam (GATE-2 completeness open question) pending NEXUS/PROBE/ORACLE sign-off.
{
  const HIGH = [
    [/\b\d{8}-\d-\d{2}\b/, 'HU tax-id'],
    [/\bDE\d{9}\b/, 'EU-VAT (DE)'],
    [/NAV-TX-\d{4}/, 'NAV transaction id'],
    [/\bNAV-[A-Z0-9]{2,}-[A-Z0-9-]{4,}\b/, 'NAV reference'],
  ];
  const SOFT = [
    [/\b(bk_[a-z_]+|cs_[a-z_]+|nav_[a-z_]+)\b/, 'vertical table-name literal'],
    [/Globál|Kávézó|árbevétel(e)?|Vevők|Beruh[áa]z|Sz[áa]llít[óo]k/, 'COA/customer string'],
    [/\/api\/bk\//, "'/api/bk/' path in core"],
  ];
  const allowed = new Set([...KNOWN_F0_DEBT, ...KNOWN_F0_TEST_DEBT]);
  const softHits = [];
  for (const f of allTs(SRC)) {
    const r = rel(f);
    if (isVerticalRoot(r) || r === KKV_MAIN) continue; // verticals own their substance
    const src = readFileSync(f, 'utf8');
    for (const [re, label] of HIGH) {
      if (re.test(src)) {
        if (allowed.has(r)) continue; // bounded, reviewed debt
        fail('GATE2', `private substance (${label}) in core file: ${r}`);
      }
    }
    for (const [re, label] of SOFT) if (re.test(src) && !allowed.has(r)) softHits.push(`${r} (${label})`);
  }
  console.log('GATE2 content-denylist: HIGH-confidence substance OK (none outside the bounded debt allowlist)');
  console.log(`  KNOWN_F0_DEBT (schema/config, F1 cuts): ${KNOWN_F0_DEBT.join(', ')}`);
  console.log(`  KNOWN_F0_TEST_DEBT (privacy-core tests, soak-frozen; public-REPO relocation pending): ${KNOWN_F0_TEST_DEBT.join(', ')}`);
  if (softHits.length) {
    console.log(`  REVIEWED-SEAM report (NOT failing — table-name/COA/path literals, ${softHits.length} files; many are legit core logic):`);
    for (const h of softHits.slice(0, 20)) console.log(`    - ${h}`);
    if (softHits.length > 20) console.log(`    ... +${softHits.length - 20} more`);
  }
}

// ---------------------------------------------------------------- GATE 3: build-in-stripped-tree
// `tsc -p tsconfig.public.json` into a temp outDir EXITS 0 (the core compiles standalone), and the
// emitted tree contains ZERO vertical file. Import-graph purity != artifact purity — this is the test
// that makes 'the public binary contains zero vertical code' actually TRUE.
{
  const out = mkdtempSync(join(tmpdir(), 'f0-public-'));
  try {
    const r = spawnSync('npx', ['tsc', '-p', 'tsconfig.public.json', '--outDir', out], { cwd: ROOT, encoding: 'utf8' });
    if (r.status !== 0) {
      fail('GATE3', `tsc -p tsconfig.public.json did NOT compile standalone (exit ${r.status}):\n${(r.stdout || '') + (r.stderr || '')}`);
    } else {
      const verticals = allFiles(out).filter((p) => /\/(cs|bookkeeper|portal|modules)\//.test(p));
      if (verticals.length) for (const x of verticals.slice(0, 10)) fail('GATE3', `vertical file in public build: ${relative(out, x)}`);
      else console.log('GATE3 build-in-stripped-tree: OK (tsc public exits 0; dist tree has 0 vertical files)');
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- GATE 4: audit-anchor invariance
// The dbproject bundle sha256 must equal the pinned anchor (catches re-coupling of pack/dbProjectCli/
// exportFieldPolicy to the new runtime module.ts), and there must be NO barrel src/modules/accounting/index.ts.
const EXPECTED_DBPROJECT_SHA256 = '33cfe32c140aa1c411dff337b2b114b3ff3f12d27ec748bde396959a1ed175dc';
{
  if (existsSync(join(SRC, 'modules/accounting/index.ts'))) {
    fail('GATE4', 'a barrel src/modules/accounting/index.ts exists (would risk pulling runtime module.ts into the dbproject closure)');
  }
  const out = mkdtempSync(join(tmpdir(), 'f0-dbproject-'));
  try {
    const outfile = join(out, 'dbproject.mjs');
    const r = spawnSync('node', [join(ROOT, 'scripts/build-dbproject.mjs'), outfile], { cwd: ROOT, encoding: 'utf8' });
    if (r.status !== 0) {
      fail('GATE4', `build-dbproject.mjs failed (exit ${r.status}): ${r.stderr}`);
    } else {
      const got = createHash('sha256').update(readFileSync(outfile)).digest('hex');
      if (got !== EXPECTED_DBPROJECT_SHA256) fail('GATE4', `dbproject sha256 ${got} != pinned ${EXPECTED_DBPROJECT_SHA256} (audit anchor moved)`);
      else console.log(`GATE4 audit-anchor: OK (dbproject sha256 == pinned ${EXPECTED_DBPROJECT_SHA256.slice(0, 12)}…; no barrel)`);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- GATE 5: web-shell vertical-free (#425)
// The CORE web entry (web/src/main.ts) must bundle with ZERO vertical web modules in its input graph —
// the web twin of GATE1 (import-direction) + GATE3 (stripped-tree), enforce-not-instruct. The bookkeeping
// + CS views, the bkRoute engine model, the vertical web-registration module and the private/portal entries
// are vertical; only the composed entry (web/src/kkv-main.ts) may reach them.
{
  const VERTICAL_WEB = [
    /web\/src\/views\/bkRoute\.ts$/,
    /web\/src\/views\/cs\.ts$/,
    /web\/src\/views\/bookkeeping\//,
    /web\/src\/views\/verticalWeb\.ts$/,
    /web\/src\/kkv-main\.ts$/,
    /web\/src\/portal\.ts$/,
  ];
  const result = await esbuild({
    entryPoints: [join(ROOT, 'web/src/main.ts')],
    bundle: true, format: 'esm', target: 'es2022', write: false, metafile: true, logLevel: 'silent',
  });
  const inputs = Object.keys(result.metafile.inputs);
  const leaked = inputs.filter((p) => VERTICAL_WEB.some((re) => re.test(p)));
  if (leaked.length) fail('GATE5', `the core web entry (main.ts) pulls vertical web modules: ${leaked.join(', ')}`);
  else console.log(`GATE5 web-shell vertical-free: OK (core web entry main.ts bundles 0 vertical view module; ${inputs.length} core inputs)`);
}

function allFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...allFiles(p));
    else out.push(p);
  }
  return out;
}

if (failures.length) {
  console.error(`\n#386 LEAK-GATE FAILED (${failures.length}):`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log('\n#386 LEAK-GATE PASSED — public/private split holds (import-direction, substance, artifact-purity, audit-anchor, web-shell).');
