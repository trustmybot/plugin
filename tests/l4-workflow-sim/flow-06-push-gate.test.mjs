// Flow 6 — Push Gate (FLOWS.md §6)
//
// Trajectory: bro closes a task without per-task pr-reviewer (Flow 2 behavior).
// At git-push time, the git-push-guard.sh hook scans for closed tasks lacking
// validation_attempts.verdict='pass' rows. When the human runs
// `@bro review before push`, bro spawns pr-reviewer per unsigned task.
// pr-reviewer signs off via validation_record. Re-trying the push then succeeds.
//
// This test simulates the full sequence at the MCP level (the hook itself is
// covered by tests/l3-integration/hooks/git-push-guard.test.sh).
//
// Asserts: pr-reviewer is the ONLY role allowed to write validation_record;
// validation_history reflects each attempt; bro can read the verdict to know
// whether to retry SWE or unblock the push.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startClient, call } from '../l3-integration/mcp/harness.mjs';

test('Flow 6 — push gate: bro closes → unsigned commits → pr-reviewer signs → push unblocked', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  // Setup: 2 closed tasks ready to push (simulating Flow 2 already ran twice)
  const issue = await call(client, 'issue_create', {
    agent: 'bro', objective: 'Two things', description: 'd',
    labels: ['Feature', 'Priority: Medium'],
  });
  const issueId = issue.data.id;

  const batch = await call(client, 'task_create_batch', {
    agent: 'bro', issue_id: issueId,
    waive_scope_gate: true,
    waive_scope_gate_reason: 'simple-triage batch of two trivial tasks; no architecture impact',
    waive_branch_gate: true,
    waive_branch_gate_reason: 'workflow-sim test; branch gate not under test in this flow',
    waive_intent_gate: true,
    waive_intent_gate_reason: 'workflow-sim test; intent gate not under test in this flow',
    waive_decision_gate: true,
    waive_decision_gate_reason: 'workflow-sim test; triage gate not under test in this flow',
    tasks: [
      { branch_id: 'feat/a', title: 'A', description: 'd', spec_body: '## Success Criteria\n- A works' },
      { branch_id: 'feat/b', title: 'B', description: 'd', spec_body: '## Success Criteria\n- B works' },
    ],
  });
  assert.equal(batch.ok, true, JSON.stringify(batch));
  const created = Array.isArray(batch.data) ? batch.data : batch.data.tasks;
  const taskA = created[0].id;
  const taskB = created[1].id;

  // SWE completes both, bro closes both
  for (const [id, sha] of [[taskA, 'aaa1111111111111111111111111111111111111'], [taskB, 'bbb2222222222222222222222222222222222222']]) {
    await call(client, 'task_update_status', {
      agent: 'swe', task_id: id, status: 'completed', commit_sha: sha,
    });
    await call(client, 'task_update_status', {
      agent: 'bro', task_id: id, status: 'closed',
    });
  }

  // 1. Pre-push: NEITHER task has a passing validation row.
  // The git-push-guard hook (covered by tests/l3-integration/hooks/) would block here.
  const histA1 = await call(client, 'validation_history', { agent: 'bro', task_id: taskA });
  const histB1 = await call(client, 'validation_history', { agent: 'bro', task_id: taskB });
  assert.equal(histA1.data.length, 0);
  assert.equal(histB1.data.length, 0);

  // 2. Human runs `@bro review before push`. Bro spawns pr-reviewer per unsigned
  // task (parallel in real life; sequential here for asserting the contract).
  // pr-reviewer is the ONLY role allowed to write validation_record.
  const recordWrongRole = await call(client, 'validation_record', {
    agent: 'bro', task_id: taskA, attempt_n: 1, verdict: 'pass', feedback: 'lgtm',
  });
  assert.equal(recordWrongRole.ok, false,
    'bro must NOT be allowed to write validation_record; only pr-reviewer.');
  assert.match(JSON.stringify(recordWrongRole.error), /forbidden/);

  // 3. pr-reviewer signs off task A
  const recordA = await call(client, 'validation_record', {
    agent: 'pr-reviewer', task_id: taskA, attempt_n: 1, verdict: 'pass',
    feedback: 'MCP available: yes\nGate 2 review: tests pass; diff matches spec; LGTM.',
    subagent_session_id: 'flow06-session-A',
  });
  assert.equal(recordA.ok, true, `pr-reviewer→A: ${JSON.stringify(recordA)}`);

  // 4. pr-reviewer signs off task B
  const recordB = await call(client, 'validation_record', {
    agent: 'pr-reviewer', task_id: taskB, attempt_n: 1, verdict: 'pass',
    feedback: 'MCP available: yes\nGate 2 review: clean.',
    subagent_session_id: 'flow06-session-B',
  });
  assert.equal(recordB.ok, true);

  // 5. Bro reads back to confirm both signed
  const histA2 = await call(client, 'validation_history', { agent: 'bro', task_id: taskA });
  const histB2 = await call(client, 'validation_history', { agent: 'bro', task_id: taskB });
  assert.equal(histA2.data.length, 1);
  assert.equal(histA2.data[0].verdict, 'pass');
  assert.equal(histB2.data.length, 1);
  assert.equal(histB2.data[0].verdict, 'pass');

  // 6. After this, the push hook would see all commits signed and ALLOW.
  // (The hook itself is covered by tests/l3-integration/hooks/git-push-guard.test.sh.)
});

