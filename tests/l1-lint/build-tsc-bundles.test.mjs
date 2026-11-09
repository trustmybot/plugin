// L1 lint (GH 2694): mcp/trajectory-server's build:tsc ends with build:bundle, so a verification of `npm run build:tsc && node --test ...` never runs on stale dist/hooks.js, dist/cli.js or dist/index.js, and build reaches build:bundle only through build:tsc, so the bundles build once.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PKG = join(ROOT, 'mcp', 'trajectory-server', 'package.json');
const RUN_BUNDLE_RE = /\b(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?build:bundle\b/g;

export function buildScriptProblems(scripts) {
  const problems = [];
  const tsc = scripts['build:tsc'] || '';
  const build = scripts.build || '';
  if (!scripts['build:bundle']) problems.push('scripts.build:bundle is missing');
  if ((tsc.match(RUN_BUNDLE_RE) || []).length !== 1) problems.push('scripts.build:tsc must run build:bundle exactly once');
  else if (!/&&\s*(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?build:bundle\s*$/.test(tsc)) problems.push('scripts.build:tsc must end with build:bundle, after tsc');
  if (!/\brun\s+build:tsc\b/.test(build)) problems.push('scripts.build must run build:tsc');
  if ((build.match(RUN_BUNDLE_RE) || []).length !== 0) problems.push('scripts.build must not run build:bundle directly; build:tsc already does');
  return problems;
}

test('the checker accepts the intended shape and rejects each drift', () => {
  const bundle = 'esbuild src/index.ts --bundle --outfile=dist/index.js';
  const good = { 'build:tsc': 'tsc -p tsconfig.build.json && tsc && bun run build:bundle', 'build:bundle': bundle, build: 'bun run build:tsc && cp a b' };
  assert.deepEqual(buildScriptProblems(good), []);
  assert.deepEqual(buildScriptProblems({ ...good, 'build:tsc': 'tsc -p tsconfig.build.json && tsc' }), ['scripts.build:tsc must run build:bundle exactly once']);
  assert.deepEqual(buildScriptProblems({ ...good, 'build:tsc': 'bun run build:bundle && tsc' }), ['scripts.build:tsc must end with build:bundle, after tsc']);
  assert.deepEqual(buildScriptProblems({ ...good, build: 'bun run build:tsc && bun run build:bundle && cp a b' }), [
    'scripts.build must not run build:bundle directly; build:tsc already does',
  ]);
  assert.deepEqual(buildScriptProblems({ ...good, build: 'bun run build:bundle && cp a b' }), [
    'scripts.build must run build:tsc',
    'scripts.build must not run build:bundle directly; build:tsc already does',
  ]);
});

test('mcp/trajectory-server build:tsc rebuilds the bundles and build runs them once', () => {
  const { scripts } = JSON.parse(readFileSync(PKG, 'utf8'));
  assert.deepEqual(buildScriptProblems(scripts), [], 'Fix mcp/trajectory-server/package.json scripts: build:tsc ends with `&& bun run build:bundle`, build calls only build:tsc');
});
