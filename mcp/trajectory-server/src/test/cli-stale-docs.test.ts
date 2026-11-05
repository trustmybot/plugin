/**
 * `cli.js stale-docs` (GH 1955), the advisory pre-close check for stale docs
 * and comments, run against the built dist/cli.js bundle in throwaway git repos.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installRoot } from '../hooks/lib/project-env.js';

const PLUGIN_ROOT = installRoot(dirname(fileURLToPath(import.meta.url))) as string;
const CLI = join(PLUGIN_ROOT, 'mcp/trajectory-server/dist/cli.js');
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
};

let repo = '';

function git(...args: string[]): string {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: GIT_ENV });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function write(files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
}

function commit(files: Record<string, string>): string {
  write(files);
  git('add', '-A');
  git('commit', '-qm', 'change');
  return git('rev-parse', 'HEAD');
}

function staleDocs(...args: string[]): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ['--experimental-sqlite', CLI, 'stale-docs', ...args], { cwd: repo, encoding: 'utf8', env: GIT_ENV });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('cli.js stale-docs (GH 1955)', () => {
  let base = '';

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-stale-docs-')));
    git('init', '-q', '-b', 'main');
    base = commit({
      'src/store.ts': 'export const commits_behind = 1;\n',
      'scripts/sync-helper.sh': 'echo one\n',
      'docs/GUIDE.md': 'Intro.\nThe scan stores `commits_behind` per row.\nRun `sync-helper.sh` nightly.\n',
      'src/notes.ts': '// commits_behind counts commits\nconst label = "commits_behind";\n',
    });
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('GH 1955: a renamed snake_case identifier flags an untouched doc line and comment naming the old token', () => {
    const head = commit({ 'src/store.ts': 'export const commits_since = 1;\n' });
    const r = staleDocs(base, '--head', head);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^\S+:\d+: \S/m, 'at least one path:line: token line');
    assert.equal(r.stdout, 'docs/GUIDE.md:2: commits_behind\nsrc/notes.ts:1: commits_behind\n');
  });

  it("a changed file's basename flags a doc line naming it", () => {
    const head = commit({ 'scripts/sync-helper.sh': 'echo two\n' });
    assert.equal(staleDocs(base, '--head', head).stdout, 'docs/GUIDE.md:3: sync-helper.sh\n');
  });

  it('a doc line the diff edited is not flagged', () => {
    const head = commit({
      'src/store.ts': 'export const commits_since = 1;\n',
      'docs/GUIDE.md': 'Intro.\nThe scan stores `commits_behind` and more per row.\nRun `sync-helper.sh` nightly.\n',
    });
    assert.equal(staleDocs(base, '--head', head).stdout, 'src/notes.ts:1: commits_behind\n');
  });

  it('skips a token found on more doc lines than --max-hits', () => {
    const head = commit({ 'src/store.ts': 'export const commits_since = 1;\n' });
    assert.equal(staleDocs(base, '--head', head, '--max-hits', '1').stdout, '');
    assert.equal(staleDocs(base, '--head', head, '--max-hits', '2').stdout.split('\n').filter(Boolean).length, 2);
  });

  it('lists every token of a flagged line comma-separated, sorted by path then line', () => {
    write({ 'docs/A.md': 'x\ny\n`sync-helper.sh` and `commits_behind`\n' });
    git('add', '-A');
    git('commit', '-qm', 'docs');
    const from = git('rev-parse', 'HEAD');
    const head = commit({ 'src/store.ts': 'export const commits_since = 1;\n', 'scripts/sync-helper.sh': 'echo two\n' });
    assert.equal(
      staleDocs(from, '--head', head).stdout,
      'docs/A.md:3: commits_behind, sync-helper.sh\ndocs/GUIDE.md:2: commits_behind\ndocs/GUIDE.md:3: sync-helper.sh\nsrc/notes.ts:1: commits_behind\n',
    );
  });

  it('without --head it diffs the working tree, uncommitted changes included', () => {
    write({ 'src/store.ts': 'export const commits_since = 1;\n' });
    const r = staleDocs('HEAD');
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, 'docs/GUIDE.md:2: commits_behind\nsrc/notes.ts:1: commits_behind\n');
  });

  it('skips changelogs, dist/ and generated docs', () => {
    write({
      'CHANGELOG.md': '`commits_behind`\n',
      'changelog.d/x.md': '`commits_behind`\n',
      'dist/README.md': '`commits_behind`\n',
      'docs/contributing/ENUMS.md': '`commits_behind`\n',
    });
    git('add', '-A');
    git('commit', '-qm', 'docs');
    const from = git('rev-parse', 'HEAD');
    const head = commit({ 'src/store.ts': 'export const commits_since = 1;\n' });
    assert.equal(staleDocs(from, '--head', head).stdout, 'docs/GUIDE.md:2: commits_behind\nsrc/notes.ts:1: commits_behind\n');
  });

  it('exits 2 on bad usage and on an unknown base', () => {
    for (const args of [[], ['a', 'b'], [base, '--max-hits', 'x'], [base, '--bogus']]) {
      const r = staleDocs(...args);
      assert.equal(r.code, 2, `args ${JSON.stringify(args)}`);
      assert.match(r.stderr, /usage: cli\.js stale-docs <base>/);
    }
    const r = staleDocs('no-such-ref');
    assert.equal(r.code, 2);
    assert.match(r.stderr, /^stale-docs: git merge-base failed/);
    assert.equal(r.stdout, '');
  });
});
