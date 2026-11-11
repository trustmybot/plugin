/**
 * Parity of the TypeScript task-close gate with its scripts/hooks/<gate>.sh
 * (GH 1692): swe-atomic-close, over tests/fixtures/hook-corpus/<gate>/. The
 * sandbox is built once, kept as a template and copied back to the same path
 * before each side runs, so its git SHAs and worktree links are the same for
 * both. Both sides must exit
 * 0, print the same stdout and stderr byte for byte, and leave the sandbox
 * alike: each DB as its tasks, agent_runs, agent_run_tool_output and audit
 * rows, every log as its text, each with the timestamps the run wrote masked
 * as <now>.
 *
 * swe-atomic-close: a project DB and a git checkout on dev (origin/dev at the
 * same commit), one task per decision-matrix row, each with its worktree and
 * spawn transcript under transcripts/: auto-complete running (30) and pending
 * (31), no commits (32), a checkpoint from this run (33), failed (34),
 * completed (35), escalated (36), a hook block (37), an empty parent resolved
 * through repos.target_branch (38), a stale local parent with the worktree at
 * origin's tip (39), no worktree with the commit in the repo checkout (40), a
 * resumed run metered from its started_at (41), a transcript with no usage
 * beside two open tool_use rows (42) and a code-reviewer stop (43), plus the
 * transcripts of an unbound spawn and of task 999.
 *
 * A payload names the sandbox as @SANDBOX@ and the PATH without jq or the
 * sqlite3 CLI as @NOJQ_PATH@ / @NOSQLITE_PATH@; corpus_env (null unsets),
 * corpus_cwd, corpus_stdin and corpus_expect (`empty` for no output, else a
 * phrase of the stdout, stderr, project DB rows and log) are removed before
 * the run. corpus_divergent names a divergence decision 703 allows:
 * corpus_expect is then { bash, ts }, and the two sides must differ. The
 * payload × locale runs split
 * across hooks-task-close-parity.shard-<k>of<n>.test.ts.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, cpSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { corpusFiles, noCmdPath } from './hooks-swe-run-parity.suite.js';
import { goldenBash, goldenRoots, liveHookCommand, sandboxSha, settledTree } from './golden.js';
import { shardOf } from './shard.js';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const CORPUS_ROOT = join(PLUGIN_ROOT, 'tests/fixtures/hook-corpus');
const HOOKS_BUNDLE = join(PLUGIN_ROOT, 'mcp/trajectory-server/dist/hooks.js');
const SCHEMA = readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema.sql'), 'utf8');
const LOCALES = ['C', 'en_US.UTF-8'];
const HAVE_SQLITE_CLI = spawnSync('sqlite3', ['-version'], { stdio: 'ignore' }).status === 0;
const HAVE_JQ = spawnSync('jq', ['--version'], { stdio: 'ignore' }).status === 0;
const SEEDED_YEAR = '2020-';
const TS_RE = /\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(\.\d+)?Z?/g;
const PROJECT_DB = 'project/.claude/tmb/trajectory.db';
const CLOSE_GATE = 'swe-atomic-close';
const MIN_CORPUS = 12;

const UNSET = [
  'TRAJECTORY_DB_PATH',
  'TMB_TEST_RUN_ID',
  'TMB_FORBID_LIVE_SYNC',
  'TMB_HOOKS_SQLITE',
  'TMB_SKIP_AUTO_RESCAN',
  'TMB_DB_WRITE_TIMEOUT_MS',
  'TMB_STOP_TASK_ID',
  'TMB_STOP_SPAWN_ID',
  'TMB_STOP_SINCE',
  'TMB_STOP_AGENT_TYPE',
  'CLAUDE_PLUGIN_ROOT',
  'LANG',
  'LC_CTYPE',
];

const GIT_ENV: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z',
};

function git(dir: string, ...args: string[]): string {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: GIT_ENV });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function commit(dir: string, file: string, message: string): string {
  writeFileSync(join(dir, file), `${message}\n`);
  git(dir, 'add', file);
  git(dir, 'commit', '-qm', message);
  return git(dir, 'rev-parse', 'HEAD');
}

const at = (seconds: number): string => new Date(Date.UTC(2020, 0, 1) + seconds * 1000).toISOString();

const usage = (input: number, output: number, read = 0, created = 0) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: created,
});

function transcript(path: string, entries: unknown[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, entries.map((e) => `${JSON.stringify(e)}\n`).join(''));
}

/** A swe spawn naming task <id>: one Bash call, its result, and a closing message. */
function spawnEntries(prompt: string, id: string, last: unknown = { type: 'text', text: 'done' }, measured = true): unknown[] {
  const u = (a: number, b: number, c?: number, d?: number) => (measured ? { usage: usage(a, b, c, d) } : {});
  return [
    { type: 'user', timestamp: at(0), message: { role: 'user', content: prompt } },
    {
      type: 'assistant',
      timestamp: at(5),
      message: { id: `msg-${id}-a`, model: 'claude-opus-5-5', role: 'assistant', ...u(100, 20, 1000, 50), content: [{ type: 'tool_use', id: `tu-${id}`, name: 'Bash', input: { command: 'ls' } }] },
    },
    { type: 'user', timestamp: at(6), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu-${id}`, content: 'file-a\nfile-b' }] } },
    { type: 'assistant', timestamp: at(60), message: { id: `msg-${id}-b`, model: 'claude-haiku-4', role: 'assistant', ...u(10, 30), content: [last] } },
  ];
}

function hookBlockEntries(id: string): unknown[] {
  return [
    { type: 'user', timestamp: at(0), message: { role: 'user', content: `task_id=${id} You are swe.` } },
    {
      type: 'assistant',
      timestamp: at(5),
      message: { id: `msg-${id}-a`, model: 'claude-opus-5-5', usage: usage(40, 8), content: [{ type: 'tool_use', id: `tu-${id}`, name: 'Bash', input: { command: 'rm -rf /' } }] },
    },
    {
      type: 'user',
      timestamp: at(7),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu-${id}`, is_error: true, content: 'PreToolUse:Bash hook error: BLOCKED: policy\nsecond line' }] },
    },
  ];
}

