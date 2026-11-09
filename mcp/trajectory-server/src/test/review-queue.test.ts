/**
 * review_queue (GH 2225): bro reads the closed agile tasks with no passing
 * review and no trusted waiver or bypass, grouped by overlapping files[].
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { TrajectoryDB } from '../db.js';
import { tempDB } from './helpers.js';
import { groupByFileOverlap, pathsOverlap, validationTools } from '../tools/validation.js';

type RawResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type Queue = { total: number; groups: Array<{ task_ids: number[]; branch_ids: string[]; issue_ids: number[]; commit_shas: string[]; files: string[] }> };

const NOW = '2026-11-09T10:00:00.000Z';

function seedIssue(db: TrajectoryDB, id: number): void {
  db.run("INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (?, 'q', 'open', ?, ?)", [id, NOW, NOW]);
}

function seedTask(
  db: TrajectoryDB,
  id: number,
  opts: { files?: string[]; mode?: string | null; status?: string; issue?: number; sha?: string | null } = {},
): void {
  db.run(
    `INSERT INTO tasks (id, issue_id, branch_id, description, status, commit_sha, files, workflow_mode, created_at, updated_at)
     VALUES (?, ?, ?, 'd', ?, ?, ?, ?, ?, ?)`,
    [
      id,
      opts.issue ?? 1,
      `feat/${id}-x`,
      opts.status ?? 'closed',
      opts.sha === undefined ? `${id}`.padEnd(40, 'a') : opts.sha,
      JSON.stringify(opts.files ?? []),
      opts.mode === undefined ? 'agile' : opts.mode,
      NOW,
      NOW,
    ],
  );
}

function seedAudit(db: TrajectoryDB, taskId: number, eventType: string, fromNode: string): void {
  db.run(
    `INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
     VALUES (1, NULL, ?, ?, 's', ?, ?)`,
    [fromNode, eventType, JSON.stringify({ task_id: taskId, commit_sha: 'f'.repeat(40) }), NOW],
  );
}

function seedVerdict(db: TrajectoryDB, taskId: number, attemptN: number, verdict: string): void {
  db.run(
    `INSERT INTO validation_attempts (task_id, attempt_n, agent, verdict, feedback, mcp_available, created_at) VALUES (?, ?, 'code-reviewer', ?, 'f', 1, ?)`,
    [taskId, attemptN, verdict, NOW],
  );
}

async function queue(db: TrajectoryDB, agent = 'bro'): Promise<RawResult> {
  return (await validationTools(db).handlers['review_queue']!({ agent })) as unknown as RawResult;
}

async function queued(db: TrajectoryDB): Promise<Queue> {
  const r = await queue(db);
  assert.ok(!r.isError, r.content[0]?.text);
  return JSON.parse(r.content[0]!.text) as Queue;
}

describe('review_queue (GH 2225)', () => {
  it('SC1: groups overlapping, disjoint and file-less agile tasks, ordered by smallest task id', async () => {
    const db = tempDB();
    seedIssue(db, 1);
    seedIssue(db, 2);
    seedTask(db, 10, { files: ['src/a.ts', 'src/b.ts'] });
    seedTask(db, 11, { files: ['docs/x.md'], issue: 2 });
    seedTask(db, 12, { files: [] });
    seedTask(db, 13, { files: ['src/b.ts'], issue: 2 });

    const q = await queued(db);
    assert.ok(q.total > 0);
    assert.equal(q.total, 4);
    assert.deepEqual(q.groups.map((g) => g.task_ids), [[10, 13], [11], [12]]);
    assert.deepEqual(q.groups[0], {
      task_ids: [10, 13],
      branch_ids: ['feat/10-x', 'feat/13-x'],
      issue_ids: [1, 2],
      commit_shas: ['10'.padEnd(40, 'a'), '13'.padEnd(40, 'a')],
      files: ['src/a.ts', 'src/b.ts'],
    });
    assert.deepEqual(q.groups[2]!.files, []);
  });

  it('SC1: a task with NULL or unparseable files is its own group', () => {
    const groups = groupByFileOverlap([
      { id: 3, branch_id: 'b3', issue_id: 1, commit_sha: null, files: null },
      { id: 1, branch_id: 'b1', issue_id: 1, commit_sha: 'x', files: '["src/a"]' },
      { id: 2, branch_id: 'b2', issue_id: 1, commit_sha: null, files: 'not json' },
      { id: 4, branch_id: 'b4', issue_id: 1, commit_sha: null, files: null },
    ]);
    assert.deepEqual(groups.map((g) => g.task_ids), [[1], [2], [3], [4]]);
    assert.deepEqual(groups[2]!.commit_shas, []);
  });

  it('SC2: reviewed, waived and bypassed tasks are left out; other modes, statuses and authors are not trusted', async () => {
    const db = tempDB();
    seedIssue(db, 1);
    seedTask(db, 1);
    seedVerdict(db, 1, 1, 'pass');
    seedTask(db, 2);
    seedAudit(db, 2, 'review_gate_waived', 'bro');
    seedTask(db, 3);
    seedAudit(db, 3, 'review_gate_bypassed', 'bro');
    seedTask(db, 4);
    seedAudit(db, 4, 'review_gate_bypassed', 'hook:close-issue-on-merge');
    seedTask(db, 5, { mode: 'truest' });
    seedTask(db, 6, { mode: null });
    seedTask(db, 7, { status: 'completed' });
    seedTask(db, 8, { status: 'running' });
    seedTask(db, 9);
    seedAudit(db, 9, 'review_gate_waived', 'swe');
    seedTask(db, 10);
    seedAudit(db, 10, 'review_gate_bypassed', 'code-reviewer');
    seedTask(db, 11);
    seedVerdict(db, 11, 1, 'fail');
    seedTask(db, 12, { sha: null });

    const q = await queued(db);
    assert.equal(q.total, 4);
    assert.deepEqual(q.groups.map((g) => g.task_ids), [[9], [10], [11], [12]]);
  });

  it('SC3: overlap follows path segments and is transitive', async () => {
    assert.equal(pathsOverlap('src/a', 'src/a/b.ts'), true);
    assert.equal(pathsOverlap('src/a/b.ts', 'src/a'), true);
    assert.equal(pathsOverlap('src/a', 'src/ab'), false);
    assert.equal(pathsOverlap('src/a', 'src/a'), true);

    const db = tempDB();
    seedIssue(db, 1);
    seedTask(db, 1, { files: ['src/a'] });
    seedTask(db, 2, { files: ['src/ab'] });
    seedTask(db, 3, { files: ['src/a/b.ts'] });
    seedTask(db, 4, { files: ['lib/x.ts', 'src/ab/c.ts'] });
    seedTask(db, 5, { files: ['lib/'] });
    seedTask(db, 6, { files: ['other.ts'] });

    const q = await queued(db);
    assert.deepEqual(q.groups.map((g) => g.task_ids), [[1, 3], [2, 4, 5], [6]]);
    assert.deepEqual(q.groups[1]!.files, ['lib', 'lib/x.ts', 'src/ab', 'src/ab/c.ts']);
  });

  it('SC4: any agent other than bro is refused', async () => {
    const db = tempDB();
    for (const agent of ['swe', 'code-reviewer', 'consultant', 'nobody']) {
      const r = await queue(db, agent);
      assert.equal(r.isError, true, agent);
    }
    const bro = await queue(db);
    assert.ok(!bro.isError);
    assert.deepEqual(JSON.parse(bro.content[0]!.text), { total: 0, groups: [] });
  });
});
