/**
 * Parity of the TypeScript no-source-edit-from-main gate with
 * scripts/hooks/no-source-edit-from-main.sh (GH 1692) over
 * tests/fixtures/hook-corpus/no-source-edit-from-main/. Both sides must exit
 * 0 and print the same stdout and stderr byte for byte; the gate writes
 * nothing, so the sandbox is built once per shard and must end as it began.
 *
 * The sandbox: a project whose DB registers repos plugin (project/checkout,
 * a git repo whose manifest names the running plugin, tmb) and
 * other (a git repo whose manifest names other-plugin); an unregistered git
 * repo sibling; a dir in no git repo, plain; the running plugin root; a
 * corrupt DB (bad), a DB with no repos table (norepos), a project nested
 * under a .claude/worktrees/ path (nest) and scratchlink, a symlink to the
 * checkout's .claude/tmb/scratch/. Both sides run under a preload giving
 * node a fake uid, so /tmp/claude-<uid> never covers the sandbox.
 *
 * A payload names the sandbox as @SANDBOX@, the canonical /tmp/claude-<fake
 * uid> as @HARNESS_TMP@ and the PATH without jq or the sqlite3 CLI as
 * @NOJQ_PATH@ / @NOSQLITE_PATH@; corpus_env (null unsets), corpus_cwd,
 * corpus_stdin, corpus_expect and corpus_divergent read as in
 * hooks-swe-run-parity.suite.ts. The payload × locale (C, en_US.UTF-8) runs
 * split across hooks-no-source-edit-parity.shard-<k>of<n>.test.ts.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { corpusFiles, noCmdPath, snapshot } from './hooks-swe-run-parity.suite.js';
import { goldenBash, goldenRoots } from './golden.js';
import { shardOf } from './shard.js';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const CORPUS_ROOT = join(PLUGIN_ROOT, 'tests/fixtures/hook-corpus');
const HOOKS_BUNDLE = join(PLUGIN_ROOT, 'mcp/trajectory-server/dist/hooks.js');
const SCHEMA_SQL = join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema.sql');
const FAKE_UID_PRELOAD = join(PLUGIN_ROOT, 'tests/lib/fake-uid.mjs');
const FAKE_UID = 4242424;
const GATE = 'no-source-edit-from-main';
const LOCALES = ['C', 'en_US.UTF-8'];
const MIN_CORPUS = 10;
const HAVE_SQLITE_CLI = spawnSync('sqlite3', ['-version'], { stdio: 'ignore' }).status === 0;
const HAVE_JQ = spawnSync('jq', ['--version'], { stdio: 'ignore' }).status === 0;
const T1 = '2026-10-01T10:00:00.000Z';
const PROJECT_DB = 'project/.claude/tmb/trajectory.db';
const UNSET = ['TRAJECTORY_DB_PATH', 'TMB_TEST_RUN_ID', 'TMB_HOOKS_SQLITE', 'TMB_ALLOW_SOURCE_EDIT', 'TMB_DB_WRITE_TIMEOUT_MS', 'LANG', 'LC_CTYPE', 'LC_COLLATE'];

function gitRepo(dir: string, manifestName?: string): void {
  mkdirSync(dir, { recursive: true });
  const r = spawnSync('git', ['init', '-q', '-b', 'main', dir], { stdio: 'ignore' });
  assert.equal(r.status, 0, `git init ${dir}`);
  if (manifestName !== undefined) {
    mkdirSync(join(dir, '.claude-plugin'));
    writeFileSync(join(dir, '.claude-plugin/plugin.json'), `${JSON.stringify({ name: manifestName })}\n`);
  }
}

function trajectoryDb(file: string, rows: (db: DatabaseSync) => void, schema = readFileSync(SCHEMA_SQL, 'utf8')): void {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec(schema);
    rows(db);
  } finally {
    db.close();
  }
}

/** The sandbox every case reads, built once at <s>. */
export function buildSourceEditSandbox(s: string): void {
  rmSync(s, { recursive: true, force: true });
  const checkout = join(s, 'project/checkout');
  gitRepo(checkout, 'tmb');
  for (const dir of ['src', 'scripts/hooks', 'hooks', 'docs', 'templates', 'agents', '.github/workflows', '.claude/tmb/scratch', '.claude/worktrees/wt/agents', '.claude/worktrees/wt/src']) {
    mkdirSync(join(checkout, dir), { recursive: true });
  }
  gitRepo(join(s, 'other'), 'other-plugin');
  mkdirSync(join(s, 'other/hooks'));
  gitRepo(join(s, 'sibling'));
  mkdirSync(join(s, 'sibling/src'));
  mkdirSync(join(s, 'plain'));
  mkdirSync(join(s, 'home'));
  mkdirSync(join(s, 'running-plugin/.claude-plugin'), { recursive: true });
  writeFileSync(join(s, 'running-plugin/.claude-plugin/plugin.json'), `${JSON.stringify({ name: 'tmb' })}\n`);
  trajectoryDb(join(s, PROJECT_DB), (db) => {
    const repo = db.prepare('INSERT INTO repos (name, path, last_scanned_at) VALUES (?, ?, ?)');
    repo.run('plugin', checkout, T1);
    repo.run('other', join(s, 'other'), T1);
  });
  mkdirSync(join(s, 'bad/.claude/tmb'), { recursive: true });
  writeFileSync(join(s, 'bad/.claude/tmb/trajectory.db'), 'this is not a sqlite database\n'.repeat(64));
  trajectoryDb(join(s, 'norepos/.claude/tmb/trajectory.db'), () => {}, 'CREATE TABLE meta (k TEXT);');
  const nest = join(s, 'nest/.claude/worktrees/proj');
  trajectoryDb(join(nest, '.claude/tmb/trajectory.db'), () => {});
  mkdirSync(join(nest, 'agents'));
  symlinkSync(join(checkout, '.claude/tmb/scratch'), join(s, 'scratchlink'));
}