function trajectoryDb(path: string, rows: (db: DatabaseSync) => void): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec(SCHEMA);
    rows(db);
  } finally {
    db.close();
  }
}

/** The swe-atomic-close sandbox at <s> (see the header). */
export function buildCloseSandbox(s: string): void {
  rmSync(s, { recursive: true, force: true });
  mkdirSync(join(s, 'home'), { recursive: true });
  mkdirSync(join(s, 'bare'));
  mkdirSync(join(s, 'plugin-root/.claude-plugin'), { recursive: true });
  writeFileSync(join(s, 'plugin-root/.claude-plugin/plugin.json'), '{"name":"tmb","version":"9.9.9-parity"}\n');

  const repo = join(s, 'project/checkout');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'dev');
  const base = commit(repo, 'README.md', 'init');
  git(repo, 'update-ref', 'refs/remotes/origin/dev', base);
  const wt = (branch: string, slug: string): string => {
    const path = join(repo, '.claude/worktrees', slug);
    git(repo, 'branch', branch, base);
    git(repo, 'worktree', 'add', '-q', path, branch);
    return path;
  };
  const verifiedHeads = new Map<number, string>();
  verifiedHeads.set(30, commit(wt('feat/auto', 'auto'), 'work.txt', 'auto work'));
  verifiedHeads.set(31, commit(wt('feat/pending-commit', 'pending-commit'), 'work.txt', 'pending work'));
  wt('feat/no-commit', 'no-commit');
  wt('feat/checkpoint', 'checkpoint');
  commit(wt('feat/failed', 'failed'), 'work.txt', 'failed work');
  wt('feat/done', 'done');
  wt('feat/escalated', 'escalated');
  wt('feat/blocked', 'blocked');
  verifiedHeads.set(38, commit(wt('feat/empty-parent', 'empty-parent'), 'work.txt', 'empty parent work'));
  git(repo, 'branch', 'release', base);
  const stale = wt('feat/stale', 'stale');
  const released = commit(stale, 'release.txt', 'release on origin');
  git(repo, 'update-ref', 'refs/remotes/origin/release', released);
  wt('feat/resumed', 'resumed');
  wt('feat/unmeasured', 'unmeasured');

  const other = join(s, 'project/other');
  mkdirSync(other, { recursive: true });
  git(other, 'init', '-q', '-b', 'dev');
  commit(other, 'README.md', 'other init');
  git(other, 'checkout', '-q', '-b', 'feat/nowt');
  verifiedHeads.set(40, commit(other, 'work.txt', 'no worktree work'));

  const T0 = at(-3600);
  trajectoryDb(join(s, PROJECT_DB), (db) => {
    const repos = db.prepare('INSERT INTO repos (name, path, last_scanned_at, target_branch) VALUES (?, ?, ?, ?)');
    repos.run('plugin', repo, T0, 'dev');
    repos.run('other', other, T0, null);
    const issue = db.prepare("INSERT OR IGNORE INTO issues (id, objective, status, created_at, updated_at) VALUES (?, 'task close', 'open', ?, ?)");
    issue.run(-1, T0, T0);
    issue.run(1, T0, T0);
    const task = db.prepare(
      "INSERT INTO tasks (id, issue_id, branch_id, parent_branch_id, description, status, repo, effort, checkpoint, created_at, updated_at) VALUES (?, 1, ?, ?, 'd', ?, ?, ?, ?, ?, ?)",
    );
    const add = (id: number, branch: string, parent: string | null, status: string, repoName = 'plugin', effort = 'medium', checkpoint: string | null = null): void => {
      task.run(id, branch, parent, status, repoName, effort, checkpoint, T0, T0);
    };
    add(30, 'feat/auto', 'dev', 'running', 'plugin', 'high');
    add(31, 'feat/pending-commit', 'dev', 'pending');
    add(32, 'feat/no-commit', 'dev', 'running');
    add(33, 'feat/checkpoint', 'dev', 'running', 'plugin', 'low', JSON.stringify({ done: 'half', left: 'half', files: [], at: at(30) }));
    add(34, 'feat/failed', 'dev', 'failed');
    add(35, 'feat/done', 'dev', 'completed');
    add(36, 'feat/escalated', 'dev', 'escalated');
    add(37, 'feat/blocked', 'dev', 'running');
    add(38, 'feat/empty-parent', null, 'running');
    add(39, 'feat/stale', 'release', 'running');
    add(40, 'feat/nowt', 'dev', 'running', 'other');
    add(41, 'feat/resumed', 'dev', 'running');
    add(42, 'feat/unmeasured', 'dev', 'running');
    add(43, 'feat/reviewed', 'dev', 'completed');
    const run = db.prepare(
      'INSERT INTO agent_runs (id, task_id, issue_id, agent_type, spawn_id, started_at, completed_at, exit_reason, resumed_from, tokens_in) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)',
    );
    run.run(1, 30, 'swe', 'agent-30', at(0), null, null, null, null);
    run.run(2, 41, 'swe', 'agent-41', at(0), at(20), 'failed', null, 5);
    run.run(3, 41, 'swe', 'agent-41', at(30), null, null, 2, null);
    run.run(4, 42, 'swe', 'tool_use:toolu_42a', at(-600), null, null, null, null);
    run.run(5, 42, 'swe', 'tool_use:toolu_42b', at(-600), null, null, null, null);
    run.run(6, 43, 'code-reviewer', 'agent-43', at(0), null, null, null, null);
    const verified = db.prepare(
      "INSERT INTO verification_runs (task_id, commit_sha, source, started_at, finished_at, exit_code, budget_s, timed_out) VALUES (?, ?, 'gate', ?, ?, 0, 600, 0)",
    );
    for (const [taskId, head] of verifiedHeads) verified.run(taskId, head, at(0), at(5));
    db.prepare("INSERT OR REPLACE INTO plugin_config (key, value_json) VALUES ('reviewer_effort', '\"low\"')").run();
  });

  const tx = join(s, 'transcripts');
  for (const id of ['30', '31', '32', '33', '34', '35', '36', '38', '39', '40', '41'])
    transcript(join(tx, `${id}.jsonl`), spawnEntries(`task_id=${id} You are swe. Implement the spec.`, id));
  transcript(join(tx, '37.jsonl'), hookBlockEntries('37'));
  transcript(join(tx, '42.jsonl'), spawnEntries('task_id=42 You are swe.', '42', { type: 'text', text: 'done' }, false));
  transcript(join(tx, '43.jsonl'), spawnEntries('task_id=43 Review the commit.', '43'));
  transcript(join(tx, 'unbound.jsonl'), spawnEntries('You are swe. No task here.', 'unbound'));
  transcript(join(tx, '999.jsonl'), spawnEntries('task_id=999 You are swe.', '999'));
}

