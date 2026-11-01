/**
 * Byte-for-byte parity of the TypeScript git-guards with
 * scripts/hooks/git-guards.sh (GH 1692) over
 * tests/fixtures/hook-corpus/git-guards/, in a sandbox of real git repos and a
 * trajectory DB: github-flow and gitflow repos, a registered repo with no
 * policy, an unregistered sibling, a checkout with linked worktrees, a repo
 * with no remote, one behind its origin, detached checkouts (one named after a
 * task whose branch is another task's parent), a target branch the repo lacks,
 * a malformed protected_branches row and a repos.pr_target column. Each
 * payload's `@SANDBOX@` is the sandbox dir, its `corpus_env` (removed before
 * the run) overrides the env, and its `corpus_expect` (removed too) is `allow`
 * or a phrase of the deny reason. The payload × locale runs split across
 * hooks-git-guards-parity.shard-<k>of<n>.test.ts, each shard with its own
 * sandbox; shard 1 also runs the whole-corpus check.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { goldenBash, goldenRoots } from './golden.js';
import { shardOf } from './shard.js';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const CORPUS = join(PLUGIN_ROOT, 'tests/fixtures/hook-corpus/git-guards');
const HOOK_SH = join(PLUGIN_ROOT, 'scripts/hooks/git-guards.sh');
const HOOKS_BUNDLE = join(PLUGIN_ROOT, 'mcp/trajectory-server/dist/hooks.js');
const SCHEMA = readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema.sql'), 'utf8');
const LOCALES = ['C', 'en_US.UTF-8'];
const MIN_CORPUS = 35;
const HAVE_SQLITE_CLI = spawnSync('sqlite3', ['-version'], { stdio: 'ignore' }).status === 0;

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

function git(dir: string, ...args: string[]): string {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: GIT_ENV });
  assert.equal(r.status, 0, `git ${args.join(' ')} in ${dir}: ${r.stderr}`);
  return r.stdout.trim();
}

function commit(dir: string, name: string, text: string): void {
  writeFileSync(join(dir, name), text);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', `add ${name}`);
}

/** A checkout on main with no remote. */
function local(sandbox: string, name: string): string {
  const dir = join(sandbox, name);
  mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  commit(dir, 'README.md', `${name}\n`);
  return dir;
}

/** A checkout on main whose first commit is pushed to its own bare origin, main tracking origin/main. */
function repo(sandbox: string, name: string): string {
  const dir = local(sandbox, name);
  git(sandbox, 'init', '-q', '--bare', `${name}.git`);
  git(dir, 'remote', 'add', 'origin', join(sandbox, `${name}.git`));
  git(dir, 'push', '-qu', 'origin', 'main');
  return dir;
}

/** A repo on main with dev pushed beside it, left on <on>. */
function gitflow(sandbox: string, name: string, on: string): string {
  const dir = repo(sandbox, name);
  git(dir, 'checkout', '-q', '-b', 'dev');
  git(dir, 'push', '-qu', 'origin', 'dev');
  git(dir, 'checkout', '-q', on);
  return dir;
}

export function buildSandbox(sandbox: string): void {
  mkdirSync(join(sandbox, 'project'));
  mkdirSync(join(sandbox, 'db'));

  const ghf = repo(sandbox, 'ghf');
  git(ghf, 'branch', 'feat/x');
  git(ghf, 'push', '-qu', 'origin', 'feat/x');
  git(ghf, 'branch', 'release');

  const gfl = gitflow(sandbox, 'gfl', 'dev');
  const gfl2 = gitflow(sandbox, 'gfl2', 'main');

  const feat = repo(sandbox, 'feat');
  git(feat, 'checkout', '-q', '-b', 'feat/a');

  const nopol = repo(sandbox, 'nopol');
  repo(sandbox, 'sib');

  const multi = repo(sandbox, 'multi');
  git(multi, 'worktree', 'add', '-q', '-b', 'wt', join(sandbox, 'multi-wt'));

  const bad = repo(sandbox, 'bad');

  const behind = repo(sandbox, 'behind');
  commit(behind, 'two.txt', 'two\n');
  git(behind, 'push', '-q', 'origin', 'main');
  git(behind, 'reset', '-q', '--hard', 'HEAD~1');

  const norem = local(sandbox, 'norem');

  const det = repo(sandbox, 'det');
  git(det, 'checkout', '-q', '--detach');
  const det2 = repo(sandbox, 'det2');
  git(det2, 'checkout', '-q', '--detach');

  const fallback = repo(sandbox, 'fallback');

  const db = new DatabaseSync(join(sandbox, 'db/trajectory.db'));
  try {
    db.exec(SCHEMA);
    db.exec('ALTER TABLE repos ADD COLUMN pr_target TEXT');
    const row = db.prepare('INSERT INTO repos (name, path, target_branch, branching_model, protected_branches) VALUES (?, ?, ?, ?, ?)');
    const flow: [string, string, string | null, string | null, string | null][] = [
      ['ghf', ghf, 'main', 'github-flow', '["main"]'],
      ['gfl', gfl, 'dev', 'gitflow', '["main","dev"]'],
      ['gfl2', gfl2, 'dev', 'gitflow', '["main","dev"]'],
      ['feat', feat, 'main', 'github-flow', '["main"]'],
      ['nopol', nopol, null, null, null],
      ['multi', multi, 'main', 'github-flow', '["main"]'],
      ['bad', bad, 'main', 'github-flow', '[main'],
      ['behind', behind, 'main', 'github-flow', '["main"]'],
      ['norem', norem, 'main', 'github-flow', '["main"]'],
      ['det', det, 'main', 'github-flow', '["main"]'],
      ['det2', det2, 'main', 'github-flow', '["main"]'],
      ['fallback', fallback, 'develop', 'github-flow', '["main"]'],
    ];
    for (const r of flow) row.run(...r);
    db.exec("UPDATE repos SET pr_target = 'release' WHERE name = 'ghf'");
    db.exec("INSERT INTO issues (id, objective, description, status, created_at, updated_at) VALUES (1, 'test', 'test', 'open', datetime('now'), datetime('now'))");
    const task = db.prepare(
      "INSERT INTO tasks (id, issue_id, branch_id, parent_branch_id, description, status, created_at, updated_at) VALUES (?, 1, ?, ?, 'd', 'running', datetime('now'), datetime('now'))",
    );
    task.run(20, 'feat/det', null);
    task.run(21, 'feat/child', 'feat/det');
  } finally {
    db.close();
  }
}

