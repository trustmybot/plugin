/**
 * The task-overrun-alert gate (GH 1738) on a temp trajectory DB with a fixture
 * clock: a running task past the threshold alerts bro once, writing one
 * task_overrun_alerted audit row; a task under the threshold, a non-bro
 * caller and a second call stay silent. A live swe run of bro's session past
 * the threshold on a task that is not running alerts once per spawn_id,
 * writing one agent_run_overrun_alerted row (GH 2190). A reopened task is
 * timed from its newest reopen and alerts once per running stint; a completed
 * task waiting on review stays silent.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { makeTaskOverrunAlert, OVERRUN_ENV, taskOverrunAlert } from '../hooks/task-overrun-alert.js';
import { findGate, gateNames } from '../hooks/registry.js';

const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCHEMA = readFileSync(join(SERVER_ROOT, 'src/schema.sql'), 'utf8');
const ISSUE_ID = 9;
const NOW = new Date('2026-10-25T12:00:00.000Z');
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

interface Fixture {
  db: string;
  env: NodeJS.ProcessEnv;
  task(id: number, createdMinAgo: number, status?: string): void;
  sweRun(taskId: number, exitReason?: string | null): void;
  fail(taskId: number, feedback: string): void;
  alertRows(taskId?: number): number;
  liveRun(spawnId: string, taskId: number | null, startedMinAgo: number, opts?: { session?: string; completed?: boolean }): void;
  runAlertRows(spawnId?: string): number;
  audit(eventType: string, content: Record<string, unknown>, atMinAgo: number): void;
}

let sandbox: string;
let seq = 0;

function fixture(): Fixture {
  seq += 1;
  const root = join(sandbox, `case-${seq}`);
  const db = join(root, '.claude/tmb/trajectory.db');
  mkdirSync(dirname(db), { recursive: true });
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: join(root, 'home'), TRAJECTORY_DB_PATH: db };
  const d = new DatabaseSync(db);
  d.exec(SCHEMA);
  d.prepare("INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (?, 'o', 'open', ?, ?)").run(ISSUE_ID, minutesAgo(600), minutesAgo(600));
  d.close();
  const exec = (sql: string, ...args: Array<string | number | null>) => {
    const w = new DatabaseSync(db);
    w.prepare(sql).run(...args);
    w.close();
  };
  let attempt = 0;
  return {
    db,
    env,
    task: (id, createdMinAgo, status = 'running') =>
      exec(
        "INSERT INTO tasks (id, issue_id, branch_id, description, status, created_at, updated_at) VALUES (?, ?, ?, 'd', ?, ?, ?)",
        id,
        ISSUE_ID,
        `feat/${id}-x`,
        status,
        minutesAgo(createdMinAgo),
        minutesAgo(createdMinAgo),
      ),
    sweRun: (taskId, exitReason = null) =>
      exec("INSERT INTO agent_runs (task_id, issue_id, agent_type, exit_reason) VALUES (?, ?, 'swe', ?)", taskId, ISSUE_ID, exitReason),
    fail: (taskId, feedback) => {
      attempt += 1;
      exec(
        "INSERT INTO validation_attempts (task_id, attempt_n, agent, verdict, feedback, mcp_available, created_at) VALUES (?, ?, 'code-reviewer', 'fail', ?, 1, ?)",
        taskId,
        attempt,
        feedback,
        minutesAgo(10),
      );
    },
    alertRows: (taskId) => {
      const r = new DatabaseSync(db);
      const sql =
        "SELECT COUNT(*) AS n FROM audit WHERE event_type = 'task_overrun_alerted'" +
        (taskId === undefined ? '' : ` AND json_extract(content_json, '$.task_id') = ${taskId}`);
      const n = (r.prepare(sql).get() as { n: number }).n;
      r.close();
      return n;
    },
    liveRun: (spawnId, taskId, startedMinAgo, opts = {}) =>
      exec(
        "INSERT INTO agent_runs (task_id, issue_id, agent_type, spawn_id, session_id, started_at, completed_at) VALUES (?, ?, 'swe', ?, ?, ?, ?)",
        taskId,
        ISSUE_ID,
        spawnId,
        opts.session ?? 's',
        minutesAgo(startedMinAgo),
        opts.completed ? minutesAgo(1) : null,
      ),
    audit: (eventType, content, atMinAgo) =>
      exec(
        "INSERT INTO audit (issue_id, from_node, event_type, summary, content_json, created_at) VALUES (?, 'bro', ?, 's', ?, ?)",
        ISSUE_ID,
        eventType,
        JSON.stringify(content),
        minutesAgo(atMinAgo),
      ),
    runAlertRows: (spawnId) => {
      const r = new DatabaseSync(db);
      const sql =
        "SELECT COUNT(*) AS n FROM audit WHERE event_type = 'agent_run_overrun_alerted'" +
        (spawnId === undefined ? '' : ` AND json_extract(content_json, '$.spawn_id') = '${spawnId}'`);
      const n = (r.prepare(sql).get() as { n: number }).n;
      r.close();
      return n;
    },
  };
}

const gate = makeTaskOverrunAlert(() => NOW);
const broPrompt = JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: 'hi' });

interface HookOutput {
  hookSpecificOutput: { hookEventName: string; additionalContext: string };
}

const parseOutput = (stdout: string) => JSON.parse(stdout) as HookOutput;

function context(stdout: string): string {
  assert.notEqual(stdout, '', 'expected an alert');
  return parseOutput(stdout).hookSpecificOutput.additionalContext;
}

describe('task-overrun-alert', () => {
  before(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'tmb-overrun-'));
  });
  after(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('is registered, so the build lists it in dist/hooks-gates.txt', () => {
    assert.equal(findGate('task-overrun-alert'), taskOverrunAlert);
    assert.ok(gateNames().includes('task-overrun-alert'));
  });

  it('alerts bro once for a task running 61 min, then is silent on the next call', () => {
    const f = fixture();
    f.task(5, 61);
    f.sweRun(5);
    f.sweRun(5);
    f.sweRun(5, 'swept_orphan');
    f.fail(5, '\n  Missing changelog fragment\nsecond line');
    const first = gate(broPrompt, f.env);
    assert.equal(first.code, 0);
    const out = parseOutput(first.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.equal(
      out.hookSpecificOutput.additionalContext,
      'TMB: task 5 has been running 61 min (attempts: 2 swe spawns; blocker: Missing changelog fragment). Decide whether to continue, redesign the spec or split the task, record the decision on the issue, and tell the Human without waiting for a reply.',
    );
    assert.equal(f.alertRows(5), 1);
    assert.deepEqual(gate(broPrompt, f.env), { stdout: '', code: 0 });
    assert.equal(f.alertRows(5), 1, 'the second call writes no row');
  });

  it('is silent for a task running 59 min', () => {
    const f = fixture();
    f.task(6, 59);
    assert.deepEqual(gate(broPrompt, f.env), { stdout: '', code: 0 });
    assert.equal(f.alertRows(), 0);
  });

  it('is silent for a non-bro caller and writes no row', () => {
    const f = fixture();
    f.task(7, 61);
    const swe = JSON.stringify({ hook_event_name: 'PostToolUse', agent_type: 'swe', tool_name: 'mcp__plugin_tmb_trajectory-server__task_brief' });
    assert.deepEqual(gate(swe, f.env), { stdout: '', code: 0 });
    assert.equal(f.alertRows(), 0);
  });

  it('one line per overrun task, the status as blocker without a FAIL, on the PostToolUse event; ignores non-running tasks', () => {
    const f = fixture();
    f.task(8, 90);
    f.task(3, 120);
    f.task(10, 200, 'closed');
    f.task(11, 30);
    const post = JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'mcp__plugin_tmb_trajectory-server__task_list' });
    const out = parseOutput(gate(post, f.env).stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
    const lines = out.hookSpecificOutput.additionalContext.split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^TMB: task 3 has been running 120 min \(attempts: 0 swe spawns; blocker: status running\)/);
    assert.match(lines[1], /^TMB: task 8 has been running 90 min/);
    assert.equal(f.alertRows(3), 1);
    assert.equal(f.alertRows(8), 1);
    assert.equal(f.alertRows(), 2);
  });

  it(`${OVERRUN_ENV} overrides the threshold`, () => {
    const f = fixture();
    f.task(12, 16);
    assert.match(context(gate(broPrompt, { ...f.env, [OVERRUN_ENV]: '15' }).stdout), /task 12 has been running 16 min/);
  });

  it('alerts bro once for a live swe run on a closed task, then is silent on the next call (GH 2190)', () => {
    const f = fixture();
    f.task(20, 500, 'closed');
    f.liveRun('a20', 20, 402);
    const out = parseOutput(gate(broPrompt, f.env).stdout);
    assert.equal(
      out.hookSpecificOutput.additionalContext,
      'TMB: swe run a20 (task 20, task status closed) started 402 min ago and has not stopped. Check whether it is stuck and stop it if so.',
    );
    assert.equal(f.runAlertRows('a20'), 1);
    const r = new DatabaseSync(f.db);
    const row = r.prepare("SELECT issue_id, branch_id, from_node, content_json FROM audit WHERE event_type = 'agent_run_overrun_alerted'").get() as Record<string, unknown>;
    r.close();
    assert.deepEqual(JSON.parse(row.content_json as string), { spawn_id: 'a20', task_id: 20, minutes: 402 });
    assert.equal(row.issue_id, ISSUE_ID);
    assert.equal(row.branch_id, 'feat/20-x');
    assert.equal(row.from_node, 'hook:task-overrun-alert');
    assert.deepEqual(gate(broPrompt, f.env), { stdout: '', code: 0 });
    assert.equal(f.runAlertRows(), 1, 'the second call writes no row');
  });

  it('a live run whose task row is missing reports the task as missing, on the run\'s issue', () => {
    const f = fixture();
    f.liveRun('a404', null, 90);
    assert.equal(
      context(gate(broPrompt, f.env).stdout),
      'TMB: swe run a404 (task none, task status missing) started 90 min ago and has not stopped. Check whether it is stuck and stop it if so.',
    );
    const r = new DatabaseSync(f.db);
    const row = r.prepare("SELECT issue_id FROM audit WHERE event_type = 'agent_run_overrun_alerted'").get() as { issue_id: number };
    r.close();
    assert.equal(row.issue_id, ISSUE_ID, 'the run carries its own issue_id');
  });

  it('no run line for another session, a stopped run, a run under the threshold or a run on a running task', () => {
    const f = fixture();
    f.task(21, 500, 'closed');
    f.task(22, 500, 'failed');
    f.task(23, 300);
    f.liveRun('other', 21, 400, { session: 'not-s' });
    f.liveRun('done', 21, 400, { completed: true });
    f.liveRun('young', 22, 59);
    f.liveRun('onrunning', 23, 250);
    const lines = context(gate(broPrompt, f.env).stdout).split('\n');
    assert.deepEqual(lines.length, 1);
    assert.match(lines[0], /^TMB: task 23 has been running 300 min/);
    assert.equal(f.runAlertRows(), 0);
    assert.equal(f.alertRows(23), 1);
    assert.deepEqual(gate(broPrompt, f.env), { stdout: '', code: 0 }, 'the running task is reported once');
  });

  it('no run line for a payload with no session_id', () => {
    const f = fixture();
    f.task(24, 500, 'closed');
    f.liveRun('a24', 24, 400);
    const noSession = JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' });
    assert.deepEqual(gate(noSession, f.env), { stdout: '', code: 0 });
    assert.equal(f.runAlertRows(), 0);
  });

  it('task lines come before run lines in one context', () => {
    const f = fixture();
    f.task(25, 70);
    f.task(26, 500, 'closed');
    f.liveRun('a26', 26, 200);
    const lines = context(gate(broPrompt, f.env).stdout).split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^TMB: task 25 has been running 70 min/);
    assert.match(lines[1], /^TMB: swe run a26 \(task 26, task status closed\) started 200 min ago/);
  });

  it('times a reopened task from its newest reopen, not its created_at', () => {
    const f = fixture();
    f.task(30, 3000);
    f.audit('task_reopened', { task_id: 30, from_status: 'closed' }, 2000);
    f.audit('task_reopened', { task_id: 30, from_status: 'completed' }, 10);
    assert.deepEqual(gate(broPrompt, f.env), { stdout: '', code: 0 }, 'a task reopened 10 min ago has not overrun');
    assert.equal(f.alertRows(), 0);
    f.task(31, 3000);
    f.audit('task_reopened', { task_id: 31, from_status: 'closed' }, 61);
    assert.match(context(gate(broPrompt, f.env).stdout), /^TMB: task 31 has been running 61 min/);
  });

  it('alerts once per running stint: a task alerted before its reopen alerts again once', () => {
    const f = fixture();
    f.task(32, 3000);
    f.audit('task_overrun_alerted', { task_id: 32, minutes: 61 }, 2900);
    f.audit('task_reopened', { task_id: 32, from_status: 'completed' }, 70);
    assert.match(context(gate(broPrompt, f.env).stdout), /^TMB: task 32 has been running 70 min/);
    assert.equal(f.alertRows(32), 2);
    assert.deepEqual(gate(broPrompt, f.env), { stdout: '', code: 0 });
    assert.equal(f.alertRows(32), 2, 'the second call in the same stint writes no row');
  });

  it('is silent while a completed task waits on its review, its swe run stopped', () => {
    const f = fixture();
    f.task(33, 500, 'completed');
    f.liveRun('done33', 33, 400, { completed: true });
    assert.deepEqual(gate(broPrompt, f.env), { stdout: '', code: 0 });
    assert.equal(f.alertRows(), 0);
    assert.equal(f.runAlertRows(), 0);
  });

  it('is silent with no DB', () => {
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: join(sandbox, 'nohome'), TRAJECTORY_DB_PATH: join(sandbox, 'absent.db'), CLAUDE_PROJECT_DIR: join(sandbox, 'noproj') };
    assert.deepEqual(gate(broPrompt, env), { stdout: '', code: 0 });
  });
});
