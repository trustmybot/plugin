// L1 lint: the plugin checkout neither tracks nor contains a `.tmp-*` dir at its root, scratch a test left behind that a scan could register as a project repo (GH 1551); scratchDirs(root) checks any other root.
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function scratchDirs(root = ROOT) {
  const found = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('.tmp-'))
    .map((e) => e.name);
  if (existsSync(join(root, '.git'))) {
    try {
      const tracked = execFileSync('git', ['-C', root, 'ls-files', '--', '.tmp-*'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      for (const f of tracked.split('\n').filter(Boolean)) found.push(f.split('/')[0]);
    } catch {}
  }
  return [...new Set(found)].sort();
}

function failureMessage(root, found) {
  return [`  ✗ scratch dirs at ${root} (tracked or on disk; tests must clean up after themselves):`, ...found.map((d) => `      ${d}`)].join('\n');
}

test('self-test: a root holding .tmp-probe/ fails and the same root without it passes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tmb-no-scratch-'));
  try {
    mkdirSync(join(dir, '.tmp-probe'));
    assert.deepEqual(scratchDirs(dir), ['.tmp-probe'], 'self-test: a root holding .tmp-probe/ should fail');
    rmdirSync(join(dir, '.tmp-probe'));
    assert.deepEqual(scratchDirs(dir), [], 'self-test: a root with no .tmp-* dir should pass');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a tracked .tmp-* path fails even when it is gone from disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tmb-no-scratch-git-'));
  try {
    execFileSync('git', ['-C', dir, 'init', '-q']);
    mkdirSync(join(dir, '.tmp-left'));
    writeFileSync(join(dir, '.tmp-left', 'state.json'), '{}\n');
    execFileSync('git', ['-C', dir, 'add', '.tmp-left/state.json']);
    rmSync(join(dir, '.tmp-left'), { recursive: true, force: true });
    const found = scratchDirs(dir);
    assert.deepEqual(found, ['.tmp-left']);
    assert.match(failureMessage(dir, found), /scratch dirs at .*\n {6}\.tmp-left/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no .tmp-* scratch dir at the checkout root', () => {
  const found = scratchDirs(ROOT);
  assert.deepEqual(found, [], failureMessage(ROOT, found));
});
