// L1 lint: every git-tracked symlink (mode 120000) points at an existing target, catching links left broken by file moves or deletes.
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

export function brokenSymlinks(root) {
  const links = git(root, ['ls-files', '-s'])
    .split('\n')
    .filter((row) => row.startsWith('120000 '))
    .map((row) => row.split('\t')[1])
    .sort();
  const broken = links.filter((link) => !existsSync(join(root, link))).map((link) => `BROKEN symlink: ${link} -> ${readlinkSync(join(root, link))}`);
  return { total: links.length, broken };
}

test('a tracked symlink to a missing target is caught', () => {
  const dir = mkdtempSync(join(tmpdir(), 'symlink-targets-'));
  try {
    git(dir, ['init', '-q']);
    writeFileSync(join(dir, 'real.txt'), 'x\n');
    symlinkSync('real.txt', join(dir, 'good'));
    symlinkSync('gone.txt', join(dir, 'bad'));
    git(dir, ['add', 'real.txt', 'good', 'bad']);
    assert.deepEqual(brokenSymlinks(dir), { total: 2, broken: ['BROKEN symlink: bad -> gone.txt'] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every tracked symlink resolves', (t) => {
  const { total, broken } = brokenSymlinks(ROOT);
  t.diagnostic(`symlink-targets: ${total} symlink(s) checked`);
  assert.deepEqual(broken, [], `${broken.join('\n')}\n\n${broken.length} broken symlink(s) found (checked ${total} total).`);
});