test('Flow 6 fail-path — pr-reviewer FAIL verdict triggers retry signal in next attempt_n', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  const issue = await call(client, 'issue_create', { agent: 'bro', objective: 'X', description: 'd', labels: ['Feature', 'Priority: Medium'] });
  const issueId = issue.data.id;
  const batch = await call(client, 'task_create_batch', {
    agent: 'bro', issue_id: issueId,
    waive_scope_gate: true,
    waive_scope_gate_reason: 'simple-triage one trivial fix-task; defaults applied',
    waive_branch_gate: true,
    waive_branch_gate_reason: 'workflow-sim test; branch gate not under test in this flow',
    waive_intent_gate: true,
    waive_intent_gate_reason: 'workflow-sim test; intent gate not under test in this flow',
    waive_decision_gate: true,
    waive_decision_gate_reason: 'workflow-sim test; triage gate not under test in this flow',
    tasks: [{ branch_id: 'fix/x', title: 't', description: 'd', spec_body: '## Success Criteria\n- x fixed' }],
  });
  const taskId = Array.isArray(batch.data) ? batch.data[0]?.id : batch.data.tasks?.[0]?.id;

  await call(client, 'task_update_status', {
    agent: 'swe', task_id: taskId, status: 'completed',
    commit_sha: 'ccc3333333333333333333333333333333333333',
  });
  await call(client, 'task_update_status', { agent: 'bro', task_id: taskId, status: 'closed' });

  // attempt 1: FAIL
  const fail1 = await call(client, 'validation_record', {
    agent: 'pr-reviewer', task_id: taskId, attempt_n: 1, verdict: 'fail',
    feedback: 'MCP available: yes\nTests reference removed module; please fix.',
    subagent_session_id: 'flow06-fail-session-1',
  });
  assert.equal(fail1.ok, true);

  // attempt 2: pass after fix
  const pass2 = await call(client, 'validation_record', {
    agent: 'pr-reviewer', task_id: taskId, attempt_n: 2, verdict: 'pass',
    feedback: 'MCP available: yes\nFixed; LGTM.',
    subagent_session_id: 'flow06-pass-session-2',
  });
  assert.equal(pass2.ok, true);

  // Validation history shows both attempts in order
  const history = await call(client, 'validation_history', { agent: 'bro', task_id: taskId });
  assert.equal(history.data.length, 2);
  assert.equal(history.data[0].verdict, 'fail');
  assert.equal(history.data[1].verdict, 'pass');
});
