/**
 * Parity of the TypeScript merge-lifecycle gates with their
 * scripts/hooks/<gate>.sh (GH 1692): clean-merged-branch and
 * close-issue-on-merge, over tests/fixtures/hook-corpus/<gate>/. The sandbox is
 * built once and copied back to the same path before each side runs (git
 * keeps absolute worktree paths); both sides must exit 0, print the same stdout
 * and stderr byte for byte, and leave the sandbox alike: the repo's refs and
 * worktrees, which worktree dirs exist, the gh stub's call log, and the DB's
 * issues, tasks, agent_runs and audit rows with every timestamp the run wrote
 * masked as <now> and a duration_ms equal to its run's window as "window".
 *
 * The repo (project/repo, main checked out, registered as plugin with
 * target_branch dev and protected_branches ["release"]) holds dev; release;
 * feat/ancestor merged into dev with --no-ff; feat/squash squash-merged;
 * feat/open not merged; and feat/clean-wt, feat/dirty-wt (an untracked file),
 * feat/current and feat/close at dev, each checked out in wt/<name>. bin/gh is
 * a stub: `pr view <ref>` prints gh/pr-<ref>.json (else fails), `issue view
 * <n>` prints gh/state-<n> (else OPEN), and every call lands in gh.log. With
 * GH_STUB_SLEEP=<s>, `pr view` first sleeps <s> seconds in the stub's own
 * process, so a timeout kills it before it logs. Real gh and glab are off every
 * PATH, so no case reaches the network.
 *
 * A payload names the sandbox as @SANDBOX@ and the PATH without gh, without jq,
 * without the sqlite3 CLI or without `timeout` as @NOGH_PATH@ / @NOJQ_PATH@ /
 * @NOSQLITE_PATH@ / @NOTIMEOUT_PATH@ (the stub's bin dir is not in them); corpus_env (null unsets), corpus_cwd,
 * corpus_stdin and corpus_expect (`empty` for no output, or a phrase of the
 * observed stdout, stderr, gh log and DB rows, or an object of them by locale)
 * are removed before the run. A payload with corpus_divergent names a
 * divergence decision 703 allows: corpus_expect is then { bash, ts }, and the
 * two sides must differ in output or in the sandbox. The payload × locale (C,
 * en_US.UTF-8) runs split across hooks-merge-lifecycle-parity.shard-<k>of<n>.test.ts.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { noCmdPath } from './hooks-swe-run-parity.suite.js';
import { goldenBash, goldenRoots } from './golden.js';
import { shardOf } from './shard.js';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const CORPUS_ROOT = join(PLUGIN_ROOT, 'tests/fixtures/hook-corpus');
const HOOKS_BUNDLE = join(PLUGIN_ROOT, 'mcp/trajectory-server/dist/hooks.js');
const SCHEMA = readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema.sql'), 'utf8');
const LOCALES = ['C', 'en_US.UTF-8'];
const HAVE_SQLITE_CLI = spawnSync('sqlite3', ['-version'], { stdio: 'ignore' }).status === 0;
const HAVE_JQ = spawnSync('jq', ['--version'], { stdio: 'ignore' }).status === 0;
const T1 = '2026-10-01T10:00:00.000Z';
const T2 = '2026-10-01T11:00:00.000Z';
const SEEDED: ReadonlySet<string> = new Set([T1, T2]);
const TS_RE = /\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(\.\d+)?Z?/g;
const PROJECT_DB = 'project/.claude/tmb/trajectory.db';
const REPO = 'project/repo';
const WORKTREES = ['clean', 'dirty', 'current', 'close'];

export const MERGE_LIFECYCLE_MIN_CORPUS: Readonly<Record<string, number>> = {
  'clean-merged-branch': 10,
  'close-issue-on-merge': 12,
};
export const MERGE_LIFECYCLE_GATES = Object.keys(MERGE_LIFECYCLE_MIN_CORPUS);

const UNSET = [
  'TRAJECTORY_DB_PATH',
  'TMB_TEST_RUN_ID',
  'TMB_FORBID_LIVE_SYNC',
  'TMB_HOOKS_SQLITE',
  'TMB_DB_WRITE_TIMEOUT_MS',
  'TMB_DISABLE_CLEAN_MERGED_BRANCH',
  'TMB_DISABLE_CLOSE_ISSUE_ON_MERGE',
  'TMB_DISABLE_REMOTE_SYNC',
  'GH_TOKEN',
  'GH_STUB_SLEEP',
  'GITHUB_TOKEN',
  'LANG',
  'LC_CTYPE',
];

const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
};

const BUILD_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  ...GIT_ENV,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_AUTHOR_DATE: T1,
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_COMMITTER_DATE: T1,
};

const GH_STUB = `#!/bin/bash
if [ -n "\${GH_STUB_SLEEP:-}" ] && [ "$1 $2" = "pr view" ]; then
  GH_STUB_SLEEP= exec perl -e 'sleep shift; exec @ARGV' "$GH_STUB_SLEEP" "\${BASH_SOURCE[0]}" "$@"
fi
dir="\${BASH_SOURCE[0]%/*}/.."
printf '%s\\n' "$*" >> "$dir/gh.log"
case "$1 $2" in
  "pr view")
    f="$dir/gh/pr-$(printf '%s' "$3" | tr -c 'A-Za-z0-9.-' _).json"
    if [ -f "$f" ]; then cat "$f"; exit 0; fi
    echo "no pull requests found for branch \\"$3\\"" >&2
    exit 1 ;;
  "issue view")
    if [ -f "$dir/gh/state-$3" ]; then cat "$dir/gh/state-$3"; else echo OPEN; fi
    exit 0 ;;
  "issue close") exit 0 ;;
esac
exit 1
`;

const PRS: Readonly<Record<string, object>> = {
  '42': {
    headRefName: 'feat/close',
    closingIssuesReferences: [{ number: 101 }],
    body: 'Closes GH #102\r\nFixes #3\nresolves #999',
  },
  '43': {
    headRefName: 'feat/waived',
    closingIssuesReferences: [],
    body: 'Closes GH #105',
  },
  '44': {
    headRefName: 'feat/none',
    closingIssuesReferences: [],
    body: 'Tidy.\n\nFixes #3',
  },
  '45': {
    headRefName: 'feat/none',
    closingIssuesReferences: [{ number: 102 }],
    body: '',
  },
  '46': {
    headRefName: 'feat/none',
    closingIssuesReferences: [{ number: 106 }],
    body: null,
  },
  '47': {
    headRefName: 'feat/none',
    closingIssuesReferences: [{ number: 104 }],
    body: '',
  },
  '48': {
    headRefName: 'feat/none',
    closingIssuesReferences: null,
    body: 'This PR closes GH #107.',
  },
};

function git(dir: string, ...args: string[]): string {
  const r = spawnSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    env: BUILD_ENV,
  });
  assert.equal(r.status, 0, `git ${args.join(' ')} in ${dir}: ${r.stderr}`);
  return r.stdout.trim();
}

function commit(dir: string, file: string, msg: string): void {
  writeFileSync(join(dir, file), `${msg}\n`);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', msg);
}

function buildRepo(s: string): void {
  const repo = join(s, REPO);
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  commit(repo, 'README.md', 'init');
  git(repo, 'checkout', '-q', '-b', 'dev');
  commit(repo, 'dev.txt', 'dev work');
  git(repo, 'branch', 'release');
  git(repo, 'checkout', '-q', '-b', 'feat/ancestor', 'dev');
  commit(repo, 'a.txt', 'ancestor work');
  git(repo, 'checkout', '-q', 'dev');
  git(repo, 'merge', '-q', '--no-ff', '-m', 'merge ancestor', 'feat/ancestor');
  git(repo, 'checkout', '-q', '-b', 'feat/squash', 'dev');
  commit(repo, 's1.txt', 'squash one');
  commit(repo, 's2.txt', 'squash two');
  git(repo, 'checkout', '-q', 'dev');
  git(repo, 'merge', '-q', '--squash', 'feat/squash');
  git(repo, 'commit', '-qm', 'squash merge');
  git(repo, 'checkout', '-q', '-b', 'feat/open', 'dev');
  commit(repo, 'o.txt', 'open work');
  git(repo, 'checkout', '-q', 'main');
  for (const [wt, branch] of [
    ['clean', 'feat/clean-wt'],
    ['dirty', 'feat/dirty-wt'],
    ['current', 'feat/current'],
    ['close', 'feat/close'],
  ]) {
    git(repo, 'branch', branch, 'dev');
    git(repo, 'worktree', 'add', '-q', join(s, 'wt', wt), branch);
  }
  writeFileSync(join(s, 'wt/dirty/untracked.txt'), 'not committed\n');
}

function buildDb(s: string): void {
  const path = join(s, PROJECT_DB);
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec(SCHEMA);
    db.prepare("INSERT INTO repos (name, path, last_scanned_at, target_branch, protected_branches) VALUES ('plugin', ?, ?, 'dev', '[\"release\"]')").run(
      join(s, REPO),
      T1,
    );
    db.prepare("UPDATE plugin_config SET value_json = '\"github\"' WHERE key = 'issue_sync'").run();
    const issue = db.prepare(
      "INSERT INTO issues (id, objective, status, gh_iid, repo, created_at, updated_at, closed_at) VALUES (?, ?, ?, ?, 'plugin', ?, ?, ?)",
    );
    issue.run(1, 'closing ref by number', 'open', 101, T1, T1, null);
    issue.run(2, 'blocked by a live sibling', 'open', 102, T1, T1, null);
    issue.run(3, 'no remote twin', 'open', null, T1, T1, null);
    issue.run(4, 'already closed', 'closed', 104, T1, T1, T1);
    issue.run(5, 'waived tasks', 'open', 105, T1, T1, null);
    issue.run(6, 'remote still open', 'open', 106, T1, T1, null);
    issue.run(7, 'closes GH ref', 'open', 107, T1, T1, null);
    issue.run(8, 'reviewed task', 'open', null, T1, T1, null);
    issue.run(9, 'running task', 'open', null, T1, T1, null);
    issue.run(10, 'waived task', 'open', null, T1, T1, null);
    issue.run(11, 'second waived task', 'open', null, T1, T1, null);
    const task = db.prepare(
      "INSERT INTO tasks (id, issue_id, branch_id, description, status, commit_sha, repo, created_at, updated_at) VALUES (?, ?, ?, 'd', ?, ?, 'plugin', ?, ?)",
    );
    task.run(30, 1, 'feat/close', 'completed', 'abc1234', T1, T1);
    task.run(31, 8, 'feat/close', 'closed', 'def5678', T1, T1);
    task.run(32, 9, 'feat/close', 'running', null, T1, T1);
    task.run(33, 10, 'feat/close', 'needs_validation', 'abc9999', T1, T1);
    task.run(34, 2, 'feat/other', 'pending', null, T1, T1);
    task.run(35, 2, 'feat/close', 'completed', 'XYZ', T1, T1);
    task.run(36, 5, 'feat/waived', 'completed', 'aaa1111', T1, T1);
    task.run(37, 11, 'feat/waived', 'completed', 'bbb2222', T1, T1);
    db.prepare("INSERT INTO agent_runs (task_id, issue_id, agent_type, spawn_id, started_at, duration_ms) VALUES (32, 9, 'swe', 'agent-32', ?, 0)").run(T1);
    db.prepare("INSERT INTO agent_runs (task_id, issue_id, agent_type, spawn_id, started_at, duration_ms) VALUES (34, 2, 'swe', 'agent-34', ?, 0)").run(T1);
    const audit = db.prepare('INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    audit.run(8, 'feat/close', 'bro', 'bro_verification_pass', 'verified', '{"task_id":31,"commit_sha":"def5678"}', T1);
    audit.run(10, 'feat/close', 'bro', 'review_gate_waived', 'waived', '{"task_id":33,"commit_sha":"abc9999"}', T1);
    audit.run(5, 'feat/waived', 'hook:close-issue-on-merge', 'review_gate_bypassed', 'bypassed', '{"task_id":36,"commit_sha":"aaa1111"}', T1);
    audit.run(11, 'feat/waived', 'bro', 'review_gate_waived', 'waived', '{"task_id":37,"commit_sha":"bbb2222"}', T1);
    db.prepare(
      "INSERT INTO validation_attempts (task_id, attempt_n, agent, verdict, mcp_available, created_at) VALUES (31, 1, 'code-reviewer', 'pass', 1, ?)",
    ).run(T2);
  } finally {
    db.close();
  }
}

/** The sandbox every case starts from, built once at <s>. */
export function buildSandbox(s: string): void {
  rmSync(s, { recursive: true, force: true });
  mkdirSync(join(s, 'home'), { recursive: true });
  mkdirSync(join(s, 'bin'));
  writeFileSync(join(s, 'bin/gh'), GH_STUB);
  chmodSync(join(s, 'bin/gh'), 0o755);
  mkdirSync(join(s, 'gh'));
  for (const [ref, pr] of Object.entries(PRS)) writeFileSync(join(s, 'gh', `pr-${ref}.json`), `${JSON.stringify(pr)}\n`);
  writeFileSync(join(s, 'gh/state-105'), 'CLOSED\n');
  writeFileSync(join(s, 'gh/state-107'), 'CLOSED\n');
  buildRepo(s);
  buildDb(s);
}