type SideExpect = string | Record<string, string>;
type Expect = string | { bash: SideExpect; ts: SideExpect };

interface Case {
  input: Buffer;
  env: Record<string, string | null>;
  cwd: string;
  expect: Expect;
  divergent: string | undefined;
}

interface Placeholders {
  sandbox: string;
  harnessTmp: string;
  noJq: string;
  noSqlite: string;
}

export function materialize(file: string, p: Placeholders): Case {
  const text = readFileSync(file, 'utf8')
    .replaceAll('@SANDBOX@', p.sandbox)
    .replaceAll('@HARNESS_TMP@', p.harnessTmp)
    .replaceAll('@NOJQ_PATH@', p.noJq)
    .replaceAll('@NOSQLITE_PATH@', p.noSqlite);
  const {
    corpus_env: env = {},
    corpus_cwd: cwd = 'project/checkout',
    corpus_stdin: stdin,
    corpus_expect: expect = '',
    corpus_divergent: divergent,
    ...payload
  } = JSON.parse(text) as {
    corpus_env?: Record<string, string | null>;
    corpus_cwd?: string;
    corpus_stdin?: string;
    corpus_expect?: Expect;
    corpus_divergent?: string;
  };
  return { input: Buffer.from(stdin ?? JSON.stringify(payload)), env, cwd: join(p.sandbox, cwd), expect, divergent };
}

function byLocale(expect: SideExpect, locale: string): string {
  return typeof expect === 'string' ? expect : (expect[locale] ?? '');
}

export function caseEnv(s: string, locale: string, extra: Record<string, string | null>, cwd: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of UNSET) delete env[key];
  Object.assign(env, {
    HOME: join(s, 'home'),
    CLAUDE_PROJECT_DIR: join(s, 'project'),
    CLAUDE_PLUGIN_ROOT: join(s, 'running-plugin'),
    TRAJECTORY_DB_PATH: join(s, PROJECT_DB),
    NODE_OPTIONS: `--import ${FAKE_UID_PRELOAD}`,
    LC_ALL: locale,
    PWD: cwd,
  });
  for (const [key, value] of Object.entries(extra)) {
    if (value === null) delete env[key];
    else env[key] = value;
  }
  return env;
}

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: string[], input: Buffer, env: NodeJS.ProcessEnv, cwd: string): Run {
  const dir = mkdtempSync(join(tmpdir(), 'tmb-no-source-edit-stdin-'));
  const file = join(dir, 'stdin');
  writeFileSync(file, input);
  const fd = openSync(file, 'r');
  try {
    const r = spawnSync(cmd, args, { stdio: [fd, 'pipe', 'pipe'], env, cwd, encoding: 'utf8', timeout: 30_000 });
    if (r.error) throw r.error;
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  } finally {
    closeSync(fd);
    rmSync(dir, { recursive: true, force: true });
  }
}

