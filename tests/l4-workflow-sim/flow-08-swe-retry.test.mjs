// Flow 8 — SWE Retry / Escalation (FLOWS.md §8)
//
// Trajectory: swe completes → bro review_handoff → code-reviewer fails the
// commit, which reopens the task for rework (same branch, same worktree) →
// SWE commits again and completes → review_handoff → code-reviewer signs off
// (then bro_atomic_close) OR fails again → repeat up to 3 →
// at 3 fails, bro flips status to 'escalated' and surfaces to Human.
//
// Asserts: a FAIL moves the task to running in its existing worktree and
// writes a task_reopened audit row, validation_attempts is append-only with the
// newest verdict winning, each attempt is a separate row, and 'escalated' is a
// valid terminal status.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { startProjectClient, call, seedReviewerObservation, seedPassingVerificationRun, REVIEW_PROBES } from '../l3-integration/mcp/harness.mjs';

async function completeAndHandOff(client, dbPath, project, taskId, worktreePath, file) {
  const brief = await call(client, 'task_brief', { agent: 'swe', task_id: taskId });
  assert.equal(brief.ok, true, `task_brief: ${JSON.stringify(brief)}`);
  const sha = project.commitIn(worktreePath, file, `${file}\n`, `work ${file}`);
  const completed = await call(client, 'task_update_status', {
    agent: 'swe', task_id: taskId, status: 'completed', commit_sha: sha, report: { criteria: [{ id: 'SC1', status: 'met' }] },
  });
  assert.equal(completed.ok, true, `swe→completed: ${JSON.stringify(completed)}`);
  seedPassingVerificationRun(dbPath, taskId, sha);
  const handoff = await call(client, 'review_handoff', { agent: 'bro', task_id: taskId });
  assert.equal(handoff.ok, true, `review_handoff: ${JSON.stringify(handoff)}`);
  return sha;
}

async function setupHandedOffTask(client, dbPath, project, branch) {
  const issue = await call(client, 'issue_create', { agent: 'bro', objective: 'X', description: 'd', labels: ['Feature', 'Priority: Medium'] });
  const issueId = issue.data.id;
  const provisioned = await call(client, 'task_provision', {
    agent: 'bro', issue_id: issueId, branch_id: branch,
    decision_body: `Chosen approach for ${branch}: fix the bug at its source.`,
    task: {
      title: 't',
      description: 'd',
      spec_body: '## Success Criteria\n- SC1: bug fixed',
      files: ['work-1.txt', 'work-2.txt', 'work-3.txt'],
      verification: ['test -f work-1.txt'],
      repo: project.name,
    },
  });
  assert.equal(provisioned.ok, true, `task_provision: ${JSON.stringify(provisioned)}`);
  const taskId = provisioned.data.task_id;
  const worktreePath = provisioned.data.worktree_path;
  await completeAndHandOff(client, dbPath, project, taskId, worktreePath, 'work-1.txt');
  return { taskId, issueId, worktreePath };
}

async function recordFail(client, dbPath, taskId, attemptN, feedback, sessionId) {
  seedReviewerObservation(dbPath, taskId, attemptN);
  const fail = await call(client, 'validation_record', {
    agent: 'code-reviewer', task_id: taskId, attempt_n: attemptN, verdict: 'fail', mcp_available: true,
    feedback,
    findings: [{ probe_cmd: `test -f work-${attemptN + 1}.txt`, expected: 'exit 0', observed: 'exit 1' }],
    subagent_session_id: sessionId,
  });
  assert.equal(fail.ok, true, `attempt ${attemptN} fail: ${JSON.stringify(fail)}`);
  return fail;
}

async function reworkAfterFail(client, dbPath, project, { taskId, issueId, worktreePath }, fail, attemptN) {
  assert.equal(fail.data.reopened?.status, 'running', `the FAIL reopens the task: ${JSON.stringify(fail.data)}`);
  assert.equal(fail.data.reopened.from_status, 'completed');

  const running = await call(client, 'task_get', { agent: 'bro', task_id: taskId });
  assert.equal(running.data.status, 'running');
  assert.ok(existsSync(worktreePath), 'the existing worktree is kept for rework');

  const audit = await call(client, 'audit_list', { agent: 'bro', issue_id: issueId });
  const reopenRows = audit.data.filter(e => e.event_type === 'task_reopened');
  assert.equal(reopenRows.length, attemptN, 'one task_reopened audit row per rework');
  assert.match(JSON.stringify(reopenRows.at(-1)), /code-reviewer FAIL/);

  return completeAndHandOff(client, dbPath, project, taskId, worktreePath, `work-${attemptN + 1}.txt`);
}

