// #360 — the PINNED, deterministic build of the (b)-DB masking projector bundle (dbproject.mjs).
//
// WHY THIS EXISTS: the deployable projector is a single self-contained node bundle that RELAY runs without
// tsx/node_modules (`node dbproject.mjs < raw-rows.jsonl > projected.jsonl`). An auditor must be able to
// reproduce that bundle BYTE-FOR-BYTE from a clean checkout to confirm the deployed mask matches the audited
// source. esbuild output is FLAG- and VERSION-sensitive (same source + different flags/esbuild version =>
// different bytes), so an improvised `npx esbuild ...` line is NOT a reproducible anchor. This script pins both:
//   - the esbuild VERSION (asserted at runtime against the package-lock pin; run after `npm ci`),
//   - the exact FLAGS (bundle + platform=node + format=esm, nothing else — no minify/sourcemap/target/keep-names,
//     all of which would change the bytes).
//
// Auditor repro flow:  npm ci  &&  node scripts/build-dbproject.mjs  ->  compare the printed sha256.
// Optional first arg overrides the output path (e.g. the deploy staging location).

import { build, version as esbuildVersion } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The pinned esbuild version. Must match the package-lock pin; bumping it is a deliberate change to the
// reproducibility anchor and must be made here AND in package.json together.
const PINNED_ESBUILD = '0.25.12';

if (esbuildVersion !== PINNED_ESBUILD) {
  throw new Error(
    `#360 dbproject build is pinned to esbuild ${PINNED_ESBUILD}, but the resolved esbuild is ${esbuildVersion}. ` +
      `Run \`npm ci\` (which installs the package-lock pin) before building; do not \`npm install\` a newer esbuild.`,
  );
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(root, 'src', 'modules', 'accounting', 'dbProjectMain.ts');
const outfile = process.argv[2] ? resolve(process.cwd(), process.argv[2]) : join(root, 'dist', 'dbproject.mjs');

mkdirSync(dirname(outfile), { recursive: true });

// The CANONICAL flag set — exactly the audited recipe. Do NOT add flags: each one changes the output bytes.
await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
});

const sha256 = createHash('sha256').update(readFileSync(outfile)).digest('hex');
process.stdout.write(`dbproject.mjs built (esbuild ${PINNED_ESBUILD}, --bundle --platform=node --format=esm)\n`);
process.stdout.write(`  out:    ${outfile}\n`);
process.stdout.write(`  sha256: ${sha256}\n`);
