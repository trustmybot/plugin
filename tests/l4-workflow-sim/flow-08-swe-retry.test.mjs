// Flow 8 — SWE Retry / Escalation (FLOWS.md §8)
//
// Trajectory: pr-reviewer fails task → bro reworks it with task_reopen (same
// branch, same worktree) → SWE commits again and completes → bro_atomic_close →
// pr-reviewer signs off OR fails again → repeat up to 3 →
// at 3 fails, bro flips status to 'escalated' and surfaces to Human.
//
// Asserts: task_reopen moves the task to running in its existing worktree and
// writes a task_reopened audit row, validation_attempts UNIQUE(task_id, attempt_n)
// is enforced, each attempt is a separate row, and 'escalated' is a valid terminal status.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startProjectClient, call, seedReviewerObservation } from '../l3-integration/mcp/harness.mjs';

async function completeAndClose(client, project, taskId, worktreePath, file) {
  const brief = await call(client, 'task_brief', { agent: 'swe', task_id: taskId });
  assert.equal(brief.ok, true, `task_brief: ${JSON.stringify(brief)}`);
  const sha = project.commitIn(worktreePath, file, `${file}\n`, `work ${file}`);
  const completed = await call(client, 'task_update_status', {
    agent: 'swe', task_id: taskId, status: 'completed', commit_sha: sha,
  });
  assert.equal(completed.ok, true, `swe→completed: ${JSON.stringify(completed)}`);
  const closed = await call(client, 'bro_atomic_close', {
    agent: 'bro', task_id: taskId, commit_sha: sha,
    verification_summary: 'V1/V2/V3 verified; closing.',
    waive_scope_gate: true, scope_waiver_reason: 'test fixture: scope not under test',
  });
  assert.equal(closed.ok, true, `bro_atomic_close: ${JSON.stringify(closed)}`);
  return sha;
}

async function setupClosedTask(client, project, branch) {
  const issue = await call(client, 'issue_create', { agent: 'bro', objective: 'X', description: 'd', labels: ['Feature', 'Priority: Medium'] });
  const issueId = issue.data.id;
  const provisioned = await call(client, 'task_provision', {
    agent: 'bro', issue_id: issueId, branch_id: branch,
    decision_body: `Chosen approach for ${branch}: fix the bug at its source.`,
    task: {
      title: 't',
      description: 'd',
      spec_body: '## Success Criteria\n- bug fixed',
      files: ['work-1.txt', 'work-2.txt', 'work-3.txt'],
      verification: ['test -f work-1.txt'],
      repo: project.name,
    },
  });
  assert.equal(provisioned.ok, true, `task_provision: ${JSON.stringify(provisioned)}`);
  const taskId = provisioned.data.task_id;
  const worktreePath = provisioned.data.worktree_path;
  await completeAndClose(client, project, taskId, worktreePath, 'work-1.txt');
  return { taskId, issueId, worktreePath };
}

async function reworkAndClose(client, project, { taskId, issueId, worktreePath }, attemptN, reason) {
  const reopened = await call(client, 'task_reopen', { agent: 'bro', task_id: taskId, reason });
  assert.equal(reopened.ok, true, `task_reopen: ${JSON.stringify(reopened)}`);
  assert.equal(reopened.data.status, 'running');
  assert.equal(reopened.data.from_status, 'closed');
  assert.equal(reopened.data.worktree_path, worktreePath, 'rework reuses the same worktree path');
  assert.equal(reopened.data.worktree_recreated, false, 'the existing worktree is reused, not recreated');

  const running = await call(client, 'task_get', { agent: 'bro', task_id: taskId });
  assert.equal(running.data.status, 'running');

  const audit = await call(client, 'audit_list', { agent: 'bro', issue_id: issueId });
  const reopenRows = audit.data.filter(e => e.event_type === 'task_reopened');
  assert.equal(reopenRows.length, attemptN, 'one task_reopened audit row per rework');
  assert.match(JSON.stringify(reopenRows.at(-1)), new RegExp(reason));

  return completeAndClose(client, project, taskId, worktreePath, `work-${attemptN + 1}.txt`);
}

