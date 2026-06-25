// Bundle the public SPA into web/dist (served by the orchestrator's static handler).
// PUBLIC OPEN-CORE: core-only build (entry = main.ts). The full composed build lives in the private
// repo; this public mirror builds the core shell only.
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const webDir = join(root, 'web');
const outDir = join(webDir, 'dist');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(join(outDir, 'assets'), { recursive: true });

const common = { bundle: true, format: 'esm', target: 'es2022', sourcemap: true, minify: true };
await build({ ...common, entryPoints: [join(webDir, 'src', 'main.ts')], outfile: join(outDir, 'assets', 'app.js') });

for (const [from, to] of [
  ['index.html', 'index.html'],
  ['manifest.webmanifest', 'manifest.webmanifest'],
  ['sw.js', 'sw.js'],
  ['icon.svg', 'icon.svg'],
  ['styles/tokens.css', 'assets/tokens.css'],
  ['styles/app.css', 'assets/app.css'],
  ['i18n', 'i18n'],
]) {
  cpSync(join(webDir, from), join(outDir, to), { recursive: true });
}

// Cache-busting: stamp a short CONTENT hash and rewrite index.html's asset URLs to `?v=<hash>`,
// so an unchanged redeploy keeps the cache warm but a changed bundle loads immediately.
const hashOf = (rel) => createHash('sha256').update(readFileSync(join(outDir, rel))).digest('hex').slice(0, 10);
const ver = { 'app.js': hashOf('assets/app.js'), 'app.css': hashOf('assets/app.css'), 'tokens.css': hashOf('assets/tokens.css') };
{
  const p = join(outDir, 'index.html');
  let html = readFileSync(p, 'utf8');
  for (const [name, v] of Object.entries(ver)) {
    html = html.replace(new RegExp(`(/assets/${name.replace('.', '\\.')})(\\?v=[0-9a-f]+)?`, 'g'), `$1?v=${v}`);
  }
  writeFileSync(p, html);
}

console.error('web bundle written to web/dist');