/** `empty`: no stdout or stderr; anything else: a phrase of the output. */
function assertExpect(side: string, r: Run, expect: string): void {
  const output = r.stdout + r.stderr;
  if (expect === 'empty') {
    assert.equal(output, '', `${side}: no output`);
    return;
  }
  assert.ok(output.includes(expect), `${side} observed ${JSON.stringify(expect)}: ${output.slice(0, 1200)}`);
}

const cases = corpusFiles(GATE).flatMap((f) => LOCALES.map((locale) => ({ f, locale })));

export function noSourceEditParityShard(k: number, n: number): void {
  describe(
    `no-source-edit-from-main parity: bash vs node over a sandbox of real repos (shard ${k} of ${n})`,
    { skip: (!HAVE_SQLITE_CLI || !HAVE_JQ) && 'the .sh side needs the sqlite3 CLI and jq' },
    () => {
      let base: string;
      let p: Placeholders;
      let tree: Record<string, string | null>;
      before(() => {
        base = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-no-source-edit-parity-')));
        const path = process.env.PATH ?? '';
        p = {
          sandbox: join(base, 'sandbox'),
          harnessTmp: `${realpathSync('/tmp')}/claude-${FAKE_UID}`,
          noJq: noCmdPath(join(base, 'nojq'), 'jq', path),
          noSqlite: noCmdPath(join(base, 'nosqlite'), 'sqlite3', path),
        };
        buildSourceEditSandbox(p.sandbox);
        tree = snapshot(p.sandbox);
      });
      after(() => {
        rmSync(base, { recursive: true, force: true });
      });

      if (k === 1) {
        it(`the corpus has at least ${MIN_CORPUS} payloads, each with an expectation`, () => {
          const files = corpusFiles(GATE);
          assert.ok(files.length >= MIN_CORPUS, `${files.length} payloads`);
          for (const f of files) {
            const { expect, divergent } = materialize(join(CORPUS_ROOT, GATE, f), { sandbox: '/s', harnessTmp: '/h', noJq: '', noSqlite: '' });
            if (divergent === undefined) assert.ok(typeof expect === 'string' ? expect !== '' : LOCALES.every((l) => byLocale(expect as SideExpect, l) !== ''), `${f}: an expectation`);
            else
              assert.ok(
                typeof expect === 'object' && 'bash' in expect && divergent !== '' && LOCALES.every((l) => byLocale(expect.bash, l) !== '' && byLocale(expect.ts, l) !== ''),
                `${f}: a divergent case names why and expects each side in every locale`,
              );
          }
        });

        it('the sandbox symlink resolves into the checkout scratch dir', () => {
          assert.equal(realpathSync(join(p.sandbox, 'scratchlink')), join(p.sandbox, 'project/checkout/.claude/tmb/scratch'));
        });
      }

      for (const { f, locale } of shardOf(cases, k, n)) {
        it(`${GATE} / ${f} (LC_ALL=${locale})`, () => {
          const c = materialize(join(CORPUS_ROOT, GATE, f), p);
          const env = caseEnv(p.sandbox, locale, c.env, c.cwd);
          const bash = goldenBash(GATE, f, locale, goldenRoots({ '@SANDBOX@': p.sandbox, '@BASE@': base, '@HARNESS_TMP@': p.harnessTmp }), () => run('bash', [join(PLUGIN_ROOT, 'scripts/hooks', `${GATE}.sh`)], c.input, env, c.cwd));
          const node = run(process.execPath, [HOOKS_BUNDLE, GATE], c.input, env, c.cwd);
          assert.equal(bash.code, 0, `bash exit: ${bash.stderr}`);
          assert.equal(node.code, 0, `node exit: ${node.stderr}`);
          if (c.divergent === undefined) {
            assert.equal(node.stdout, bash.stdout, 'stdout, byte for byte');
            assert.equal(node.stderr, bash.stderr, 'stderr, byte for byte');
            assertExpect('bash', bash, byLocale(c.expect as SideExpect, locale));
          } else {
            const expect = c.expect as { bash: SideExpect; ts: SideExpect };
            assert.notEqual(node.stdout + node.stderr, bash.stdout + bash.stderr, `divergent (${c.divergent}): the sides must differ`);
            assertExpect('bash', bash, byLocale(expect.bash, locale));
            assertExpect('ts', node, byLocale(expect.ts, locale));
          }
        });
      }

      it('the runs left the sandbox as built', () => {
        assert.deepEqual(snapshot(p.sandbox), tree);
      });
    },
  );
}
