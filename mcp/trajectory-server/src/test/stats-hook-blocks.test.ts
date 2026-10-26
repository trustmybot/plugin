import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tempDB } from './helpers.js';
import { hookBlockReason, hookBlockStats, statsTools } from '../tools/stats.js';
import type { TrajectoryDB } from '../db.js';

type RawResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

const NOW = new Date('2026-10-26T20:00:00.000Z');
const at = (hhmm: string): string => `2026-10-26T${hhmm}:00.000Z`;

function lastId(db: TrajectoryDB): number {
  return (db.get<{ id: number }>('SELECT last_insert_rowid() AS id') as { id: number }).id;
}

function seedTask(db: TrajectoryDB, issueId: number, branch: string): number {
  db.run(
    "INSERT INTO tasks (issue_id, branch_id, title, description, status, created_at, updated_at) VALUES (?, ?, 't', 'd', 'running', ?, ?)",
    [issueId, branch, at('09:00'), at('09:00')],
  );
  return lastId(db);
}

function seedRun(db: TrajectoryDB, taskId: number, issueId: number, agentType: string, start: string, end: string | null): number {
  db.run(
    'INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at, completed_at, tool_uses, duration_ms) VALUES (?, ?, ?, ?, ?, 0, 0)',
    [taskId, issueId, agentType, at(start), end === null ? null : at(end)],
  );
  return lastId(db);
}

function seedAudit(
  db: TrajectoryDB,
  issueId: number,
  eventType: string,
  content: { task_id: number; agent_type: string; hook: string; rule: string },
  when: string,
): void {
  db.run(
    "INSERT INTO audit (issue_id, from_node, event_type, summary, content_json, created_at) VALUES (?, 'hook:dispatch', ?, 'deny', ?, ?)",
    [issueId, eventType, JSON.stringify({ tool: 'Bash', cwd: '/w', ...content }), at(when)],
  );
}

function fixture() {
  const db = tempDB();
  db.run("INSERT INTO issues (objective, description, status, created_at, updated_at) VALUES ('i', '', 'open', ?, ?)", [at('09:00'), at('09:00')]);
  const issueId = lastId(db);
  const taskId = seedTask(db, issueId, 'feat/a');
  const otherTaskId = seedTask(db, issueId, 'feat/b');
  const runA = seedRun(db, taskId, issueId, 'swe', '10:00', '10:30');
  const runB = seedRun(db, taskId, issueId, 'swe', '11:00', '11:30');
  const runC = seedRun(db, taskId, issueId, 'pr-reviewer', '12:00', '12:10');
  const runD = seedRun(db, taskId, issueId, 'swe', '13:00', '13:05');

  const git = { task_id: taskId, hook: 'git-guards', rule: 'BLOCKED: ambiguous_git_target — pass git -C <worktree>' };
  seedAudit(db, issueId, 'hook_denied', { ...git, agent_type: 'tmb:swe' }, '10:05');
  seedAudit(db, issueId, 'hook_denied', { ...git, agent_type: 'swe' }, '11:05');
  seedAudit(db, issueId, 'hook_denied', { task_id: taskId, agent_type: 'tmb:swe', hook: 'containment-guard', rule: 'containment-guard: dispatch failed (exit 124)' }, '11:10');
  seedAudit(db, issueId, 'hook_denied', { ...git, agent_type: 'tmb:swe' }, '10:45');
  seedAudit(db, issueId, 'hook_denied', { ...git, task_id: otherTaskId, agent_type: 'tmb:swe' }, '10:10');
  seedAudit(db, issueId, 'containment_denied', { task_id: taskId, agent_type: 'tmb:swe', hook: 'containment-guard', rule: 'BLOCKED: containment' }, '10:06');
  seedAudit(db, issueId, 'hook_denied', { task_id: taskId, agent_type: 'tmb:pr-reviewer', hook: 'review-scope', rule: 'pr-reviewer may not edit' }, '12:05');

  return { db, taskId, runs: { runA, runB, runC, runD } };
}

async function taskStats(db: TrajectoryDB, args: Record<string, unknown>): Promise<RawResult> {
  return (await statsTools(db, () => NOW).handlers['task_stats']({ agent: 'bro', ...args })) as unknown as RawResult;
}

const parse = (r: RawResult) => JSON.parse(r.content[0].text);

