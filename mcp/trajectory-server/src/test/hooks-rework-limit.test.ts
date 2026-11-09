/**
 * The rework-limit gate (GH 1738, GH 2148) on a temp trajectory DB: a swe
 * spawn is denied once the task has two review FAILs since its last pass, six
 * swe runs (budget handbacks aside), or its issue four FAILs across its tasks
 * with no later pass on the same task, each counted since the latest Human waiver (an author 'human', kind
 * 'decision' row) on the task or its issue; no agent-written row and no Human
 * note lifts it. The agent-spawn-dispatch gate returns that deny
 * before any PREPARE step.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { agentSpawnDispatch, PREPARE } from '../hooks/agent-spawn-dispatch.js';
import { ALLOW, type Gate, type GateResult } from '../hooks/gate.js';
import { reworkLimit } from '../hooks/rework-limit.js';
import { findGate, gateNames } from '../hooks/registry.js';
import { ISSUE_FAIL_LIMIT, REWORK_FAIL_LIMIT, SWE_RUN_LIMIT } from '../task-rework.js';

const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PLUGIN_ROOT = resolve(SERVER_ROOT, '../..');
const SCHEMA = readFileSync(join(SERVER_ROOT, 'src/schema.sql'), 'utf8');
const ISSUE_ID = 9;
const OTHER_ISSUE_ID = 10;
const TASK_ID = 3;
const OTHER_TASK_ID = 4;
const FRESH_TASK_ID = 5;
const ELSEWHERE_TASK_ID = 6;

type Verdict = 'pass' | 'fail';

interface Fixture {
  db: string;
  env: NodeJS.ProcessEnv;
  verdicts(...list: Verdict[]): void;
  verdictsOn(taskId: number, ...list: Verdict[]): void;
  runs(n: number, row?: { stopCause?: string | null; exitReason?: string | null }): void;
  discuss(row: { author?: string; kind?: string; taskId?: number | null }): void;
  analysis(row?: { rootCause?: string; change?: string; taskId?: number }): number;
  proof(eventType: 'task_spec_amended' | 'task_effort_raised', taskId?: number): number;
}

let sandbox: string;
let seq = 0;

/** Every row gets the next minute of a clock, so insertion order is created_at order. */
function fixture(): Fixture {
  seq += 1;
  const root = join(sandbox, `case-${seq}`);
  const db = join(root, '.claude/tmb/trajectory.db');
  mkdirSync(dirname(db), { recursive: true });
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: join(root, 'home'), TRAJECTORY_DB_PATH: db };
  const d = new DatabaseSync(db);
  d.exec(SCHEMA);
  for (const id of [ISSUE_ID, OTHER_ISSUE_ID]) {
    d.prepare("INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (?, 'o', 'open', '2026-10-25T09:00:00.000Z', '2026-10-25T09:00:00.000Z')").run(id);
  }
  for (const [id, issue] of [
    [TASK_ID, ISSUE_ID],
    [OTHER_TASK_ID, ISSUE_ID],
    [FRESH_TASK_ID, ISSUE_ID],
    [ELSEWHERE_TASK_ID, OTHER_ISSUE_ID],
  ]) {
    d.prepare(
      "INSERT INTO tasks (id, issue_id, branch_id, description, status, created_at, updated_at) VALUES (?, ?, ?, 'd', 'running', '2026-10-25T09:00:00.000Z', '2026-10-25T09:00:00.000Z')",
    ).run(id, issue, `feat/${id}-x`);
  }
  d.close();
  let minute = 0;
  const tick = () => {
    minute += 1;
    return new Date(Date.UTC(2026, 9, 25, 10, 0, 0) + minute * 60_000).toISOString();
  };
  const write = (sql: string, ...params: Array<string | number | null>) => {
    const w = new DatabaseSync(db);
    w.prepare(sql).run(...params);
    w.close();
  };
  let attempt = 0;
  const verdictsOn = (taskId: number, ...list: Verdict[]) => {
    for (const verdict of list) {
      attempt += 1;
      write(
        "INSERT INTO validation_attempts (task_id, attempt_n, agent, verdict, feedback, mcp_available, created_at) VALUES (?, ?, 'code-reviewer', ?, 'f', 1, ?)",
        taskId,
        attempt,
        verdict,
        tick(),
      );
    }
  };
  const runs = (n: number, { stopCause = null, exitReason = 'completed' }: { stopCause?: string | null; exitReason?: string | null } = {}) => {
    for (let i = 0; i < n; i += 1) {
      const at = tick();
      write(
        "INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at, completed_at, exit_reason, stop_cause) VALUES (?, ?, 'swe', ?, ?, ?, ?)",
        TASK_ID,
        ISSUE_ID,
        at,
        at,
        exitReason,
        stopCause,
      );
    }
  };
  const discuss = ({ author = 'bro', kind = 'note', taskId = TASK_ID }: { author?: string; kind?: string; taskId?: number | null }) => {
    write('INSERT INTO discussions (issue_id, author, kind, body, created_at, task_id) VALUES (?, ?, ?, ?, ?, ?)', ISSUE_ID, author, kind, 'b', tick(), taskId);
  };
  const auditRow = (eventType: string, content: Record<string, unknown>, taskId = TASK_ID): number => {
    const w = new DatabaseSync(db);
    const res = w
      .prepare("INSERT INTO audit (issue_id, from_node, event_type, summary, content_json, created_at) VALUES (?, 'bro', ?, 's', ?, ?)")
      .run(ISSUE_ID, eventType, JSON.stringify({ task_id: taskId, ...content }), tick());
    w.close();
    return Number(res.lastInsertRowid);
  };
  const analysis = ({ rootCause = 'spec_unclear', change = 'spec_update', taskId = TASK_ID }: { rootCause?: string; change?: string; taskId?: number } = {}) =>
    auditRow('task_rework_analysis', { root_cause: rootCause, change, fail_validation_ids: [], finding_ids: [], rationale: 'r' }, taskId);
  const proof = (eventType: 'task_spec_amended' | 'task_effort_raised', taskId = TASK_ID) => auditRow(eventType, {}, taskId);
  return { db, env, verdicts: (...list) => verdictsOn(TASK_ID, ...list), verdictsOn, runs, discuss, analysis, proof };
}

