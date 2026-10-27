/**
 * Parity of the TypeScript swe-scope-fence gate with
 * scripts/hooks/swe-scope-fence.sh (GH 1692) over
 * tests/fixtures/hook-corpus/swe-scope-fence/. The sandbox is rebuilt at the
 * same path before each side runs; both sides must exit 0, print the same
 * stdout and stderr byte for byte, and leave the sandbox alike: the DB rows
 * and the scope-note markers under <state>/locks/scope-notes/.
 *
 * The project DB holds repos plugin (the real checkout) and linked (a symlink
 * to it), and tasks 10 (files src/ and tests/unit/a.test.ts), 11 (files []),
 * 12 (files src/, with docs/noted.md already noted), 13 (in linked, files
 * src/) and 14 (files src/, Docs/ and _build/, whose sort order hangs on the
 * locale). Each task's spawn transcript is tr/task-<id>.jsonl; tr/task-99.jsonl
 * names a task with no row. Beside it: a corrupt DB and a dir outside every
 * worktree. Payload placeholders, corpus_env, corpus_cwd, corpus_stdin,
 * corpus_expect and corpus_divergent read as in hooks-swe-run-parity.suite.ts.
 * The payload × locale (C, en_US.UTF-8) runs split across
 * hooks-swe-scope-fence-parity.shard-<k>of<n>.test.ts.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { cksum } from '../hooks/lib/scope-fence.js';
import { corpusFiles, type CorpusPaths, materialize, noCmdPath, snapshot } from './hooks-swe-run-parity.suite.js';
import { shardOf } from './shard.js';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const CORPUS_ROOT = join(PLUGIN_ROOT, 'tests/fixtures/hook-corpus');
const HOOKS_BUNDLE = join(PLUGIN_ROOT, 'mcp/trajectory-server/dist/hooks.js');
const SCHEMA_SQL = join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema.sql');
const GATE = 'swe-scope-fence';
const LOCALES = ['C', 'en_US.UTF-8'];
const MIN_CORPUS = 8;
const HAVE_SQLITE_CLI = spawnSync('sqlite3', ['-version'], { stdio: 'ignore' }).status === 0;
const HAVE_JQ = spawnSync('jq', ['--version'], { stdio: 'ignore' }).status === 0;
const T1 = '2026-10-01T10:00:00.000Z';
const PROJECT_DB = 'project/.claude/tmb/trajectory.db';
const UNSET = ['TRAJECTORY_DB_PATH', 'TMB_TEST_RUN_ID', 'TMB_HOOKS_SQLITE', 'TMB_DB_WRITE_TIMEOUT_MS', 'LANG', 'LC_CTYPE', 'LC_COLLATE'];

const TASKS: readonly [number, string, string, string[]][] = [
  [10, 'feat/sf-task', 'plugin', ['src/', 'tests/unit/a.test.ts']],
  [11, 'feat/sf-empty', 'plugin', []],
  [12, 'feat/sf-noted', 'plugin', ['src/']],
  [13, 'feat/sf-linked', 'linked', ['src/']],
  [14, 'feat/sf-collate', 'plugin', ['src/', 'Docs/', '_build/']],
];

/** The sandbox every case starts from, rebuilt at <s> before each side runs. */
export function buildScopeSandbox(s: string): void {
  rmSync(s, { recursive: true, force: true });
  const checkout = join(s, 'project/checkout');
  for (const [, branch] of TASKS) {
    mkdirSync(join(checkout, '.claude/worktrees', branch.slice(branch.indexOf('/') + 1), 'src'), { recursive: true });
  }
  mkdirSync(join(s, 'home'));
  mkdirSync(join(s, 'outside'));
  mkdirSync(join(s, 'tr'));
  symlinkSync(checkout, join(s, 'linked'));
  const dbFile = join(s, PROJECT_DB);
  mkdirSync(dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  try {
    db.exec(readFileSync(SCHEMA_SQL, 'utf8'));
    const repo = db.prepare('INSERT INTO repos (name, path, last_scanned_at) VALUES (?, ?, ?)');
    repo.run('plugin', checkout, T1);
    repo.run('linked', join(s, 'linked'), T1);
    db.prepare("INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (1, 'scope fence', 'open', ?, ?)").run(T1, T1);
    const task = db.prepare("INSERT INTO tasks (id, issue_id, branch_id, description, status, repo, files, created_at, updated_at) VALUES (?, 1, ?, 'd', 'running', ?, ?, ?, ?)");
    for (const [id, branch, repoName, files] of TASKS) task.run(id, branch, repoName, JSON.stringify(files), T1, T1);
  } finally {
    db.close();
  }
  for (const id of [...TASKS.map(([n]) => n), 99]) {
    writeFileSync(join(s, 'tr', `task-${id}.jsonl`), `${JSON.stringify({ message: { content: [{ type: 'text', text: `task_id=${id}` }] } })}\n`);
  }
  mkdirSync(join(dirname(dbFile), 'locks/scope-notes/12', cksum('docs/noted.md')), { recursive: true });
  mkdirSync(join(s, 'bad/.claude/tmb'), { recursive: true });
  writeFileSync(join(s, 'bad/.claude/tmb/trajectory.db'), 'this is not a sqlite database\n'.repeat(64));
}

type SideExpect = string | Record<string, string>;
type Expect = string | { bash: SideExpect; ts: SideExpect };

function byLocale(expect: SideExpect, locale: string): string {
  return typeof expect === 'string' ? expect : (expect[locale] ?? '');
}

function caseEnv(s: string, locale: string, extra: Record<string, string | null>, cwd: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of UNSET) delete env[key];
  Object.assign(env, {
    HOME: join(s, 'home'),
    CLAUDE_PROJECT_DIR: join(s, 'project'),
    TRAJECTORY_DB_PATH: join(s, PROJECT_DB),
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
  const dir = mkdtempSync(join(tmpdir(), 'tmb-scope-fence-stdin-'));
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

export function sweScopeFenceParityShard(k: number, n: number): void {
  describe(
    `swe-scope-fence parity: bash vs node over a rebuilt sandbox (shard ${k} of ${n})`,
    { skip: (!HAVE_SQLITE_CLI || !HAVE_JQ) && 'the .sh side needs the sqlite3 CLI and jq' },
    () => {
      let base: string;
      let s: string;
      let paths: CorpusPaths;
      before(() => {
        base = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-scope-fence-parity-')));
        s = join(base, 'sandbox');
        const path = process.env.PATH ?? '';
        paths = { noJq: noCmdPath(join(base, 'nojq'), 'jq', path), noSqlite: noCmdPath(join(base, 'nosqlite'), 'sqlite3', path) };
      });
      after(() => {
        rmSync(base, { recursive: true, force: true });
      });

      if (k === 1) {
        it(`the corpus has at least ${MIN_CORPUS} payloads, each with an expectation`, () => {
          const files = corpusFiles(GATE);
          assert.ok(files.length >= MIN_CORPUS, `${files.length} payloads`);
          for (const f of files) {
            const { expect, divergent } = materialize(join(CORPUS_ROOT, GATE, f), '/s', { noJq: '', noSqlite: '' }) as { expect: Expect; divergent?: string };
            if (divergent === undefined) assert.ok(typeof expect === 'string' ? expect !== '' : LOCALES.every((l) => byLocale(expect as SideExpect, l) !== ''), `${f}: an expectation`);
            else
              assert.ok(
                typeof expect === 'object' && 'bash' in expect && divergent !== '' && LOCALES.every((l) => byLocale(expect.bash, l) !== '' && byLocale(expect.ts, l) !== ''),
                `${f}: a divergent case names why and expects each side in every locale`,
              );
          }
        });

        it('the sandbox symlink and the pre-noted marker are in place', () => {
          buildScopeSandbox(s);
          assert.equal(realpathSync(join(s, 'linked')), join(s, 'project/checkout'));
          assert.ok(snapshot(s)[`project/.claude/tmb/locks/scope-notes/12/${cksum('docs/noted.md')}/`] === null);
        });
      }

      for (const { f, locale } of shardOf(cases, k, n)) {
        it(`${GATE} / ${f} (LC_ALL=${locale})`, () => {
          const c = materialize(join(CORPUS_ROOT, GATE, f), s, paths);
          const env = caseEnv(s, locale, c.env, c.cwd);
          buildScopeSandbox(s);
          const bash = run('bash', [join(PLUGIN_ROOT, 'scripts/hooks', `${GATE}.sh`)], c.input, env, c.cwd);
          const bashTree = snapshot(s);
          buildScopeSandbox(s);
          const node = run(process.execPath, [HOOKS_BUNDLE, GATE], c.input, env, c.cwd);
          const nodeTree = snapshot(s);
          assert.equal(bash.code, 0, `bash exit: ${bash.stderr}`);
          assert.equal(node.code, 0, `node exit: ${node.stderr}`);
          if (c.divergent === undefined) {
            assert.deepEqual(nodeTree, bashTree, 'the sandbox after the run');
            assert.equal(node.stdout, bash.stdout, 'stdout, byte for byte');
            assert.equal(node.stderr, bash.stderr, 'stderr, byte for byte');
            assertExpect('bash', bash, byLocale(c.expect as SideExpect, locale));
          } else {
            const expect = c.expect as { bash: SideExpect; ts: SideExpect };
            assert.ok(
              node.stdout + node.stderr !== bash.stdout + bash.stderr || JSON.stringify(nodeTree) !== JSON.stringify(bashTree),
              `divergent (${c.divergent}): the sides must differ`,
            );
            assertExpect('bash', bash, byLocale(expect.bash, locale));
            assertExpect('ts', node, byLocale(expect.ts, locale));
          }
        });
      }
    },
  );
}