function masked(value: unknown): unknown {
  return typeof value === 'string' ? value.replace(TS_RE, (ts) => (ts.startsWith(SEEDED_YEAR) ? ts : '<now>')) : value;
}

function maskRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, masked(v)])));
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
      tasks: all('SELECT * FROM tasks ORDER BY id'),
      agent_runs: all('SELECT * FROM agent_runs ORDER BY id'),
      agent_run_tool_output: all('SELECT * FROM agent_run_tool_output ORDER BY run_id, tool_name'),
      audit: all('SELECT * FROM audit ORDER BY id'),
    });
  } catch {
    return sha();
  } finally {
    db.close();
  }
}

/** Every path under <root> but SQLite's side files: each DB as dumpDb, each log as its masked text, any other file as its sha256. */
function snapshot(root: string): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (/-(wal|shm|journal)$/.test(name)) continue;
      const rel = relative(root, path);
      if (statSync(path).isDirectory()) {
        out[`${rel}/`] = null;
        walk(path);
      } else if (name.endsWith('.db')) out[rel] = dumpDb(path);
      else if (/\.log(\.1)?$/.test(name)) out[rel] = masked(readFileSync(path, 'utf8')) as string;
      else out[rel] = sandboxSha(path, root);
    }
  };
  walk(root);
  return out;
}