const payload = (subagent = 'swe', prompt = `task_id=${TASK_ID} do the thing`) =>
  JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: subagent, prompt } });

function run(f: Fixture, input = payload()) {
  return reworkLimit(input, f.env) as { stdout: string; code: number };
}

const spawnOf = (f: Fixture, taskId: number) => run(f, payload('swe', `task_id=${taskId} go`));

function denyReason(stdout: string): string {
  assert.notEqual(stdout, '', 'expected a deny');
  const out = JSON.parse(stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  return out.hookSpecificOutput.permissionDecisionReason as string;
}

function assertHumanOnlyWaiver(reason: string, taskId: number): void {
  assert.ok(reason.includes(`waive task ${taskId}`), reason);
  assert.doesNotMatch(reason, /discussion_append/);
  assert.doesNotMatch(reason, /decision/i);
}

/** The inner-limit deny: bro analyzes and changes; no Human waiver, no decision-row escape. */
function assertInnerLimit(reason: string): void {
  assert.ok(reason.includes('task_rework_analysis'), reason);
  assert.ok(reason.includes('task_update_spec') && reason.includes('task_reopen(effort=...)'), reason);
  assert.ok(reason.includes('task_retry') && /new task/.test(reason), reason);
  assert.match(reason, /Human is needed only for a product decision/);
  assert.doesNotMatch(reason, /waive task/);
  assert.doesNotMatch(reason, /discussion_append/);
  assert.doesNotMatch(reason, /outer ceiling/);
}

const ALLOWED = { stdout: '', code: 0 };

describe('rework-limit', () => {
  before(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'tmb-rework-limit-'));
  });
  after(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('is registered, so the build lists it in dist/hooks-gates.txt', () => {
    assert.equal(findGate('rework-limit'), reworkLimit);
    assert.ok(gateNames().includes('rework-limit'));
  });

  it('keeps the limits as named constants', () => {
    assert.equal(REWORK_FAIL_LIMIT, 2);
    assert.equal(SWE_RUN_LIMIT, 6);
    assert.equal(ISSUE_FAIL_LIMIT, 4);
  });

  describe('task FAILs', () => {
    it('denies a swe spawn after two FAILs, naming the limit, its count and the analysis step', () => {
      const f = fixture();
      f.verdicts('fail', 'fail');
      const reason = denyReason(run(f).stdout);
      assert.match(reason, /task 3 is at the rework limit/);
      assert.match(reason, /task FAILs: 2 review FAILs on the task since its last pass \(limit 2\)/);
      assert.doesNotMatch(reason, /task runs:|issue FAILs:/);
      assertInnerLimit(reason);
    });

    it('a newer kind=decision row by bro, on the task or the issue, does not lift it', () => {
      const f = fixture();
      f.verdicts('fail', 'fail');
      f.discuss({ kind: 'decision' });
      denyReason(run(f).stdout);
      f.discuss({ kind: 'decision', taskId: null });
      denyReason(run(f).stdout);
      f.discuss({ kind: 'note' });
      denyReason(run(f).stdout);
    });

    it('a newer Human row on the task lifts it', () => {
      const f = fixture();
      f.verdicts('fail', 'fail');
      f.discuss({ author: 'human', kind: 'decision' });
      assert.deepEqual(run(f), ALLOWED);
    });

    it('a newer issue-level Human row lifts it', () => {
      const f = fixture();
      f.verdicts('fail', 'fail');
      f.discuss({ author: 'human', kind: 'decision', taskId: null });
      assert.deepEqual(run(f), ALLOWED);
    });

    it('a Human row on another task of the issue does not lift it', () => {
      const f = fixture();
      f.verdicts('fail', 'fail');
      f.discuss({ author: 'human', kind: 'decision', taskId: OTHER_TASK_ID });
      denyReason(run(f).stdout);
    });

    it('counts the FAILs after the latest Human row afresh', () => {
      const f = fixture();
      f.verdicts('fail', 'fail');
      f.discuss({ author: 'human', kind: 'decision' });
      f.verdicts('fail');
      assert.deepEqual(run(f), ALLOWED);
      f.verdicts('fail');
      const reason = denyReason(run(f).stdout);
      assert.match(reason, /task FAILs: 2 review FAILs/);
      assert.match(reason, /since the Human's last waiver at 2026-10-25T10:03:00\.000Z/);
    });

    it('counts only the FAILs after the latest pass', () => {
      const f = fixture();
      f.verdicts('fail', 'fail', 'pass', 'fail');
      assert.deepEqual(run(f), ALLOWED);
      f.verdicts('fail');
      assert.match(denyReason(run(f).stdout), /task FAILs: 2 review FAILs on the task since its last pass/);
    });
  });

  describe('task runs', () => {
    it('denies a seventh swe run with no FAILs, naming the limit and its count', () => {
      const f = fixture();
      f.runs(5);
      assert.deepEqual(run(f), ALLOWED);
      f.runs(1);
      const reason = denyReason(run(f).stdout);
      assert.match(reason, /task runs: 6 swe runs of the task, budget handbacks aside \(limit 6\)/);
      assert.doesNotMatch(reason, /task FAILs:|issue FAILs:/);
      assertHumanOnlyWaiver(reason, TASK_ID);
    });

    it('does not count budget handbacks or swept orphans', () => {
      const f = fixture();
      f.runs(5);
      f.runs(3, { stopCause: 'budget' });
      f.runs(2, { exitReason: 'swept_orphan' });
      assert.deepEqual(run(f), ALLOWED);
      f.runs(1, { stopCause: 'hook_block' });
      denyReason(run(f).stdout);
    });

    it('a newer Human row resets the count; a bro decision does not', () => {
      const f = fixture();
      f.runs(6);
      f.discuss({ kind: 'decision' });
      denyReason(run(f).stdout);
      f.discuss({ author: 'human', kind: 'decision', taskId: null });
      assert.deepEqual(run(f), ALLOWED);
      f.runs(5);
      assert.deepEqual(run(f), ALLOWED);
      f.runs(1);
      assert.match(denyReason(run(f).stdout), /task runs: 6 swe runs/);
    });
  });

  describe('issue FAILs', () => {
    it('denies a spawn of a fresh task once the issue has four unresolved FAILs across its tasks', () => {
      const f = fixture();
      f.verdictsOn(OTHER_TASK_ID, 'fail', 'fail');
      f.verdictsOn(TASK_ID, 'fail');
      f.verdictsOn(ELSEWHERE_TASK_ID, 'fail');
      assert.deepEqual(spawnOf(f, FRESH_TASK_ID), ALLOWED);
      f.verdictsOn(OTHER_TASK_ID, 'fail');
      const reason = denyReason(spawnOf(f, FRESH_TASK_ID).stdout);
      assert.match(reason, /task 5 is at the rework limit/);
      assert.match(reason, /issue FAILs: 4 review FAILs across the issue's tasks \(limit 4\)/);
      assert.doesNotMatch(reason, /task FAILs:|task runs:/);
      assertHumanOnlyWaiver(reason, FRESH_TASK_ID);
      denyReason(spawnOf(f, TASK_ID).stdout);
      assert.deepEqual(spawnOf(f, ELSEWHERE_TASK_ID), ALLOWED);
    });

    it('allows every task of an issue whose FAILs all have a later pass on the same task, however many', () => {
      const f = fixture();
      f.verdictsOn(OTHER_TASK_ID, 'fail', 'fail', 'fail', 'pass', 'fail', 'fail', 'pass');
      f.verdictsOn(TASK_ID, 'fail', 'pass', 'fail', 'fail', 'fail', 'pass');
      for (const taskId of [FRESH_TASK_ID, TASK_ID, OTHER_TASK_ID]) {
        assert.deepEqual(spawnOf(f, taskId), ALLOWED);
      }
    });

    it('a FAIL after a task\'s latest pass counts again', () => {
      const f = fixture();
      f.verdictsOn(OTHER_TASK_ID, 'fail', 'fail', 'pass', 'fail', 'fail');
      f.verdictsOn(TASK_ID, 'fail', 'pass', 'fail');
      assert.deepEqual(spawnOf(f, FRESH_TASK_ID), ALLOWED);
      f.verdictsOn(TASK_ID, 'fail');
      assert.match(denyReason(spawnOf(f, FRESH_TASK_ID).stdout), /issue FAILs: 4 review FAILs/);
    });

    it('a pass on one task does not clear the FAILs on another', () => {
      const f = fixture();
      f.verdictsOn(OTHER_TASK_ID, 'fail', 'fail');
      f.verdictsOn(TASK_ID, 'fail', 'fail');
      f.verdictsOn(FRESH_TASK_ID, 'pass');
      assert.match(denyReason(spawnOf(f, FRESH_TASK_ID).stdout), /issue FAILs: 4 review FAILs/);
      f.verdictsOn(TASK_ID, 'pass');
      assert.deepEqual(spawnOf(f, FRESH_TASK_ID), ALLOWED);
    });

    it('a newer issue-level Human row lifts it for every task', () => {
      const f = fixture();
      f.verdictsOn(OTHER_TASK_ID, 'fail', 'fail', 'fail', 'fail');
      denyReason(spawnOf(f, FRESH_TASK_ID).stdout);
      f.discuss({ kind: 'decision', taskId: null });
      denyReason(spawnOf(f, FRESH_TASK_ID).stdout);
      f.discuss({ author: 'human', kind: 'decision', taskId: null });
      assert.deepEqual(spawnOf(f, FRESH_TASK_ID), ALLOWED);
      assert.deepEqual(spawnOf(f, TASK_ID), ALLOWED);
    });

    it('counts unresolved FAILs afresh after the latest Human row', () => {
      const f = fixture();
      f.verdictsOn(OTHER_TASK_ID, 'fail', 'fail', 'fail', 'fail');
      f.discuss({ author: 'human', kind: 'decision', taskId: null });
      f.verdictsOn(OTHER_TASK_ID, 'fail', 'fail', 'fail');
      assert.deepEqual(spawnOf(f, FRESH_TASK_ID), ALLOWED);
      f.verdictsOn(TASK_ID, 'fail');
      assert.match(denyReason(spawnOf(f, FRESH_TASK_ID).stdout), /issue FAILs: 4 review FAILs/);
    });

    it('a newer Human row on the task being spawned lifts it for that task only', () => {
      const f = fixture();
      f.verdictsOn(OTHER_TASK_ID, 'fail', 'fail', 'fail', 'fail');
      f.discuss({ author: 'human', kind: 'decision', taskId: FRESH_TASK_ID });
      assert.deepEqual(spawnOf(f, FRESH_TASK_ID), ALLOWED);
      denyReason(spawnOf(f, TASK_ID).stdout);
    });
  });

  describe('the inner limit: an analysis plus its proven change (GH 2830)', () => {
    it('denies at two FAILs with no analysis', () => {
      const f = fixture();
      f.verdicts('fail', 'fail');
      const reason = denyReason(run(f).stdout);
      assert.match(reason, /no task_rework_analysis newer than the latest FAIL/);
      assertInnerLimit(reason);
    });

    it('denies with an analysis but no proving row', () => {
      const f = fixture();
      f.verdicts('fail', 'fail');
      const id = f.analysis({ change: 'spec_update' });
      const reason = denyReason(run(f).stdout);
      assert.ok(reason.includes(`analysis #${id} names change spec_update, with no task_spec_amended row newer than the latest FAIL`), reason);
      assertInnerLimit(reason);
    });

    it('denies when the proving row predates the latest FAIL', () => {
      const f = fixture();
      f.verdicts('fail');
      f.proof('task_spec_amended');
      f.proof('task_effort_raised');
      f.verdicts('fail');
      f.analysis({ change: 'spec_update' });
      denyReason(run(f).stdout);
      const g = fixture();
      g.verdicts('fail');
      g.proof('task_effort_raised');
      g.verdicts('fail');
      g.analysis({ change: 'effort_raise' });
      assert.match(denyReason(run(g).stdout), /with no task_effort_raised row newer than the latest FAIL/);
    });

    it('denies with an analysis older than the latest FAIL, even with a newer proof', () => {
      const f = fixture();
      f.verdicts('fail');
      f.analysis({ change: 'spec_update' });
      f.verdicts('fail');
      f.proof('task_spec_amended');
      assert.match(denyReason(run(f).stdout), /no task_rework_analysis newer than the latest FAIL/);
    });

    for (const change of ['split', 'retry', 're_review']) {
      it(`denies for change ${change}, whatever proof follows`, () => {
        const f = fixture();
        f.verdicts('fail', 'fail');
        const id = f.analysis({ change });
        f.proof('task_spec_amended');
        f.proof('task_effort_raised');
        const reason = denyReason(run(f).stdout);
        assert.ok(reason.includes(`analysis #${id} names change ${change}, which admits no further swe run of this task`), reason);
        assertInnerLimit(reason);
      });
    }

    it('admits with an analysis plus a newer task_spec_amended', () => {
      const f = fixture();
      f.verdicts('fail', 'fail');
      f.analysis({ change: 'spec_update' });
      f.proof('task_spec_amended');
      assert.deepEqual(run(f), ALLOWED);
    });

    it('admits with an analysis plus a newer task_effort_raised, made before or after the analysis', () => {
      const f = fixture();
      f.verdicts('fail', 'fail');
      f.analysis({ change: 'effort_raise' });
      f.proof('task_effort_raised');
      assert.deepEqual(run(f), ALLOWED);
      const g = fixture();
      g.verdicts('fail', 'fail');
      g.proof('task_effort_raised');
      g.analysis({ change: 'effort_raise' });
      assert.deepEqual(run(g), ALLOWED);
    });

    it('a proof of the other change does not admit', () => {
      const f = fixture();
      f.verdicts('fail', 'fail');
      f.analysis({ change: 'spec_update' });
      f.proof('task_effort_raised');
      denyReason(run(f).stdout);
    });

    it("another task's analysis and proof do not admit", () => {
      const f = fixture();
      f.verdicts('fail', 'fail');
      f.analysis({ taskId: OTHER_TASK_ID });
      f.proof('task_spec_amended', OTHER_TASK_ID);
      denyReason(run(f).stdout);
    });

    it('the latest analysis decides: a later split analysis denies', () => {
      const f = fixture();
      f.verdicts('fail', 'fail');
      f.analysis({ rootCause: 'spec_unclear', change: 'spec_update' });
      f.proof('task_spec_amended');
      f.analysis({ rootCause: 'swe_execution', change: 'split' });
      assert.match(denyReason(run(f).stdout), /names change split/);
    });

    it('denies again after a third FAIL until a new analysis and change', () => {
      const f = fixture();
      f.verdicts('fail', 'fail');
      f.analysis({ rootCause: 'spec_unclear', change: 'spec_update' });
      f.proof('task_spec_amended');
      assert.deepEqual(run(f), ALLOWED);
      f.verdicts('fail');
      let reason = denyReason(run(f).stdout);
      assert.match(reason, /task FAILs: 3 review FAILs/);
      assert.match(reason, /no task_rework_analysis newer than the latest FAIL/);
      assertInnerLimit(reason);
      f.analysis({ rootCause: 'swe_execution', change: 'effort_raise' });
      reason = denyReason(run(f).stdout);
      assert.match(reason, /with no task_effort_raised row newer than the latest FAIL/);
      f.proof('task_effort_raised');
      assert.deepEqual(run(f), ALLOWED);
    });

    it('the swe-resume path shares the verdict', async () => {
      const { sweResumeGate } = await import('../hooks/swe-resume-gate.js');
      const f = fixture();
      const w = new DatabaseSync(f.db);
      w.prepare("INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at, spawn_id, exit_reason) VALUES (?, ?, 'swe', '2026-10-25T09:05:00.000Z', 'agent-x', 'completed')").run(TASK_ID, ISSUE_ID);
      w.close();
      const resume = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'SendMessage', tool_input: { to: 'agent-x', message: 'go on' } });
      f.verdicts('fail', 'fail');
      assertInnerLimit(denyReason((sweResumeGate(resume, f.env) as { stdout: string }).stdout));
      f.analysis({ change: 'spec_update' });
      f.proof('task_spec_amended');
      assert.deepEqual(sweResumeGate(resume, f.env), ALLOWED);
    });
  });

  describe('GH 2148 regression: no bro row lifts a limit', () => {
    it('a newer bro discussion_append decision, on the task or the issue, lifts neither the inner limit nor the ceiling', () => {
      const f = fixture();
      f.verdicts('fail', 'fail');
      f.discuss({ kind: 'decision' });
      f.discuss({ kind: 'decision', taskId: null });
      assertInnerLimit(denyReason(run(f).stdout));
      const g = fixture();
      g.runs(6);
      g.discuss({ kind: 'decision' });
      g.discuss({ kind: 'decision', taskId: null });
      assertHumanOnlyWaiver(denyReason(run(g).stdout), TASK_ID);
    });
  });

  describe('the outer ceiling (GH 2830)', () => {
    const provenAnalysis = (f: Fixture, rootCause = 'spec_unclear') => {
      const id = f.analysis({ rootCause, change: 'spec_update' });
      f.proof('task_spec_amended');
      return id;
    };

    it('at six runs denies even with an analysis and a proven change, listing the analysis', () => {
      const f = fixture();
      f.runs(6);
      f.verdicts('fail', 'fail');
      const id = provenAnalysis(f);
      const reason = denyReason(run(f).stdout);
      assert.match(reason, /task runs: 6 swe runs/);
      assert.doesNotMatch(reason, /task FAILs:/);
      assert.match(reason, /outer ceiling/);
      assert.ok(reason.includes(`#${id} (root_cause spec_unclear, change spec_update)`), reason);
      assertHumanOnlyWaiver(reason, TASK_ID);
    });

    it('at four issue FAILs denies even with an analysis and a proven change', () => {
      const f = fixture();
      f.verdictsOn(OTHER_TASK_ID, 'fail', 'fail');
      f.verdicts('fail', 'fail');
      provenAnalysis(f);
      const reason = denyReason(run(f).stdout);
      assert.match(reason, /issue FAILs: 4 review FAILs/);
      assertHumanOnlyWaiver(reason, TASK_ID);
    });

    it('a second analysis with a repeated root_cause denies even with its proven change, naming both rows', () => {
      const f = fixture();
      f.verdicts('fail', 'fail');
      const first = provenAnalysis(f, 'spec_wrong');
      assert.deepEqual(run(f), ALLOWED);
      f.verdicts('fail');
      const second = provenAnalysis(f, 'spec_wrong');
      const reason = denyReason(run(f).stdout);
      assert.match(reason, /repeated root cause: two task_rework_analysis rows of the task name root_cause spec_wrong/);
      assert.ok(reason.includes(`#${first} (root_cause spec_wrong, change spec_update), #${second} (root_cause spec_wrong, change spec_update)`), reason);
      assertHumanOnlyWaiver(reason, TASK_ID);
    });

    it('a Human waiver lifts every limit; analyses before it no longer count', () => {
      const f = fixture();
      f.runs(6);
      f.verdicts('fail', 'fail');
      provenAnalysis(f, 'environment');
      f.verdictsOn(OTHER_TASK_ID, 'fail', 'fail');
      provenAnalysis(f, 'environment');
      denyReason(run(f).stdout);
      f.discuss({ author: 'human', kind: 'decision' });
      assert.deepEqual(run(f), ALLOWED);
      f.verdicts('fail', 'fail');
      provenAnalysis(f, 'environment');
      assert.deepEqual(run(f), ALLOWED);
    });
  });

  it('names every limit that tripped', () => {
    const f = fixture();
    f.runs(6);
    f.verdicts('fail', 'fail');
    f.verdictsOn(OTHER_TASK_ID, 'fail', 'fail');
    const reason = denyReason(run(f).stdout);
    assert.match(reason, /task FAILs: 2 .*; task runs: 6 .*; issue FAILs: 4 /);
    assertHumanOnlyWaiver(reason, TASK_ID);
  });

  it("a newer author 'human' kind 'note' row (pr_monitor's shape for a login named human) resets none of the three limits", () => {
    const f = fixture();
    f.runs(6);
    f.verdicts('fail', 'fail');
    f.verdictsOn(OTHER_TASK_ID, 'fail', 'fail');
    f.discuss({ author: 'human', kind: 'note' });
    f.discuss({ author: 'human', kind: 'note', taskId: null });
    const reason = denyReason(run(f).stdout);
    assert.match(reason, /task FAILs: 2 .*; task runs: 6 .*; issue FAILs: 4 /);
    assert.doesNotMatch(reason, /since the Human's last waiver/);
    f.discuss({ author: 'human', kind: 'decision' });
    assert.deepEqual(run(f), ALLOWED);
  });

  it('allows one FAIL, no FAIL, an unknown task, a non-swe spawn, a non-Agent tool and a prompt without task_id', () => {
    const f = fixture();
    assert.deepEqual(run(f), ALLOWED);
    f.verdicts('fail');
    assert.deepEqual(run(f), ALLOWED);
    f.verdicts('fail');
    assert.deepEqual(run(f, payload('swe', 'task_id=999')), ALLOWED);
    assert.deepEqual(run(f, payload('code-reviewer')), ALLOWED);
    assert.deepEqual(run(f, payload('swe', 'no task here')), ALLOWED);
    assert.deepEqual(run(f, JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } })), ALLOWED);
    denyReason(run(f, payload('tmb:swe')).stdout);
  });

  it('denies when the DB cannot be read', () => {
    const f = fixture();
    writeFileSync(f.db, 'not a database');
    denyReason(run(f).stdout);
  });

  describe('the agent-spawn-dispatch gate', () => {
    /** Of CHAIN only the gate under test runs, so the fixture needs no spec; PREPARE runs as markers. */
    function dispatch(f: Fixture): Promise<{ result: GateResult; ran: string[] }> {
      const ran: string[] = [];
      const find = (name: string): Gate | undefined =>
        PREPARE.includes(name)
          ? () => {
              ran.push(name);
              return ALLOW;
            }
          : name === 'rework-limit' ? findGate(name) : undefined;
      return agentSpawnDispatch(payload(), f.env, find).then((result) => ({ result, ran }));
    }

    it('returns the rework deny and runs no PREPARE step', async () => {
      const f = fixture();
      f.verdicts('fail', 'fail');
      f.discuss({ kind: 'decision' });
      const { result, ran } = await dispatch(f);
      assert.equal(result.code, 0);
      assert.match(denyReason(result.stdout.trim()), /task FAILs: 2 review FAILs/);
      assert.equal(ran.includes('ensure-swe-worktree'), false, 'ensure-swe-worktree did not run');
      assert.equal(ran.includes('record-swe-spawn'), false, 'record-swe-spawn did not run');
    });

    it('passes after a Human waiver and runs the PREPARE steps', async () => {
      const f = fixture();
      f.verdicts('fail', 'fail');
      f.discuss({ author: 'human', kind: 'decision' });
      const { result, ran } = await dispatch(f);
      assert.equal(result.code, 0);
      assert.equal(result.stdout.trim(), '');
      assert.equal(ran.includes('ensure-swe-worktree'), true, 'ensure-swe-worktree ran');
      assert.equal(ran.includes('record-swe-spawn'), true, 'record-swe-spawn ran');
    });
  });

  describe('hook docs', () => {
    for (const [doc, stale] of [
      ['scripts/hooks/README.md', 'a decision naming the change of approach'],
      ['mcp/trajectory-server/src/hooks/rework-limit.ts', 'needs a newer decision'],
    ]) {
      it(`${doc} names the Human-only waiver and no decision-row escape`, () => {
        const text = readFileSync(join(PLUGIN_ROOT, doc), 'utf8');
        assert.equal(text.includes(stale), false, `${doc} still says "${stale}"`);
        assert.ok(text.includes('waive task'), `${doc} names \`waive task <N>\``);
      });
    }
  });
});
