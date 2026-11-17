/**
 * The issue closes at merge, not at task close (GH 3234, decision #245).
 *
 * The replay walks the 40 -> 49 -> 50 sequence that stranded issue 43: the
 * last task closes, integrate exits 5 and leaves an uncarried commit, the task
 * is reopened, escalated and retried, and every step keeps the issue open, so
 * rework always has a task to reopen. The revert guard covers an issue that
 * was closed anyway (issue_close, a merge): task_reopen, task_retry and a
 * review FAIL each reopen it in their own transaction with one issue_reopened
 * row naming the cause.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AUDIT_EVENT_TYPES } from '../audit-events.js';
import type { TrajectoryDB } from '../db.js';
import { compositeTools } from '../tools/composites.js';
import { validationTools } from '../tools/validation.js';
import { TEST_PROBES, pinScanEnv, seedReviewerObservation, tempDB, type ScanEnvPin } from './helpers.js';

type Raw = { content: Array<{ type: string; text: string }>; isError?: boolean };
type Handlers = Record<string, (args: Record<string, unknown>) => Promise<unknown>>;

const DB_PATH = '/tmp/.claude/tmb/trajectory.db';
const parse = (r: Raw): Record<string, unknown> => JSON.parse(r.content[0].text) as Record<string, unknown>;

async function call(handlers: Handlers, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = (await handlers[name](args)) as Raw;
  assert.ok(!r.isError, `${name}: ${r.content[0]?.text}`);
  return parse(r);
}

let pin: ScanEnvPin;
before(() => {
  pin = pinScanEnv();
});
after(() => pin.restore());

function seedIssue(db: TrajectoryDB, status: 'open' | 'closed', closedAt: string | null = null): number {
  db.run(
    `INSERT INTO issues (objective, status, closed_at, created_at, updated_at) VALUES ('rework', ?, ?, datetime('now'), datetime('now'))`,
    [status, closedAt],
  );
  return db.get<{ id: number }>('SELECT MAX(id) AS id FROM issues')!.id;
}

function seedTask(db: TrajectoryDB, issueId: number, branch: string, status: string, commitSha: string | null = null): number {
  db.run(
    `INSERT INTO tasks (issue_id, branch_id, parent_branch_id, description, status, spec_body, effort, commit_sha, created_at, updated_at)
     VALUES (?, ?, 'dev', 'd', ?, 'spec', 'medium', ?, datetime('now'), datetime('now'))`,
    [issueId, branch, status, commitSha],
  );
  return db.get<{ id: number }>('SELECT MAX(id) AS id FROM tasks')!.id;
}

// Spread: node:sqlite rows have a null prototype, which deepStrictEqual rejects.
const issueOf = (db: TrajectoryDB, issueId: number) => ({
  ...db.get<{ status: string; closed_at: string | null }>('SELECT status, closed_at FROM issues WHERE id = ?', [issueId])!,
});
const statusOf = (db: TrajectoryDB, taskId: number) =>
  db.get<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [taskId])!.status;
const reopenRows = (db: TrajectoryDB, issueId: number) =>
  db
    .all<{ from_node: string; content_json: string }>(
      `SELECT from_node, content_json FROM audit WHERE event_type = 'issue_reopened' AND issue_id = ? ORDER BY id`,
      [issueId],
    )
    .map((r) => ({ from_node: r.from_node, content: JSON.parse(r.content_json) as Record<string, unknown> }));

describe('rework after an exit-5 integrate keeps the issue open (GH 3234)', () => {
  let db: TrajectoryDB;
  let handlers: Handlers;
  let issueId: number;
  const attempts = new Map<number, number>();
  const spawned: string[][] = [];
  const _spawnFn = (cmd: string, args: string[]) => {
    spawned.push([cmd, ...args]);
    return { status: 0, stdout: '', stderr: '' };
  };

  before(() => {
    db = tempDB();
    handlers = compositeTools(db, DB_PATH).handlers;
    issueId = seedIssue(db, 'open');
  });
  after(() => db.close());

  // swe finishes a commit and code-reviewer passes it: a review_handoff for the
  // sha, then a pass recorded at or after it.
  function completeAndPass(taskId: number, sha: string): void {
    db.run(`UPDATE tasks SET status = 'completed', commit_sha = ? WHERE id = ?`, [sha, taskId]);
    db.run(
      `INSERT INTO audit (issue_id, from_node, event_type, summary, content_json, created_at) VALUES (?, 'bro', 'review_handoff', 'handoff', ?, ?)`,
      [issueId, JSON.stringify({ task_id: taskId, commit_sha: sha }), new Date().toISOString()],
    );
    const attemptN = (attempts.get(taskId) ?? 0) + 1;
    attempts.set(taskId, attemptN);
    db.run(
      `INSERT INTO validation_attempts (task_id, attempt_n, agent, verdict, mcp_available, created_at) VALUES (?, ?, 'code-reviewer', 'pass', 1, ?)`,
      [taskId, attemptN, new Date().toISOString()],
    );
  }

  async function close(taskId: number, sha: string): Promise<Record<string, unknown>> {
    return call(handlers, 'bro_atomic_close', {
      agent: 'bro', task_id: String(taskId), commit_sha: sha, verification_summary: 'ok',
      close_issue_if_last_task: true, waive_scope_gate: true, scope_waiver_reason: 'test fixture: scope not under test', _spawnFn,
    });
  }

  // integrate exit 5 (UNCARRIED_CODE): the task points at the rebased sha and
  // a task_integrated row records that the reviewed pass did not carry.
  function integrateExit5(taskId: number, reviewedSha: string, newSha: string): void {
    const branch = db.get<{ branch_id: string }>('SELECT branch_id FROM tasks WHERE id = ?', [taskId])!.branch_id;
    db.run(`UPDATE tasks SET commit_sha = ?, updated_at = ? WHERE id = ? AND commit_sha = ?`, [newSha, new Date().toISOString(), taskId, reviewedSha]);
    db.run(
      `INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
       VALUES (?, ?, 'hook:integrate', 'task_integrated', ?, ?, ?)`,
      [
        issueId,
        branch,
        `task ${taskId} integrated onto dev: ${reviewedSha} -> ${newSha}`,
        JSON.stringify({ task_id: taskId, rebased_from: reviewedSha, commit_sha: newSha, base: 'dev', run_id: 1, carried: false }),
        new Date().toISOString(),
      ],
    );
  }

  const reopen = (taskId: number, reason: string) => call(handlers, 'task_reopen', { agent: 'bro', task_id: String(taskId), reason });
  const retry = (taskId: number, branch: string) =>
    call(handlers, 'task_retry', {
      agent: 'bro', failed_task_id: String(taskId), new_branch_id: branch,
      corrected_spec_body: 'corrected spec', retry_rationale: 'escalated after uncarried rework', description: 'retry',
    });
  const assertIssueOpen = (step: string) => assert.deepEqual(issueOf(db, issueId), { status: 'open', closed_at: null }, step);

  it('replays 40 -> 49 -> 50 with the issue open at every step', async () => {
    // 1. Task A closes as the issue's last task: the close is deferred to merge.
    const a = seedTask(db, issueId, 'fix/rework-a', 'running');
    completeAndPass(a, 'aaaa0001');
    const first = await close(a, 'aaaa0001');
    assert.equal(first['issue_closed'], false);
    assert.equal(first['issue_close_deferred'], 'merge');
    assert.equal(statusOf(db, a), 'closed');
    assertIssueOpen('after A closes');

    // 2. integrate exits 5 on A.
    integrateExit5(a, 'aaaa0001', 'aaaa0002');
    assertIssueOpen('after the first exit 5');

    // 3. A is reopened and closes again.
    const reopenedA = await reopen(a, 'integrate exit 5: the reviewed pass did not carry');
    assert.equal(reopenedA['issue_reopened'], undefined, 'an open issue is left as it is');
    assert.equal(statusOf(db, a), 'running');
    assertIssueOpen('after A is reopened');
    completeAndPass(a, 'aaaa0003');
    const second = await close(a, 'aaaa0003');
    assert.equal(second['issue_close_deferred'], 'merge');
    assertIssueOpen('after A closes again');

    // 4. A meets exit 5 again, is reopened, escalates and is retried as B.
    integrateExit5(a, 'aaaa0003', 'aaaa0004');
    await reopen(a, 'integrate exit 5 again');
    db.run(`UPDATE tasks SET status = 'escalated' WHERE id = ?`, [a]);
    const b = Number((await retry(a, 'fix/rework-b'))['task_id']);
    assert.equal(statusOf(db, b), 'pending');
    assertIssueOpen('after the retry to B');

    // 5. B closes, meets exit 5, and can be reopened.
    completeAndPass(b, 'bbbb0001');
    const third = await close(b, 'bbbb0001');
    assert.equal(third['issue_closed'], false);
    assertIssueOpen('after B closes');
    integrateExit5(b, 'bbbb0001', 'bbbb0002');
    await reopen(b, 'integrate exit 5 on B');
    assert.equal(statusOf(db, b), 'running');
    assertIssueOpen('after B is reopened');

    // 6. B escalates and is retried as C.
    db.run(`UPDATE tasks SET status = 'escalated' WHERE id = ?`, [b]);
    const c = Number((await retry(b, 'fix/rework-c'))['task_id']);
    assert.equal(statusOf(db, c), 'pending');
    assertIssueOpen('after the retry to C');

    assert.deepEqual(reopenRows(db, issueId), [], 'the issue never closed, so the guard never fired');
    assert.deepEqual(spawned, [], 'no close reached a remote');
  });
});

describe('the revert guard reopens a closed issue once per cause (GH 3234)', () => {
  const CLOSED_AT = '2026-01-01T00:00:00.000Z';
  let db: TrajectoryDB;
  let handlers: Handlers;

  before(() => {
    db = tempDB();
    handlers = compositeTools(db, DB_PATH).handlers;
  });
  after(() => db.close());

  function assertReopenedBy(issueId: number, taskId: number, cause: string, fromNode: string): void {
    assert.deepEqual(issueOf(db, issueId), { status: 'open', closed_at: null });
    assert.deepEqual(reopenRows(db, issueId), [{ from_node: fromNode, content: { task_id: taskId, cause, from_closed_at: CLOSED_AT } }]);
  }

  it('task_reopen reopens the closed issue of the task it reopens', async () => {
    const issueId = seedIssue(db, 'closed', CLOSED_AT);
    const taskId = seedTask(db, issueId, 'fix/guard-reopen', 'closed', 'cccc0001');
    const out = await call(handlers, 'task_reopen', { agent: 'bro', task_id: String(taskId), reason: 'rework after merge' });
    assert.equal(out['issue_reopened'], true);
    assert.equal(statusOf(db, taskId), 'running');
    assertReopenedBy(issueId, taskId, 'task_reopen', 'bro');
  });

  it('task_retry reopens the closed issue its new task joins', async () => {
    const issueId = seedIssue(db, 'closed', CLOSED_AT);
    const failedId = seedTask(db, issueId, 'fix/guard-retry', 'escalated');
    const out = await call(handlers, 'task_retry', {
      agent: 'bro', failed_task_id: String(failedId), new_branch_id: 'fix/guard-retry-v2',
      corrected_spec_body: 'corrected spec', retry_rationale: 'retry under a closed issue', description: 'retry',
    });
    assert.equal(out['issue_reopened'], true);
    const newId = Number(out['task_id']);
    assertReopenedBy(issueId, newId, 'task_retry', 'bro');
  });

  it('a review FAIL reopens the closed issue of the task it reopens', async () => {
    const issueId = seedIssue(db, 'closed', CLOSED_AT);
    const taskId = seedTask(db, issueId, 'fix/guard-fail', 'closed', 'cccc0002');
    seedReviewerObservation(db, taskId, 1, { agentId: `reviewer-${taskId}` });
    const r = (await validationTools(db).handlers['validation_record']({
      agent: 'code-reviewer', task_id: String(taskId), attempt_n: 1, verdict: 'fail', feedback: '# Review',
      mcp_available: true, probes: TEST_PROBES,
      findings: [{ probe_cmd: 'false', expected: 'e', observed: 'o', class: 'regression' }],
    })) as unknown as Raw;
    assert.ok(!r.isError, r.content[0]?.text);
    const reopened = parse(r)['reopened'] as Record<string, unknown>;
    assert.equal(reopened['issue_reopened'], true);
    assert.equal(statusOf(db, taskId), 'running');
    assertReopenedBy(issueId, taskId, 'review_fail', 'code-reviewer');
  });

  it('writes nothing for an issue that is already open', async () => {
    const issueId = seedIssue(db, 'open');
    const taskId = seedTask(db, issueId, 'fix/guard-open', 'closed', 'cccc0003');
    const out = await call(handlers, 'task_reopen', { agent: 'bro', task_id: String(taskId), reason: 'rework' });
    assert.equal(out['issue_reopened'], undefined);
    assert.deepEqual(issueOf(db, issueId), { status: 'open', closed_at: null });
    assert.deepEqual(reopenRows(db, issueId), []);
  });
});

describe('docs describe the revert guard, not the closed-issue refusal (GH 3234)', () => {
  const readRepoFile = (relativeToDistTest: string): string =>
    readFileSync(fileURLToPath(new URL(relativeToDistTest, import.meta.url)), 'utf8');
  const toolsReadme = readRepoFile('../../src/tools/README.md');
  const enumsDoc = readRepoFile('../../../../docs/contributing/ENUMS.md');
  const taskReopened = AUDIT_EVENT_TYPES.find((e) => e.type === 'task_reopened');

  it('src/tools/README.md no longer says rework refuses or skips a task of a closed issue', () => {
    for (const stale of [
      'It refuses a task whose issue is closed',
      'or one of a closed issue, is left as it is',
      'task of an open issue',
    ]) {
      assert.ok(!toolsReadme.includes(stale), `README still says: ${stale}`);
    }
    assert.ok(toolsReadme.includes('finding_ids, issue_reopened?}'), 'the reopened result shape lists issue_reopened?');
  });

  it('the task_reopened description and ENUMS.md no longer limit a FAIL reopen to an open issue', () => {
    assert.ok(taskReopened, 'task_reopened is registered');
    assert.ok(!taskReopened.description.includes('of an open issue'), taskReopened.description);
    assert.ok(!enumsDoc.includes('task of an open issue'), 'ENUMS.md still limits a FAIL reopen to an open issue');
  });
});
