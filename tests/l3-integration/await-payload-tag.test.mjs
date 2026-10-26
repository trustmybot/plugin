// L3: scripts/await-payload-tag.ts waits for payload/<tag> on the plugin remote
// before publish-rc-channel.sh pins it (GH 1699). A local bare repo stands in
// for origin. Asserts exit codes and output only, never elapsed time.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = join(ROOT, 'scripts/await-payload-tag.ts');
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.invalid',
};
const HELPER_ENV = { ...GIT_ENV, TMB_PAYLOAD_TIMEOUT: '' };

function git(cwd, ...args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { env: GIT_ENV, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function remoteWithCommit(t) {
  const dir = mkdtempSync(join(tmpdir(), 'await-payload-tag-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bare = join(dir, 'origin.git');
  const work = join(dir, 'work');
  spawnSync('git', ['init', '-q', '--bare', bare], { env: GIT_ENV });
  spawnSync('git', ['init', '-q', work], { env: GIT_ENV });
  writeFileSync(join(work, 'f'), 'x\n');
  git(work, 'add', 'f');
  git(work, 'commit', '-q', '-m', 'payload');
  git(work, 'push', '-q', bare, 'HEAD:refs/heads/stable-build');
  return { bare, sha: git(work, 'rev-parse', 'HEAD') };
}

function helperArgs(...args) {
  return ['--experimental-strip-types', '--no-warnings', SCRIPT, ...args];
}

function runHelper(...args) {
  return spawnSync(process.execPath, helperArgs(...args), { env: HELPER_ENV, encoding: 'utf8' });
}

test('a payload tag already on the remote → exit 0 with the commit SHA', (t) => {
  const { bare, sha } = remoteWithCommit(t);
  git(bare, 'tag', 'payload/v1.2.0', sha);
  const r = runHelper('v1.2.0', '--remote', bare, '--timeout', '5', '--interval', '1');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `${sha}\n`);
  assert.match(r.stderr, /waiting for refs\/tags\/payload\/v1\.2\.0/);
});

test('a payload tag created while polling → exit 0 with the commit SHA (annotated tag peeled)', async (t) => {
  const { bare, sha } = remoteWithCommit(t);
  const child = spawn(process.execPath, helperArgs('v1.2.0-rc.3', '--remote', bare, '--timeout', '120', '--interval', '1'), {
    env: HELPER_ENV,
  });
  let stdout = '';
  let stderr = '';
  let tagged = false;
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => {
    stderr += d;
    if (!tagged && /poll 2\b/.test(stderr)) {
      tagged = true;
      spawn('git', ['-C', bare, 'tag', '-a', '-m', 'payload', 'payload/v1.2.0-rc.3', sha], { env: GIT_ENV });
    }
  });
  const code = await new Promise((done) => child.on('close', done));
  assert.equal(code, 0, stderr);
  assert.equal(stdout, `${sha}\n`);
  assert.ok(tagged, 'the tag was created after the first poll missed it');
});

test('a payload tag never created → exit 4 naming the release-payload run', (t) => {
  const { bare } = remoteWithCommit(t);
  const r = runHelper('v1.2.0', '--remote', bare, '--timeout', '2', '--interval', '1');
  assert.equal(r.status, 4, r.stderr);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /release-payload/);
  assert.match(r.stderr, /waiting for refs\/tags\/payload\/v1\.2\.0/);
});

test('a bad tag or bad usage → exit 1 without polling', (t) => {
  const { bare } = remoteWithCommit(t);
  for (const args of [['v1.2'], ['payload/v1.2.0'], ['1.2.0'], ['v1.2.0-rc'], [], ['v1.2.0', '--interval', '0'], ['v1.2.0', '--bogus']]) {
    const r = runHelper(...args, '--remote', bare);
    assert.equal(r.status, 1, `${JSON.stringify(args)}: ${r.stderr}`);
    assert.equal(r.stdout, '');
    assert.doesNotMatch(r.stderr, /waiting for/);
  }
});
