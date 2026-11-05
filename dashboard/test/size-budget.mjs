// Size budget for dashboard/dist/web (or the directory in argv[2]): app.js +
// app.css plus the chunks app.js imports statically stay under 250 KiB
// gzipped, and every .js/.css file other than app.js and app.css stays under
// 60 KiB gzipped. Prints each file's gzipped size and exits 1 on any breach.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { gzipSync } from 'node:zlib';

const WEB = process.argv[2] ?? join(new URL('..', import.meta.url).pathname, 'dist/web');
const ENTRY_BUDGET = 250 * 1024;
const CHUNK_BUDGET = 60 * 1024;

const isDir = (p) => existsSync(p) && statSync(p).isDirectory();
const isFile = (p) => existsSync(p) && statSync(p).isFile();

if (!isDir(WEB)) {
  console.error(`✗ ${WEB} missing; run bun run build in dashboard/`);
  process.exit(1);
}
const app = join(WEB, 'app.js');
if (!isFile(app)) {
  console.error(`✗ ${app} missing`);
  process.exit(1);
}

const gz = (path) => gzipSync(readFileSync(path), { level: 9 }).length;
const row = (rel, size, note) => console.log(`  ${rel.padEnd(40)} ${String(size).padStart(7)} B gz${note}`);

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return files(p);
    return e.isFile() && /\.(js|css)$/.test(e.name) ? [p] : [];
  });
}

let failed = false;
let entry = 0;
for (const name of ['app.js', 'app.css']) {
  const f = join(WEB, name);
  if (!isFile(f)) continue;
  const size = gz(f);
  row(name, size, ' (entry)');
  entry += size;
}

const statics = new Set(
  [...readFileSync(app, 'utf8').matchAll(/(?:from|import) ?"\.\/(chunks\/[^"]+)"/g)].map((m) => m[1]),
);

const byBytes = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
for (const f of files(WEB).sort(byBytes)) {
  const rel = relative(WEB, f);
  if (rel === 'app.js' || rel === 'app.css') continue;
  const size = gz(f);
  let note = '';
  if (statics.has(rel)) {
    entry += size;
    note = ' (loaded by app.js)';
  }
  row(rel, size, note);
  if (size > CHUNK_BUDGET) {
    console.error(`✗ ${rel} is ${size} B gzipped, over the ${CHUNK_BUDGET} B per-chunk budget`);
    failed = true;
  }
}

if (entry > ENTRY_BUDGET) {
  console.error(`✗ dashboard entry bundle is ${entry} B gzipped, over the ${ENTRY_BUDGET} B budget`);
  failed = true;
}
if (failed) process.exit(1);
console.log(`✓ dashboard entry bundle ${entry} B gzipped (budget ${ENTRY_BUDGET} B); every other chunk under ${CHUNK_BUDGET} B`);