function masked(value: unknown): unknown {
  return typeof value === 'string' ? value.replace(TS_RE, (ts) => (SEEDED.has(ts) ? ts : '<now>')) : value;
}

function rows(db: DatabaseSync, sql: string): Record<string, unknown>[] {
  return (db.prepare(sql).all() as Record<string, unknown>[]).map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, masked(v)])));
}

function dumpDb(path: string): string {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return JSON.stringify({
      issues: rows(db, 'SELECT id, status, closed_at, updated_at FROM issues ORDER BY id'),
      tasks: rows(db, 'SELECT id, status, completed_at, updated_at FROM tasks ORDER BY id'),
      agent_runs: rows(
        db,
        `SELECT id, task_id, exit_reason, usage_source, completed_at,
                CASE WHEN completed_at IS NOT NULL AND completed_at <> started_at AND duration_ms > 0
                          AND duration_ms = CAST(ROUND((julianday(completed_at) - julianday(started_at)) * 86400000) AS INTEGER)
                     THEN 'window' ELSE duration_ms END AS duration_ms
           FROM agent_runs ORDER BY id`,
      ),
      audit: rows(db, 'SELECT * FROM audit ORDER BY id'),
    });
  } finally {
    db.close();
  }
}

interface Snapshot {
  refs: string;
  worktrees: string;
  dirs: string[];
  ghLog: string;
  db: string;
}