test('Flow 8 — retry loop: fail, task_reopen rework in the same worktree, then pass; history preserves both attempts', async (t) => {
  const { client, close, dbPath, project } = await startProjectClient();
  t.after(async () => { await close(); });

  const task = await setupClosedTask(client, project, 'fix/retry');
  const { taskId } = task;

  seedReviewerObservation(dbPath, taskId, 1);
  const fail = await call(client, 'validation_record', {
    agent: 'pr-reviewer', task_id: taskId, attempt_n: 1, verdict: 'fail', mcp_available: true,
    feedback: 'Attempt 1: still has the bug.',
    subagent_session_id: 'flow08-retry-session-1',
  });
  assert.equal(fail.ok, true, `attempt 1 fail: ${JSON.stringify(fail)}`);

  const firstSha = project.git('rev-parse', 'refs/heads/fix/retry');
  const secondSha = await reworkAndClose(client, project, task, 1, 'reviewer found the bug still present');
  assert.notEqual(secondSha, firstSha, 'rework adds a second commit on the same branch');
  assert.equal(project.git('rev-parse', 'refs/heads/fix/retry'), secondSha);

  const closedAgain = await call(client, 'task_get', { agent: 'bro', task_id: taskId });
  assert.equal(closedAgain.data.status, 'closed');
  assert.equal(closedAgain.data.commit_sha, secondSha);

  seedReviewerObservation(dbPath, taskId, 2);
  const pass = await call(client, 'validation_record', {
    agent: 'pr-reviewer', task_id: taskId, attempt_n: 2, verdict: 'pass', mcp_available: true,
    feedback: 'Fixed; LGTM.',
    subagent_session_id: 'flow08-retry-session-2',
  });
  assert.equal(pass.ok, true, `attempt 2 pass: ${JSON.stringify(pass)}`);

  const history = await call(client, 'validation_history', { agent: 'bro', task_id: taskId });
  assert.equal(history.ok, true);
  assert.deepEqual(
    history.data.map(r => `${r.attempt_n}:${r.verdict}`),
    ['1:fail', '2:pass'],
  );
});

test('Flow 8 — UNIQUE(task_id, attempt_n) yields upsert semantics: latest verdict wins', async (t) => {
  const { client, close, dbPath, project } = await startProjectClient();
  t.after(async () => { await close(); });

  const { taskId } = await setupClosedTask(client, project, 'fix/dup');

  // attempt 1: pass
  seedReviewerObservation(dbPath, taskId, 1);
  await call(client, 'validation_record', {
    agent: 'pr-reviewer', task_id: taskId, attempt_n: 1, verdict: 'pass', mcp_available: true, feedback: 'first',
    subagent_session_id: 'flow08-upsert-session-1',
  });

  // attempt 1 again with different verdict — upsert overwrites the row in place
  // (intentional: pr-reviewer can revise its own verdict on the same attempt
  // before the push happens). UNIQUE(task_id, attempt_n) is enforced via ON CONFLICT.
  seedReviewerObservation(dbPath, taskId, 1);
  const overwrite = await call(client, 'validation_record', {
    agent: 'pr-reviewer', task_id: taskId, attempt_n: 1, verdict: 'fail', mcp_available: true, feedback: 'second',
    subagent_session_id: 'flow08-upsert-session-1-revised',
  });
  assert.equal(overwrite.ok, true, 'upsert must succeed (latest write wins)');

  const history = await call(client, 'validation_history', { agent: 'bro', task_id: taskId });
  assert.equal(history.data.length, 1, 'still ONE row for attempt_n=1 after upsert');
  assert.equal(history.data[0].verdict, 'fail', 'latest verdict wins');
  assert.equal(history.data[0].feedback, 'second', 'latest feedback wins');
});

test('Flow 8 — bro escalates after 3 fails by flipping status to escalated', async (t) => {
  const { client, close, dbPath, project } = await startProjectClient();
  t.after(async () => { await close(); });

  const task = await setupClosedTask(client, project, 'fix/esc');
  const { taskId, issueId } = task;

  for (let n = 1; n <= 3; n++) {
    seedReviewerObservation(dbPath, taskId, n);
    const r = await call(client, 'validation_record', {
      agent: 'pr-reviewer', task_id: taskId, attempt_n: n, verdict: 'fail', mcp_available: true,
      feedback: `Attempt ${n} still broken.`,
      subagent_session_id: `flow08-escalate-session-${n}`,
    });
    assert.equal(r.ok, true);
    if (n < 3) await reworkAndClose(client, project, task, n, `attempt ${n} still broken`);
  }

  // Bro records the escalation note (uses the issueId returned from setup —
  // not a hardcoded 1, since schema-seeded system issue at id=-1 bumps
  // AUTOINCREMENT past the legacy assumption).
  await call(client, 'discussion_append', {
    agent: 'bro', issue_id: issueId, author: 'bro', kind: 'note',
    body: 'Escalating: 3 attempts failed; surfacing to Human.',
  });

  // Bro flips status — 'escalated' is a valid terminal state per VALID_STATUSES
  const escalate = await call(client, 'task_update_status', {
    agent: 'bro', task_id: taskId, status: 'escalated',
  });
  assert.equal(escalate.ok, true, `escalate: ${JSON.stringify(escalate)}`);

  const finalTask = await call(client, 'task_get', { agent: 'bro', task_id: taskId });
  assert.equal(finalTask.data.status, 'escalated');

  const history = await call(client, 'validation_history', { agent: 'bro', task_id: taskId });
  assert.equal(history.data.length, 3, 'all three failed attempts are preserved');
});