type SideExpect = string | Record<string, string>;
type Sided<T> = T | { bash: T; ts: T };

function byLocale(expect: SideExpect, locale: string): string {
  return typeof expect === 'string' ? expect : (expect[locale] ?? '');
}

function side<T>(value: Sided<T>, name: 'bash' | 'ts'): T {
  return typeof value === 'object' && value !== null && 'bash' in value ? value[name] : (value as T);
}

interface Case {
  input: Buffer;
  env: Record<string, string | null>;
  cwd: string;
  expect: Sided<SideExpect>;
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
    corpus_expect?: Sided<SideExpect>;
    corpus_divergent?: string;
  };
  return { input: Buffer.from(stdin ?? JSON.stringify(payload)), env, cwd: join(s, cwd), expect, divergent };
}

export function caseEnv(s: string, locale: string, extra: Record<string, string | null>, cwd: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of UNSET) delete env[key];
  Object.assign(env, {
    HOME: join(s, 'home'),
    CLAUDE_PROJECT_DIR: join(s, 'project'),
    TRAJECTORY_DB_PATH: join(s, PROJECT_DB),
    CLAUDE_PLUGIN_ROOT: join(s, 'plugin-root'),
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
  const dir = mkdtempSync(join(tmpdir(), 'tmb-task-close-stdin-'));
  const file = join(dir, 'stdin');
  writeFileSync(file, c.input);
  const fd = openSync(file, 'r');
  try {
    const r = spawnSync(cmd, args, { stdio: [fd, 'pipe', 'pipe'], env, cwd: c.cwd, encoding: 'utf8', timeout: 20_000 });
    if (r.error) throw r.error;
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  } finally {
    closeSync(fd);
    rmSync(dir, { recursive: true, force: true });
  }
}

function assertExpect(name: string, r: Run, tree: Record<string, string | null>, expect: string): void {
  const output = r.stdout + r.stderr;
  if (expect === 'empty') {
    assert.equal(output, '', `${name}: no output`);
    return;
  }
  const observed = `${output}\n${tree[PROJECT_DB] ?? ''}\n${tree['project/.claude/tmb/logs/mcp-health.log'] ?? ''}`;
  assert.ok(observed.includes(expect), `${name} observed ${JSON.stringify(expect)}: ${observed.slice(0, 1500)}`);
}

const cases = corpusFiles(CLOSE_GATE).flatMap((f) => LOCALES.map((locale) => ({ gate: CLOSE_GATE, f, locale })));

export function taskCloseParityShard(k: number, n: number): void {
  describe(
    `task-close gates parity: bash vs node over a copied sandbox (shard ${k} of ${n})`,
    { skip: (!HAVE_SQLITE_CLI || !HAVE_JQ) && 'the .sh side needs the sqlite3 CLI and jq' },
    () => {
      let base: string;
      let s: string;
      let paths: CorpusPaths;
      let template: string;
      before(() => {
        base = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-task-close-parity-')));
        s = join(base, 'sandbox');
        const path = process.env.PATH ?? '';
        paths = { noJq: noCmdPath(join(base, 'nojq'), 'jq', path), noSqlite: noCmdPath(join(base, 'nosqlite'), 'sqlite3', path) };
        buildCloseSandbox(s);
        template = join(base, `template-${CLOSE_GATE}`);
        cpSync(s, template, { recursive: true });
      });
      after(() => {
        rmSync(base, { recursive: true, force: true });
      });
      const restore = (): void => {
        rmSync(s, { recursive: true, force: true });
        cpSync(template, s, { recursive: true });
      };

      if (k === 1) {
        it(`the ${CLOSE_GATE} corpus has its minimum of payloads, each with an expectation`, () => {
          const files = corpusFiles(CLOSE_GATE);
          assert.ok(files.length >= MIN_CORPUS, `${CLOSE_GATE}: ${files.length} payloads`);
          for (const f of files) {
            const { expect, divergent } = materialize(join(CORPUS_ROOT, CLOSE_GATE, f), '/s', { noJq: '', noSqlite: '' });
            const filled = (e: SideExpect): boolean => LOCALES.every((l) => byLocale(e, l) !== '');
            if (divergent === undefined) assert.ok(!(typeof expect === 'object' && 'bash' in expect) && filled(expect as SideExpect), `${CLOSE_GATE}/${f}: an expectation`);
            else
              assert.ok(
                typeof expect === 'object' && 'bash' in expect && divergent !== '' && filled(side(expect, 'bash')) && filled(side(expect, 'ts')),
                `${CLOSE_GATE}/${f}: a divergent case names why and expects each side`,
              );
          }
        });
      }

      for (const { gate, f, locale } of shardOf(cases, k, n)) {
        it(`${gate} / ${f} (LC_ALL=${locale})`, () => {
          const c = materialize(join(CORPUS_ROOT, gate, f), s, paths);
          const runSide = (name: 'bash' | 'ts') => {
            const env = caseEnv(s, locale, c.env, c.cwd);
            restore();
            const setup = snapshot(s);
            const r = name === 'bash' ? run(...liveHookCommand(gate), c, env) : run(process.execPath, [HOOKS_BUNDLE, gate], c, env);
            const tree = settledTree(setup, snapshot(s));
            return { name, r, tree };
          };
          const bash = goldenBash(gate, f, locale, goldenRoots({ '@SANDBOX@': s, '@BASE@': base }), () => runSide('bash'));
          const node = runSide('ts');
          for (const x of [bash, node]) assert.equal(x.r.code, 0, `${x.name} exit: ${x.r.stderr}`);
          if (c.divergent === undefined) {
            assert.deepEqual(node.tree, bash.tree, 'the sandbox after the run');
            assert.equal(node.r.stdout, bash.r.stdout, 'stdout, byte for byte');
            assert.equal(node.r.stderr, bash.r.stderr, 'stderr, byte for byte');
            assertExpect('bash', bash.r, bash.tree, byLocale(c.expect as SideExpect, locale));
          } else {
            assert.ok(
              node.r.stdout + node.r.stderr !== bash.r.stdout + bash.r.stderr || !isDeepStrictEqual(node.tree, bash.tree),
              `divergent (${c.divergent}): the sides must differ`,
            );
            assertExpect('bash', bash.r, bash.tree, byLocale(side(c.expect, 'bash'), locale));
            assertExpect('ts', node.r, node.tree, byLocale(side(c.expect, 'ts'), locale));
          }
        });
      }
    },
  );
}
