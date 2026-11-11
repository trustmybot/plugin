// lint-runs.ts (GH 2570) against a temp DB: start, result and finish SQL land a lint_runs row and its results, latestLintRun reads them back, the start sweep finishes a stale run as 137, and parseCloseLints validates close-lints.json.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { dbWrite, nowIso } from '../hooks/lib/audit.js';
import {
  LINT_RUN_STALE_S,
  latestLintRun,
  lintRunFinishSql,
  lintRunResultSql,
  lintRunStartSql,
  parseCloseLints,
  type LintRunSource,
} from '../hooks/lib/lint-runs.js';
import { childEnv, migratedDb, sandboxDir, sqlExec } from './db-test-fixtures.js';

function sqlRows(db: string, sql: string): Record<string, unknown>[] {
  const d = new DatabaseSync(db, { timeout: 5000 });
  try {
    return d.prepare(sql).all();
  } finally {
    d.close();
  }
}

const SHA = '0123456789abcdef0123456789abcdef01234567';
const BASE = 'fedcba9876543210fedcba9876543210fedcba98';
const FP = 'v1:' + 'ab'.repeat(32);
const TASK = '4242';

describe('lint runs (GH 2570)', () => {
  let dir: string;
  let db: string;
  const env = childEnv();

  const write = (sql: string): string => {
    const r = dbWrite(db, sql, { caller: 'lint-runs-test', env });
    assert.ok(r.ok, r.error);
    return r.stdout.trim();
  };
  const start = (sha: string, source: LintRunSource = 'gate', now?: string): string => {
    const s = lintRunStartSql(TASK, sha, BASE, FP, source, now);
    assert.equal(s.code, 0, s.error);
    const id = write(s.sql);
    assert.match(id, /^[0-9]+$/, 'start prints the run id');
    return id;
  };
  const result = (runId: string, ordinal: number, name: string, rc: number, elapsed: number, output: string, extra: Record<string, string> = {}): void => {
    const s = lintRunResultSql(runId, ordinal, name, rc, elapsed, output, { ...env, ...extra });
    assert.equal(s.code, 0, s.error);
    write(s.sql);
  };
  const finish = (runId: string, rc: number, now?: string): void => {
    const s = lintRunFinishSql(runId, rc, now);
    assert.equal(s.code, 0, s.error);
    write(s.sql);
  };

  before(() => {
    dir = sandboxDir('lint-runs');
    db = join(dir, 'trajectory.db');
    migratedDb(db);
    const now = nowIso();
    sqlExec(
      db,
      `INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (${TASK}, 'lr', 'open', '${now}', '${now}');
INSERT INTO tasks (id, issue_id, branch_id, description, status, created_at, updated_at) VALUES (${TASK}, ${TASK}, 'feat/lr', 'd', 'running', '${now}', '${now}');`,
    );
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  it('start, result and finish land the run and its results; latestLintRun reads them in ordinal order', () => {
    const run = start(SHA);
    assert.equal(latestLintRun(db, TASK, SHA, env), null, 'an unfinished run is not read');
    result(run, 2, "it's second", 1, 0.5, 'line one\nline two');
    result(run, 1, 'first', 0, 1.25, 'ok');
    finish(run, 1);

    const rows = sqlRows(db, `SELECT commit_sha, base_sha, fingerprint, source, exit_code, finished_at FROM lint_runs WHERE id = ${run}`);
    assert.deepEqual({ ...rows[0], finished_at: typeof rows[0].finished_at }, {
      commit_sha: SHA,
      base_sha: BASE,
      fingerprint: FP,
      source: 'gate',
      exit_code: 1,
      finished_at: 'string',
    });
    const counts = sqlRows(db, 'SELECT (SELECT COUNT(*) FROM lint_runs) AS runs, (SELECT COUNT(*) FROM lint_run_results) AS results')[0];
    assert.ok(Number(counts.runs) > 0 && Number(counts.results) > 0, 'both tables are populated');
    const nulls = sqlRows(
      db,
      `SELECT COUNT(*) AS n FROM lint_run_results WHERE run_id = ${run} AND (name IS NULL OR exit_code IS NULL OR elapsed_s IS NULL OR output_tail IS NULL)`,
    )[0];
    assert.equal(Number(nulls.n), 0, 'every named result column is set');

    const latest = latestLintRun(db, TASK, SHA, env);
    assert.ok(latest);
    assert.equal(latest.run_id, Number(run));
    assert.equal(latest.task_id, Number(TASK));
    assert.equal(latest.commit_sha, SHA);
    assert.equal(latest.base_sha, BASE);
    assert.equal(latest.fingerprint, FP);
    assert.equal(latest.source, 'gate');
    assert.equal(latest.exit_code, 1);
    assert.deepEqual(latest.results, [
      { ordinal: 1, name: 'first', exit_code: 0, elapsed_s: 1.25, output_tail: 'ok' },
      { ordinal: 2, name: "it's second", exit_code: 1, elapsed_s: 0.5, output_tail: 'line one\nline two' },
    ]);
    assert.equal(latestLintRun(db, TASK, BASE, env), null, 'another sha has no run');
    assert.equal(latestLintRun(db, '1', SHA, env), null, 'another task has no run');
    assert.equal(latestLintRun(db, 'x', SHA, env), null, 'a non-numeric task id reads nothing');
    assert.equal(latestLintRun(join(dir, 'missing.db'), TASK, SHA, env), null, 'a missing DB reads nothing');
  });

  it('a zero-lint run reads back with exit_code 0 and no results, and is the newest', () => {
    const run = start(SHA, 'integrate');
    finish(run, 0);
    const latest = latestLintRun(db, TASK, SHA, env);
    assert.ok(latest);
    assert.equal(latest.run_id, Number(run));
    assert.equal(latest.source, 'integrate');
    assert.equal(latest.exit_code, 0);
    assert.deepEqual(latest.results, []);
  });

  it('the output tail is capped as verification command rows are', () => {
    const run = start(BASE);
    result(run, 1, 'long', 0, 0, '0123456789abcdefghij', { TMB_VERIFICATION_TAIL_CHARS: '10' });
    finish(run, 0);
    assert.equal(latestLintRun(db, TASK, BASE, env)?.results[0]?.output_tail, 'abcdefghij');
  });

  it('start finishes a run left unfinished past LINT_RUN_STALE_S as exit 137 and leaves a live one', () => {
    const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString();
    const stale = start('stale', 'gate', ago(LINT_RUN_STALE_S + 60));
    const live = start('live', 'gate', ago(60));
    const next = start(SHA);
    const state = (id: string) => sqlRows(db, `SELECT exit_code, finished_at IS NOT NULL AS done FROM lint_runs WHERE id = ${id}`)[0];
    assert.deepEqual({ ...state(stale) }, { exit_code: 137, done: 1 }, 'the stale run is finished as 137');
    assert.deepEqual({ ...state(live) }, { exit_code: null, done: 0 }, 'a run within the window is left');
    assert.deepEqual({ ...state(next) }, { exit_code: null, done: 0 }, 'the new run starts unfinished');
    assert.equal(latestLintRun(db, TASK, 'stale', env)?.exit_code, 137);
  });

  it('latestLintRun picks the newest-started run even when an older run is swept to 137 after a newer run passed', () => {
    const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString();
    const killed = start('swept', 'gate', ago(LINT_RUN_STALE_S + 600));
    const passed = start('swept', 'gate', ago(LINT_RUN_STALE_S + 300));
    finish(passed, 0, ago(LINT_RUN_STALE_S + 200));
    start(SHA);
    const stamp = (id: string) => sqlRows(db, `SELECT exit_code, finished_at FROM lint_runs WHERE id = ${id}`)[0];
    assert.equal(stamp(killed).exit_code, 137, 'the killed run is swept to 137');
    assert.ok(String(stamp(killed).finished_at) > String(stamp(passed).finished_at), 'the sweep stamps the killed run finished after the passing one');
    const latest = latestLintRun(db, TASK, 'swept', env);
    assert.equal(latest?.run_id, Number(passed));
    assert.equal(latest?.exit_code, 0);
  });

  it('deleting the task cascades to its runs and results', () => {
    sqlExec(db, `PRAGMA foreign_keys = ON; DELETE FROM tasks WHERE id = ${TASK};`);
    const counts = sqlRows(db, 'SELECT (SELECT COUNT(*) FROM lint_runs) AS runs, (SELECT COUNT(*) FROM lint_run_results) AS results')[0];
    assert.deepEqual({ ...counts }, { runs: 0, results: 0 });
  });

  it('the builders refuse ids, sources and numbers that are not what they say', () => {
    assert.equal(lintRunStartSql('1; DROP TABLE x', SHA, BASE, FP, 'gate').code, 2);
    assert.equal(lintRunStartSql(TASK, SHA, BASE, FP, 'manual' as LintRunSource).code, 2);
    assert.equal(lintRunResultSql('1 OR 1', 1, 'n', 0, 0, '', env).code, 2);
    assert.equal(lintRunResultSql('1', 0, 'n', 0, 0, '', env).code, 2);
    assert.equal(lintRunResultSql('1', 1, 'n', 0, Number.NaN, '', env).code, 2);
    assert.match(lintRunFinishSql('x', 0).error, /^tmb_lint_run: lintRunFinishSql: invalid run_id 'x'$/);
  });
});

describe('parseCloseLints (GH 2570)', () => {
  it('accepts a valid config', () => {
    assert.deepEqual(
      parseCloseLints(
        JSON.stringify({ lints: [{ name: 'l1', command: 'node tests/run-all.ts --l1-only', extra: 1 }], fingerprint_inputs: ['**/*', 'bun.lock'] }),
      ),
      { lints: [{ name: 'l1', command: 'node tests/run-all.ts --l1-only' }], fingerprint_inputs: ['**/*', 'bun.lock'] },
    );
    assert.deepEqual(parseCloseLints('{"lints":[],"fingerprint_inputs":[]}'), { lints: [], fingerprint_inputs: [] });
  });

  it('rejects a missing name or command, a non-array and bad JSON', () => {
    const bad = (text: string, re: RegExp) => {
      const r = parseCloseLints(text);
      assert.equal(typeof r, 'string', `rejected: ${text}`);
      assert.match(r as string, re);
    };
    bad('{"lints":[{"command":"true"}],"fingerprint_inputs":[]}', /lints\[0\]\.name/);
    bad('{"lints":[{"name":"n","command":" "}],"fingerprint_inputs":[]}', /lints\[0\]\.command/);
    bad('{"lints":[{"name":"n"}],"fingerprint_inputs":[]}', /lints\[0\]\.command/);
    bad('{"lints":{"name":"n","command":"true"},"fingerprint_inputs":[]}', /lints must be an array/);
    bad('{"lints":[],"fingerprint_inputs":"**/*"}', /fingerprint_inputs must be an array/);
    bad('{"lints":[]}', /fingerprint_inputs must be an array/);
    bad('{"lints":["true"],"fingerprint_inputs":[]}', /lints\[0\] must be an object/);
    bad('[]', /must be a JSON object/);
    bad('{"lints":[', /not valid JSON/);
  });

  it('rejects a duplicate lint name', () => {
    const reason = (lints: Array<{ name: string; command: string }>) => parseCloseLints(JSON.stringify({ lints, fingerprint_inputs: [] }));
    assert.equal(reason([{ name: 'l1', command: 'true' }, { name: 'l1', command: 'false' }]), "lints[1].name 'l1' is a duplicate");
    assert.deepEqual(reason([{ name: 'l1', command: 'true' }, { name: 'l2', command: 'true' }]), {
      lints: [{ name: 'l1', command: 'true' }, { name: 'l2', command: 'true' }],
      fingerprint_inputs: [],
    });
  });
});
