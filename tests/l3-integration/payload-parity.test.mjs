// L3: scripts/maintenance/payload-parity.ts checks that HEAD holds every
// generated path a reference ref holds (GH 2054), in a synthetic repo.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = join(ROOT, 'scripts/maintenance/payload-parity.ts');
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.invalid',
};

const GENERATED = [
  'mcp/trajectory-server/dist/index.js',
  'mcp/trajectory-server/dist/hooks.js',
  'dashboard/dist/server.mjs',
  'scripts/hooks/lib/audit-events.txt',
  'scripts/hooks/lib/data-contracts.json',
];

function git(cwd, ...args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { env: GIT_ENV, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

function parity(root, ref) {
  return spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', SCRIPT, '--root', root, '--ref', ref], {
    encoding: 'utf8',
  });
}

function repoWith(t, files) {
  const repo = mkdtempSync(join(tmpdir(), 'payload-parity-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, 'init', '-q');
  for (const f of ['README.md', ...files]) {
    mkdirSync(dirname(join(repo, f)), { recursive: true });
    writeFileSync(join(repo, f), `${f}\n`);
  }
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'reference');
  git(repo, 'tag', 'reference');
  return repo;
}

test('passes when HEAD holds every generated path of the ref', (t) => {
  const repo = repoWith(t, GENERATED);
  writeFileSync(join(repo, 'mcp/trajectory-server/dist/extra.js'), 'x\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'build');
  const r = parity(repo, 'reference');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /holds all generated paths of reference/);
});

test('fails listing a generated file the ref holds and HEAD lacks', (t) => {
  const repo = repoWith(t, GENERATED);
  git(repo, 'rm', '-q', 'dashboard/dist/server.mjs', 'README.md');
  git(repo, 'commit', '-q', '-m', 'build');
  const r = parity(repo, 'reference');
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /1 generated paths in reference are missing from HEAD/);
  assert.match(r.stdout, /^ {2}dashboard\/dist\/server\.mjs$/m);
  assert.doesNotMatch(r.stdout, /README\.md/);
});

test('fails when HEAD holds no generated file', (t) => {
  const repo = repoWith(t, []);
  const r = parity(repo, 'reference');
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /HEAD holds no generated file/);
});

test('exits 2 without --ref', (t) => {
  const repo = repoWith(t, GENERATED);
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', SCRIPT, '--root', repo], { encoding: 'utf8' });
  assert.equal(r.status, 2);
});

test('runs when invoked through a symlinked directory', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'payload-parity-link-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const link = join(dir, 'root');
  symlinkSync(ROOT, link);
  const r = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', join(link, 'scripts/maintenance/payload-parity.ts'), '--bogus'],
    { encoding: 'utf8' },
  );
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /usage: payload-parity\.ts --ref <ref>/);
});
