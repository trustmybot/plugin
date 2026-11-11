// L1 lint: mcp/trajectory-server/package.json and the root package.json carry the version of .claude-plugin/plugin.json, so a release-prep PR that bumps only one fails.
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CANON = '.claude-plugin/plugin.json';
const OTHERS = [
  ['mcp/trajectory-server/package.json', 'mcp/trajectory-server/package.json'],
  ['package.json (workspace root)', 'package.json'],
];

function version(root, rel) {
  return JSON.parse(readFileSync(join(root, rel), 'utf8')).version;
}

export function versionMismatches(root) {
  const canon = version(root, CANON);
  return OTHERS.flatMap(([name, rel]) => {
    const actual = version(root, rel);
    return actual === canon ? [] : [`  ✗ ${name.padEnd(40)} ${actual}  (expected ${canon})`];
  });
}

function failureMessage(root, mismatches) {
  return [
    `Enforcing version sync (canonical: ${CANON} = ${version(root, CANON)})`,
    ...mismatches,
    '',
    'Version sync FAILED. Bump all three to match in the same commit.',
  ].join('\n');
}

test('a manifest that lags the canonical version fails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tmb-version-sync-'));
  try {
    for (const rel of [CANON, ...OTHERS.map(([, r]) => r)]) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), JSON.stringify({ version: '1.2.0' }));
    }
    assert.deepEqual(versionMismatches(dir), []);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '0.3.2' }));
    const mismatches = versionMismatches(dir);
    assert.equal(mismatches.length, 1);
    assert.match(mismatches[0], /✗ package\.json \(workspace root\) +0\.3\.2 {2}\(expected 1\.2\.0\)/);
    assert.match(failureMessage(dir, mismatches), /Version sync FAILED/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('all three version fields agree', () => {
  const mismatches = versionMismatches(ROOT);
  assert.deepEqual(mismatches, [], failureMessage(ROOT, mismatches));
});
