/**
 * Parity of the TypeScript swe-verification-gate with
 * scripts/hooks/swe-verification-gate.sh (GH 1692) over
 * tests/fixtures/hook-corpus/swe-verification-gate/. The sandbox is rebuilt at
 * the same path before each side runs; both sides must exit 0, print the same
 * stdout and stderr byte for byte once timestamps and elapsed seconds are
 * masked, and leave the sandbox alike, each DB compared as its
 * verification_runs, verification_run_commands, review_findings and audit
 * rows with the same masks. Worktree .git dirs are left out of the
 * comparison: git keeps stat data in its index.
 *
 * The project DB registers repo plugin; each task's worktree under
 * project/checkout/.claude/worktrees/<slug> is a one-commit git repo built
 * with a fixed author, committer and date, so its HEAD is the same on every
 * rebuild. Tasks: passing verification[] (30), a failing command (31), a
 * command outliving a 5 s budget (32; a shorter one can run out before the
 * command starts on a loaded machine, leaving no command row), a passing run of the current HEAD
 * recorded a minute ago (33), an empty verification[] (34), probes of an open
 * and a wontfix finding (35), a fixed finding whose probe fails again (36), a
 * worktree that is not there (37) and an empty branch (38). Beside it: a corrupt
 * DB. Verification commands are true, false, echo and sleep.
 *
 * A payload names the sandbox as @SANDBOX@ and the PATH without jq or without
 * the sqlite3 CLI as @NOJQ_PATH@ / @NOSQLITE_PATH@; corpus_env (null unsets),
 * corpus_cwd, corpus_stdin and corpus_expect (`empty` for no output, or a
 * phrase of the observed stdout, stderr and project DB rows, or an object of
 * them by locale) are removed before the run. A payload with corpus_divergent
 * names a divergence decision 703 allows: corpus_expect is then { bash, ts }
 * and the two sides must differ. The payload × locale (C, en_US.UTF-8) runs
 * split across hooks-swe-verification-parity.shard-<k>of<n>.test.ts.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { goldenBash, goldenRoots } from './golden.js';
import { shardOf } from './shard.js';

const GATE = 'swe-verification-gate';
const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const CORPUS_DIR = join(PLUGIN_ROOT, 'tests/fixtures/hook-corpus', GATE);
const HOOKS_BUNDLE = join(PLUGIN_ROOT, 'mcp/trajectory-server/dist/hooks.js');
const SCHEMA = readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema.sql'), 'utf8');
const LOCALES = ['C', 'en_US.UTF-8'];
const MIN_CORPUS = 12;
const HAVE_SQLITE_CLI = spawnSync('sqlite3', ['-version'], { stdio: 'ignore' }).status === 0;
const HAVE_JQ = spawnSync('jq', ['--version'], { stdio: 'ignore' }).status === 0;
const T1 = '2026-10-01T10:00:00.000Z';
const TS_RE = /\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(\.\d+)?Z?/g;
const ELAPSED_RE = /\b\d+\.\ds\b/g;
const PROJECT_DB = 'project/.claude/tmb/trajectory.db';
const GIT_DATE = '2026-10-01T10:00:00Z';

const UNSET = [
  'TRAJECTORY_DB_PATH',
  'TMB_TEST_RUN_ID',
  'TMB_FORBID_LIVE_SYNC',
  'TMB_HOOKS_SQLITE',
  'TMB_DB_WRITE_TIMEOUT_MS',
  'TMB_DB_WRITE_RUN_BUDGET_MS',
  'TMB_VERIFICATION_TIMEOUT_S',
  'TMB_VERIFICATION_TAIL_CHARS',
  'LANG',
  'LC_CTYPE',
];

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Parity',
  GIT_AUTHOR_EMAIL: 'parity@example.invalid',
  GIT_AUTHOR_DATE: GIT_DATE,
  GIT_COMMITTER_NAME: 'Parity',
  GIT_COMMITTER_EMAIL: 'parity@example.invalid',
  GIT_COMMITTER_DATE: GIT_DATE,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

interface TaskSeed {
  id: number;
  branch: string;
  verification: string[];
  worktree: boolean;
}

const TASKS: readonly TaskSeed[] = [
  { id: 30, branch: 'feat/pass', verification: ['true', 'echo verified'], worktree: true },
  { id: 31, branch: 'feat/fail', verification: ['true', "echo 'Error: boom' >&2; echo tail; false"], worktree: true },
  { id: 32, branch: 'feat/slow', verification: ['sleep 30'], worktree: true },
  { id: 33, branch: 'feat/reused', verification: ['true'], worktree: true },
  { id: 34, branch: 'feat/empty', verification: [], worktree: true },
  { id: 35, branch: 'feat/probes', verification: ['true'], worktree: true },
  { id: 36, branch: 'feat/regressed', verification: [], worktree: true },
  { id: 37, branch: 'feat/missing', verification: ['true'], worktree: false },
  { id: 38, branch: '', verification: ['true'], worktree: false },
];

function git(dir: string, args: string[]): string {
  const r = spawnSync('git', ['-C', dir, '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], {
    env: GIT_ENV,
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function worktreeRepo(dir: string, slug: string): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'README.md'), `${slug}\n`);
  git(dir, ['init', '-q']);
  git(dir, ['add', 'README.md']);
  git(dir, ['commit', '-q', '-m', slug]);
  return git(dir, ['rev-parse', 'HEAD']);
}

/** The sandbox every case starts from, rebuilt at <s> before each side runs. */
export function buildVerificationSandbox(s: string): void {
  rmSync(s, { recursive: true, force: true });
  mkdirSync(join(s, 'home'), { recursive: true });
  const checkout = join(s, 'project/checkout');
  mkdirSync(checkout, { recursive: true });
  const heads = new Map<number, string>();
  for (const t of TASKS) {
    if (t.worktree) {
      const slug = t.branch.slice(t.branch.indexOf('/') + 1);
      heads.set(t.id, worktreeRepo(join(checkout, '.claude/worktrees', slug), slug));
    }
  }
  const dbFile = join(s, PROJECT_DB);
  mkdirSync(dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  try {
    db.exec(SCHEMA);
    db.prepare('INSERT INTO repos (name, path, last_scanned_at) VALUES (?, ?, ?)').run('plugin', checkout, T1);
    db.prepare("INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (1, 'verification gate', 'open', ?, ?)").run(T1, T1);
    const task = db.prepare(
      "INSERT INTO tasks (id, issue_id, branch_id, description, status, repo, verification, created_at, updated_at) VALUES (?, 1, ?, 'd', 'running', 'plugin', ?, ?, ?)",
    );
    for (const t of TASKS) task.run(t.id, t.branch, JSON.stringify(t.verification), T1, T1);
    const recent = new Date(Date.now() - 60_000).toISOString();
    db.prepare("INSERT INTO verification_runs (id, task_id, commit_sha, source, started_at, finished_at, exit_code, budget_s, timed_out) VALUES (1, 33, ?, 'gate', ?, ?, 0, 900, 0)").run(
      heads.get(33) ?? '',
      recent,
      recent,
    );
    db.prepare("INSERT INTO verification_run_commands (run_id, ordinal, command, exit_code, elapsed_s, output_tail) VALUES (1, 1, 'true', 0, 0.1, '')").run();
    const finding = db.prepare(
      "INSERT INTO review_findings (id, task_id, attempt_n, criterion_id, probe_cmd, expected, observed, status, created_at) VALUES (?, ?, 1, 'SC1', ?, 'exit 0', 'exit 1', ?, ?)",
    );
    finding.run('F35-1', 35, 'true', 'open', T1);
    finding.run('F35-2', 35, 'false', 'wontfix', T1);
    finding.run('F36-1', 36, "echo 'FAIL: regressed'; exit 3", 'fixed', T1);
  } finally {
    db.close();
  }
  mkdirSync(join(s, 'bad/.claude/tmb'), { recursive: true });
  writeFileSync(join(s, 'bad/.claude/tmb/trajectory.db'), 'this is not a sqlite database\n'.repeat(64));
}

/** PATH with <cmd> gone: each dir holding it replaced by a dir of links to everything else. */
function noCmdPath(dir: string, cmd: string, path: string): string {
  let n = 0;
  return path
    .split(':')
    .filter((d) => d !== '')
    .map((d) => {
      if (!existsSync(join(d, cmd))) return d;
      n += 1;
      const shadow = join(dir, String(n));
      mkdirSync(shadow, { recursive: true });
      let names: string[] = [];
      try {
        names = readdirSync(d);
      } catch {
        /* unreadable dir: empty shadow */
      }
      for (const name of names) if (name !== cmd) symlinkSync(join(d, name), join(shadow, name));
      return shadow;
    })
    .join(':');
}

/** Timestamps as <ts>, `<n>.<n>s` elapsed seconds as <s>. */
export function maskVolatile(text: string): string {
  return text.replace(TS_RE, '<ts>').replace(ELAPSED_RE, '<s>');
}

function maskRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([k, v]) => {
        if (k === 'elapsed_s') return [k, v === null ? null : '<elapsed>'];
        return [k, typeof v === 'string' ? maskVolatile(v) : v];
      }),
    ),
  );
}