test('Flow 8 — retry loop: fail reopens the task for rework in the same worktree, then pass; history preserves both attempts', async (t) => {
  const { client, close, dbPath, project } = await startProjectClient();
  t.after(async () => { await close(); });

  const task = await setupHandedOffTask(client, dbPath, project, 'fix/retry');
  const { taskId } = task;

  const fail = await recordFail(client, dbPath, taskId, 1, 'Attempt 1: still has the bug.', 'flow08-retry-session-1');

  const firstSha = project.git('rev-parse', 'refs/heads/fix/retry');
  const secondSha = await reworkAfterFail(client, dbPath, project, task, fail, 1);
  assert.notEqual(secondSha, firstSha, 'rework adds a second commit on the same branch');
  assert.equal(project.git('rev-parse', 'refs/heads/fix/retry'), secondSha);

  seedReviewerObservation(dbPath, taskId, 2);
  const pass = await call(client, 'validation_record', {
    agent: 'code-reviewer', task_id: taskId, attempt_n: 2, verdict: 'pass', mcp_available: true, probes: REVIEW_PROBES,
    feedback: 'Fixed; LGTM.',
    subagent_session_id: 'flow08-retry-session-2',
  });
  assert.equal(pass.ok, true, `attempt 2 pass: ${JSON.stringify(pass)}`);

  const closed = await call(client, 'bro_atomic_close', {
    agent: 'bro', task_id: taskId, commit_sha: secondSha,
    verification_summary: 'V1/V2/V3 verified; code-reviewer passed attempt 2.',
    waive_scope_gate: true, scope_waiver_reason: 'test fixture: scope not under test',
  });
  assert.equal(closed.ok, true, `bro_atomic_close: ${JSON.stringify(closed)}`);

  const closedTask = await call(client, 'task_get', { agent: 'bro', task_id: taskId });
  assert.equal(closedTask.data.status, 'closed');
  assert.equal(closedTask.data.commit_sha, secondSha);

  const history = await call(client, 'validation_history', { agent: 'bro', task_id: taskId });
  assert.equal(history.ok, true);
  assert.deepEqual(
    history.data.map(r => `${r.attempt_n}:${r.verdict}`),
    ['1:fail', '2:pass'],
  );
});

test('Flow 8 — a re-recorded attempt_n appends a row: latest verdict wins', async (t) => {
  const { client, close, dbPath, project } = await startProjectClient();
  t.after(async () => { await close(); });

  const { taskId } = await setupHandedOffTask(client, dbPath, project, 'fix/dup');

  // attempt 1: pass
  seedReviewerObservation(dbPath, taskId, 1);
  const first = await call(client, 'validation_record', {
    agent: 'code-reviewer', task_id: taskId, attempt_n: 1, verdict: 'pass', mcp_available: true, probes: REVIEW_PROBES, feedback: 'first',
    subagent_session_id: 'flow08-upsert-session-1',
  });
  assert.equal(first.ok, true, `attempt 1 pass: ${JSON.stringify(first)}`);

  // attempt 1 again with a different verdict: validation rows are append-only
  // (GH 2412), so the revision is stored under the next attempt_n and the
  // newest verdict is the one that gates the task.
  seedReviewerObservation(dbPath, taskId, 1);
  const revised = await call(client, 'validation_record', {
    agent: 'code-reviewer', task_id: taskId, attempt_n: 1, verdict: 'fail', mcp_available: true, feedback: 'second',
    findings: [{ probe_cmd: 'test -f work-2.txt', expected: 'exit 0', observed: 'exit 1' }],
    subagent_session_id: 'flow08-upsert-session-1-revised',
  });
  assert.equal(revised.ok, true, `the revised verdict must record: ${JSON.stringify(revised)}`);
  assert.equal(revised.data.reopened?.status, 'running', 'the newest verdict, a FAIL, reopens the passed task');

  const history = await call(client, 'validation_history', { agent: 'bro', task_id: taskId });
  assert.deepEqual(
    history.data.map(r => `${r.attempt_n}:${r.verdict}:${r.feedback}`),
    ['1:pass:first', '2:fail:second'],
    'the first verdict is kept and the revision appends under the next attempt_n',
  );
});

test('Flow 8 — bro escalates after 3 fails by flipping status to escalated', async (t) => {
  const { client, close, dbPath, project } = await startProjectClient();
  t.after(async () => { await close(); });

  const task = await setupHandedOffTask(client, dbPath, project, 'fix/esc');
  const { taskId, issueId } = task;

  for (let n = 1; n <= 3; n++) {
    const fail = await recordFail(client, dbPath, taskId, n, `Attempt ${n} still broken.`, `flow08-escalate-session-${n}`);
    if (n < 3) await reworkAfterFail(client, dbPath, project, task, fail, n);
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
