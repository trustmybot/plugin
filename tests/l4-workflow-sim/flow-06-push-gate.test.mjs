// Flow 6 — Push Gate (FLOWS.md §6)
//
// Trajectory: bro provisions tasks, swe commits in each worktree and completes,
// bro hands each commit to code-reviewer with review_handoff. bro_atomic_close
// refuses an unsigned commit (review_pass_missing, GH 2939), so a task closes
// only after code-reviewer signs off via validation_record; the git-push-guard
// hook then sees every closed task signed and lets the push through.
//
// This test simulates the full sequence at the MCP level (the hook itself is
// covered by mcp/trajectory-server/src/test/git-push-guard-l3.test.ts).
//
// Asserts: code-reviewer is the ONLY role allowed to write validation_record;
// the stored reviewer identity is the observed subagent, never bro or the
// task's swe; validation_history reflects each attempt; bro can read the verdict to know
// whether to retry SWE or close and push.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startProjectClient, call, seedReviewerObservation, seedPassingVerificationRun, sqliteRun, REVIEW_PROBES } from '../l3-integration/mcp/harness.mjs';

async function completeAndHandOff(client, project, dbPath, taskId, worktreePath, branchId, content) {
  const sha = project.commitIn(worktreePath, 'change.txt', content, `change ${branchId}`);
  const completed = await call(client, 'task_update_status', {
    agent: 'swe', task_id: taskId, status: 'completed', commit_sha: sha, report: { criteria: [{ id: 'SC1', status: 'met' }] },
  });
  assert.equal(completed.ok, true, `swe→completed ${branchId}: ${JSON.stringify(completed)}`);
  seedPassingVerificationRun(dbPath, taskId, sha);
  const handoff = await call(client, 'review_handoff', { agent: 'bro', task_id: taskId });
  assert.equal(handoff.ok, true, `review_handoff ${branchId}: ${JSON.stringify(handoff)}`);
  return sha;
}

async function provisionHandedOffTask(client, project, dbPath, issueId, branchId, sweAgentId) {
  const provisioned = await call(client, 'task_provision', {
    agent: 'bro', issue_id: issueId, branch_id: branchId,
    decision_body: `Chosen approach for ${branchId}: smallest change that satisfies the criteria.`,
    task: {
      title: branchId,
      description: 'd',
      spec_body: '## Success Criteria\n- SC1: change lands',
      files: ['change.txt'],
      verification: ['test -f change.txt'],
      repo: project.name,
    },
  });
  assert.equal(provisioned.ok, true, `task_provision ${branchId}: ${JSON.stringify(provisioned)}`);
  const taskId = provisioned.data.task_id;
  const worktreePath = provisioned.data.worktree_path;

  const brief = await call(client, 'task_brief', { agent: 'swe', task_id: taskId });
  assert.equal(brief.ok, true, `task_brief ${branchId}: ${JSON.stringify(brief)}`);
  sqliteRun(dbPath, `UPDATE agent_runs SET spawn_id = '${sweAgentId}' WHERE task_id = ${taskId} AND agent_type = 'swe'`);

  const sha = await completeAndHandOff(client, project, dbPath, taskId, worktreePath, branchId, `${branchId}\n`);
  return { taskId, worktreePath, sha };
}

function closeArgs(taskId, sha) {
  return {
    agent: 'bro', task_id: taskId, commit_sha: sha,
    verification_summary: 'V1/V2/V3 verified; code-reviewer passed.',
    waive_scope_gate: true, scope_waiver_reason: 'test fixture: scope not under test',
  };
}

async function closeTask(client, taskId, sha) {
  const closed = await call(client, 'bro_atomic_close', closeArgs(taskId, sha));
  assert.equal(closed.ok, true, `bro_atomic_close task ${taskId}: ${JSON.stringify(closed)}`);
  const task = await call(client, 'task_get', { agent: 'bro', task_id: taskId });
  assert.equal(task.data.status, 'closed');
}

function assertIndependentReviewer(row, dbPath, taskId, reviewerAgentId) {
  assert.equal(row.agent, 'code-reviewer');
  assert.equal(row.reviewer_agent_id, reviewerAgentId, 'reviewer identity comes from the observed subagent');
  assert.notEqual(row.reviewer_agent_id, 'bro');
  const sweRuns = sqliteRun(dbPath, `SELECT spawn_id FROM agent_runs WHERE task_id = ${taskId} AND agent_type = 'swe'`);
  assert.ok(sweRuns.length > 0, 'task has a swe run');
  for (const run of sweRuns) assert.notEqual(run.spawn_id, row.reviewer_agent_id, 'reviewer is not the task swe');
}

