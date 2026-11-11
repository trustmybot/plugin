/**
 * A code-reviewer FAIL reopens its task at high (GH 2866): validation_record
 * moves a completed, needs_validation or closed task of an open issue back to
 * running at effort high in the FAIL's own transaction, raises a running one
 * to high, and leaves every other task as it is; require-spawn-effort and
 * task_reopen hold a task with a FAIL since its last pass at high; and
 * require-task-spec denies the swe spawn of a reopened task whose worktree is
 * gone until task_reopen recreates it, on a project that is not this plugin.
 */
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TrajectoryDB } from '../db.js';
import { GraphHolder, WorldModelGraph } from '../graph.js';
import { ALLOW } from '../hooks/gate.js';
import { requireSpawnEffort } from '../hooks/require-spawn-effort.js';
import { requireTaskSpec } from '../hooks/require-task-spec.js';
import { GATE_NAME as REWORK_GATE, reworkLimitVerdict } from '../hooks/rework-limit.js';
import { SPAWN_NOTE_MAX_CHARS } from '../success-criteria.js';
import { compositeTools } from '../tools/composites.js';
import { reReviewAdmission } from '../tools/reopen.js';
import { scanTools } from '../tools/scan.js';
import { REVIEWER_SPAWN_FROM_NODE, validationTools } from '../tools/validation.js';
import { reindexIdle } from '../world-model/freshness.js';
import { TEST_PROBES, pinScanEnv, seedPassingRun, seedReviewerObservation, tempDB, type ScanEnvPin } from './helpers.js';

type Raw = { content: Array<{ type: string; text: string }>; isError?: boolean };
type Handlers = Record<string, (args: Record<string, unknown>) => Promise<unknown>>;

const parse = (r: unknown): Record<string, unknown> => JSON.parse((r as Raw).content[0].text) as Record<string, unknown>;

interface Finding {
  probe_cmd: string;
  expected: string;
  observed: string;
  severity?: 'blocking' | 'nit' | 'pre_existing';
  class?: string | null;
}

const blocking = (cls: string | null): Finding => ({ probe_cmd: 'false', expected: 'e', observed: 'o', class: cls });
const nit: Finding = { probe_cmd: 'true', expected: 'e', observed: 'o', severity: 'nit' };

let pin: ScanEnvPin;
before(() => {
  pin = pinScanEnv();
});
after(() => pin.restore());
afterEach(() => reindexIdle());

