// repoGitRoot (GH 2180): the main checkout of the repo a dir is in, a
// submodule and its linked worktrees included, whose common git dir sits
// under the superproject's .git/modules rather than in a checkout.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoGitRoot } from '../hooks/lib/repo.js';

const GIT_ENV: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE']) delete GIT_ENV[key];

function git(dir: string, ...args: string[]): void {
  execFileSync(
    'git',
    ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'protocol.file.allow=always', ...args],
    { env: GIT_ENV, stdio: 'pipe' },
  );
}

function initRepo(dir: string): void {
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'init');
}

const rootOf = (dir: string) => repoGitRoot(dir, GIT_ENV);
const real = (path: string) => realpathSync(path);
const realOrEmpty = (path: string) => (path === '' ? '' : real(path));

describe('repoGitRoot', () => {
  let scratch: string;
  let plain: string;
  let sup: string;
  let sub: string;

  before(() => {
    scratch = mkdtempSync(join(tmpdir(), 'repo-git-root-'));
    plain = join(scratch, 'plain');
    mkdirSync(join(plain, 'src', 'deep'), { recursive: true });
    initRepo(plain);
    git(plain, 'worktree', 'add', '-q', '-b', 'side', join(scratch, 'plainwt'));

    const subsrc = join(scratch, 'subsrc');
    mkdirSync(subsrc);
    initRepo(subsrc);
    sup = join(scratch, 'sup');
    mkdirSync(sup);
    initRepo(sup);
    git(sup, 'submodule', 'add', '-q', subsrc, 'sub');
    sub = join(sup, 'sub');
    mkdirSync(join(sub, 'nested'));
    git(sub, 'worktree', 'add', '-q', '-b', 'subside', '../subwt');
  });

  after(() => rmSync(scratch, { recursive: true, force: true }));

  it('returns the submodule checkout from the submodule and its subdirectory', async () => {
    assert.equal(realOrEmpty(await rootOf(sub)), real(sub));
    assert.equal(realOrEmpty(await rootOf(join(sub, 'nested'))), real(sub));
  });

  it("returns the submodule's main checkout from a linked worktree of it", async () => {
    assert.equal(realOrEmpty(await rootOf(join(sup, 'subwt'))), real(sub));
  });

  it('returns the superproject itself from the superproject', async () => {
    assert.equal(realOrEmpty(await rootOf(sup)), real(sup));
  });

  it('returns the repo root from a plain repo and its subdirectory', async () => {
    assert.equal(realOrEmpty(await rootOf(plain)), real(plain));
    assert.equal(realOrEmpty(await rootOf(join(plain, 'src', 'deep'))), real(plain));
  });

  it("returns a plain repo's main checkout from a linked worktree of it", async () => {
    assert.equal(realOrEmpty(await rootOf(join(scratch, 'plainwt'))), real(plain));
  });

  it('returns the nearest existing parent repo for a missing path inside a submodule', async () => {
    assert.equal(realOrEmpty(await rootOf(join(sub, 'missing', 'file.ts'))), real(sub));
  });

  it("returns '' outside any repo", async () => {
    const loose = mkdtempSync(join(tmpdir(), 'repo-git-root-loose-'));
    try {
      assert.equal(await rootOf(loose), '');
    } finally {
      rmSync(loose, { recursive: true, force: true });
    }
  });
});