function dumpDb(path: string): string {
  const sha = (): string => createHash('sha256').update(readFileSync(path)).digest('hex');
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch {
    return sha();
  }
  try {
    const all = (sql: string): Record<string, unknown>[] => maskRows(db.prepare(sql).all() as Record<string, unknown>[]);
    return JSON.stringify({
      verification_runs: all('SELECT * FROM verification_runs ORDER BY id'),
      verification_run_commands: all('SELECT * FROM verification_run_commands ORDER BY run_id, ordinal'),
      review_findings: all('SELECT id, task_id, status, resolved_at FROM review_findings ORDER BY id'),
      audit: all('SELECT * FROM audit ORDER BY id'),
    });
  } catch {
    return sha();
  } finally {
    db.close();
  }
}

/** Every path under <root> but SQLite's side files and .git dirs; each DB as dumpDb, any other file as its sha256. */
function snapshot(root: string): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (/-(wal|shm|journal)$/.test(name) || name === '.git') continue;
      const rel = relative(root, path);
      if (statSync(path).isDirectory()) {
        out[`${rel}/`] = null;
        walk(path);
      } else {
        out[rel] = name.endsWith('.db') ? dumpDb(path) : createHash('sha256').update(readFileSync(path)).digest('hex');
      }
    }
  };
  walk(root);
  return out;
}

