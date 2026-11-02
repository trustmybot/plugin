import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installMergeDriver, MERGE_DRIVER_COMMAND, MERGE_DRIVER_NAME, mergeDriverCli } from '../hooks/lib/merge-driver.js';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-merge-driver-unit-')));
after(() => rmSync(TMP, { recursive: true, force: true }));

const ENV: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', ['-C', cwd, ...args], { env: ENV, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

function freshRepo(name: string): string {
  const repo = join(TMP, name);
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'dev');
  return repo;
}

function cli(args: string[]): { code: number; out: string; err: string } {
  let out = '';
  let err = '';
  const code = mergeDriverCli(args, ENV, (t) => (out += t), (t) => (err += t));
  return { code, out, err };
}

describe('tmb-regen merge driver (GH 1692)', () => {
  it('the driver names regen-generated.ts, the string the worktree-create golden records', () => {
    assert.equal(
      MERGE_DRIVER_COMMAND,
      `sh -c 'echo "tmb-regen: kept ours for $1 — run: node --experimental-strip-types scripts/maintenance/regen-generated.ts" >&2' tmb-regen %P`,
    );
    const golden = readFileSync(join(PLUGIN_ROOT, 'tests/fixtures/hook-golden/worktree-create.json'), 'utf8');
    assert.ok(golden.includes(JSON.stringify(MERGE_DRIVER_COMMAND).slice(1, -1)), 'golden records the current driver');
  });

  it("writes name and driver into the repo's local config, once, and returns its path", () => {
    const repo = freshRepo('install');
    assert.equal(installMergeDriver(repo, ENV), `${repo}/.git/config`);
    assert.equal(installMergeDriver(repo, ENV), `${repo}/.git/config`);
    assert.equal(git(repo, 'config', '--local', '--get-all', 'merge.tmb-regen.driver'), `${MERGE_DRIVER_COMMAND}\n`);
    assert.equal(git(repo, 'config', '--local', '--get', 'merge.tmb-regen.name'), `${MERGE_DRIVER_NAME}\n`);
  });

  it('a worktree shares the main checkout config', () => {
    const repo = freshRepo('main');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'base');
    const wt = join(repo, '.claude/worktrees/w');
    git(repo, 'worktree', 'add', '-q', '-b', 'w', wt);
    assert.equal(installMergeDriver(wt, ENV), `${repo}/.git/config`);
    assert.equal(git(repo, 'config', '--local', '--get', 'merge.tmb-regen.driver'), `${MERGE_DRIVER_COMMAND}\n`);
  });

  it('a directory outside git is refused', () => {
    const plain = join(TMP, 'plain');
    mkdirSync(plain);
    assert.equal(installMergeDriver(plain, ENV), null);
    assert.deepEqual(cli([plain]), { code: 1, out: '', err: `install-merge-driver: ${plain} is not a git repository\n` });
  });

  it('the CLI reports the config it wrote', () => {
    const repo = freshRepo('cli');
    assert.deepEqual(cli([repo]), { code: 0, out: `install-merge-driver: merge.tmb-regen installed in ${repo}/.git/config\n`, err: '' });
  });

  it('the driver keeps ours: exits 0 and names the file on stderr', () => {
    const r = spawnSync('sh', ['-c', MERGE_DRIVER_COMMAND.replace('%P', 'dist/index.js')], { encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, 'tmb-regen: kept ours for dist/index.js — run: node --experimental-strip-types scripts/maintenance/regen-generated.ts\n');
  });
});
