// Flow 6 — Push Gate (FLOWS.md §6)
//
// Trajectory: bro provisions tasks, swe commits in each worktree, bro closes them
// without per-task pr-reviewer (Flow 2 behavior).
// At git-push time, the git-push-guard.sh hook scans for closed tasks lacking
// validation_attempts.verdict='pass' rows. When the human runs
// `@bro review before push`, bro spawns pr-reviewer per unsigned task.
// pr-reviewer signs off via validation_record. Re-trying the push then succeeds.
//
// This test simulates the full sequence at the MCP level (the hook itself is
// covered by tests/l3-integration/hooks/git-push-guard.test.sh).
//
// Asserts: pr-reviewer is the ONLY role allowed to write validation_record;
// the stored reviewer identity is the observed subagent, never bro or the
// task's swe; validation_history reflects each attempt; bro can read the verdict to know
// whether to retry SWE or unblock the push.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startProjectClient, call, seedReviewerObservation, seedPassingVerificationRun, sqliteRun } from '../l3-integration/mcp/harness.mjs';

async function provisionClosedTask(client, project, dbPath, issueId, branchId, sweAgentId) {
  const provisioned = await call(client, 'task_provision', {
    agent: 'bro', issue_id: issueId, branch_id: branchId,
    decision_body: `Chosen approach for ${branchId}: smallest change that satisfies the criteria.`,
    task: {
      title: branchId,
      description: 'd',
      spec_body: '## Success Criteria\n- change lands',
      files: ['change.txt'],
      verification: ['test -f change.txt'],
      repo: project.name,
    },
  });
  assert.equal(provisioned.ok, true, `task_provision ${branchId}: ${JSON.stringify(provisioned)}`);
  const taskId = provisioned.data.task_id;

  const brief = await call(client, 'task_brief', { agent: 'swe', task_id: taskId });
  assert.equal(brief.ok, true, `task_brief ${branchId}: ${JSON.stringify(brief)}`);
  sqliteRun(dbPath, `UPDATE agent_runs SET spawn_id = '${sweAgentId}' WHERE task_id = ${taskId} AND agent_type = 'swe'`);

  const sha = project.commitIn(provisioned.data.worktree_path, 'change.txt', `${branchId}\n`, `change ${branchId}`);
  const completed = await call(client, 'task_update_status', {
    agent: 'swe', task_id: taskId, status: 'completed', commit_sha: sha,
  });
  assert.equal(completed.ok, true, `swe→completed ${branchId}: ${JSON.stringify(completed)}`);
  seedPassingVerificationRun(dbPath, taskId, sha);
  const closed = await call(client, 'bro_atomic_close', {
    agent: 'bro', task_id: taskId, commit_sha: sha,
    verification_summary: 'V1/V2/V3 verified; closing pre-push.',
    waive_scope_gate: true, scope_waiver_reason: 'test fixture: scope not under test',
  });
  assert.equal(closed.ok, true, `bro_atomic_close ${branchId}: ${JSON.stringify(closed)}`);
  return taskId;
}

function assertIndependentReviewer(row, dbPath, taskId, reviewerAgentId) {
  assert.equal(row.agent, 'pr-reviewer');
  assert.equal(row.reviewer_agent_id, reviewerAgentId, 'reviewer identity comes from the observed subagent');
  assert.notEqual(row.reviewer_agent_id, 'bro');
  const sweRuns = sqliteRun(dbPath, `SELECT spawn_id FROM agent_runs WHERE task_id = ${taskId} AND agent_type = 'swe'`);
  assert.ok(sweRuns.length > 0, 'task has a swe run');
  for (const run of sweRuns) assert.notEqual(run.spawn_id, row.reviewer_agent_id, 'reviewer is not the task swe');
}

