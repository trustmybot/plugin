// Flow 8 — SWE Retry / Escalation (FLOWS.md §8)
//
// Trajectory: pr-reviewer fails task → bro re-spawns SWE with feedback →
// SWE attempts again → pr-reviewer signs off OR fails again → repeat up to 3 →
// at 3 fails, bro flips status to 'escalated' and surfaces to Human.
//
// Asserts: validation_attempts UNIQUE(task_id, attempt_n) is enforced,
// each attempt is a separate row, and 'escalated' is a valid terminal status.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startClient, call } from '../mcp-integration/harness.mjs';

async function setupClosedTask(client, branch, sha) {
  await call(client, 'identity_set', { agent: 'bro', human_name: 'Test' });
  const issue = await call(client, 'issue_create', { agent: 'bro', objective: 'X', description: 'd' });
  const batch = await call(client, 'task_create_batch', {
    agent: 'bro', issue_id: issue.data.id,
    waive_scope_gate: true,
    waive_scope_gate_reason: 'simple-triage retry-test scaffolding; defaults applied for synthetic test',
    waive_branch_gate: true,
    waive_branch_gate_reason: 'workflow-sim test; branch gate not under test in this flow',
    tasks: [{ branch_id: branch, title: 't', description: 'd', success_criteria: 's', spec_body: '## body' }],
  });
  const taskId = batch.data[0].id;
  await call(client, 'task_update_status', {
    agent: 'swe', task_id: taskId, status: 'completed', commit_sha: sha,
  });
  await call(client, 'task_update_status', { agent: 'bro', task_id: taskId, status: 'closed' });
  return taskId;
}

test('Flow 8 — retry loop: 2 fails then a pass, history preserves all attempts', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  const taskId = await setupClosedTask(client, 'fix/retry', 'ddd4444444444444444444444444444444444444');

  for (let n = 1; n <= 2; n++) {
    const r = await call(client, 'validation_record', {
      agent: 'pr-reviewer', task_id: taskId, attempt_n: n, verdict: 'fail',
      feedback: `MCP available: yes\nAttempt ${n}: still has the bug.`,
      subagent_session_id: `flow08-retry-session-${n}`,
    });
    assert.equal(r.ok, true, `attempt ${n} fail: ${JSON.stringify(r)}`);
  }

  // attempt 3: pass
  const pass = await call(client, 'validation_record', {
    agent: 'pr-reviewer', task_id: taskId, attempt_n: 3, verdict: 'pass',
    feedback: 'MCP available: yes\nFixed; LGTM.',
    subagent_session_id: 'flow08-retry-session-3',
  });
  assert.equal(pass.ok, true);

  const history = await call(client, 'validation_history', { agent: 'bro', task_id: taskId });
  assert.equal(history.ok, true);
  assert.equal(history.data.length, 3);
  assert.deepEqual(
    history.data.map(r => `${r.attempt_n}:${r.verdict}`),
    ['1:fail', '2:fail', '3:pass'],
  );
});

test('Flow 8 — UNIQUE(task_id, attempt_n) yields upsert semantics: latest verdict wins', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  const taskId = await setupClosedTask(client, 'fix/dup', 'eee5555555555555555555555555555555555555');

  // attempt 1: pass
  await call(client, 'validation_record', {
    agent: 'pr-reviewer', task_id: taskId, attempt_n: 1, verdict: 'pass', feedback: 'MCP available: yes\nfirst',
    subagent_session_id: 'flow08-upsert-session-1',
  });

  // attempt 1 again with different verdict — upsert overwrites the row in place
  // (intentional: pr-reviewer can revise its own verdict on the same attempt
  // before the push happens). UNIQUE(task_id, attempt_n) is enforced via ON CONFLICT.
  const overwrite = await call(client, 'validation_record', {
    agent: 'pr-reviewer', task_id: taskId, attempt_n: 1, verdict: 'fail', feedback: 'MCP available: yes\nsecond',
    subagent_session_id: 'flow08-upsert-session-1-revised',
  });
  assert.equal(overwrite.ok, true, 'upsert must succeed (latest write wins)');

  const history = await call(client, 'validation_history', { agent: 'bro', task_id: taskId });
  assert.equal(history.data.length, 1, 'still ONE row for attempt_n=1 after upsert');
  assert.equal(history.data[0].verdict, 'fail', 'latest verdict wins');
  assert.equal(history.data[0].feedback, 'MCP available: yes\nsecond', 'latest feedback wins');
});

test('Flow 8 — bro escalates after 3 fails by flipping status to escalated', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  const taskId = await setupClosedTask(client, 'fix/esc', 'fff6666666666666666666666666666666666666');

  for (let n = 1; n <= 3; n++) {
    const r = await call(client, 'validation_record', {
      agent: 'pr-reviewer', task_id: taskId, attempt_n: n, verdict: 'fail',
      feedback: `MCP available: yes\nAttempt ${n} still broken.`,
      subagent_session_id: `flow08-escalate-session-${n}`,
    });
    assert.equal(r.ok, true);
  }

  // Bro records the escalation note
  const issue = await call(client, 'issue_get', { agent: 'bro', issue_id: 1 });
  await call(client, 'discussion_append', {
    agent: 'bro', issue_id: issue.data.id, author: 'bro', kind: 'note',
    body: 'Escalating: 3 attempts failed; surfacing to Human.',
  });

  // Bro flips status — 'escalated' is a valid terminal state per VALID_STATUSES
  const escalate = await call(client, 'task_update_status', {
    agent: 'bro', task_id: taskId, status: 'escalated',
  });
  assert.equal(escalate.ok, true, `escalate: ${JSON.stringify(escalate)}`);

  const finalTask = await call(client, 'task_get', { agent: 'bro', task_id: taskId });
  assert.equal(finalTask.data.status, 'escalated');
});
