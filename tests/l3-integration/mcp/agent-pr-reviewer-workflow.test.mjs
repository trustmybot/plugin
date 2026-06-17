// Layer 2 agent-workflow: pr-reviewer's MCP responsibilities end-to-end.
// Reviewer reads the completed task, records pass/fail via validation_record,
// and verifies history round-trip. This is the gate that unlocks push.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startClient, call } from './harness.mjs';

async function seedCompletedTask(client) {
  const issue = await call(client, 'issue_create', {
    agent: 'bro', objective: 'pr test', description: 'x',
  });
  assert.equal(issue.ok, true);
  const batch = await call(client, 'task_create_batch', {
    waive_scope_gate: true, waive_scope_gate_reason: 'unit-test synthetic scope; gate not under test',
    waive_branch_gate: true, waive_branch_gate_reason: 'integration-test fixture; branch gate not under test', waive_intent_gate: true, waive_intent_gate_reason: 'unit-test synthetic intent; not under test', waive_decision_gate: true, waive_decision_gate_reason: 'unit-test synthetic triage; not under test',
    agent: 'bro',
    issue_id: issue.data.id,
    tasks: [{
      branch_id: 'feat/pr-test',
      title: 't',
      description: 'd',
      spec_body: [
        '# Task: pr-test handler',
        '',
        '## Success Criteria',
        '- handler returns 200 with body "ok"',
      ].join('\n'),
    }],
  });
  const taskId = Array.isArray(batch.data) ? batch.data[0]?.id : batch.data.tasks?.[0]?.id;

  // SWE completes it.
  await call(client, 'task_update_status', { agent: 'swe', task_id: taskId, status: 'running' });
  await call(client, 'task_update_status', { agent: 'swe', task_id: taskId, status: 'completed' });

  return taskId;
}

test('pr-reviewer — happy path: read task → record pass → history reflects it', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  const taskId = await seedCompletedTask(client);

  // Reviewer reads the task spec.
  const task = await call(client, 'task_get', { agent: 'pr-reviewer', task_id: taskId });
  assert.equal(task.ok, true, `task_get: ${JSON.stringify(task)}`);
  assert.equal(task.data.status, 'completed', 'task must be completed before review');

  // Record pass.
  const record = await call(client, 'validation_record', {
    agent: 'pr-reviewer',
    task_id: taskId,
    attempt_n: 1,
    verdict: 'pass',
    feedback: 'MCP available: yes\nLGTM — tests pass, no smells.',
    subagent_session_id: 'integration-test-session-pass',
  });
  assert.equal(record.ok, true, `validation_record: ${JSON.stringify(record)}`);

  // History reflects exactly one pass row.
  const history = await call(client, 'validation_history', {
    agent: 'pr-reviewer', task_id: taskId,
  });
  assert.equal(history.ok, true);
  const rows = Array.isArray(history.data) ? history.data : history.data.attempts ?? [];
  assert.equal(rows.length, 1, `expected 1 history row; got ${rows.length}`);
  assert.equal(rows[0].verdict, 'pass');
});

test('pr-reviewer — fail path: record fail → bro sees it in history', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  const taskId = await seedCompletedTask(client);

  const fail = await call(client, 'validation_record', {
    agent: 'pr-reviewer',
    task_id: taskId,
    attempt_n: 1,
    verdict: 'fail',
    feedback: 'MCP available: yes\nmissing test for edge case X',
    subagent_session_id: 'integration-test-session-fail',
  });
  assert.equal(fail.ok, true);

  // bro reads back (validation_history is read-any).
  const history = await call(client, 'validation_history', {
    agent: 'bro', task_id: taskId,
  });
  assert.equal(history.ok, true);
  const rows = Array.isArray(history.data) ? history.data : history.data.attempts ?? [];
  assert.equal(rows[0].verdict, 'fail');
  assert.match(rows[0].feedback, /missing test/);
});

test('pr-reviewer — multiple attempts accumulate in history (retry loop)', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  const taskId = await seedCompletedTask(client);

  // Three attempts: fail, fail, pass — typical retry sequence.
  for (let n = 1; n <= 2; n++) {
    const fail = await call(client, 'validation_record', {
      agent: 'pr-reviewer',
      task_id: taskId,
      attempt_n: n,
      verdict: 'fail',
      feedback: `MCP available: yes\nattempt ${n} — still broken`,
      subagent_session_id: `integration-test-session-retry-${n}`,
    });
    assert.equal(fail.ok, true);
  }
  const pass = await call(client, 'validation_record', {
    agent: 'pr-reviewer',
    task_id: taskId,
    attempt_n: 3,
    verdict: 'pass',
    feedback: 'MCP available: yes\nfinally green',
    subagent_session_id: 'integration-test-session-retry-3',
  });
  assert.equal(pass.ok, true);

  const history = await call(client, 'validation_history', {
    agent: 'pr-reviewer', task_id: taskId,
  });
  const rows = Array.isArray(history.data) ? history.data : history.data.attempts ?? [];
  assert.equal(rows.length, 3, `expected 3 history rows; got ${rows.length}`);
  assert.deepEqual(
    rows.map((r) => r.verdict),
    ['fail', 'fail', 'pass'],
    'verdicts must be in ascending-attempt order',
  );
});
