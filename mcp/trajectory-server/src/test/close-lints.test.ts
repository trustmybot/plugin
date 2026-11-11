/**
 * close-lints.ts (GH 2570) on a temp git repo and a temp trajectory DB:
 * runCloseLints runs a repo's close-lints.json lints and records one lint_runs
 * row with a lint_run_results row per lint in order; a failing lint keeps its
 * exit code and output tail, no config records a clean run with no results
 * over no fingerprint inputs, a lint past the budget records 124, and a
 * malformed config runs nothing.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { nowIso } from '../hooks/lib/audit.js';
import { describeFailures, LINT_TIMED_OUT, reusableLintRun, runCloseLints, type CloseLintsRun, type LintRecordTarget } from '../hooks/lib/close-lints.js';
import { CLOSE_LINTS_PATH, lintFingerprint } from '../hooks/lib/lint-fingerprint.js';
import { childEnv, GIT_ENV, migratedDb, sandboxDir, sqlExec } from './db-test-fixtures.js';

const TASK = '5151';

function rows(db: string, sql: string): Record<string, unknown>[] {
  const d = new DatabaseSync(db, { timeout: 5000 });
  try {
    return d.prepare(sql).all();
  } finally {
    d.close();
  }
}

function ran(run: CloseLintsRun | string): CloseLintsRun {
  if (typeof run === 'string') assert.fail(run);
  return run;
}

describe('close lints (GH 2570)', () => {
  let dir: string;
  let db: string;
  let seq = 0;
  const env = childEnv({ ...GIT_ENV, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' });
  const target = (): LintRecordTarget => ({ db, taskId: TASK, source: 'gate' });

  /** A repo whose base commit has changelog.d/ and whose HEAD adds a fragment plus <files>; returns its path, base and HEAD. */
  function repoAt(files: Record<string, string>): { repo: string; base: string; sha: string } {
    seq += 1;
    const repo = join(dir, `repo-${seq}`);
    mkdirSync(repo, { recursive: true });
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const write = (path: string, text: string) => {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), text);
    };
    git('init', '-q', '-b', 'dev');
    write('changelog.d/README.md', 'One file per change.\n');
    write('src/a.txt', 'one\n');
    git('add', '-A');
    git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD');
    write('changelog.d/1-x.md', '### Added\n- x\n');
    for (const [path, text] of Object.entries(files)) write(path, text);
    git('add', '-A');
    git('commit', '-qm', 'feature');
    return { repo, base, sha: git('rev-parse', 'HEAD') };
  }

  const config = (lints: Array<{ name: string; command: string }>, inputs: string[] = ['src/**']) =>
    JSON.stringify({ version: 1, lints, fingerprint_inputs: inputs });

  function recorded(run: CloseLintsRun) {
    const head = rows(db, `SELECT commit_sha, base_sha, fingerprint, source, exit_code, finished_at FROM lint_runs WHERE id = ${run.runId}`);
    const results = rows(db, `SELECT ordinal, name, exit_code, elapsed_s, output_tail FROM lint_run_results WHERE run_id = ${run.runId} ORDER BY ordinal`);
    assert.equal(head.length, 1);
    for (const col of ['commit_sha', 'base_sha', 'fingerprint', 'source', 'exit_code']) assert.notEqual(head[0][col], null, `lint_runs.${col}`);
    for (const r of results) for (const col of ['name', 'exit_code', 'elapsed_s', 'output_tail']) assert.notEqual(r[col], null, `lint_run_results.${col}`);
    return { head: head[0], results };
  }

  before(() => {
    dir = sandboxDir('close-lints');
    db = join(dir, 'trajectory.db');
    migratedDb(db);
    const now = nowIso();
    sqlExec(
      db,
      `INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (${TASK}, 'cl', 'open', '${now}', '${now}');
INSERT INTO tasks (id, issue_id, branch_id, description, status, created_at, updated_at) VALUES (${TASK}, ${TASK}, 'feat/cl', 'd', 'running', '${now}', '${now}');`,
    );
  });

  after(() => {
    const counts = rows(db, 'SELECT (SELECT COUNT(*) FROM lint_runs) AS runs, (SELECT COUNT(*) FROM lint_run_results) AS results')[0];
    assert.ok(Number(counts.runs) > 0, 'lint_runs has rows');
    assert.ok(Number(counts.results) > 0, 'lint_run_results has rows');
    rmSync(dir, { recursive: true, force: true });
  });

  it('records a passing config lint as one gate run with exit 0', async () => {
    const { repo, base, sha } = repoAt({ [CLOSE_LINTS_PATH]: config([{ name: 'greet', command: 'echo hello from $PWD' }]) });
    const run = ran(await runCloseLints(repo, sha, base, 30, env, target()));
    assert.equal(run.exitCode, 0);
    assert.deepEqual(run.failures, []);
    assert.equal(run.fingerprint, await lintFingerprint(repo, sha, ['src/**'], env));
    const { head, results } = recorded(run);
    assert.deepEqual({ ...head, finished_at: typeof head.finished_at }, {
      commit_sha: sha,
      base_sha: base,
      fingerprint: run.fingerprint,
      source: 'gate',
      exit_code: 0,
      finished_at: 'string',
    });
    assert.deepEqual(
      results.map((r) => [r.ordinal, r.name, r.exit_code]),
      [[1, 'greet', 0]],
    );
    assert.ok(String(results[0].output_tail).includes(`hello from ${repo}`), String(results[0].output_tail));
    assert.equal(reusableLintRun(target(), sha, base, run.fingerprint, env), run.runId);
    assert.equal(reusableLintRun(target(), sha, 'f'.repeat(40), run.fingerprint, env), null, 'another base is not reused');
    assert.equal(reusableLintRun(target(), sha, base, 'v1:other', env), null, 'another fingerprint is not reused');
  });

  it('records a failing lint with its exit code and output tail, and names it in the failure text', async () => {
    const script = 'for i in $(seq 1 30); do echo "line $i"; done; exit 3';
    const { repo, base, sha } = repoAt({
      [CLOSE_LINTS_PATH]: config([
        { name: 'ok', command: 'true' },
        { name: 'counts', command: script },
      ]),
    });
    const run = ran(await runCloseLints(repo, sha, base, 30, env, target()));
    assert.equal(run.exitCode, 3);
    assert.deepEqual(
      run.failures.map((f) => [f.name, f.exitCode]),
      [['counts', 3]],
    );
    const { head, results } = recorded(run);
    assert.equal(head.exit_code, 3);
    assert.deepEqual(
      results.map((r) => [r.name, r.exit_code]),
      [
        ['ok', 0],
        ['counts', 3],
      ],
    );
    assert.match(String(results[1].output_tail), /line 30$/);
    const text = describeFailures(run);
    assert.match(text, /^Lint counts exited 3\.\nOutput \(last 15 lines\):\nline 16\n/);
    assert.ok(!text.includes('line 15\n'), text);
    assert.equal(reusableLintRun(target(), sha, base, run.fingerprint, env), null, 'a failed run is not reused');
  });

  it('records a clean run with no results, fingerprinted over no inputs, when the repo has no close-lints.json', async () => {
    const { repo, sha } = repoAt({});
    const run = ran(await runCloseLints(repo, sha, sha, 30, env, target()));
    assert.equal(run.exitCode, 0);
    assert.equal(run.fingerprint, await lintFingerprint(repo, sha, [], env));
    const { head, results } = recorded(run);
    assert.equal(head.exit_code, 0);
    assert.equal(head.fingerprint, await lintFingerprint(repo, sha, [], env));
    assert.deepEqual(results, []);
  });

  it('records 124 for a lint past the budget, and for one the budget ran out before, and names them', async () => {
    const { repo, base, sha } = repoAt({
      [CLOSE_LINTS_PATH]: config([
        { name: 'slow', command: 'echo started; sleep 30' },
        { name: 'later', command: 'true' },
      ]),
    });
    const run = ran(await runCloseLints(repo, sha, base, 1, env, target()));
    assert.equal(run.exitCode, LINT_TIMED_OUT);
    const { head, results } = recorded(run);
    assert.equal(head.exit_code, LINT_TIMED_OUT);
    assert.deepEqual(
      results.map((r) => [r.name, r.exit_code]),
      [
        ['slow', LINT_TIMED_OUT],
        ['later', LINT_TIMED_OUT],
      ],
    );
    assert.match(String(results[0].output_tail), /started\nkilled at the 1s close-lint budget/);
    assert.match(String(results[1].output_tail), /budget ran out before `true` started/);
    const text = describeFailures(run);
    assert.match(text, /Lint slow exited 124 \(timed out\)\./);
    assert.match(text, /Lint later exited 124 \(timed out\)\./);
  });

  it('returns why, with nothing run or recorded, for a malformed close-lints.json', async () => {
    const { repo, base, sha } = repoAt({ [CLOSE_LINTS_PATH]: '{"version":1,"lints":"nope"}' });
    const before = rows(db, 'SELECT COUNT(*) AS n FROM lint_runs')[0].n;
    const run = await runCloseLints(repo, sha, base, 30, env, target());
    if (typeof run !== 'string') assert.fail(`expected a reason, got lint run ${run.runId}`);
    assert.ok(run.includes(`${CLOSE_LINTS_PATH} at ${sha.slice(0, 12)}: `), run);
    assert.equal(rows(db, 'SELECT COUNT(*) AS n FROM lint_runs')[0].n, before);
  });
});
