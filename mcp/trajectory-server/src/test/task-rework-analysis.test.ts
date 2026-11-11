/**
 * task_rework_analysis (GH 2830, GH 2857): bro's typed analysis of a task's
 * review FAILs since its last pass writes one task_rework_analysis audit row
 * and refuses a non-bro agent, a FAIL id not on the task or not after its
 * latest pass, a list missing the latest FAIL, a malformed finding id, an
 * unknown root_cause or change, a missing approach_shared_cause, a pairing
 * outside the rules (world_model takes only world_model_fix, design_drift only
 * split or retry, a shared approach cause takes only split or retry), and a
 * short rationale. With a newer task_spec_amended row the
 * rework-limit gate admits the next swe spawn.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { TrajectoryDB } from '../db.js';
import { tempDB } from './helpers.js';
import { taskTools } from '../tools/tasks.js';
import { insertAudit } from '../tools/audit.js';
import { reworkLimit } from '../hooks/rework-limit.js';

const TASK_ID = 7;
const OTHER_TASK_ID = 8;
const ISSUE_ID = 4;

let sandbox: string;
let seq = 0;

interface Fixture {
  db: TrajectoryDB;
  path: string;
  verdict(verdict: 'pass' | 'fail', taskId?: number): number;
  call(args: Record<string, unknown>): Promise<CallToolResult>;
  rows(): Array<{ id: number; from_node: string; issue_id: number; content_json: string }>;
}

function fixture(): Fixture {
  seq += 1;
  const path = join(sandbox, `case-${seq}`, '.claude/tmb/trajectory.db');
  mkdirSync(join(sandbox, `case-${seq}`, '.claude/tmb'), { recursive: true });
  const db = tempDB({ path });
  db.run("INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (?, 'o', 'open', '2026-11-09T09:00:00.000Z', '2026-11-09T09:00:00.000Z')", [ISSUE_ID]);
  for (const id of [TASK_ID, OTHER_TASK_ID]) {
    db.run(
      "INSERT INTO tasks (id, issue_id, branch_id, description, status, created_at, updated_at) VALUES (?, ?, ?, 'd', 'running', '2026-11-09T09:00:00.000Z', '2026-11-09T09:00:00.000Z')",
      [id, ISSUE_ID, `feat/${id}-x`],
    );
  }
  let minute = 0;
  let attempt = 0;
  const handlers = taskTools(db).handlers;
  return {
    db,
    path,
    verdict(verdict, taskId = TASK_ID) {
      minute += 1;
      attempt += 1;
      const at = new Date(Date.UTC(2020, 0, 1, 10, minute)).toISOString();
      const res = db.run(
        "INSERT INTO validation_attempts (task_id, attempt_n, agent, verdict, feedback, mcp_available, created_at) VALUES (?, ?, 'code-reviewer', ?, 'f', 1, ?)",
        [taskId, attempt, verdict, at],
      );
      return Number(res.lastInsertRowid);
    },
    call: (args) => handlers['task_rework_analysis'](args),
    rows: () =>
      db.all("SELECT id, from_node, issue_id, content_json FROM audit WHERE event_type = 'task_rework_analysis' ORDER BY id"),
  };
}

const payloadOf = (r: CallToolResult) => JSON.parse((r.content[0] as { text: string }).text) as Record<string, unknown>;

const valid = (failIds: number[], over: Record<string, unknown> = {}) => ({
  agent: 'bro',
  task_id: TASK_ID,
  fail_validation_ids: failIds,
  finding_ids: [`F${TASK_ID}-1`, `F${TASK_ID}-2`],
  root_cause: 'spec_unclear',
  change: 'spec_update',
  approach_shared_cause: false,
  rationale: 'Both FAILs trace to the spec naming the wrong table.',
  ...over,
});

async function refused(f: Fixture, args: Record<string, unknown>, pattern: RegExp): Promise<void> {
  const r = await f.call(args);
  assert.equal(r.isError, true, JSON.stringify(r.content));
  assert.match(String(payloadOf(r)['error']), pattern);
  assert.equal(f.rows().length, 0, 'a refused call writes no row');
}

describe('task_rework_analysis', () => {
  before(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'tmb-rework-analysis-'));
  });
  after(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('writes one task_rework_analysis row carrying every argument and returns its id', async () => {
    const f = fixture();
    const a = f.verdict('fail');
    const b = f.verdict('fail');
    const r = await f.call(valid([a, b]));
    assert.ok(!r.isError, JSON.stringify(r.content));
    const rows = f.rows();
    assert.equal(rows.length, 1);
    assert.deepEqual(payloadOf(r), { audit_id: rows[0].id, task_id: TASK_ID });
    assert.equal(rows[0].from_node, 'bro');
    assert.equal(rows[0].issue_id, ISSUE_ID);
    assert.deepEqual(JSON.parse(rows[0].content_json), {
      task_id: TASK_ID,
      fail_validation_ids: [a, b],
      finding_ids: [`F${TASK_ID}-1`, `F${TASK_ID}-2`],
      root_cause: 'spec_unclear',
      change: 'spec_update',
      approach_shared_cause: false,
      rationale: 'Both FAILs trace to the spec naming the wrong table.',
    });
  });

  it('records approach_shared_cause true with a split or a retry', async () => {
    const f = fixture();
    const a = f.verdict('fail');
    for (const change of ['split', 'retry']) {
      const r = await f.call(valid([a], { root_cause: 'swe_execution', change, approach_shared_cause: true }));
      assert.ok(!r.isError, JSON.stringify(r.content));
    }
    const rows = f.rows().map((row) => JSON.parse(row.content_json) as Record<string, unknown>);
    assert.deepEqual(
      rows.map((c) => [c['change'], c['approach_shared_cause']]),
      [
        ['split', true],
        ['retry', true],
      ],
    );
  });

  it('accepts every root_cause and change the pairing rules allow', async () => {
    const f = fixture();
    const a = f.verdict('fail');
    const allowed: Array<[string, string]> = [
      ['world_model', 'world_model_fix'],
      ['design_drift', 'retry'],
      ['design_drift', 'split'],
      ['spec_wrong', 'ask_human'],
      ['environment', 'ask_human'],
      ['spec_wrong', 'world_model_fix'],
      ['reviewer_disputed', 're_review'],
      ['environment', 'retry'],
      ['swe_execution', 'effort_raise'],
      ['spec_unclear', 'split'],
    ];
    for (const [root_cause, change] of allowed) {
      const r = await f.call(valid([a], { root_cause, change }));
      assert.ok(!r.isError, `${root_cause} → ${change}: ${JSON.stringify(r.content)}`);
    }
    assert.equal(f.rows().length, allowed.length);
  });

  it('refuses world_model with any change but world_model_fix', async () => {
    const f = fixture();
    const a = f.verdict('fail');
    for (const change of ['spec_update', 'effort_raise', 'split', 'retry', 're_review', 'ask_human']) {
      await refused(f, valid([a], { root_cause: 'world_model', change }), /rework_analysis_invalid: root_cause world_model takes only change world_model_fix/);
    }
  });

  it('refuses design_drift with any change but split or retry, ask_human included (GH 2857)', async () => {
    const f = fixture();
    const a = f.verdict('fail');
    for (const change of ['spec_update', 'world_model_fix', 'effort_raise', 're_review', 'ask_human']) {
      await refused(f, valid([a], { root_cause: 'design_drift', change }), /rework_analysis_invalid: root_cause design_drift takes only change split or retry/);
    }
  });

  it('records design_drift with split or retry, the approach shared or not', async () => {
    const f = fixture();
    const a = f.verdict('fail');
    for (const change of ['split', 'retry']) {
      for (const approach_shared_cause of [false, true]) {
        const r = await f.call(valid([a], { root_cause: 'design_drift', change, approach_shared_cause }));
        assert.ok(!r.isError, JSON.stringify(r.content));
      }
    }
    assert.equal(f.rows().length, 4);
  });

  it('ask_human answers any root_cause whose pairing allows it, and no root_cause requires it', async () => {
    const f = fixture();
    const a = f.verdict('fail');
    await refused(f, valid([a], { root_cause: 'world_model', change: 'ask_human' }), /rework_analysis_invalid: root_cause world_model takes only change world_model_fix/);
    for (const root_cause of ['spec_unclear', 'spec_wrong', 'reviewer_disputed', 'environment', 'swe_execution']) {
      const r = await f.call(valid([a], { root_cause, change: 'ask_human' }));
      assert.ok(!r.isError, `${root_cause}: ${JSON.stringify(r.content)}`);
    }
  });

  it('refuses approach_shared_cause true with any change but split or retry', async () => {
    const f = fixture();
    const a = f.verdict('fail');
    for (const change of ['spec_update', 'world_model_fix', 'effort_raise', 're_review']) {
      await refused(
        f,
        valid([a], { root_cause: 'swe_execution', change, approach_shared_cause: true }),
        /rework_analysis_invalid: approach_shared_cause true takes only change split or retry .*a redesign, not another patch/,
      );
    }
    await refused(f, valid([a], { root_cause: 'spec_wrong', change: 'ask_human', approach_shared_cause: true }), /approach_shared_cause true takes only change split or retry/);
    await refused(f, valid([a], { root_cause: 'world_model', change: 'world_model_fix', approach_shared_cause: true }), /approach_shared_cause true takes only change split or retry/);
  });

  it('refuses a missing or non-boolean approach_shared_cause', async () => {
    const f = fixture();
    const a = f.verdict('fail');
    for (const approach_shared_cause of [undefined, 'false', 0, null]) {
      await refused(f, valid([a], { approach_shared_cause }), /rework_analysis_invalid: approach_shared_cause must be a boolean/);
    }
  });

  it('accepts the latest FAIL alone', async () => {
    const f = fixture();
    f.verdict('fail');
    const b = f.verdict('fail');
    const r = await f.call(valid([b]));
    assert.ok(!r.isError, JSON.stringify(r.content));
  });

  it('refuses a non-bro agent', async () => {
    const f = fixture();
    const a = f.verdict('fail');
    for (const agent of ['swe', 'code-reviewer', 'pm']) {
      const r = await f.call(valid([a], { agent }));
      assert.equal(r.isError, true);
      assert.equal(payloadOf(r)['error'], 'forbidden');
    }
    assert.equal(f.rows().length, 0);
  });

  it('refuses a FAIL id on another task, a pass id, an unknown id, or one before the latest pass', async () => {
    const f = fixture();
    const early = f.verdict('fail');
    const pass = f.verdict('pass');
    const other = f.verdict('fail', OTHER_TASK_ID);
    const late = f.verdict('fail');
    await refused(f, valid([late, other]), new RegExp(`rework_analysis_invalid: fail_validation_ids ${other} are not FAIL verdicts on task ${TASK_ID}`));
    await refused(f, valid([late, pass]), /rework_analysis_invalid: fail_validation_ids .* not FAIL verdicts/);
    await refused(f, valid([late, 9999]), /rework_analysis_invalid: fail_validation_ids 9999/);
    await refused(f, valid([early, late]), new RegExp(`fail_validation_ids ${early} are not FAIL verdicts on task ${TASK_ID} after its latest pass`));
  });

  it('refuses a list missing the latest FAIL, and a task with no FAIL', async () => {
    const f = fixture();
    const a = f.verdict('fail');
    const b = f.verdict('fail');
    await refused(f, valid([a]), new RegExp(`must include the latest FAIL on task ${TASK_ID}, validation_attempts row ${b}`));
    const g = fixture();
    await refused(g, valid([1]), /rework_analysis_invalid/);
  });

  it('refuses an empty or non-integer fail list', async () => {
    const f = fixture();
    f.verdict('fail');
    await refused(f, valid([]), /fail_validation_ids must be a non-empty array of integers/);
    await refused(f, valid(['1'] as unknown as number[]), /fail_validation_ids must be a non-empty array of integers/);
  });

  it('refuses a malformed finding id or an empty list', async () => {
    const f = fixture();
    const a = f.verdict('fail');
    for (const finding_ids of [[`F${OTHER_TASK_ID}-1`], ['F7-'], ['f7-1'], ['F7-1x'], [7]]) {
      await refused(f, valid([a], { finding_ids }), /rework_analysis_invalid: finding_ids entry .* does not match F7-<n>/);
    }
    await refused(f, valid([a], { finding_ids: [] }), /finding_ids must be a non-empty array/);
  });

  it('refuses an unknown root_cause or change', async () => {
    const f = fixture();
    const a = f.verdict('fail');
    await refused(
      f,
      valid([a], { root_cause: 'bad_luck' }),
      /rework_analysis_invalid: root_cause must be one of spec_unclear, spec_wrong, world_model, reviewer_disputed, environment, swe_execution, design_drift \(/,
    );
    await refused(
      f,
      valid([a], { change: 'try_again' }),
      /rework_analysis_invalid: change must be one of spec_update, world_model_fix, effort_raise, split, retry, re_review, ask_human \(/,
    );
  });

  it('refuses a rationale under 20 characters', async () => {
    const f = fixture();
    const a = f.verdict('fail');
    await refused(f, valid([a], { rationale: 'too short' }), /rationale must be at least 20 characters/);
    await refused(f, valid([a], { rationale: `   ${'x'.repeat(19)}   ` }), /rationale must be at least 20 characters/);
  });

  it('refuses an unknown task', async () => {
    const f = fixture();
    await refused(f, valid([1], { task_id: 999 }), /rework_analysis_invalid: task 999 not found/);
  });

  it('its row, with a newer task_spec_amended, admits the next swe spawn at the two-FAIL limit', async () => {
    const f = fixture();
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: join(sandbox, 'home'), TRAJECTORY_DB_PATH: f.path };
    const spawn = () =>
      reworkLimit(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'swe', prompt: `task_id=${TASK_ID}` } }), env) as {
        stdout: string;
      };
    const a = f.verdict('fail');
    const b = f.verdict('fail');
    assert.match(spawn().stdout, /task_rework_analysis/);
    const r = await f.call(valid([a, b]));
    assert.ok(!r.isError, JSON.stringify(r.content));
    assert.match(spawn().stdout, /no proof dated after the latest FAIL \(a task_spec_amended row\)/);
    insertAudit(f.db, {
      issue_id: ISSUE_ID,
      branch_id: `feat/${TASK_ID}-x`,
      from_node: 'bro',
      event_type: 'task_spec_amended',
      summary: 's',
      content_json: JSON.stringify({ task_id: TASK_ID, status: 'running', reason: 'r', changes: {} }),
    });
    assert.equal(spawn().stdout, '');
  });
});