function snapshot(s: string): Snapshot {
  const repo = join(s, REPO);
  const ghLog = join(s, 'gh.log');
  return {
    refs: git(repo, 'for-each-ref', '--format=%(refname) %(objectname)'),
    worktrees: git(repo, 'worktree', 'list', '--porcelain'),
    dirs: WORKTREES.filter((wt) => existsSync(join(s, 'wt', wt))),
    ghLog: existsSync(ghLog) ? readFileSync(ghLog, 'utf8') : '',
    db: dumpDb(join(s, PROJECT_DB)),
  };
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

interface Paths {
  noGh: string;
  noJq: string;
  noSqlite: string;
  noTimeout: string;
}

export function materialize(file: string, s: string, paths: Paths): Case {
  const text = readFileSync(file, 'utf8')
    .replaceAll('@SANDBOX@', s)
    .replaceAll('@NOGH_PATH@', paths.noGh)
    .replaceAll('@NOJQ_PATH@', paths.noJq)
    .replaceAll('@NOSQLITE_PATH@', paths.noSqlite)
    .replaceAll('@NOTIMEOUT_PATH@', paths.noTimeout);
  const {
    corpus_env: env = {},
    corpus_cwd: cwd = REPO,
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
  return {
    input: Buffer.from(stdin ?? JSON.stringify(payload)),
    env,
    cwd: join(s, cwd),
    expect,
    divergent,
  };
}

export function caseEnv(s: string, locale: string, paths: Paths, extra: Record<string, string | null>, cwd: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of UNSET) delete env[key];
  Object.assign(env, GIT_ENV, {
    PATH: `${join(s, 'bin')}:${paths.noGh}`,
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

function run(cmd: string, args: string[], c: Case, env: NodeJS.ProcessEnv, scratch: string): Run {
  const file = join(scratch, 'stdin');
  writeFileSync(file, c.input);
  const fd = openSync(file, 'r');
  try {
    const r = spawnSync(cmd, args, {
      stdio: [fd, 'pipe', 'pipe'],
      env,
      cwd: c.cwd,
      encoding: 'utf8',
      timeout: 30_000,
    });
    if (r.error) throw r.error;
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  } finally {
    closeSync(fd);
  }
}

/** `empty`: no stdout or stderr; anything else: a phrase of the output, the gh log or the DB rows. */
function assertExpect(side: string, r: Run, snap: Snapshot, expect: string): void {
  const output = r.stdout + r.stderr;
  if (expect === 'empty') {
    assert.equal(output, '', `${side}: no output`);
    return;
  }
  const observed = `${output}\n${snap.ghLog}\n${snap.db}`;
  assert.ok(observed.includes(expect), `${side} observed ${JSON.stringify(expect)}: ${observed.slice(0, 1500)}`);
}

export function mergeLifecycleCorpusFiles(gate: string): string[] {
  const dir = join(CORPUS_ROOT, gate);
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .sort()
    : [];
}

const cases = MERGE_LIFECYCLE_GATES.flatMap((gate) => mergeLifecycleCorpusFiles(gate).flatMap((f) => LOCALES.map((locale) => ({ gate, f, locale }))));

export function mergeLifecycleParityShard(k: number, n: number): void {
  describe(
    `merge-lifecycle gates parity: bash vs node over a git and DB sandbox (shard ${k} of ${n})`,
    {
      skip: (!HAVE_SQLITE_CLI || !HAVE_JQ) && 'the .sh side needs the sqlite3 CLI and jq',
    },
    () => {
      let base: string;
      let s: string;
      let pristine: string;
      let scratch: string;
      let paths: Paths;
      before(() => {
        base = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-merge-parity-')));
        s = join(base, 'sandbox');
        pristine = join(base, 'pristine');
        scratch = join(base, 'scratch');
        mkdirSync(scratch);
        const noGh = noCmdPath(join(base, 'noglab'), 'glab', noCmdPath(join(base, 'nogh'), 'gh', process.env.PATH ?? ''));
        paths = {
          noGh,
          noJq: noCmdPath(join(base, 'nojq'), 'jq', noGh),
          noSqlite: noCmdPath(join(base, 'nosqlite'), 'sqlite3', noGh),
          noTimeout: noCmdPath(join(base, 'notimeout'), 'timeout', noGh),
        };
        buildSandbox(s);
        cpSync(s, pristine, { recursive: true, verbatimSymlinks: true });
      });
      after(() => {
        rmSync(base, { recursive: true, force: true });
      });

      const restore = (): void => {
        rmSync(s, { recursive: true, force: true });
        cpSync(pristine, s, { recursive: true, verbatimSymlinks: true });
      };

      if (k === 1) {
        it('each merge-lifecycle gate has its minimum corpus, each payload with an expectation', () => {
          for (const gate of MERGE_LIFECYCLE_GATES) {
            const files = mergeLifecycleCorpusFiles(gate);
            const plain = files.filter(
              (f) =>
                materialize(join(CORPUS_ROOT, gate, f), '/s', {
                  noGh: '',
                  noJq: '',
                  noSqlite: '',
                  noTimeout: '',
                }).divergent === undefined,
            );
            assert.ok(plain.length >= MERGE_LIFECYCLE_MIN_CORPUS[gate], `${gate}: ${plain.length} parity payloads`);
            for (const f of files) {
              const { expect, divergent } = materialize(join(CORPUS_ROOT, gate, f), '/s', { noGh: '', noJq: '', noSqlite: '', noTimeout: '' });
              if (divergent === undefined)
                assert.ok(
                  typeof expect === 'string' ? expect !== '' : !('bash' in expect) && LOCALES.every((l) => byLocale(expect as SideExpect, l) !== ''),
                  `${gate}/${f}: an expectation, or one per locale`,
                );
              else
                assert.ok(
                  typeof expect === 'object' && divergent !== '' && LOCALES.every((l) => byLocale(expect.bash, l) !== '' && byLocale(expect.ts, l) !== ''),
                  `${gate}/${f}: a divergent case names why and expects each side in every locale`,
                );
            }
          }
        });

        it('the gh stub stands in for gh and real gh / glab are off the PATH', () => {
          const env = caseEnv(s, 'C', paths, {}, s);
          const which = (cmd: string): string =>
            spawnSync('bash', ['-c', `command -v ${cmd} || true`], {
              env,
              encoding: 'utf8',
            }).stdout.trim();
          assert.equal(which('gh'), join(s, 'bin/gh'));
          assert.equal(which('glab'), '');
          assert.equal(
            spawnSync('bash', ['-c', 'command -v gh || true'], {
              env: { ...env, PATH: paths.noGh },
              encoding: 'utf8',
            }).stdout.trim(),
            '',
          );
        });
      }

      for (const { gate, f, locale } of shardOf(cases, k, n)) {
        it(`${gate} / ${f} (LC_ALL=${locale})`, () => {
          const c = materialize(join(CORPUS_ROOT, gate, f), s, paths);
          const env = caseEnv(s, locale, paths, c.env, c.cwd);
          const { tree: bashSnap, ...bash } = goldenBash(gate, f, locale, goldenRoots({ '@SANDBOX@': s, '@BASE@': base }), () => {
            restore();
            return { ...run('bash', [join(PLUGIN_ROOT, 'scripts/hooks', `${gate}.sh`)], c, env, scratch), tree: snapshot(s) };
          });
          restore();
          const node = run(process.execPath, [HOOKS_BUNDLE, gate], c, env, scratch);
          const nodeSnap = snapshot(s);
          assert.equal(bash.code, 0, `bash exit: ${bash.stderr}`);
          assert.equal(node.code, 0, `node exit: ${node.stderr}`);
          if (c.divergent === undefined) {
            assert.deepEqual(nodeSnap, bashSnap, 'the sandbox after the run');
            assert.equal(node.stdout, bash.stdout, 'stdout, byte for byte');
            assert.equal(node.stderr, bash.stderr, 'stderr, byte for byte');
            assertExpect('bash', bash, bashSnap, byLocale(c.expect as SideExpect, locale));
          } else {
            const expect = c.expect as { bash: SideExpect; ts: SideExpect };
            assert.ok(
              node.stdout + node.stderr !== bash.stdout + bash.stderr || !isDeepStrictEqual(nodeSnap, bashSnap),
              `divergent (${c.divergent}): the sides must differ`,
            );
            assertExpect('bash', bash, bashSnap, byLocale(expect.bash, locale));
            assertExpect('ts', node, nodeSnap, byLocale(expect.ts, locale));
          }
        });
      }
    },
  );
}