interface Materialized {
  input: string;
  env: NodeJS.ProcessEnv;
  expect: string;
}

export function materialize(file: string, sandbox: string): Materialized {
  const text = readFileSync(file, 'utf8').replaceAll('@SANDBOX@', sandbox);
  const { corpus_env: env = {}, corpus_expect: expect = '', ...payload } = JSON.parse(text) as {
    corpus_env?: NodeJS.ProcessEnv;
    corpus_expect?: string;
  };
  return { input: JSON.stringify(payload), env, expect };
}

function run(cmd: string, args: string[], input: string, env: NodeJS.ProcessEnv, cwd: string): { code: number | null; stdout: string } {
  const r = spawnSync(cmd, args, { input, env, cwd, encoding: 'utf8', timeout: 30_000 });
  if (r.error) throw r.error;
  return { code: r.status, stdout: r.stdout };
}

const corpus = readdirSync(CORPUS)
  .filter((f) => f.endsWith('.json'))
  .sort();

const cases = corpus.flatMap((f) => LOCALES.map((locale) => ({ f, locale })));

export function gitGuardsParityShard(k: number, n: number): void {
  describe(`git-guards parity: bash vs node over a git and DB sandbox (shard ${k} of ${n})`, { skip: !HAVE_SQLITE_CLI && 'the .sh needs the sqlite3 CLI' }, () => {
    let sandbox: string;
    before(() => {
      sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-gg-parity-')));
      buildSandbox(sandbox);
    });
    after(() => {
      rmSync(sandbox, { recursive: true, force: true });
    });

    if (k === 1) {
      it(`the corpus holds at least ${MIN_CORPUS} payloads, each with an expectation`, () => {
        assert.ok(corpus.length >= MIN_CORPUS, `${corpus.length} payloads`);
        for (const f of corpus) assert.notEqual(materialize(join(CORPUS, f), '/s').expect, '', f);
      });
    }

    for (const { f, locale } of shardOf(cases, k, n)) {
      it(`${f} (LC_ALL=${locale})`, () => {
        const { input, env: extra, expect } = materialize(join(CORPUS, f), sandbox);
        const env: NodeJS.ProcessEnv = {
          ...GIT_ENV,
          CLAUDE_PROJECT_DIR: join(sandbox, 'project'),
          CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
          TRAJECTORY_DB_PATH: join(sandbox, 'db/trajectory.db'),
          LC_ALL: locale,
          ...extra,
        };
        delete env.TMB_HOOKS_SQLITE;
        const cwd = join(sandbox, 'project');
        const bash = goldenBash('git-guards', f, locale, goldenRoots({ '@SANDBOX@': sandbox }), () => run('bash', [HOOK_SH], input, env, cwd));
        const node = run(process.execPath, [HOOKS_BUNDLE, 'git-guards'], input, env, cwd);
        assert.equal(node.code, bash.code, 'exit code');
        assert.equal(node.stdout, bash.stdout, 'stdout, byte for byte');
        assert.equal(bash.code, 0);
        if (expect === 'allow') {
          assert.equal(bash.stdout, '', 'allowed');
        } else {
          const out = JSON.parse(bash.stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
          assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
          assert.ok(out.hookSpecificOutput.permissionDecisionReason.includes(expect), out.hookSpecificOutput.permissionDecisionReason);
        }
      });
    }
  });
}
