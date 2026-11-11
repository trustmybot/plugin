/**
 * The rework-limit gate (GH 1738, GH 2148, GH 2830, GH 2857) on a temp
 * trajectory DB. From two review FAILs on a task since its last passing
 * review, a swe spawn is admitted only when the task's latest
 * task_rework_analysis is newer than its latest FAIL and its change is proven
 * by a row dated after that FAIL: task_spec_amended for spec_update,
 * task_effort_raised for effort_raise, and a world-model scan, reindex,
 * concept upsert or `Area: World Model` issue for world_model_fix. split,
 * retry, re_review and ask_human never admit. No swe-run or issue-wide FAIL
 * count denies. A design_drift analysis denies at any FAIL count and names
 * task_retry and a split, never the Human. No discussions row, bro's or
 * author 'human', counts or lifts a deny. The agent-spawn-dispatch gate
 * returns the deny before any PREPARE step.
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
import * as taskRework from '../task-rework.js';
import { REWORK_FAIL_LIMIT } from '../task-rework.js';

const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PLUGIN_ROOT = resolve(SERVER_ROOT, '../..');
const SCHEMA = readFileSync(join(SERVER_ROOT, 'src/schema.sql'), 'utf8');
const SYSTEM_ISSUE_ID = -1;
const ISSUE_ID = 9;
const OTHER_ISSUE_ID = 10;
const TASK_ID = 3;
const OTHER_TASK_ID = 4;
const FRESH_TASK_ID = 5;
const ELSEWHERE_TASK_ID = 6;
const WORLD_MODEL_LABEL = 'Area: World Model';

type Verdict = 'pass' | 'fail';
type WorldModelProof = 'deep_scan_completed' | 'wm_reindex' | 'concept_upsert' | 'issue';

interface Fixture {
  db: string;
  env: NodeJS.ProcessEnv;
  verdicts(...list: Verdict[]): void;
  verdictsOn(taskId: number, ...list: Verdict[]): void;
  runs(n: number, row?: { stopCause?: string | null; exitReason?: string | null }): void;
  discuss(row: { author?: string; kind?: string; taskId?: number | null }): void;
  analysis(row?: { rootCause?: string; change?: string; taskId?: number; at?: string }): number;
  proof(eventType: 'task_spec_amended' | 'task_effort_raised', taskId?: number): number;
  worldModelProof(kind: WorldModelProof): void;
  wmToolCall(tool: string, error: boolean): void;
  issue(labels: string | null): void;
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
  const write = (sql: string, ...params: Array<string | number | null>): number => {
    const w = new DatabaseSync(db);
    const res = w.prepare(sql).run(...params);
    w.close();
    return Number(res.lastInsertRowid);
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
  const auditRow = (eventType: string, content: Record<string, unknown>, issueId = ISSUE_ID, at = tick()): number =>
    write(
      "INSERT INTO audit (issue_id, from_node, event_type, summary, content_json, created_at) VALUES (?, 'bro', ?, 's', ?, ?)",
      issueId,
      eventType,
      JSON.stringify(content),
      at,
    );
  const analysis = ({ rootCause = 'spec_unclear', change = 'spec_update', taskId = TASK_ID, at }: { rootCause?: string; change?: string; taskId?: number; at?: string } = {}) =>
    auditRow(
      'task_rework_analysis',
      { task_id: taskId, root_cause: rootCause, change, approach_shared_cause: false, fail_validation_ids: [], finding_ids: [], rationale: 'r' },
      ISSUE_ID,
      at,
    );
  const proof = (eventType: 'task_spec_amended' | 'task_effort_raised', taskId = TASK_ID) => auditRow(eventType, { task_id: taskId });
  const wmToolCall = (tool: string, error: boolean) => {
    auditRow('wm_tool_called', { tool, agent: 'bro', task_id: null, error }, SYSTEM_ISSUE_ID);
  };
  const issue = (labels: string | null) => {
    const at = tick();
    write("INSERT INTO issues (objective, status, created_at, updated_at, labels) VALUES ('wm bug', 'open', ?, ?, ?)", at, at, labels);
  };
  const worldModelProof = (kind: WorldModelProof) => {
    if (kind === 'concept_upsert') wmToolCall('world_model_concept_upsert', false);
    else if (kind === 'issue') issue(JSON.stringify(['Bug', WORLD_MODEL_LABEL]));
    else auditRow(kind, { repo: 'plugin' }, SYSTEM_ISSUE_ID);
  };
  return {
    db,
    env,
    verdicts: (...list) => verdictsOn(TASK_ID, ...list),
    verdictsOn,
    runs,
    discuss,
    analysis,
    proof,
    worldModelProof,
    wmToolCall,
    issue,
  };
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

/** The rework-limit deny: bro debugs, answers the approach question, records and changes; no Human waiver, no decision-row escape. */
function assertReworkLimit(reason: string): void {
  assert.ok(reason.includes('the spec, the world model, the reviewer, the environment), then swe\'s execution'), reason);
  assert.match(reason, /approach question/);
  assert.ok(reason.includes('task_rework_analysis'), reason);
  assert.ok(reason.includes('task_update_spec') && reason.includes('task_reopen(effort=...)') && reason.includes('world_model_fix'), reason);
  assert.ok(reason.includes('task_retry') && /new task/.test(reason), reason);
  assert.match(reason, /approach_shared_cause/);
  assert.match(reason, /design_drift, change split or retry/);
  assert.doesNotMatch(reason, /[Ww]aive|Human/);
  assert.doesNotMatch(reason, /discussion_append/);
  assert.doesNotMatch(reason, /decision/i);
}