describe('task_stats — hook blocks (GH 1915)', () => {
  it('totals the task\'s attributed hook_denied rows, gate failures apart, by_reason highest first', async () => {
    const { db, taskId } = fixture();
    const res = await taskStats(db, { task_id: taskId });
    assert.ok(!res.isError, res.content[0].text);
    const payload = parse(res);
    assert.equal(payload.hook_blocks.denials, 3);
    assert.equal(payload.hook_blocks.gate_failures, 1);
    assert.deepEqual(Object.entries(payload.hook_blocks.by_reason), [
      ['git-guards:ambiguous_git_target', 2],
      ['containment-guard:gate_failure', 1],
      ['review-scope', 1],
    ]);
    db.close();
  });

  it('gives every spawn its own hook_blocks count, 0 for a run with none', async () => {
    const { db, taskId, runs } = fixture();
    const payload = parse(await taskStats(db, { task_id: taskId }));
    assert.deepEqual(
      payload.spawns.map((s: { id: number; hook_blocks: number }) => [s.id, s.hook_blocks]),
      [[runs.runA, 1], [runs.runB, 2], [runs.runC, 1], [runs.runD, 0]],
    );
    db.close();
  });

  it('window mode sums swe runs started since the date', async () => {
    const { db } = fixture();
    const payload = parse(await taskStats(db, { since: '2026-10-26' }));
    assert.deepEqual(payload, {
      since: '2026-10-26',
      window: {
        runs: 3,
        runs_with_blocks: 2,
        denials: 2,
        gate_failures: 1,
        blocks_per_run: 1,
        by_reason: { 'git-guards:ambiguous_git_target': 2, 'containment-guard:gate_failure': 1 },
      },
    });
    const later = parse(await taskStats(db, { since: '2026-10-26T10:50:00Z' }));
    assert.equal(later.window.runs, 2);
    assert.equal(later.window.runs_with_blocks, 1);
    assert.equal(later.window.blocks_per_run, 1);
    db.close();
  });

  it('window mode with no runs reports blocks_per_run 0', async () => {
    const { db } = fixture();
    const payload = parse(await taskStats(db, { since: '2027-01-01' }));
    assert.deepEqual(payload.window, { runs: 0, runs_with_blocks: 0, denials: 0, gate_failures: 0, blocks_per_run: 0, by_reason: {} });
    db.close();
  });

  it('errors with neither task_id nor since, and on a since that is not an ISO date', async () => {
    const { db } = fixture();
    const none = await taskStats(db, {});
    assert.ok(none.isError);
    assert.match(parse(none).error, /task_id .* or since/);
    for (const since of ['yesterday', 'October 26 2026', '2026-13-45']) {
      const bad = await taskStats(db, { since });
      assert.ok(bad.isError, `since=${since} must error`);
      assert.match(parse(bad).error, /ISO date/);
    }
    db.close();
  });

  it('the tool requires only agent and names both modes', () => {
    const def = statsTools(tempDB()).definitions.find((d) => d.name === 'task_stats');
    assert.deepEqual(def?.inputSchema.required, ['agent']);
    assert.match(def?.description ?? '', /task_id/);
    assert.match(def?.description ?? '', /since/);
  });
});

describe('hookBlockStats attribution', () => {
  it('an overlapping row goes to the run with the latest started_at, counted once', () => {
    const { db, taskId } = fixture();
    const runs = [
      { id: 1, task_id: taskId, agent_type: 'swe', started_at: at('10:00'), completed_at: null },
      { id: 2, task_id: taskId, agent_type: 'swe', started_at: at('11:00'), completed_at: null },
    ];
    const stats = hookBlockStats(db, runs, NOW);
    assert.deepEqual([...stats.per_run], [[1, 2], [2, 2]]);
    assert.equal(stats.denials + stats.gate_failures, 4);
    db.close();
  });
});

describe('hookBlockReason', () => {
  const cases: Array<[string | null, string | null, string, boolean]> = [
    ['containment-guard', 'containment-guard: dispatch failed (exit 124)', 'containment-guard:gate_failure', true],
    ['git-guards', 'gate ran past its 5s budget; ambiguous_git_target', 'git-guards:gate_failure', true],
    ['git-guards', 'BLOCKED: ambiguous_git_target', 'git-guards:ambiguous_git_target', false],
    ['write-guard', 'write target "$OUT" cannot be judged', 'write-guard:write_path', false],
    ['write-guard', 'the path comes from a process substitution', 'write-guard:write_path', false],
    ['write-guard', 'the target depends on a variable', 'write-guard:write_path', false],
    ['containment-guard', 'BLOCKED: containment — outside the worktree', 'containment-guard:containment', false],
    ['swe-scope', 'SWE may only edit files inside /w', 'swe-scope:swe_worktree', false],
    ['other', 'nope', 'other', false],
    [null, null, 'unknown', false],
  ];
  for (const [hook, rule, reason, gate] of cases) {
    it(`${hook} / ${rule} -> ${reason}`, () => {
      assert.deepEqual(hookBlockReason(hook, rule), { reason, gate_failure: gate });
    });
  }
});
