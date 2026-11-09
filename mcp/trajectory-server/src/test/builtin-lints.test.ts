/**
 * builtin-lints.ts (GH 2570) on temp git repos: the missing_changelog and
 * stale_doc_ref checks the close lints run, each against fixed expected
 * results and texts.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { builtinLints, MISSING_CHANGELOG, missingChangelog, STALE_DOC_REF, staleDocRefs } from '../hooks/lib/builtin-lints.js';
import { sandboxDir } from './db-test-fixtures.js';

const BRANCH = 'feat/3-x';
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.com',
};

const BASE_FILES: Record<string, string> = {
  'README.md': 'See docs/guide.md.\n',
  'docs/guide.md': 'Run `scripts/old.sh` first.\n',
  'scripts/old.sh': 'echo old\n',
  'skills/s/SKILL.md': 'Call `mcp__plugin_tmb_trajectory-server__old_tool` then `keep_tool`.\n',
  'mcp/srv/src/tools/t.ts': "export const tools = [\n  {\n    name: 'keep_tool',\n  },\n  {\n    name: 'old_tool',\n  },\n];\n",
  'changelog.d/README.md': 'One file per change.\n',
  'src/a.txt': 'one\n',
};

const BUILT_FILES: Record<string, string> = {
  ...BASE_FILES,
  'docs/guide.md': 'Run `scripts/old.sh` first, then `node pkg/dist/out.js`.\n',
  'pkg/dist/out.js': 'built\n',
};

interface Repo {
  repo: string;
  env: NodeJS.ProcessEnv;
  base: string;
  git(...args: string[]): string;
  write(path: string, text: string): void;
  commit(message: string): string;
}

let sandbox: string;
let seq = 0;

function repoFixture(files: Record<string, string> = BASE_FILES): Repo {
  seq += 1;
  const root = join(sandbox, `case-${seq}`);
  const repo = join(root, 'repo');
  mkdirSync(repo, { recursive: true });
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: join(root, 'home'), ...GIT_ENV };
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  };
  const commit = (message: string) => {
    git('add', '-A');
    git('commit', '-qm', message);
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q', '-b', 'dev');
  for (const [path, text] of Object.entries(files)) write(path, text);
  const base = commit('base');
  git('checkout', '-q', '-b', BRANCH);
  return { repo, env, base, git, write, commit };
}

const changelogExpected = (base: string, sha: string) => `${base}..${sha} adds a file under changelog.d/`;
const staleExpected = (base: string, sha: string) =>
  `no agents/, skills/, docs/ *.md, CLAUDE.md or README.md at ${sha} mentions a path or MCP tool that ${base}..${sha} removes`;

/** A commit that untracks pkg/dist/out.js, which docs/guide.md names; <ignore> writes how the repo ignores it. */
function untrackBuildOutput(r: Repo, ignore: () => void, alsoDropOldSh = false): string {
  r.write('changelog.d/3-x.md', '### Added\n- x (GH 3)\n');
  r.write('docs/guide.md', alsoDropOldSh ? 'Run `scripts/old.sh` first, then `node pkg/dist/out.js`.\n' : 'Run `node pkg/dist/out.js`.\n');
  ignore();
  r.git('rm', '-q', '--cached', 'pkg/dist/out.js');
  if (alsoDropOldSh) r.git('rm', '-q', 'scripts/old.sh');
  return r.commit('untrack dist');
}