test('Flow 6 — push gate: unsigned commits refuse the close → code-reviewer signs → bro closes', async (t) => {
  const { client, close, dbPath, project } = await startProjectClient();
  t.after(async () => { await close(); });

  // Setup: 2 tasks to review, close and push
  const issue = await call(client, 'issue_create', {
    agent: 'bro', objective: 'Two things', description: 'd',
    labels: ['Feature', 'Priority: Medium'],
  });
  const issueId = issue.data.id;

  // Provision, brief, commit, complete and hand off both tasks
  const a = await provisionHandedOffTask(client, project, dbPath, issueId, 'feat/a', 'flow06-swe-agent-a');
  const b = await provisionHandedOffTask(client, project, dbPath, issueId, 'feat/b', 'flow06-swe-agent-b');

  // 1. Pre-review: NEITHER task has a passing validation row, so neither closes.
  const histA1 = await call(client, 'validation_history', { agent: 'bro', task_id: a.taskId });
  const histB1 = await call(client, 'validation_history', { agent: 'bro', task_id: b.taskId });
  assert.equal(histA1.data.length, 0);
  assert.equal(histB1.data.length, 0);
  for (const { taskId, sha } of [a, b]) {
    const unsigned = await call(client, 'bro_atomic_close', closeArgs(taskId, sha));
    assert.equal(unsigned.ok, false, `task ${taskId} must not close unsigned`);
    assert.match(String(unsigned.error?.error), /^review_pass_missing/);
  }

  // 2. Bro spawns code-reviewer per handed-off task (parallel in real life;
  // sequential here for asserting the contract).
  // code-reviewer is the ONLY role allowed to write validation_record.
  const recordWrongRole = await call(client, 'validation_record', {
    agent: 'bro', task_id: a.taskId, attempt_n: 1, verdict: 'pass', feedback: 'lgtm',
  });
  assert.equal(recordWrongRole.ok, false,
    'bro must NOT be allowed to write validation_record; only code-reviewer.');
  assert.match(JSON.stringify(recordWrongRole.error), /forbidden/);

  // 3. code-reviewer signs off task A
  seedReviewerObservation(dbPath, a.taskId, 1, { agentId: 'flow06-reviewer-a' });
  const recordA = await call(client, 'validation_record', {
    agent: 'code-reviewer', task_id: a.taskId, attempt_n: 1, verdict: 'pass', mcp_available: true, probes: REVIEW_PROBES,
    feedback: 'Gate 2 review: tests pass; diff matches spec; LGTM.',
    subagent_session_id: 'flow06-session-A',
  });
  assert.equal(recordA.ok, true, `code-reviewer→A: ${JSON.stringify(recordA)}`);

  // 4. code-reviewer signs off task B
  seedReviewerObservation(dbPath, b.taskId, 1, { agentId: 'flow06-reviewer-b' });
  const recordB = await call(client, 'validation_record', {
    agent: 'code-reviewer', task_id: b.taskId, attempt_n: 1, verdict: 'pass', mcp_available: true, probes: REVIEW_PROBES,
    feedback: 'Gate 2 review: clean.',
    subagent_session_id: 'flow06-session-B',
  });
  assert.equal(recordB.ok, true);

  // 5. Bro reads back to confirm both signed
  const histA2 = await call(client, 'validation_history', { agent: 'bro', task_id: a.taskId });
  const histB2 = await call(client, 'validation_history', { agent: 'bro', task_id: b.taskId });
  assert.equal(histA2.data.length, 1);
  assert.equal(histA2.data[0].verdict, 'pass');
  assert.equal(histB2.data.length, 1);
  assert.equal(histB2.data[0].verdict, 'pass');
  assertIndependentReviewer(histA2.data[0], dbPath, a.taskId, 'flow06-reviewer-a');
  assertIndependentReviewer(histB2.data[0], dbPath, b.taskId, 'flow06-reviewer-b');

  // 6. Signed, both close; the push hook then sees all commits signed and ALLOWS.
  // (The hook itself is covered by mcp/trajectory-server/src/test/git-push-guard-l3.test.ts.)
  await closeTask(client, a.taskId, a.sha);
  await closeTask(client, b.taskId, b.sha);
});

test('Flow 6 fail-path — code-reviewer FAIL verdict triggers retry signal in next attempt_n', async (t) => {
  const { client, close, dbPath, project } = await startProjectClient();
  t.after(async () => { await close(); });

  const issue = await call(client, 'issue_create', { agent: 'bro', objective: 'X', description: 'd', labels: ['Feature', 'Priority: Medium'] });
  const issueId = issue.data.id;
  const { taskId, worktreePath } = await provisionHandedOffTask(client, project, dbPath, issueId, 'fix/x', 'flow06-swe-agent-x');

  // attempt 1: FAIL — the retry signal reopens the task for swe rework
  seedReviewerObservation(dbPath, taskId, 1, { agentId: 'flow06-reviewer-x1' });
  const fail1 = await call(client, 'validation_record', {
    agent: 'code-reviewer', task_id: taskId, attempt_n: 1, verdict: 'fail', mcp_available: true,
    feedback: 'Tests reference removed module; please fix.',
    findings: [{ probe_cmd: 'npm test', expected: 'exit 0', observed: 'Cannot find module ./removed' }],
    subagent_session_id: 'flow06-fail-session-1',
  });
  assert.equal(fail1.ok, true, `attempt 1 fail: ${JSON.stringify(fail1)}`);
  assert.equal(fail1.data.reopened?.status, 'running', `a FAIL reopens the task for rework: ${JSON.stringify(fail1)}`);

  // swe fixes it and bro hands the new commit off again
  const fixedSha = await completeAndHandOff(client, project, dbPath, taskId, worktreePath, 'fix/x', 'fix/x fixed\n');

  // attempt 2: pass after fix
  seedReviewerObservation(dbPath, taskId, 2, { agentId: 'flow06-reviewer-x2' });
  const pass2 = await call(client, 'validation_record', {
    agent: 'code-reviewer', task_id: taskId, attempt_n: 2, verdict: 'pass', mcp_available: true, probes: REVIEW_PROBES,
    feedback: 'Fixed; LGTM.',
    subagent_session_id: 'flow06-pass-session-2',
  });
  assert.equal(pass2.ok, true, `attempt 2 pass: ${JSON.stringify(pass2)}`);

  // Validation history shows both attempts in order
  const history = await call(client, 'validation_history', { agent: 'bro', task_id: taskId });
  assert.equal(history.data.length, 2);
  assert.equal(history.data[0].verdict, 'fail');
  assert.equal(history.data[1].verdict, 'pass');
  assertIndependentReviewer(history.data[0], dbPath, taskId, 'flow06-reviewer-x1');
  assertIndependentReviewer(history.data[1], dbPath, taskId, 'flow06-reviewer-x2');

  await closeTask(client, taskId, fixedSha);
});
