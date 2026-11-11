// lintFingerprint (GH 2570) over a temp git repo: stable, moved by matched blobs and the close-lints config, not by unmatched files.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CLOSE_LINTS_PATH, fingerprintDigest, lintFingerprint, matchesInput } from '../hooks/lib/lint-fingerprint.js';
import { childEnv, GIT_ENV } from './db-test-fixtures.js';

const ENV = childEnv(GIT_ENV);
const INPUTS = ['src/**/*.ts', 'package.json'];

const git = (cwd: string, ...a: string[]): string =>
  execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t.t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...a], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: ENV,
  })
    .toString()
    .trim();

describe('lintFingerprint (GH 2570)', () => {
  let repo: string;

  const commit = (files: Record<string, string>): string => {
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), body);
    }
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'change');
    return git(repo, 'rev-parse', 'HEAD');
  };
  const fp = (sha: string, inputs: readonly string[] = INPUTS) => lintFingerprint(repo, sha, inputs, ENV);

  before(() => {
    repo = mkdtempSync(join(tmpdir(), 'tmb-lint-fingerprint-'));
    git(repo, 'init', '-q', '-b', 'dev');
  });

  after(() => rmSync(repo, { recursive: true, force: true }));

  it('is stable, moves with a matched file or the close-lints config, and ignores an unmatched file', async () => {
    const base = commit({
      'src/a.ts': 'a\n',
      'src/lib/b.ts': 'b\n',
      'package.json': '{}\n',
      'docs/x.md': 'x\n',
      [CLOSE_LINTS_PATH]: '{"lints":[],"fingerprint_inputs":[]}\n',
    });
    const first = await fp(base);
    assert.match(first ?? '', /^v1:[0-9a-f]{64}$/);
    assert.equal(await fp(base), first, 'two calls on one commit agree');

    const unmatched = commit({ 'docs/x.md': 'x v2\n', 'src/a.js': 'js\n' });
    assert.equal(await fp(unmatched), first, 'a change outside the inputs leaves it');

    const matched = commit({ 'src/lib/b.ts': 'b v2\n' });
    const second = await fp(matched);
    assert.notEqual(second, first, 'a matched file content change moves it');

    const config = commit({ [CLOSE_LINTS_PATH]: '{"lints":[{"name":"l","command":"true"}],"fingerprint_inputs":[]}\n' });
    assert.notEqual(await fp(config), second, 'a close-lints.json change moves it');
    assert.notEqual(await fp(config, []), await fp(matched, []), 'close-lints.json counts with no inputs at all');
  });

  it('is the digest of the matched blobs', async () => {
    const sha = commit({ 'src/only.ts': 'only\n' });
    const oids = git(repo, 'ls-tree', '-r', '--full-tree', sha)
      .split('\n')
      .map((line) => {
        const [meta, path] = line.split('\t');
        return { path, oid: meta.split(' ')[2] };
      })
      .filter((e) => e.path === CLOSE_LINTS_PATH || e.path === 'package.json' || /^src\/.*\.ts$/.test(e.path));
    const got = await fp(sha);
    assert.equal(got, fingerprintDigest(oids));
    assert.notEqual(fingerprintDigest(oids.slice(1)), got, 'dropping a matched blob moves it');
    assert.equal(fingerprintDigest([...oids].reverse()), got, 'entry order does not matter');
  });

  it('matches files under dot directories with **/* and .config/** inputs (F636-1)', async () => {
    assert.equal(matchesInput('.github/x.yml', '**/*'), true);
    assert.equal(matchesInput('.github/.x.yml', '**/*'), true);
    assert.equal(matchesInput('.config/tmb/a.json', '.config/**'), true);
    assert.equal(matchesInput('.github/x.yml', '.config/**'), false);
    assert.equal(matchesInput('src/a.js', 'src/**/*.ts'), false);

    const before = commit({ '.github/x.yml': 'on: push\n' });
    const all = await fp(before, ['**/*']);
    const after = commit({ '.github/x.yml': 'on: pull_request\n' });
    assert.notEqual(await fp(after, ['**/*']), all, 'a .github/ change moves a **/* fingerprint');
    assert.equal(await fp(after, ['.config/**']), await fp(before, ['.config/**']), 'but not a .config/** one');
  });

  it('returns null for a bad sha or a path that is not a repo', async () => {
    assert.equal(await fp('0000000000000000000000000000000000000000'), null);
    assert.equal(await fp('not-a-ref'), null);
    assert.equal(await fp('--output=/dev/null'), null);
    assert.equal(await fp(''), null);
    assert.equal(await lintFingerprint(join(repo, 'missing'), 'HEAD', INPUTS, ENV), null);
  });
});
