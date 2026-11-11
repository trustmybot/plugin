// L1 lint (GH 2149): mcp/trajectory-server/dist/index.js and run-scan.js are self-contained esbuild bundles (first line opens with the `var __` prelude, no relative import/export ... from line), not tsc module output, so a marketplace install with no node_modules still boots (#647, GH 1157).
import { strict as assert } from 'node:assert';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIX = join(ROOT, 'tests', 'l1-lint', 'fixtures', 'dist-bundles');
const DIST = join(ROOT, 'mcp', 'trajectory-server', 'dist');
const RELATIVE_IMPORT_RE = /^(import|export) .* from ['"]\.\.?\//;

export function checkBundle(file, label) {
  if (!existsSync(file) || statSync(file).size === 0) return `  ✗ ${label} is missing or empty`;
  const lines = readFileSync(file, 'utf8').split('\n');
  if (!lines[0].startsWith('var __')) return `  ✗ ${label} does not open with the esbuild prelude (\`var __\`): ${lines[0]}`;
  const relative = lines.filter((l) => RELATIVE_IMPORT_RE.test(l)).length;
  if (relative !== 0) return `  ✗ ${label} has ${relative} relative import/export line(s) — tsc module output, not a bundle`;
  return null;
}

test('the bundle-shaped fixture passes and the tsc-module-shaped fixture fails', () => {
  assert.equal(checkBundle(join(FIX, 'bundle.js'), 'fixtures/dist-bundles/bundle.js'), null, 'Dist-bundles self-test: FAIL — bundle-shaped fixture rejected');
  assert.notEqual(checkBundle(join(FIX, 'module.js'), 'fixtures/dist-bundles/module.js'), null, 'Dist-bundles self-test: FAIL — tsc-module-shaped fixture accepted');
});

test('a missing bundle is caught', () => {
  assert.equal(checkBundle(join(FIX, 'absent.js'), 'fixtures/dist-bundles/absent.js'), '  ✗ fixtures/dist-bundles/absent.js is missing or empty');
});

test('dist entrypoints are esbuild bundles', () => {
  const problems = ['index.js', 'run-scan.js']
    .map((name) => checkBundle(join(DIST, name), `mcp/trajectory-server/dist/${name}`))
    .filter(Boolean);
  assert.deepEqual(
    problems,
    [],
    [
      ...problems,
      '',
      '  These dist entrypoints must be esbuild bundles. To fix:',
      '    cd mcp/trajectory-server && bun run build',
      '    git add mcp/trajectory-server/dist/',
      'Dist-bundles: FAIL',
    ].join('\n'),
  );
});