describe('validation_record reopens on a FAIL (GH 2866)', () => {
  let dir: string;
  let dbFile: string;
  let db: TrajectoryDB;
  let nextTask = 100;
  const attempts = new Map<number, number>();

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'auto-reopen-'));
    dbFile = join(dir, 'project', '.claude', 'tmb', 'trajectory.db');
    mkdirSync(dirname(dbFile), { recursive: true });
    db = tempDB({ path: dbFile });
    db.run(`INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (1, 'o', 'open', datetime('now'), datetime('now'))`);
    db.run(`INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (2, 'shut', 'closed', datetime('now'), datetime('now'))`);
  });
  after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function task(status: string, effort: string, issueId = 1): number {
    const id = nextTask++;
    db.run(
      `INSERT INTO tasks (id, issue_id, branch_id, parent_branch_id, description, status, effort, spec_body, completion_report, completed_at, created_at, updated_at)
       VALUES (?, ?, ?, 'dev', 'd', ?, ?, 'spec', '{"criteria":[]}', datetime('now'), datetime('now'), datetime('now'))`,
      [id, issueId, `feat/t${id}`, status, effort],
    );
    return id;
  }

  async function record(taskId: number, verdict: string, findings?: Finding[]): Promise<Raw> {
    const attemptN = (attempts.get(taskId) ?? 0) + 1;
    attempts.set(taskId, attemptN);
    seedReviewerObservation(db, taskId, attemptN, { agentId: `reviewer-${taskId}-${attemptN}` });
    if (verdict === 'pass') seedPassingRun(db, taskId);
    return (await validationTools(db).handlers['validation_record']({
      agent: 'code-reviewer',
      task_id: String(taskId),
      attempt_n: attemptN,
      verdict,
      feedback: '# Review',
      mcp_available: true,
      probes: TEST_PROBES,
      ...(findings ? { findings } : {}),
    })) as unknown as Raw;
  }

  const row = (taskId: number) =>
    db.get<{ status: string; effort: string; completion_report: string | null; completed_at: string | null; spawn_note: string | null }>(
      'SELECT status, effort, completion_report, completed_at, spawn_note FROM tasks WHERE id = ?',
      [taskId],
    )!;
  const auditRows = (taskId: number, eventType: string) =>
    db.all<{ from_node: string; content_json: string; created_at: string }>(
      `SELECT from_node, content_json, created_at FROM audit WHERE event_type = ? AND json_extract(content_json, '$.task_id') = ? ORDER BY id`,
      [eventType, taskId],
    );

  it('SC1/SC2: a FAIL on a completed medium task reopens it at high with one reopen and one raise row', async () => {
    const id = task('completed', 'medium');
    const out = parse(await record(id, 'fail', [blocking('stale-cache'), blocking(null), nit]));
    const findingIds = (out['findings'] as Array<{ id: string; severity: string }>).filter((f) => f.severity === 'blocking').map((f) => f.id);
    assert.equal(findingIds.length, 2);

    const t = row(id);
    assert.equal(t.status, 'running');
    assert.equal(t.effort, 'high');
    assert.equal(t.completion_report, null);
    assert.equal(t.completed_at, null);

    const reopened = auditRows(id, 'task_reopened');
    assert.equal(reopened.length, 1);
    assert.equal(reopened[0].from_node, 'code-reviewer');
    const content = JSON.parse(reopened[0].content_json) as Record<string, unknown>;
    assert.equal(content['validation_id'], out['id']);
    assert.notEqual(content['validation_id'], null);
    assert.deepEqual(content['finding_ids'], findingIds);
    assert.equal(content['auto'], true);
    assert.equal(content['from_status'], 'completed');

    const raised = auditRows(id, 'task_effort_raised');
    assert.equal(raised.length, 1);
    assert.equal(raised[0].from_node, 'code-reviewer');
    assert.deepEqual(JSON.parse(raised[0].content_json), { task_id: id, from: 'medium', to: 'high' });
    assert.equal(raised[0].created_at, out['created_at'], 'the raise is dated the FAIL row');

    assert.deepEqual(out['reopened'], {
      task_id: id,
      from_status: 'completed',
      status: 'running',
      effort: 'high',
      effort_raised: true,
      finding_ids: findingIds,
    });
    assert.equal(out['reopen_skipped'], undefined);
    assert.ok(t.spawn_note !== null);
    assert.ok(t.spawn_note.includes(`${findingIds[0]} (stale-cache)`), t.spawn_note);
    assert.ok(t.spawn_note.includes(findingIds[1]), t.spawn_note);
    assert.match(String(out['return_line']), /fail/i, 'return_line is still the reviewer line');
  });

  it('SC1: needs_validation and closed tasks reopen too; a task already at high writes no raise row', async () => {
    for (const status of ['needs_validation', 'closed']) {
      const id = task(status, 'high');
      const out = parse(await record(id, 'fail', [blocking('x')]));
      assert.equal(row(id).status, 'running', status);
      assert.equal(auditRows(id, 'task_reopened').length, 1, status);
      assert.equal(auditRows(id, 'task_effort_raised').length, 0, status);
      assert.equal((out['reopened'] as { effort_raised: boolean }).effort_raised, false);
    }
  });

  it('SC1: a failed write rolls back the FAIL row, its findings and the reopen', async () => {
    const id = task('completed', 'low');
    db.run(`CREATE TRIGGER boom BEFORE INSERT ON audit WHEN NEW.event_type = 'task_effort_raised'
             BEGIN SELECT RAISE(ABORT, 'boom'); END;`);
    try {
      const r = await record(id, 'fail', [blocking('x')]);
      assert.equal(r.isError, true, r.content[0].text);
    } finally {
      db.run('DROP TRIGGER boom');
    }
    assert.equal(row(id).status, 'completed');
    assert.equal(row(id).effort, 'low');
    assert.notEqual(row(id).completion_report, null);
    assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM validation_attempts WHERE task_id = ?', [id])!.n, 0);
    assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM review_findings WHERE task_id = ?', [id])!.n, 0);
    assert.equal(auditRows(id, 'task_reopened').length, 0);
    assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM discussions WHERE task_id = ?", [id])!.n, 0);
  });

  it(`SC2: the spawn_note is capped at ${SPAWN_NOTE_MAX_CHARS} characters`, async () => {
    const id = task('completed', 'high');
    await record(id, 'fail', Array.from({ length: 12 }, (_, i) => blocking(`a-rather-long-bug-class-name-${i}`)));
    const note = row(id).spawn_note;
    assert.ok(note !== null);
    assert.ok(note.length <= SPAWN_NOTE_MAX_CHARS, `${note.length}`);
    assert.ok(note.includes(`F${id}-1 (a-rather-long-bug-class-name-0)`));
  });

  it('SC2/SC3: a FAIL on a pending task or on a task of a closed issue changes nothing', async () => {
    const pending = task('pending', 'medium');
    let out = parse(await record(pending, 'fail', [blocking('x')]));
    assert.deepEqual(out['reopen_skipped'], { reason: 'status_pending' });
    assert.equal(out['reopened'], undefined);
    assert.equal(row(pending).status, 'pending');
    assert.equal(row(pending).effort, 'medium');

    const ofClosedIssue = task('completed', 'medium', 2);
    out = parse(await record(ofClosedIssue, 'fail', [blocking('x')]));
    assert.deepEqual(out['reopen_skipped'], { reason: 'issue_closed' });
    assert.equal(row(ofClosedIssue).status, 'completed');
    assert.equal(row(ofClosedIssue).effort, 'medium');

    const runningOfClosedIssue = task('running', 'medium', 2);
    await record(runningOfClosedIssue, 'fail', [blocking('x')]);
    assert.equal(row(runningOfClosedIssue).effort, 'medium');

    for (const id of [pending, ofClosedIssue, runningOfClosedIssue]) {
      assert.equal(auditRows(id, 'task_reopened').length, 0);
      assert.equal(auditRows(id, 'task_effort_raised').length, 0);
    }
  });

  it('SC3: a FAIL on a failed or escalated task changes nothing', async () => {
    for (const status of ['failed', 'escalated']) {
      const id = task(status, 'low');
      const out = parse(await record(id, 'fail', [blocking('x')]));
      assert.deepEqual(out['reopen_skipped'], { reason: `status_${status}` });
      assert.equal(row(id).status, status);
      assert.equal(row(id).effort, 'low');
      assert.equal(auditRows(id, 'task_reopened').length + auditRows(id, 'task_effort_raised').length, 0);
    }
  });

  it('SC3: pass and escalate never reopen', async () => {
    const id = task('completed', 'medium');
    let out = parse(await record(id, 'pass'));
    assert.equal(out['reopened'], undefined);
    assert.equal(out['reopen_skipped'], undefined);
    out = parse(await record(id, 'escalate', [blocking('x')]));
    assert.equal(out['reopened'], undefined);
    assert.equal(row(id).status, 'completed');
    assert.equal(row(id).effort, 'medium');
    assert.equal(auditRows(id, 'task_reopened').length + auditRows(id, 'task_effort_raised').length, 0);
  });

  it('SC3: a FAIL on a running task only raises its effort; a second FAIL writes nothing more and rework-limit still denies', async () => {
    const id = task('running', 'medium');
    let out = parse(await record(id, 'fail', [blocking('x')]));
    assert.deepEqual(out['reopen_skipped'], { reason: 'status_running', effort_raised: true });
    assert.equal(row(id).status, 'running');
    assert.equal(row(id).effort, 'high');
    assert.equal(auditRows(id, 'task_reopened').length, 0);
    assert.equal(auditRows(id, 'task_effort_raised').length, 1);

    out = parse(await record(id, 'fail', [blocking('x')]));
    assert.deepEqual(out['reopen_skipped'], { reason: 'status_running', effort_raised: false });
    assert.equal(auditRows(id, 'task_reopened').length, 0);
    assert.equal(auditRows(id, 'task_effort_raised').length, 1);

    const env = { PATH: process.env['PATH'], HOME: dir, TRAJECTORY_DB_PATH: dbFile };
    assert.notDeepEqual(reworkLimitVerdict(REWORK_GATE, dbFile, String(id), env), ALLOW, 'two FAILs and no analysis: denied');
  });

  it('SC3: an effort_raise analysis proven only by the raise dated at the FAIL is no proof', async () => {
    const id = task('running', 'high');
    await record(id, 'fail', [blocking('x')]);
    db.run('UPDATE tasks SET effort = ? WHERE id = ?', ['medium', id]);
    const second = parse(await record(id, 'fail', [blocking('x')]));
    const raised = auditRows(id, 'task_effort_raised');
    assert.equal(raised.length, 1);
    assert.equal(raised[0].created_at, second['created_at']);
    db.run(
      `INSERT INTO audit (issue_id, from_node, event_type, summary, content_json, created_at)
       VALUES (1, 'bro', 'task_rework_analysis', 's', ?, '2999-01-01T00:00:00.000Z')`,
      [JSON.stringify({ task_id: id, root_cause: 'swe_execution', change: 'effort_raise', approach_shared_cause: false, fail_validation_ids: [], finding_ids: [], rationale: 'r' })],
    );
    const env = { PATH: process.env['PATH'], HOME: dir, TRAJECTORY_DB_PATH: dbFile };
    const verdict = reworkLimitVerdict(REWORK_GATE, dbFile, String(id), env);
    assert.notDeepEqual(verdict, ALLOW);
    assert.match(verdict.stdout, /no proof dated after the latest FAIL/);
  });

  it('SC4: task_reopen refuses an effort below high while a FAIL stands, and allows it after a pass', async () => {
    const id = task('running', 'medium');
    await record(id, 'fail', [blocking('x')]);
    const tools = compositeTools(db, dbFile, null, { host: 'claude', projectRoot: dir }).handlers as Handlers;
    for (const effort of ['low', 'medium']) {
      const r = (await tools['task_reopen']({ agent: 'bro', task_id: id, reason: 'rework', effort })) as Raw;
      assert.equal(r.isError, true);
      assert.match(r.content[0].text, /effort_below_rework_floor/);
    }
    assert.equal(row(id).effort, 'high');

    await record(id, 'pass');
    const r = (await tools['task_reopen']({ agent: 'bro', task_id: id, reason: 'rework', effort: 'medium' })) as Raw;
    assert.ok(!r.isError, r.content[0].text);
    assert.equal(row(id).effort, 'medium');
  });

  it('F857-1: a running task re-reviews its FAILed commit only with that commit unchanged and verified, no live swe and a re_review analysis after the FAIL', async () => {
    const id = task('completed', 'high');
    const sha = 'abc1234def5678';
    db.run('UPDATE tasks SET commit_sha = ? WHERE id = ?', [sha, id]);
    const { completion_report: report, completed_at: completedAt } = row(id);
    db.run(
      `INSERT INTO audit (issue_id, from_node, event_type, summary, content_json, created_at)
       VALUES (1, ?, 'reviewer_spawn_observed', 'spawn', json_object('task_id', ?, 'attempt_n', 1, 'commit_sha', ?), datetime('now'))`,
      [REVIEWER_SPAWN_FROM_NODE, id, sha],
    );
    const fail = parse(await record(id, 'fail', [blocking('disputed')]));
    const failAt = String(fail['created_at']);
    const later = (s: number) => new Date(Date.parse(failAt) + s * 1000).toISOString();
    const admission = () =>
      reReviewAdmission(
        db,
        db.get<{ id: number; issue_id: number; commit_sha: string | null; completion_report: string | null }>(
          'SELECT id, issue_id, commit_sha, completion_report FROM tasks WHERE id = ?',
          [id],
        )!,
      );
    const refused = (pattern: RegExp) => {
      const r = admission();
      assert.ok('refusal' in r, `refused: ${JSON.stringify(r)}`);
      assert.match(r.refusal, pattern);
    };
    const analysis = (change: string, at: string) =>
      db.run(
        `INSERT INTO audit (issue_id, from_node, event_type, summary, content_json, created_at)
         VALUES (1, 'bro', 'task_rework_analysis', 'analysis', json_object('task_id', ?, 'change', ?), ?)`,
        [id, change, at],
      );

    db.run(`INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at, duration_ms) VALUES (?, 1, 'swe', ?, 0)`, [id, later(1)]);
    refused(/swe run \d+ of task \d+ is live/);
    db.run('UPDATE agent_runs SET completed_at = ? WHERE task_id = ?', [later(2), id]);

    refused(/no passing verification run/);
    const run = `INSERT INTO verification_runs (task_id, commit_sha, source, started_at, finished_at, exit_code, budget_s, timed_out)
                 VALUES (?, ?, 'gate', ?, ?, ?, 600, 0)`;
    db.run(run, [id, sha.slice(0, 9), later(-60), later(-50), 1]);
    db.run(run, [id, 'fff0000', later(-60), later(-50), 0]);
    refused(/no passing verification run/);
    db.run(run, [id, sha.slice(0, 9), later(-40), later(-30), 0]);

    refused(/latest task_rework_analysis \(none\) is not a re_review analysis/);
    analysis('re_review', failAt);
    refused(/is not a re_review analysis dated after FAIL/);
    analysis('re_review', later(3));
    analysis('spec_update', later(4));
    refused(/change spec_update\) is not a re_review analysis/);
    analysis('re_review', later(5));

    const admitted = admission();
    assert.ok(!('refusal' in admitted), JSON.stringify(admitted));
    assert.deepEqual(admitted, { failValidationId: fail['id'], completionReport: report, completedAt });

    db.run('UPDATE tasks SET commit_sha = ? WHERE id = ?', ['fff0000', id]);
    refused(/not the task's current commit fff0000/);
    db.run('UPDATE tasks SET commit_sha = ? WHERE id = ?', [sha, id]);

    await record(id, 'pass');
    refused(/latest review verdict is 'pass'/);
  });
});

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t.t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t.t',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