describe('builtin lints (GH 2570)', () => {
  before(() => {
    sandbox = sandboxDir('builtin-lints');
  });
  after(() => rmSync(sandbox, { recursive: true, force: true }));

  it('passes both checks on a diff that adds a fragment and removes nothing a doc names', async () => {
    const r = repoFixture();
    r.write('src/a.txt', 'one\ntwo\n');
    r.write('changelog.d/3-x.md', '### Added\n- x (GH 3)\n');
    const sha = r.commit('feature');
    assert.deepEqual(await builtinLints(r.repo, r.base, sha, r.env), [
      { name: 'missing_changelog', exitCode: 0, output: '' },
      { name: 'stale_doc_ref', exitCode: 0, output: '' },
    ]);
  });

  it('fails missing_changelog on a diff that adds no fragment', async () => {
    const r = repoFixture();
    r.write('src/a.txt', 'one\ntwo\n');
    const sha = r.commit('feature without fragment');
    assert.equal(await missingChangelog(r.repo, r.base, sha, r.env), 'no file added under changelog.d/');
    assert.deepEqual(await builtinLints(r.repo, r.base, sha, r.env), [
      { name: MISSING_CHANGELOG, exitCode: 1, output: `expected: ${changelogExpected(r.base, sha)}\nactual: no file added under changelog.d/` },
      { name: STALE_DOC_REF, exitCode: 0, output: '' },
    ]);
  });

  it('passes missing_changelog in a repo without changelog.d/', async () => {
    const files = { ...BASE_FILES };
    delete files['changelog.d/README.md'];
    const r = repoFixture(files);
    r.write('src/a.txt', 'one\ntwo\n');
    const sha = r.commit('feature');
    assert.equal(await missingChangelog(r.repo, r.base, sha, r.env), null);
    assert.deepEqual((await builtinLints(r.repo, r.base, sha, r.env))[0], { name: MISSING_CHANGELOG, exitCode: 0, output: '' });
  });

  it('fails stale_doc_ref on a deleted path, a renamed path and a removed MCP tool the docs still name', async () => {
    const r = repoFixture();
    r.git('rm', '-q', 'scripts/old.sh');
    r.git('mv', 'docs/guide.md', 'docs/handbook.md');
    r.write('mcp/srv/src/tools/t.ts', "export const tools = [\n  {\n    name: 'keep_tool',\n  },\n];\n");
    r.write('changelog.d/3-x.md', '### Added\n- x (GH 3)\n');
    const sha = r.commit('drop old.sh, old_tool; rename guide');
    const hits = [
      "README.md mentions removed path 'docs/guide.md'",
      "docs/handbook.md mentions removed path 'scripts/old.sh'",
      "skills/s/SKILL.md mentions removed MCP tool 'old_tool'",
    ];
    assert.deepEqual(await staleDocRefs(r.repo, r.base, sha, r.env), hits);
    assert.deepEqual(await builtinLints(r.repo, r.base, sha, r.env), [
      { name: MISSING_CHANGELOG, exitCode: 0, output: '' },
      { name: STALE_DOC_REF, exitCode: 1, output: `expected: ${staleExpected(r.base, sha)}\nactual: ${hits.join('\n')}` },
    ]);
  });

  it('passes stale_doc_ref once the docs drop what the diff removes, and on a path the commit .gitignore untracks', async () => {
    const r = repoFixture({ ...BASE_FILES, 'docs/guide.md': 'Run `node pkg/dist/out.js`.\n', 'pkg/dist/out.js': 'built\n' });
    r.write('pkg/.gitignore', 'dist/\n');
    r.git('rm', '-q', '--cached', 'pkg/dist/out.js');
    r.git('rm', '-q', 'scripts/old.sh');
    r.write('skills/s/SKILL.md', 'Call `keep_tool`.\n');
    r.write('mcp/srv/src/tools/t.ts', "export const tools = [\n  {\n    name: 'keep_tool',\n  },\n];\n");
    r.write('changelog.d/3-x.md', '### Added\n- x (GH 3)\n');
    const sha = r.commit('untrack dist, drop old.sh and old_tool');
    assert.deepEqual(await staleDocRefs(r.repo, r.base, sha, r.env), []);
    assert.deepEqual((await builtinLints(r.repo, r.base, sha, r.env))[1], { name: STALE_DOC_REF, exitCode: 0, output: '' });
  });

  describe('a path untracked as build output (GH 2054)', () => {
    it('still fails on a plain deletion beside the untracked build output', async () => {
      const r = repoFixture(BUILT_FILES);
      const sha = untrackBuildOutput(r, () => r.write('pkg/.gitignore', 'dist/\n'), true);
      assert.deepEqual(await staleDocRefs(r.repo, r.base, sha, r.env), ["docs/guide.md mentions removed path 'scripts/old.sh'"]);
    });

    it('fails when only the local exclude file, not the commit, ignores the path', async () => {
      const r = repoFixture(BUILT_FILES);
      const sha = untrackBuildOutput(r, () => writeFileSync(join(r.repo, '.git/info/exclude'), 'dist/\n'));
      assert.deepEqual(await staleDocRefs(r.repo, r.base, sha, r.env), ["docs/guide.md mentions removed path 'pkg/dist/out.js'"]);
    });

    it('counts the path as removed when git check-ignore fails (fail-closed)', async () => {
      const r = repoFixture(BUILT_FILES);
      const sha = untrackBuildOutput(r, () => r.write('pkg/.gitignore', 'dist/\n'));
      const bin = join(dirname(r.repo), 'bin');
      mkdirSync(bin);
      const wrapper = join(bin, 'git');
      writeFileSync(
        wrapper,
        [
          '#!/usr/bin/env node',
          "const { spawnSync } = require('node:child_process');",
          "if (process.argv.includes('check-ignore')) process.exit(128);",
          `const r = spawnSync(${JSON.stringify(execFileSync('which', ['git'], { encoding: 'utf8' }).trim())}, process.argv.slice(2), { stdio: 'inherit' });`,
          'process.exit(r.status ?? 1);',
          '',
        ].join('\n'),
      );
      chmodSync(wrapper, 0o755);
      const env = { ...r.env, PATH: `${bin}:${r.env.PATH}` };
      assert.deepEqual(await staleDocRefs(r.repo, r.base, sha, env), ["docs/guide.md mentions removed path 'pkg/dist/out.js'"]);
    });
  });

  it('fails both checks closed when git cannot diff the range', async () => {
    const r = repoFixture();
    const bogus = 'f'.repeat(40);
    const [changelog, stale] = await builtinLints(r.repo, bogus, r.base, r.env);
    assert.equal(changelog.exitCode, 1);
    assert.match(changelog.output, /actual: git diff failed: /);
    assert.equal(stale.exitCode, 1);
  });
});