test('Flow 6 — push gate: bro closes → unsigned commits → pr-reviewer signs → push unblocked', async (t) => {
  const { client, close, dbPath, project } = await startProjectClient();
  t.after(async () => { await close(); });

  // Setup: 2 tasks to close and push
  const issue = await call(client, 'issue_create', {
    agent: 'bro', objective: 'Two things', description: 'd',
    labels: ['Feature', 'Priority: Medium'],
  });
  const issueId = issue.data.id;

  // Provision, brief, commit, complete and close both tasks (Flow 2 twice)
  const taskA = await provisionClosedTask(client, project, dbPath, issueId, 'feat/a', 'flow06-swe-agent-a');
  const taskB = await provisionClosedTask(client, project, dbPath, issueId, 'feat/b', 'flow06-swe-agent-b');

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
  seedReviewerObservation(dbPath, taskA, 1, { agentId: 'flow06-reviewer-a' });
  const recordA = await call(client, 'validation_record', {
    agent: 'pr-reviewer', task_id: taskA, attempt_n: 1, verdict: 'pass', mcp_available: true,
    feedback: 'Gate 2 review: tests pass; diff matches spec; LGTM.',
    subagent_session_id: 'flow06-session-A',
  });
  assert.equal(recordA.ok, true, `pr-reviewer→A: ${JSON.stringify(recordA)}`);

  // 4. pr-reviewer signs off task B
  seedReviewerObservation(dbPath, taskB, 1, { agentId: 'flow06-reviewer-b' });
  const recordB = await call(client, 'validation_record', {
    agent: 'pr-reviewer', task_id: taskB, attempt_n: 1, verdict: 'pass', mcp_available: true,
    feedback: 'Gate 2 review: clean.',
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
  assertIndependentReviewer(histA2.data[0], dbPath, taskA, 'flow06-reviewer-a');
  assertIndependentReviewer(histB2.data[0], dbPath, taskB, 'flow06-reviewer-b');

  // 6. After this, the push hook would see all commits signed and ALLOW.
  // (The hook itself is covered by tests/l3-integration/hooks/git-push-guard.test.sh.)
});

test('Flow 6 fail-path — pr-reviewer FAIL verdict triggers retry signal in next attempt_n', async (t) => {
  const { client, close, dbPath, project } = await startProjectClient();
  t.after(async () => { await close(); });

  const issue = await call(client, 'issue_create', { agent: 'bro', objective: 'X', description: 'd', labels: ['Feature', 'Priority: Medium'] });
  const issueId = issue.data.id;
  const taskId = await provisionClosedTask(client, project, dbPath, issueId, 'fix/x', 'flow06-swe-agent-x');

  // attempt 1: FAIL
  seedReviewerObservation(dbPath, taskId, 1, { agentId: 'flow06-reviewer-x1' });
  const fail1 = await call(client, 'validation_record', {
    agent: 'pr-reviewer', task_id: taskId, attempt_n: 1, verdict: 'fail', mcp_available: true,
    feedback: 'Tests reference removed module; please fix.',
    findings: [{ probe_cmd: 'npm test', expected: 'exit 0', observed: 'Cannot find module ./removed' }],
    subagent_session_id: 'flow06-fail-session-1',
  });
  assert.equal(fail1.ok, true);

  // attempt 2: pass after fix
  seedReviewerObservation(dbPath, taskId, 2, { agentId: 'flow06-reviewer-x2' });
  const pass2 = await call(client, 'validation_record', {
    agent: 'pr-reviewer', task_id: taskId, attempt_n: 2, verdict: 'pass', mcp_available: true,
    feedback: 'Fixed; LGTM.',
    subagent_session_id: 'flow06-pass-session-2',
  });
  assert.equal(pass2.ok, true);

  // Validation history shows both attempts in order
  const history = await call(client, 'validation_history', { agent: 'bro', task_id: taskId });
  assert.equal(history.data.length, 2);
  assert.equal(history.data[0].verdict, 'fail');
  assert.equal(history.data[1].verdict, 'pass');
  assertIndependentReviewer(history.data[0], dbPath, taskId, 'flow06-reviewer-x1');
  assertIndependentReviewer(history.data[1], dbPath, taskId, 'flow06-reviewer-x2');
});
