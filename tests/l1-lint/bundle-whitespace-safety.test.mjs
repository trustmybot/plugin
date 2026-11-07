// L1 lint (GH 1163, GH 1850): bundle post-processing rewrites only Bun-store module labels, never whitespace inside generated template literals; every esbuild bundle in build:bundle and its map goes through the postprocessor, and no built bundle keeps a build-location module key.
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SERVER = join(ROOT, 'mcp', 'trajectory-server');
const POSTPROCESSOR = join(SERVER, 'scripts', 'postprocess-bundle.pl');
const PREFIX = 'bundle-whitespace-safety: FAIL: ';

function packageJson() {
  return JSON.parse(readFileSync(join(SERVER, 'package.json'), 'utf8'));
}

export function bundleProblems(script) {
  const processed = new Set();
  for (const step of script.split('&&')) {
    const words = step.trim().split(/\s+/);
    if (words[0] === 'perl' && words[1] === 'scripts/postprocess-bundle.pl') words.slice(2).forEach((w) => processed.add(w));
  }
  const bundles = [...script.matchAll(/--outfile=dist\/([^\s/]+)\.js(?=\s|$)/g)].map((m) => m[1]);
  if (bundles.length === 0) return [`${PREFIX}no --outfile=dist/<name>.js found in mcp/trajectory-server/package.json scripts.build:bundle`];
  return bundles
    .flatMap((name) => [`dist/${name}.js`, `dist/${name}.js.map`])
    .filter((file) => !processed.has(file))
    .map((file) => `${PREFIX}build:bundle must pass ${file} to scripts/postprocess-bundle.pl`);
}

test('package.json uses the shared bundle postprocessor', () => {
  assert.ok(
    readFileSync(join(SERVER, 'package.json'), 'utf8').includes('scripts/postprocess-bundle.pl'),
    `${PREFIX}mcp/trajectory-server/package.json must use the shared bundle postprocessor`,
  );
});

test('production postprocessing changes only Bun-store labels', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tmb-bundle-whitespace-safety-'));
  try {
    const input = join(dir, 'input.js');
    writeFileSync(input, 'const generated = `first line   \nsecond line  \n`;\nconst label = "../../node_modules/.bun/pkg";\n');
    execFileSync('perl', [POSTPROCESSOR, input], { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] });
    assert.equal(
      readFileSync(input, 'utf8'),
      'const generated = `first line   \nsecond line  \n`;\nconst label = "node_modules/.bun/pkg";\n',
      `${PREFIX}production bundle postprocessing changed bytes outside Bun-store labels`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a bundle or map left out of the postprocessor is caught', () => {
  const script =
    'esbuild a.ts --outfile=dist/a.js && esbuild b.ts --outfile=dist/b.js && perl scripts/postprocess-bundle.pl dist/a.js dist/a.js.map dist/b.js';
  assert.deepEqual(bundleProblems(script), [`${PREFIX}build:bundle must pass dist/b.js.map to scripts/postprocess-bundle.pl`]);
  assert.deepEqual(bundleProblems('tsc'), [
    `${PREFIX}no --outfile=dist/<name>.js found in mcp/trajectory-server/package.json scripts.build:bundle`,
  ]);
});

test('every build:bundle bundle and map goes through the postprocessor', () => {
  const problems = bundleProblems(packageJson().scripts['build:bundle'] || '');
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('no built bundle carries a build-location module key', () => {
  const dist = join(SERVER, 'dist');
  const leaked = existsSync(dist)
    ? readdirSync(dist)
        .filter((f) => f.endsWith('.js'))
        .filter((f) => /"(\.\.\/)+node_modules\/\.bun\//.test(readFileSync(join(dist, f), 'utf8')))
        .map((f) => `mcp/trajectory-server/dist/${f}`)
    : [];
  assert.deepEqual(leaked, [], `${PREFIX}built bundle carries a build-location module key: ${leaked.join('\n')}`);
});