/** The design-drift deny: redesign as a new task by task_retry or a split; no Human action, no policy stop. */
function assertDesignDrift(reason: string, taskId: number): void {
  assert.match(reason, /names root_cause design_drift/);
  assert.match(reason, /no further swe run of this task goes on/);
  assert.match(reason, /Redesign the work as a new task: `task_retry` this task with a spec redesigned/);
  assert.match(reason, /split it into new tasks with `task_create_batch`/);
  assert.ok(reason.includes(`Allowed form: task_update_status(agent='bro', task_id=${taskId}, status='escalated'), then task_retry(agent='bro', failed_task_id=${taskId}, `), reason);
  assert.doesNotMatch(reason, /policy/);
  assert.doesNotMatch(reason, /[Ww]aive|Human/);
  assert.doesNotMatch(reason, /discussion_append/);
  assert.doesNotMatch(reason, /decision/i);
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

  it('keeps the FAIL limit as a named constant and no swe-run or issue-FAIL cap', () => {
    assert.equal(REWORK_FAIL_LIMIT, 2);
    assert.equal('SWE_RUN_LIMIT' in taskRework, false);
    assert.equal('ISSUE_FAIL_LIMIT' in taskRework, false);
  });

  describe('task FAILs', () => {
    it('denies a swe spawn after two FAILs, naming the limit, its count and the debug steps', () => {
      const f = fixture();
      f.verdicts('fail', 'fail');
      const reason = denyReason(run(f).stdout);
      assert.match(reason, /task 3 is at the rework limit/);
      assert.match(reason, /task FAILs: 2 review FAILs on the task since its last passing review \(limit 2\)/);
      assertReworkLimit(reason);
    });

    it("no author 'human' decision row, on the task, its issue or another task, lifts it or resets the count (GH 2857)", () => {
      const f = fixture();
      f.verdicts('fail', 'fail');
      f.discuss({ author: 'human', kind: 'decision' });
      f.discuss({ author: 'human', kind: 'decision', taskId: null });
      f.discuss({ author: 'human', kind: 'decision', taskId: OTHER_TASK_ID });
      assertReworkLimit(denyReason(run(f).stdout));
      f.verdicts('fail');
      assert.match(denyReason(run(f).stdout), /task FAILs: 3 review FAILs on the task since its last passing review/);
    });

    it('offers no effort_raise to a task already at high, which a FAIL raised it to (GH 2866)', () => {
      const f = fixture();
      const d = new DatabaseSync(f.db);
      d.prepare("UPDATE tasks SET effort = 'high' WHERE id = ?").run(TASK_ID);
      d.close();
      f.verdicts('fail', 'fail');
      const reason = denyReason(run(f).stdout);
      assert.match(reason, /task 3 is at the rework limit/);
      assert.match(reason, /already runs at effort "high", so no effort_raise is left/);
      assert.ok(reason.includes('spec_update with `task_update_spec`') && reason.includes('world_model_fix with `scan_run`'), reason);
      assert.doesNotMatch(reason, /effort_raise with|task_reopen\(task_id=3, effort=/);
    });

    it('counts only the FAILs after the latest pass', () => {
      const f = fixture();
      f.verdicts('fail', 'fail', 'pass', 'fail');
      assert.deepEqual(run(f), ALLOWED);
      f.verdicts('fail');
      assert.match(denyReason(run(f).stdout), /task FAILs: 2 review FAILs on the task since its last passing review/);
    });
  });

  describe('no count alone denies (GH 2830)', () => {
    it('admits a spawn after seven or more swe runs with fewer than two FAILs', () => {
      const f = fixture();
      f.runs(7);
      assert.deepEqual(run(f), ALLOWED);
      f.runs(5, { stopCause: 'hook_block' });
      f.verdicts('fail');
      assert.deepEqual(run(f), ALLOWED);
    });

    it('admits a spawn with five or more unresolved FAILs across the issue and fewer than two on the task', () => {
      const f = fixture();
      f.verdictsOn(OTHER_TASK_ID, 'fail', 'fail', 'fail', 'fail', 'fail');
      f.verdictsOn(ELSEWHERE_TASK_ID, 'fail', 'fail');
      assert.deepEqual(spawnOf(f, FRESH_TASK_ID), ALLOWED);
      f.verdictsOn(TASK_ID, 'fail');
      assert.deepEqual(spawnOf(f, TASK_ID), ALLOWED);
      assert.deepEqual(spawnOf(f, FRESH_TASK_ID), ALLOWED);
    });

    it('many runs and issue FAILs add nothing to the deny of a task at two FAILs', () => {
      const f = fixture();
      f.runs(9);
      f.verdictsOn(OTHER_TASK_ID, 'fail', 'fail', 'fail', 'fail', 'fail');
      f.verdicts('fail', 'fail');
      const reason = denyReason(run(f).stdout);
      assert.doesNotMatch(reason, /task runs:|issue FAILs:|outer ceiling/);
      f.analysis({ change: 'spec_update' });
      f.proof('task_spec_amended');
      assert.deepEqual(run(f), ALLOWED);
    });

    it('a repeated root cause across analyses does not deny on its own', () => {
      const f = fixture();
      f.verdicts('fail', 'fail');
      f.analysis({ rootCause: 'spec_wrong', change: 'spec_update' });
      f.proof('task_spec_amended');
      assert.deepEqual(run(f), ALLOWED);
      f.verdicts('fail');
      f.analysis({ rootCause: 'spec_wrong', change: 'spec_update' });
      f.proof('task_spec_amended');
      assert.deepEqual(run(f), ALLOWED);
    });
  });

  describe('the allowlist at two or more FAILs (GH 2830)', () => {
    it('denies at two FAILs with no analysis', () => {
      const f = fixture();
      f.verdicts('fail', 'fail');
      const reason = denyReason(run(f).stdout);
      assert.match(reason, /no task_rework_analysis newer than the latest FAIL/);
      assertReworkLimit(reason);
    });

    for (const [change, proofName] of [
      ['spec_update', 'a task_spec_amended row'],
      ['effort_raise', 'a task_effort_raised row'],
      ['world_model_fix', 'a world-model scan, reindex, world_model_concept_upsert or `Area: World Model` issue'],
    ]) {
      it(`denies a ${change} analysis with no proving row`, () => {
        const f = fixture();
        f.verdicts('fail', 'fail');
        const id = f.analysis({ change });
        const reason = denyReason(run(f).stdout);
        assert.ok(reason.includes(`analysis #${id} names change ${change}, with no proof dated after the latest FAIL (${proofName})`), reason);
        assertReworkLimit(reason);
      });
    }

    it('denies when the task proving row predates the latest FAIL', () => {
      const f = fixture();
      f.verdicts('fail');
      f.proof('task_spec_amended');
      f.proof('task_effort_raised');
      f.verdicts('fail');
      f.analysis({ change: 'spec_update' });
      assert.match(denyReason(run(f).stdout), /\(a task_spec_amended row\)/);
      const g = fixture();
      g.verdicts('fail');
      g.proof('task_effort_raised');
      g.verdicts('fail');
      g.analysis({ change: 'effort_raise' });
      assert.match(denyReason(run(g).stdout), /\(a task_effort_raised row\)/);
    });

    for (const kind of ['deep_scan_completed', 'wm_reindex', 'concept_upsert', 'issue'] as const) {
      it(`denies world_model_fix when its ${kind} proof predates the latest FAIL`, () => {
        const f = fixture();
        f.verdicts('fail');
        f.worldModelProof(kind);
        f.verdicts('fail');
        f.analysis({ rootCause: 'world_model', change: 'world_model_fix' });
        assert.match(denyReason(run(f).stdout), /names change world_model_fix, with no proof dated after the latest FAIL/);
      });

      it(`admits world_model_fix proven by a ${kind} row after the latest FAIL`, () => {
        const f = fixture();
        f.verdicts('fail', 'fail');
        f.analysis({ rootCause: 'world_model', change: 'world_model_fix' });
        f.worldModelProof(kind);
        assert.deepEqual(run(f), ALLOWED);
      });
    }

    it('a failed concept upsert, another world-model tool, or an issue without the label proves no world_model_fix', () => {
      const f = fixture();
      f.verdicts('fail', 'fail');
      f.analysis({ rootCause: 'world_model', change: 'world_model_fix' });
      f.wmToolCall('world_model_concept_upsert', true);
      f.wmToolCall('world_model_search', false);
      f.issue(JSON.stringify(['Bug', 'Area: Hooks']));
      f.issue(null);
      f.issue('not json');
      denyReason(run(f).stdout);
    });

    it('denies with an analysis older than the latest FAIL, even with a newer proof', () => {
      const f = fixture();
      f.verdicts('fail');
      f.analysis({ change: 'spec_update' });
      f.verdicts('fail');
      f.proof('task_spec_amended');
      assert.match(denyReason(run(f).stdout), /no task_rework_analysis newer than the latest FAIL/);
    });

    for (const [rootCause, change] of [
      ['spec_unclear', 'split'],
      ['swe_execution', 'retry'],
      ['reviewer_disputed', 're_review'],
      ['spec_wrong', 'ask_human'],
    ]) {
      it(`denies for change ${change}, whatever proof follows`, () => {
        const f = fixture();
        f.verdicts('fail', 'fail');
        const id = f.analysis({ rootCause, change });
        f.proof('task_spec_amended');
        f.proof('task_effort_raised');
        f.worldModelProof('deep_scan_completed');
        const reason = denyReason(run(f).stdout);
        assert.ok(reason.includes(`analysis #${id} names change ${change}, which admits no further swe run of this task`), reason);
        assertReworkLimit(reason);
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

    it('a malformed issue label set does not break the read', () => {
      const f = fixture();
      f.issue('not json');
      f.verdicts('fail', 'fail');
      f.analysis({ change: 'spec_update' });
      f.proof('task_spec_amended');
      assert.deepEqual(run(f), ALLOWED);
    });

    it('a proof of another change does not admit', () => {
      const f = fixture();
      f.verdicts('fail', 'fail');
      f.analysis({ change: 'spec_update' });
      f.proof('task_effort_raised');
      f.worldModelProof('wm_reindex');
      denyReason(run(f).stdout);
      const g = fixture();
      g.verdicts('fail', 'fail');
      g.analysis({ rootCause: 'world_model', change: 'world_model_fix' });
      g.proof('task_spec_amended');
      denyReason(run(g).stdout);
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

    it('analyses with one created_at order by id', () => {
      const f = fixture();
      f.verdicts('fail', 'fail');
      const at = '2026-10-25T11:00:00.000Z';
      f.analysis({ change: 'spec_update', at });
      const split = f.analysis({ change: 'split', at });
      f.proof('task_spec_amended');
      assert.ok(denyReason(run(f).stdout).includes(`analysis #${split} names change split`));
      const g = fixture();
      g.verdicts('fail', 'fail');
      g.analysis({ change: 'split', at });
      g.analysis({ change: 'spec_update', at });
      g.proof('task_spec_amended');
      assert.deepEqual(run(g), ALLOWED);
    });

    it('denies again after a further FAIL until a new analysis and change', () => {
      const f = fixture();
      f.verdicts('fail', 'fail');
      f.analysis({ rootCause: 'spec_unclear', change: 'spec_update' });
      f.proof('task_spec_amended');
      assert.deepEqual(run(f), ALLOWED);
      f.verdicts('fail');
      let reason = denyReason(run(f).stdout);
      assert.match(reason, /task FAILs: 3 review FAILs/);
      assert.match(reason, /no task_rework_analysis newer than the latest FAIL/);
      assertReworkLimit(reason);
      f.analysis({ rootCause: 'swe_execution', change: 'effort_raise' });
      reason = denyReason(run(f).stdout);
      assert.match(reason, /\(a task_effort_raised row\)/);
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
      assertReworkLimit(denyReason((sweResumeGate(resume, f.env) as { stdout: string }).stdout));
      f.analysis({ change: 'spec_update' });
      f.proof('task_spec_amended');
      assert.deepEqual(sweResumeGate(resume, f.env), ALLOWED);
      f.analysis({ rootCause: 'design_drift', change: 'retry' });
      assertDesignDrift(denyReason((sweResumeGate(resume, f.env) as { stdout: string }).stdout), TASK_ID);
    });
  });

  describe('design drift (GH 2830, GH 2857)', () => {
    for (const change of ['retry', 'split']) {
      it(`denies at zero FAILs with change ${change}, naming task_retry and a split, never the Human`, () => {
        const f = fixture();
        const id = f.analysis({ rootCause: 'design_drift', change });
        const reason = denyReason(run(f).stdout);
        assert.ok(reason.includes(`analysis #${id} names root_cause design_drift`), reason);
        assertDesignDrift(reason, TASK_ID);
        assert.doesNotMatch(reason, /task FAILs:/);
      });
    }

    it('denies at one FAIL and past a later analysis with a proven change', () => {
      const f = fixture();
      f.verdicts('fail');
      f.analysis({ rootCause: 'design_drift', change: 'retry' });
      assertDesignDrift(denyReason(run(f).stdout), TASK_ID);
      f.verdicts('fail');
      f.analysis({ change: 'spec_update' });
      f.proof('task_spec_amended');
      assertDesignDrift(denyReason(run(f).stdout), TASK_ID);
    });

    it('a later passing review does not lift it', () => {
      const f = fixture();
      f.analysis({ rootCause: 'design_drift', change: 'split' });
      f.verdicts('pass');
      assertDesignDrift(denyReason(run(f).stdout), TASK_ID);
    });

    it("no discussions row lifts it: a bro decision, a Human note, or an author 'human' decision on the task, its issue or another task", () => {
      const f = fixture();
      f.analysis({ rootCause: 'design_drift', change: 'retry' });
      f.discuss({ kind: 'decision' });
      f.discuss({ kind: 'decision', taskId: null });
      f.discuss({ author: 'human', kind: 'note' });
      f.discuss({ author: 'human', kind: 'decision' });
      f.discuss({ author: 'human', kind: 'decision', taskId: null });
      f.discuss({ author: 'human', kind: 'decision', taskId: OTHER_TASK_ID });
      assertDesignDrift(denyReason(run(f).stdout), TASK_ID);
    });

    it("another task's design drift does not block this task", () => {
      const f = fixture();
      f.analysis({ rootCause: 'design_drift', change: 'retry', taskId: OTHER_TASK_ID });
      assert.deepEqual(run(f), ALLOWED);
      assertDesignDrift(denyReason(spawnOf(f, OTHER_TASK_ID).stdout), OTHER_TASK_ID);
    });
  });

  describe('GH 2148 regression: no bro row counts as an analysis or lifts a deny', () => {
    it('a newer bro discussion_append decision, on the task or the issue, lifts neither the rework limit nor design drift', () => {
      const f = fixture();
      f.verdicts('fail', 'fail');
      f.discuss({ kind: 'decision' });
      f.discuss({ kind: 'decision', taskId: null });
      f.discuss({ kind: 'note' });
      const reason = denyReason(run(f).stdout);
      assert.match(reason, /no task_rework_analysis newer than the latest FAIL/);
      assertReworkLimit(reason);
      f.proof('task_spec_amended');
      f.discuss({ kind: 'decision' });
      assert.match(denyReason(run(f).stdout), /no task_rework_analysis newer than the latest FAIL/);
      const g = fixture();
      g.analysis({ rootCause: 'design_drift', change: 'split' });
      g.discuss({ kind: 'decision' });
      g.discuss({ kind: 'decision', taskId: null });
      assertDesignDrift(denyReason(run(g).stdout), TASK_ID);
    });

    it("a newer author 'human' row of any kind (pr_monitor's note for a login named human included) resets nothing", () => {
      const f = fixture();
      f.verdicts('fail', 'fail');
      f.discuss({ author: 'human', kind: 'note' });
      f.discuss({ author: 'human', kind: 'note', taskId: null });
      f.discuss({ author: 'human', kind: 'decision' });
      const reason = denyReason(run(f).stdout);
      assert.match(reason, /task FAILs: 2 /);
      assertReworkLimit(reason);
    });
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

    it('passes after a proven analysis and runs the PREPARE steps', async () => {
      const f = fixture();
      f.verdicts('fail', 'fail');
      f.analysis({ change: 'spec_update' });
      f.proof('task_spec_amended');
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
      it(`${doc} names no Human waiver, decision-row escape or fixed cap`, () => {
        const text = readFileSync(join(PLUGIN_ROOT, doc), 'utf8');
        assert.equal(text.includes(stale), false, `${doc} still says "${stale}"`);
        assert.doesNotMatch(text, /waive\s+task|Human waiver|Human's (last|latest) waiver/i, `${doc} still names a Human waiver`);
        for (const cap of ['SWE_RUN_LIMIT', 'ISSUE_FAIL_LIMIT', 'outer ceiling']) {
          assert.equal(text.includes(cap), false, `${doc} still names ${cap}`);
        }
      });
    }
  });
});