type SideExpect = string | Record<string, string>;
type Expect = string | { bash: SideExpect; ts: SideExpect };

function byLocale(expect: SideExpect, locale: string): string {
  return typeof expect === 'string' ? expect : (expect[locale] ?? '');
}

interface Case {
  input: Buffer;
  env: Record<string, string | null>;
  cwd: string;
  expect: Expect;
  divergent: string | undefined;
}

interface CorpusPaths {
  noJq: string;
  noSqlite: string;
}

export function materialize(file: string, s: string, paths: CorpusPaths): Case {
  const text = readFileSync(file, 'utf8').replaceAll('@SANDBOX@', s).replaceAll('@NOJQ_PATH@', paths.noJq).replaceAll('@NOSQLITE_PATH@', paths.noSqlite);
  const {
    corpus_env: env = {},
    corpus_cwd: cwd = 'project',
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
  return { input: Buffer.from(stdin ?? JSON.stringify(payload)), env, cwd: join(s, cwd), expect, divergent };
}

export function caseEnv(s: string, base: string, locale: string, extra: Record<string, string | null>, cwd: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of UNSET) delete env[key];
  Object.assign(env, {
    HOME: join(s, 'home'),
    CLAUDE_PROJECT_DIR: join(s, 'project'),
    TRAJECTORY_DB_PATH: join(s, PROJECT_DB),
    MISE_DATA_DIR: join(base, 'mise/data'),
    MISE_STATE_DIR: join(base, 'mise/state'),
    MISE_CACHE_DIR: join(base, 'mise/cache'),
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

function run(cmd: string, args: string[], c: Case, env: NodeJS.ProcessEnv): Run {
  const dir = mkdtempSync(join(tmpdir(), 'tmb-verification-stdin-'));
  const file = join(dir, 'stdin');
  writeFileSync(file, c.input);
  const fd = openSync(file, 'r');
  try {
    const r = spawnSync(cmd, args, { stdio: [fd, 'pipe', 'pipe'], env, cwd: c.cwd, encoding: 'utf8', timeout: 60_000 });
    if (r.error) throw r.error;
    return { code: r.status, stdout: maskVolatile(r.stdout), stderr: maskVolatile(r.stderr) };
  } finally {
    closeSync(fd);
    rmSync(dir, { recursive: true, force: true });
  }
}

/** `empty`: no stdout or stderr; anything else: a phrase of the output or of the project DB rows. */
function assertExpect(side: string, r: Run, tree: Record<string, string | null>, expect: string): void {
  const output = r.stdout + r.stderr;
  if (expect === 'empty') {
    assert.equal(output, '', `${side}: no output`);
    return;
  }
  const observed = `${output}\n${tree[PROJECT_DB] ?? ''}`;
  assert.ok(observed.includes(expect), `${side} observed ${JSON.stringify(expect)}: ${observed.slice(0, 1600)}`);
}

export function verificationCorpusFiles(): string[] {
  return existsSync(CORPUS_DIR) ? readdirSync(CORPUS_DIR).filter((f) => f.endsWith('.json')).sort() : [];
}

const cases = verificationCorpusFiles().flatMap((f) => LOCALES.map((locale) => ({ f, locale })));

export function sweVerificationParityShard(k: number, n: number): void {
  describe(
    `${GATE} parity: bash vs node over a rebuilt sandbox (shard ${k} of ${n})`,
    { skip: (!HAVE_SQLITE_CLI || !HAVE_JQ) && 'the .sh side needs the sqlite3 CLI and jq' },
    () => {
      let base: string;
      let s: string;
      let paths: CorpusPaths;
      before(() => {
        base = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-verification-parity-')));
        s = join(base, 'sandbox');
        const path = process.env.PATH ?? '';
        paths = { noJq: noCmdPath(join(base, 'nojq'), 'jq', path), noSqlite: noCmdPath(join(base, 'nosqlite'), 'sqlite3', path) };
      });
      after(() => {
        rmSync(base, { recursive: true, force: true });
      });

      if (k === 1) {
        it(`${GATE} has at least ${MIN_CORPUS} payloads, each with an expectation`, () => {
          const files = verificationCorpusFiles();
          assert.ok(files.length >= MIN_CORPUS, `${files.length} payloads`);
          for (const f of files) {
            const { expect, divergent } = materialize(join(CORPUS_DIR, f), '/s', { noJq: '', noSqlite: '' });
            if (divergent === undefined)
              assert.ok(
                typeof expect === 'string' ? expect !== '' : !('bash' in expect) && LOCALES.every((l) => byLocale(expect as SideExpect, l) !== ''),
                `${f}: an expectation, or one per locale`,
              );
            else
              assert.ok(
                typeof expect === 'object' && divergent !== '' && LOCALES.every((l) => byLocale(expect.bash, l) !== '' && byLocale(expect.ts, l) !== ''),
                `${f}: a divergent case names why and expects each side in every locale`,
              );
          }
        });
      }

      for (const { f, locale } of shardOf(cases, k, n)) {
        it(`${GATE} / ${f} (LC_ALL=${locale})`, () => {
          const c = materialize(join(CORPUS_DIR, f), s, paths);
          const env = caseEnv(s, base, locale, c.env, c.cwd);
          const { tree: bashTree, ...bash } = goldenBash(GATE, f, locale, goldenRoots({ '@SANDBOX@': s, '@BASE@': base }), () => {
            buildVerificationSandbox(s);
            return { ...run('bash', [join(PLUGIN_ROOT, 'scripts/hooks', `${GATE}.sh`)], c, env), tree: snapshot(s) };
          });
          buildVerificationSandbox(s);
          const node = run(process.execPath, [HOOKS_BUNDLE, GATE], c, env);
          const nodeTree = snapshot(s);
          assert.equal(bash.code, 0, `bash exit: ${bash.stderr}`);
          assert.equal(node.code, 0, `node exit: ${node.stderr}`);
          if (c.divergent === undefined) {
            assert.deepEqual(nodeTree, bashTree, 'the sandbox after the run');
            assert.equal(node.stdout, bash.stdout, 'stdout, byte for byte');
            assert.equal(node.stderr, bash.stderr, 'stderr, byte for byte');
            assertExpect('bash', bash, bashTree, byLocale(c.expect as SideExpect, locale));
          } else {
            const expect = c.expect as { bash: SideExpect; ts: SideExpect };
            assert.ok(
              node.stdout + node.stderr !== bash.stdout + bash.stderr || !isDeepStrictEqual(nodeTree, bashTree),
              `divergent (${c.divergent}): the sides must differ`,
            );
            assertExpect('bash', bash, bashTree, byLocale(expect.bash, locale));
            assertExpect('ts', node, nodeTree, byLocale(expect.ts, locale));
          }
        });
      }
    },
  );
}