function gitIn(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args], {
    env: GIT_ENV,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    .toString()
    .trim();
}

const PROJECT: Record<string, string> = {
  'pyproject.toml': '[project]\nname = "pyapp"\nversion = "0.1.0"\n',
  'pyapp/__init__.py': '',
  'pyapp/main.py': 'def greet(name: str) -> str:\n    return f"hello {name}"\n',
  '.gitignore': '.claude/\n__pycache__/\n',
};

const SPEC = ['## Description', 'Change `greet` in `pyapp/main.py`.', '', '## Success Criteria', '- SC1: works'].join('\n');

describe('a reopened task whose worktree is gone (GH 2866)', () => {
  it('SC5: the swe spawn is denied until task_reopen recreates the worktree', async () => {
    const ws = realpathSync(mkdtempSync(join(tmpdir(), 'auto-reopen-ws-')));
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'auto-reopen-remote-')));
    const origin = join(outside, 'origin.git');
    const root = join(ws, 'pyapp');
    mkdirSync(root);
    gitIn(outside, 'init', '-q', '--bare', origin);
    gitIn(root, 'init', '-q', '-b', 'main');
    for (const [rel, body] of Object.entries(PROJECT)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), body);
    }
    gitIn(root, 'add', '-A');
    gitIn(root, 'commit', '-qm', 'init');
    gitIn(root, 'remote', 'add', 'origin', origin);
    gitIn(root, 'push', '-q', 'origin', 'main');

    const dbFile = join(ws, '.claude', 'tmb', 'trajectory.db');
    mkdirSync(dirname(dbFile), { recursive: true });
    const db = tempDB({ path: dbFile });
    try {
      const holder = GraphHolder.fixed(new WorldModelGraph(db));
      const scan = (await (scanTools(db, holder, dbFile).handlers as Handlers)['scan_run']({
        agent: 'bro',
        session_dir: ws,
        source: 'user_manual',
      })) as Raw;
      assert.ok(!scan.isError, JSON.stringify(scan));
      db.run(`UPDATE repos SET target_branch = 'main' WHERE name = 'pyapp'`);
      db.run(`INSERT INTO issues (id, objective, description, status, created_at, updated_at)
              VALUES (1, 'o', 'd', 'open', datetime('now'), datetime('now'))`);
      const tools = compositeTools(db, dbFile, holder, { host: 'claude', projectRoot: ws }).handlers as Handlers;

      const provisioned = parse(
        await tools['task_provision']({
          agent: 'bro',
          issue_id: 1,
          branch_id: 'feat/lost-tree',
          decision_body: 'Chosen approach: provision, then lose the worktree.',
          task: { description: 'd', spec_body: SPEC, files: ['pyapp/main.py'], verification: ['true'], repo: 'pyapp' },
        }),
      );
      const taskId = provisioned['task_id'] as number;
      assert.equal(typeof taskId, 'number', JSON.stringify(provisioned));
      const worktree = join(root, '.claude', 'worktrees', 'lost-tree');
      assert.ok(existsSync(worktree));

      gitIn(root, 'worktree', 'remove', '--force', worktree);
      db.run(`UPDATE tasks SET status = 'closed', completed_at = datetime('now') WHERE id = ?`, [taskId]);

      seedReviewerObservation(db, taskId, 1, { agentId: 'reviewer-sc5-0001' });
      const fail = parse(
        (await validationTools(db).handlers['validation_record']({
          agent: 'code-reviewer',
          task_id: String(taskId),
          attempt_n: 1,
          verdict: 'fail',
          feedback: '# Review',
          mcp_available: true,
          findings: [blocking('x')],
        })),
      );
      assert.equal((fail['reopened'] as { status: string }).status, 'running');

      const hookEnv = (): NodeJS.ProcessEnv => ({ PATH: process.env['PATH'], HOME: ws, TRAJECTORY_DB_PATH: dbFile });
      const spawn = (effort: string) =>
        JSON.stringify({ tool_name: 'Agent', hook_event_name: 'PreToolUse', tool_input: { subagent_type: 'swe', prompt: `task_id=${taskId} go`, effort } });
      const denied = await requireTaskSpec(spawn('high'), hookEnv());
      assert.match(denied.stdout, /"permissionDecision":"deny"/);
      assert.match(denied.stdout, new RegExp(`task_id=${taskId} is running and branch feat/lost-tree has no linked worktree`));
      assert.match(denied.stdout, new RegExp(`task_reopen\\(task_id=${taskId}, reason=`));
      assert.deepEqual(requireSpawnEffort(spawn('high'), hookEnv()), ALLOW, 'tasks.effort is high after the FAIL');

      const lower = (await tools['task_reopen']({ agent: 'bro', task_id: taskId, reason: 'recreate', effort: 'medium' })) as Raw;
      assert.equal(lower.isError, true);
      assert.match(lower.content[0].text, /effort_below_rework_floor/);

      const reopened = parse(await tools['task_reopen']({ agent: 'bro', task_id: taskId, reason: 'recreate the worktree' }));
      assert.equal(reopened['worktree_recreated'], true, JSON.stringify(reopened));
      assert.equal(reopened['worktree_path'], worktree);
      assert.ok(existsSync(join(worktree, 'pyapp', 'main.py')));
      assert.deepEqual(await requireTaskSpec(spawn('high'), hookEnv()), ALLOW);
    } finally {
      db.close();
      for (const d of [ws, outside]) rmSync(d, { recursive: true, force: true });
    }
  });
});
