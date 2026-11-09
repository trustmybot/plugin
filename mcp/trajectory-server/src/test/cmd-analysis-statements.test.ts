/**
 * Same-command VAR=<literal> tracking in statementsEnc against
 * _tmb_cmd_statements_enc (GH 1911): every row of
 * tests/fixtures/cmd-analysis/statement-vars.jsonl, which
 * cmd-analysis-l3-helpers.test.ts asserts on the bash side,
 * gives the same dir token per statement after encode(). A `parse: false` row
 * is one tree-sitter-bash rejects, so the TS refuses it outright; a `ts_dirs`
 * row records where the TS splits statements differently, or keeps a literal
 * past a literal redirect the bash lib does not (GH 2404).
 * cmdStatements keeps `git -C $W`'s literal across such a redirect in a
 * checkout with a linked worktree.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Parser } from 'web-tree-sitter';
import { bashParser } from '../hooks/cmd-analysis/parser.js';
import { encode } from '../hooks/cmd-analysis/encode.js';
import { cmdStatements, gitSubcommand } from '../hooks/cmd-analysis/git.js';
import { statementsEnc } from '../hooks/cmd-analysis/statements.js';
import { GIT_ENV } from './hook-sandbox.js';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const FIXTURE = join(PLUGIN_ROOT, 'tests/fixtures/cmd-analysis/statement-vars.jsonl');
const HOME = '/home/u';

interface Row {
  cmd: string;
  dirs: string[];
  why: string;
  parse?: boolean;
  ts_dirs?: string[];
}

const rows: Row[] = readFileSync(FIXTURE, 'utf8')
  .split('\n')
  .filter((l) => l !== '')
  .map((l) => JSON.parse(l) as Row);

describe('statementsEnc keeps VAR=<literal> past data (GH 1911)', () => {
  let parser: Parser;
  before(async () => {
    parser = await bashParser();
  });

  it('the fixture covers resolving and unresolved rows', () => {
    assert.ok(rows.filter((r) => r.dirs.at(-1) === '-').length >= 60);
    assert.ok(rows.filter((r) => r.dirs.at(-1)?.startsWith('/')).length >= 14);
  });

  for (const row of rows) {
    it(`${row.why}: ${JSON.stringify(row.cmd)}`, () => {
      const encoded = encode(parser, row.cmd);
      if (row.parse === false) {
        assert.equal(encoded.ok, false);
        return;
      }
      assert.ok(encoded.ok);
      const dirs = statementsEnc(encoded.text, '@', HOME, false).map((r) => r.dir);
      assert.deepEqual(dirs, row.ts_dirs ?? row.dirs);
    });
  }

  it('the heredoc verdict marks never reach a statement', () => {
    const encoded = encode(parser, "W=/w; cat <<A\n$((W=0))\nA\ncat <<'B'\nx\nB\n");
    assert.ok(encoded.ok);
    for (const assign of [false, true]) {
      for (const r of statementsEnc(encoded.text, '@', HOME, assign)) assert.doesNotMatch(r.stmt + r.dir, /[\x1a\x1e]/);
    }
  });
});

describe('cmdStatements keeps git -C $W past a literal redirect (GH 2404)', () => {
  let root: string;
  let repo: string;
  let wt: string;
  const env = { ...process.env, ...GIT_ENV };
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  const dirs = async (cmd: string): Promise<string[]> => {
    const res = await cmdStatements(cmd, repo, env);
    assert.ok(res.ok);
    return res.statements.map((s) => s.dir);
  };
  before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-gh2404-')));
    repo = join(root, 'repo');
    git(root, 'init', '-q', '-b', 'dev', repo);
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
    wt = join(repo, 'wt');
    git(repo, 'worktree', 'add', '-q', '-b', 'fix/x', wt);
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it('the checkout has a linked worktree, so a bare git is ambiguous', async () => {
    assert.deepEqual(await dirs('git merge x'), ['?']);
    assert.deepEqual(await dirs(`W=${wt}; git -C $W merge x`), [wt]);
  });

  for (const redirect of ['2>&1', '2>/dev/null', '>out.log', '&>/dev/null'])
    it(`W=<wt>; git -C $W merge x ${redirect} resolves to <wt>`, async () => {
      assert.deepEqual(await dirs(`W=${wt}; git -C $W merge x ${redirect}`), [wt]);
    });

  it('W=<wt>; git -C "$W" commit -m x 2>&1 | tail -3 resolves to <wt>', async () => {
    assert.deepEqual(await dirs(`W=${wt}; git -C "$W" commit -m x 2>&1 | tail -3`), [wt, '?']);
  });

  for (const redirect of ['>$(W=0)', '2>$((W=0))', '>"$W"/log', '2>$[W=0]', '>f`W=0`', '{W}>f'])
    it(`W=<wt>; git -C $W merge x ${redirect} stays unresolved`, async () => {
      assert.equal((await dirs(`W=${wt}; git -C $W merge x ${redirect}`))[0], '-');
    });
});

describe("cmdStatements keeps an empty quoted git -C '' value (GH 2549)", () => {
  let root: string;
  let single: string;
  let linked: string;
  const env = { ...process.env, ...GIT_ENV };
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  const listed = async (cmd: string, cwd: string) => {
    const res = await cmdStatements(cmd, cwd, env);
    assert.ok(res.ok);
    return res.statements;
  };
  before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-gh2549-')));
    single = join(root, 'single');
    linked = join(root, 'linked');
    for (const repo of [single, linked]) {
      git(root, 'init', '-q', '-b', 'dev', repo);
      git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
    }
    git(linked, 'worktree', 'add', '-q', '-b', 'fix/x', join(linked, 'wt'));
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  for (const [cmd, sub] of [
    ["git -C '' push origin dev", 'push origin dev'],
    ['git -C "" push origin dev', 'push origin dev'],
    ["git -C $'' push origin dev", 'push origin dev'],
    ["git -c '' push origin dev", 'push origin dev'],
    ["git --attr-source '' push origin dev", 'push origin dev'],
    ["/usr/bin/git -C '' push origin dev", 'push origin dev'],
  ])
    it(`${cmd}: the subcommand is ${sub}`, async () => {
      const [stmt] = await listed(cmd, single);
      assert.equal(gitSubcommand(stmt.stmt), sub);
    });

  it("git -C '' commit -m 'a b': the subcommand starts with commit", async () => {
    const [stmt] = await listed("git -C '' commit -m 'a b'", single);
    assert.match(gitSubcommand(stmt.stmt), /^commit /);
  });

  for (const sub of ['push origin dev', 'merge x', 'commit -m x'])
    it(`git -C '' ${sub} runs in the dir git ${sub} runs in`, async () => {
      for (const [repo, dir] of [
        [single, single],
        [linked, '?'],
      ]) {
        const bare = await listed(`git ${sub}`, repo);
        const empty = await listed(`git -C '' ${sub}`, repo);
        assert.equal(bare[0].dir, dir);
        assert.equal(empty[0].dir, bare[0].dir);
      }
    });

  it("git -C '' -C wt merge x runs in <linked>/wt", async () => {
    const [stmt] = await listed("git -C '' -C wt merge x", linked);
    assert.equal(stmt.dir, join(linked, 'wt'));
  });

  it('an empty -m value after the subcommand is still dropped', async () => {
    const [stmt] = await listed("git commit -m ''", single);
    assert.equal(stmt.stmt, 'git commit -m');
  });
});
