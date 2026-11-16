// review_queue (GH 2225 A3): the unreviewed agile closes, grouped by declared
// files[] overlap, with the doctor's agile_review_queued membership.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TrajectoryDB } from '../db.js';
import { tempDB } from './helpers.js';
import { DATA_CONTRACTS, isSqlContract, type SqlContract } from '../data-contracts.js';
import { runDataContracts, trajectoryDbReader } from '../tools/trajectory-doctor.js';
import { groupQueuedTasks, pathsOverlap, reviewQueueTools } from '../tools/review-queue.js';
import { AGILE_QUEUED_SQL, reviewBatchKey } from '../review-sql.js';
import { closedTasksWithoutReview } from '../tools/lifecycle.js';
import { issueTools } from '../tools/issues.js';

type RawResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type Group = { tasks: Array<{ id: number; commit_sha: string | null; updated_at: string }>; files: string[]; base: string | null; head: string | null };
type Queue = { total: number; groups: Group[] };

const HOUR = 3_600_000;
const iso = (offsetMs = 0): string => new Date(Date.now() + offsetMs).toISOString();

function seedIssue(db: TrajectoryDB): number {
  db.run(`INSERT INTO issues (objective, status, created_at, updated_at) VALUES ('queue', 'open', ?, ?)`, [iso(), iso()]);
  return db.get<{ id: number }>('SELECT MAX(id) AS id FROM issues')!.id;
}

interface SeedOpts {
  mode?: 'agile' | 'truest' | null;
  status?: string;
  files?: string[];
  updatedAt?: string;
  commit?: string | null;
  base?: string | null;
  repo?: string | null;
}

function seedTask(db: TrajectoryDB, issueId: number, opts: SeedOpts = {}): number {
  db.run(
    `INSERT INTO tasks (issue_id, branch_id, description, status, files, commit_sha, base_sha, repo, workflow_mode, created_at, updated_at)
     VALUES (?, ?, 'd', ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      issueId,
      `feat/q-${Math.random().toString(36).slice(2)}`,
      opts.status ?? 'closed',
      JSON.stringify(opts.files ?? []),
      opts.commit === undefined ? 'c0ffee1' : opts.commit,
      opts.base ?? null,
      opts.repo ?? null,
      opts.mode === undefined ? 'agile' : opts.mode,
      iso(),
      opts.updatedAt ?? iso(-HOUR),
    ],
  );
  return db.get<{ id: number }>('SELECT MAX(id) AS id FROM tasks')!.id;
}

async function queue(db: TrajectoryDB, args: Record<string, unknown> = {}): Promise<RawResult> {
  return (await reviewQueueTools(db).handlers['review_queue']({ agent: 'bro', ...args })) as RawResult;
}

async function queueOk(db: TrajectoryDB, args: Record<string, unknown> = {}): Promise<Queue> {
  const r = await queue(db, args);
  assert.ok(!r.isError, r.content[0].text);
  return JSON.parse(r.content[0].text) as Queue;
}

const ids = (q: Queue): number[] => q.groups.flatMap((g) => g.tasks.map((t) => t.id)).sort((a, b) => a - b);

describe('SC1: membership is the unreviewed closed agile tasks', () => {
  it('lists an unreviewed agile close and leaves out a passed, waived, truest, NULL-mode, open or 31-day-old task', async () => {
    const db = tempDB();
    try {
      const issue = seedIssue(db);
      const queued = seedTask(db, issue);
      const passed = seedTask(db, issue);
      db.run(`INSERT INTO validation_attempts (task_id, attempt_n, verdict, mcp_available, created_at) VALUES (?, 1, 'pass', 1, ?)`, [passed, iso()]);
      const waived = seedTask(db, issue);
      db.run(
        `INSERT INTO audit (issue_id, from_node, event_type, summary, content_json, created_at) VALUES (?, 'bro', 'review_gate_waived', 'w', ?, ?)`,
        [issue, JSON.stringify({ task_id: waived }), iso()],
      );
      seedTask(db, issue, { mode: 'truest' });
      seedTask(db, issue, { mode: null });
      seedTask(db, issue, { status: 'completed' });
      seedTask(db, issue, { updatedAt: iso(-31 * 24 * HOUR) });
      const q = await queueOk(db);
      assert.deepEqual(ids(q), [queued]);
      assert.equal(q.total, 1);
    } finally {
      db.close();
    }
  });

  it('filters by repo when one is given', async () => {
    const db = tempDB();
    try {
      db.run(`INSERT INTO repos (name, path) VALUES ('app', '/app'), ('lib', '/lib')`);
      const issue = seedIssue(db);
      const inApp = seedTask(db, issue, { repo: 'app' });
      seedTask(db, issue, { repo: 'lib' });
      assert.deepEqual(ids(await queueOk(db, { repo: 'app' })), [inApp]);
      assert.equal((await queueOk(db)).total, 2);
    } finally {
      db.close();
    }
  });
});

describe('SC2: membership reads the stamped mode, not the config', () => {
  it('agile tasks stay listed after plugin_config.workflow_mode is set to truest', async () => {
    const db = tempDB();
    try {
      const task = seedTask(db, seedIssue(db));
      db.run(`INSERT INTO plugin_config (key, value_json) VALUES ('workflow_mode', '"truest"')
                ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`);
      assert.deepEqual(ids(await queueOk(db)), [task]);
    } finally {
      db.close();
    }
  });
});

describe('GH 2225 T2: the review_queued row of an agile close keeps the task queued', () => {
  it('a bro review_queued row leaves the task listed, where a review_gate_bypassed row would drop it', async () => {
    const db = tempDB();
    try {
      const issue = seedIssue(db);
      const queued = seedTask(db, issue);
      const bypassed = seedTask(db, issue);
      const row = (taskId: number, eventType: string) =>
        db.run(
          `INSERT INTO audit (issue_id, from_node, event_type, summary, content_json, created_at) VALUES (?, 'bro', ?, 'r', ?, ?)`,
          [issue, eventType, JSON.stringify({ task_id: taskId, commit_sha: 'c0ffee1' }), iso()],
        );
      row(queued, 'review_queued');
      row(bypassed, 'review_gate_bypassed');
      assert.deepEqual(ids(await queueOk(db)), [queued]);
    } finally {
      db.close();
    }
  });
});

describe('SC3: groups are disjoint connected components of files[] overlap', () => {
  it('two overlapping tasks share a group and a third stands alone', async () => {
    const db = tempDB();
    try {
      const issue = seedIssue(db);
      const a = seedTask(db, issue, { files: ['src/tools'], base: 'base-a', commit: 'head-a', updatedAt: iso(-3 * HOUR) });
      const lone = seedTask(db, issue, { files: ['docs/x.md'], base: 'base-lone', commit: 'head-lone' });
      const b = seedTask(db, issue, { files: ['src/tools/review-queue.ts'], base: 'base-b', commit: 'head-b', updatedAt: iso(-2 * HOUR) });
      const q = await queueOk(db);
      assert.equal(q.groups.length, 2);
      assert.deepEqual(q.groups.map((g) => g.tasks.length), [2, 1]);
      assert.deepEqual(q.groups[0].tasks.map((t) => t.id), [a, b]);
      assert.deepEqual(q.groups[1].tasks.map((t) => t.id), [lone]);
      assert.deepEqual(ids(q), [a, lone, b].sort((x, y) => x - y), 'every task in exactly one group');
      assert.equal(q.total, 3);
      assert.deepEqual(q.groups[0].files, ['src/tools', 'src/tools/review-queue.ts']);
      assert.equal(q.groups[0].base, 'base-a', 'base is the lowest task id\'s base_sha');
      assert.equal(q.groups[0].head, 'head-b', 'head is the newest-updated task\'s commit_sha');
      assert.equal(q.groups[1].base, 'base-lone');
    } finally {
      db.close();
    }
  });

  it('a chain of overlaps forms one component and base is null for a pre-v67 task', () => {
    const row = (id: number, files: string[], updated_at: string) =>
      ({ id, issue_id: 1, branch_id: `b${id}`, commit_sha: `c${id}`, base_sha: null, updated_at, files: JSON.stringify(files) });
    const groups = groupQueuedTasks([
      row(3, ['b/y', 'c'], '2026-01-03T00:00:00.000Z'),
      row(1, ['a'], '2026-01-01T00:00:00.000Z'),
      row(2, ['a/x', 'b'], '2026-01-02T00:00:00.000Z'),
      row(4, ['ab'], '2026-01-04T00:00:00.000Z'),
    ]);
    assert.deepEqual(groups.map((g) => g.tasks.map((t) => t.id)), [[1, 2, 3], [4]]);
    assert.equal(groups[0].base, null);
    assert.equal(groups[0].head, 'c3');
  });

  it('paths overlap only when equal or prefixed at a / boundary', () => {
    assert.equal(pathsOverlap('src/a', 'src/a'), true);
    assert.equal(pathsOverlap('src', 'src/a.ts'), true);
    assert.equal(pathsOverlap('src/a.ts', 'src'), true);
    assert.equal(pathsOverlap('src/a', 'src/ab'), false);
    assert.equal(pathsOverlap('src/a.ts', 'src/b.ts'), false);
  });
});

describe('SC4: parity with the doctor', () => {
  it('total under grace_hours 24 equals agile_review_queued\'s observed value, both leaving out a task inside the grace window', async () => {
    const db = tempDB();
    try {
      const issue = seedIssue(db);
      seedTask(db, issue, { updatedAt: iso(-25 * HOUR), files: ['a'] });
      seedTask(db, issue, { updatedAt: iso(-30 * HOUR), files: ['b'] });
      const inGrace = seedTask(db, issue, { updatedAt: iso(-2 * HOUR), files: ['a'] });
      seedTask(db, issue, { updatedAt: iso(-25 * HOUR), mode: 'truest' });
      const contract = DATA_CONTRACTS.filter(isSqlContract).find((c): c is SqlContract => c.id === 'agile_review_queued')!;
      const report = runDataContracts(trajectoryDbReader(db), [contract], { env: {} });
      const observed = report.violations.find((v) => v.id === 'agile_review_queued')?.actual;
      const q = await queueOk(db, { grace_hours: 24 });
      assert.ok(q.total > 0);
      assert.equal(q.total, observed);
      assert.equal(q.groups.reduce((n, g) => n + g.tasks.length, 0), q.total);
      assert.ok(!ids(q).includes(inGrace), 'the in-grace task is left out');
      assert.ok(ids(await queueOk(db)).includes(inGrace), 'the default grace of 0 lists it');
    } finally {
      db.close();
    }
  });

  it('a negative or non-numeric grace_hours is refused', async () => {
    const db = tempDB();
    try {
      for (const bad of [-1, '24', Number.NaN]) {
        const r = await queue(db, { grace_hours: bad });
        assert.equal(r.isError, true, String(bad));
      }
    } finally {
      db.close();
    }
  });
});

describe('SC5: bro only, and no write', () => {
  it('refuses any other caller and changes no row count', async () => {
    const db = tempDB();
    try {
      seedTask(db, seedIssue(db), { files: ['a'] });
      const counts = () =>
        db.get<{ tasks: number; audit: number; validations: number }>(
          `SELECT (SELECT COUNT(*) FROM tasks) AS tasks, (SELECT COUNT(*) FROM audit) AS audit,
                  (SELECT COUNT(*) FROM validation_attempts) AS validations`,
        );
      const before = counts();
      for (const agent of ['swe', 'code-reviewer', 'pm']) {
        const r = await queue(db, { agent });
        assert.equal(r.isError, true, agent);
        const payload = JSON.parse(r.content[0].text) as { error: string; allowed_roles: string[] };
        assert.equal(payload.error, 'forbidden');
        assert.deepEqual(payload.allowed_roles, ['bro']);
      }
      await queueOk(db);
      assert.deepEqual(counts(), before);
    } finally {
      db.close();
    }
  });
});

// GH 2225 T4: review_batch_record, code-reviewer's one verdict on a group of
// queued agile tasks at a feature-branch head.
describe('GH 2225 T4: review_batch_record', () => {
  // main: base -> head; side branches off base, so it is no ancestor of head.
  let repo: { root: string; base: string; head: string; side: string };

  before(() => {
    const root = mkdtempSync(join(tmpdir(), 'batch-review-'));
    const git = (...a: string[]) => execFileSync('git', ['-C', root, ...a], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }).toString().trim();
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@t.t');
    git('config', 'user.name', 't');
    git('config', 'commit.gpgsign', 'false');
    const commit = (file: string): string => {
      writeFileSync(join(root, file), `${file}\n`);
      git('add', '.');
      git('commit', '-q', '-m', file);
      return git('rev-parse', 'HEAD');
    };
    const base = commit('base.txt');
    const head = commit('head.txt');
    git('checkout', '-q', '-b', 'side', base);
    const side = commit('side.txt');
    git('checkout', '-q', 'main');
    repo = { root, base, head, side };
  });

  after(() => rmSync(repo.root, { recursive: true, force: true }));

  const REVIEWER = 'reviewer0agent01';

  function batchDb(): { db: TrajectoryDB; issue: number } {
    const db = tempDB();
    db.run(`INSERT INTO repos (name, path) VALUES ('app', ?)`, [repo.root]);
    return { db, issue: seedIssue(db) };
  }

  // A closed agile task with bro's review_queued row for its commit, as bro_atomic_close leaves it.
  function seedQueued(db: TrajectoryDB, issue: number, commit: string, opts: SeedOpts = {}): number {
    const id = seedTask(db, issue, { repo: 'app', commit, ...opts });
    db.run(
      `INSERT INTO audit (issue_id, from_node, event_type, summary, content_json, created_at) VALUES (?, 'bro', 'review_queued', 'q', ?, ?)`,
      [issue, JSON.stringify({ task_id: id, commit_sha: commit }), iso()],
    );
    return id;
  }

  // The row the reviewer-identity-observe hook writes for a review_batch_record call.
  function observe(db: TrajectoryDB, taskIds: number[], headSha: string, opts: { agentId?: string; observedAt?: string } = {}): number {
    const sorted = [...new Set(taskIds)].sort((a, b) => a - b);
    const content = {
      tool: 'review_batch_record',
      task_ids: sorted,
      head_sha: headSha.toLowerCase(),
      batch_key: reviewBatchKey(sorted, headSha),
      session_id: 'main-session',
      agent_id: opts.agentId ?? REVIEWER,
      tool_use_id: 'toolu_batch000001',
      observed_at: opts.observedAt ?? iso(),
      consumed: 0,
    };
    const res = db.run(
      `INSERT INTO audit (issue_id, from_node, event_type, summary, content_json, created_at)
       VALUES (-1, 'hook:reviewer-identity-observe', 'reviewer_identity_observed', 'observed', ?, ?)`,
      [JSON.stringify(content), iso()],
    );
    return Number(res.lastInsertRowid);
  }

  async function batch(db: TrajectoryDB, args: Record<string, unknown>): Promise<RawResult> {
    return (await reviewQueueTools(db).handlers['review_batch_record']({
      agent: 'code-reviewer',
      feature_branch: 'feat/agile',
      ...args,
    })) as RawResult;
  }

  async function observedBatch(db: TrajectoryDB, taskIds: number[], headSha: string, verdict: string, extra: Record<string, unknown> = {}): Promise<RawResult> {
    observe(db, taskIds, headSha);
    return batch(db, { task_ids: taskIds, head_sha: headSha, verdict, ...extra });
  }

  type BatchRow = { from_node: string; branch_id: string | null; content: Record<string, unknown> };
  const batchRows = (db: TrajectoryDB): BatchRow[] =>
    db
      .all<{ from_node: string; branch_id: string | null; content_json: string }>(
        `SELECT from_node, branch_id, content_json FROM audit WHERE event_type = 'review_batch_recorded' ORDER BY id`,
      )
      .map((r) => ({ from_node: r.from_node, branch_id: r.branch_id, content: JSON.parse(r.content_json) as Record<string, unknown> }));

  // Everything a call can write: the audit rows and the observation rows' consumed/superseded marks.
  const snapshot = (db: TrajectoryDB) =>
    db.get<{ rows: number; batches: number; marked: number }>(
      `SELECT (SELECT COUNT(*) FROM audit) AS rows,
              (SELECT COUNT(*) FROM audit WHERE event_type = 'review_batch_recorded') AS batches,
              (SELECT COUNT(*) FROM audit WHERE event_type = 'reviewer_identity_observed'
                 AND (json_extract(content_json, '$.consumed') = 1 OR json_extract(content_json, '$.superseded') = 1)) AS marked`,
    );

  const pushAdmits = (db: TrajectoryDB, id: number): boolean =>
    db.get<{ q: number }>(`SELECT ${AGILE_QUEUED_SQL} AS q FROM tasks t WHERE t.id = ?`, [id])!.q === 1;

  function refusedWith(r: RawResult, error: string | RegExp): { error: string; tasks?: Array<{ task_id: number; reason: string }> } {
    assert.equal(r.isError, true, r.content[0].text);
    const body = JSON.parse(r.content[0].text) as { error: string; tasks?: Array<{ task_id: number; reason: string }> };
    if (typeof error === 'string') assert.equal(body.error, error, r.content[0].text);
    else assert.match(body.error, error, r.content[0].text);
    return body;
  }

  describe('SC1: one row per verdict; a pass batch-reviews every task, a fail leaves them queued', () => {
    it('a pass over two queued tasks writes one code-reviewer row and drops both from review_queue', async () => {
      const { db, issue } = batchDb();
      try {
        const a = seedQueued(db, issue, repo.base);
        const b = seedQueued(db, issue, repo.head);
        const r = await observedBatch(db, [b, a], repo.head.toUpperCase(), 'pass');
        assert.ok(!r.isError, r.content[0].text);
        const rows = batchRows(db);
        assert.ok(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit WHERE event_type = 'review_batch_recorded'`)!.n > 0);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].from_node, 'code-reviewer');
        assert.equal(rows[0].branch_id, 'feat/agile');
        assert.deepEqual(
          {
            task_ids: rows[0].content['task_ids'],
            commit_shas: rows[0].content['commit_shas'],
            feature_branch: rows[0].content['feature_branch'],
            head_sha: rows[0].content['head_sha'],
            verdict: rows[0].content['verdict'],
            findings: rows[0].content['findings'],
            reviewer_agent_id: rows[0].content['reviewer_agent_id'],
          },
          { task_ids: [a, b], commit_shas: [repo.base, repo.head], feature_branch: 'feat/agile', head_sha: repo.head, verdict: 'pass', findings: null, reviewer_agent_id: REVIEWER },
        );
        assert.equal((await queueOk(db)).total, 0, 'both tasks are batch-reviewed');
        assert.ok(pushAdmits(db, a) && pushAdmits(db, b), 'the review_queued rows stay, so the push guard still admits both commits');
        assert.equal(snapshot(db)!.marked, 1, 'the observation is consumed');
      } finally {
        db.close();
      }
    });

    it('a fail writes the same row with verdict fail and its findings, leaves every task queued, and a later pass still clears them', async () => {
      const { db, issue } = batchDb();
      try {
        const a = seedQueued(db, issue, repo.base);
        const b = seedQueued(db, issue, repo.head);
        const finding = { probe_cmd: 'npm test', expected: 'exit 0', observed: 'exit 1', class: 'regression' };
        const r = await observedBatch(db, [a, b], repo.head, 'fail', { findings: [finding] });
        assert.ok(!r.isError, r.content[0].text);
        assert.ok(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit WHERE event_type = 'review_batch_recorded'`)!.n > 0);
        const [row] = batchRows(db);
        assert.equal(row.content['verdict'], 'fail');
        assert.deepEqual(row.content['task_ids'], [a, b]);
        assert.deepEqual(row.content['findings'], [{ ...finding, criterion_id: null, severity: 'blocking' }]);
        assert.deepEqual(ids(await queueOk(db)), [a, b], 'a fail leaves both queued');
        const again = await observedBatch(db, [a, b], repo.head, 'pass');
        assert.ok(!again.isError, again.content[0].text);
        assert.equal((await queueOk(db)).total, 0);
      } finally {
        db.close();
      }
    });

    it('a task whose commit moves after the pass is queued again at its new commit', async () => {
      const { db, issue } = batchDb();
      try {
        const a = seedQueued(db, issue, repo.base);
        assert.ok(!(await observedBatch(db, [a], repo.head, 'pass')).isError);
        assert.equal((await queueOk(db)).total, 0);
        db.run('UPDATE tasks SET commit_sha = ? WHERE id = ?', [repo.head, a]);
        db.run(
          `INSERT INTO audit (issue_id, from_node, event_type, summary, content_json, created_at) VALUES (?, 'bro', 'review_queued', 'q', ?, ?)`,
          [issue, JSON.stringify({ task_id: a, commit_sha: repo.head }), iso()],
        );
        assert.deepEqual(ids(await queueOk(db)), [a]);
        assert.ok(!(await observedBatch(db, [a], repo.head, 'pass')).isError, 'the moved commit can be batch-reviewed again');
      } finally {
        db.close();
      }
    });
  });

  describe('SC2: a refused call writes nothing', () => {
    it('refuses a caller other than code-reviewer', async () => {
      const { db, issue } = batchDb();
      try {
        const a = seedQueued(db, issue, repo.base);
        observe(db, [a], repo.head);
        const before = snapshot(db);
        for (const agent of ['bro', 'swe', 'pm']) {
          const body = refusedWith(await batch(db, { agent, task_ids: [a], head_sha: repo.head, verdict: 'pass' }), 'forbidden');
          assert.deepEqual((body as unknown as { allowed_roles: string[] }).allowed_roles, ['code-reviewer']);
        }
        assert.deepEqual(snapshot(db), before);
      } finally {
        db.close();
      }
    });

    it('refuses a reviewer that is the swe of any task in the group', async () => {
      const { db, issue } = batchDb();
      try {
        const a = seedQueued(db, issue, repo.base);
        const b = seedQueued(db, issue, repo.head);
        db.run(
          `INSERT INTO agent_runs (task_id, issue_id, agent_type, spawn_id, started_at) VALUES (?, ?, 'swe', 'swe0agent000001', ?)`,
          [b, issue, iso()],
        );
        observe(db, [a, b], repo.head, { agentId: 'swe0agent000001' });
        const before = snapshot(db);
        const body = refusedWith(await batch(db, { task_ids: [a, b], head_sha: repo.head, verdict: 'pass' }), 'reviewer_not_independent');
        assert.match(JSON.stringify(body), new RegExp(`task ${b}`));
        assert.deepEqual(snapshot(db), before, 'the observation is not consumed either');
        assert.deepEqual(ids(await queueOk(db)), [a, b]);
      } finally {
        db.close();
      }
    });

    it('refuses an observation with no agent_id or a malformed one', async () => {
      const { db, issue } = batchDb();
      try {
        const a = seedQueued(db, issue, repo.base);
        observe(db, [a], repo.head, { agentId: '' });
        const before = snapshot(db);
        refusedWith(await batch(db, { task_ids: [a], head_sha: repo.head, verdict: 'pass' }), 'reviewer_not_independent');
        assert.deepEqual(snapshot(db), before);
        observe(db, [a], repo.head, { agentId: 'bad id;' });
        const before2 = snapshot(db);
        refusedWith(await batch(db, { task_ids: [a], head_sha: repo.head, verdict: 'pass' }), 'reviewer_agent_id_malformed');
        assert.deepEqual(snapshot(db), before2);
      } finally {
        db.close();
      }
    });

    it('refuses with no observation of this call, or a stale one', async () => {
      const { db, issue } = batchDb();
      try {
        const a = seedQueued(db, issue, repo.base);
        const b = seedQueued(db, issue, repo.head);
        observe(db, [a], repo.head);
        const before = snapshot(db);
        refusedWith(await batch(db, { task_ids: [a, b], head_sha: repo.head, verdict: 'pass' }), 'subagent_session_unavailable');
        refusedWith(await batch(db, { task_ids: [a], head_sha: repo.base, verdict: 'pass' }), 'subagent_session_unavailable');
        assert.deepEqual(snapshot(db), before);
        observe(db, [b], repo.head, { observedAt: iso(-11 * 60_000) });
        const before2 = snapshot(db);
        refusedWith(await batch(db, { task_ids: [b], head_sha: repo.head, verdict: 'pass' }), 'subagent_session_unavailable');
        assert.deepEqual(snapshot(db), before2);
      } finally {
        db.close();
      }
    });

    it('refuses empty or malformed task_ids, a verdict other than pass or fail, a bad head_sha or findings', async () => {
      const { db, issue } = batchDb();
      try {
        const a = seedQueued(db, issue, repo.base);
        observe(db, [a], repo.head);
        const before = snapshot(db);
        const bad: Array<Record<string, unknown>> = [
          { task_ids: [], head_sha: repo.head, verdict: 'pass' },
          { task_ids: 'x', head_sha: repo.head, verdict: 'pass' },
          { task_ids: [0], head_sha: repo.head, verdict: 'pass' },
          { task_ids: [a], head_sha: repo.head, verdict: 'waived' },
          { task_ids: [a], head_sha: repo.head, verdict: 'PASS' },
          { task_ids: [a], head_sha: repo.head },
          { task_ids: [a], head_sha: 'not-a-sha', verdict: 'pass' },
          { task_ids: [a], head_sha: repo.head, verdict: 'pass', feature_branch: ' ' },
          { task_ids: [a], head_sha: repo.head, verdict: 'fail', findings: [{ probe_cmd: 'x' }] },
        ];
        for (const args of bad) refusedWith(await batch(db, args), 'invalid_args');
        assert.deepEqual(snapshot(db), before);
      } finally {
        db.close();
      }
    });

    it('refuses the whole group when any task fails the allowlist, naming each one', async () => {
      const { db, issue } = batchDb();
      try {
        const good = seedQueued(db, issue, repo.base);
        const open = seedQueued(db, issue, repo.base, { status: 'completed' });
        const truest = seedQueued(db, issue, repo.base, { mode: 'truest' });
        const unqueued = seedTask(db, issue, { repo: 'app', commit: repo.base });
        const reviewed = seedQueued(db, issue, repo.base);
        assert.ok(!(await observedBatch(db, [reviewed], repo.head, 'pass')).isError);
        const offHead = seedQueued(db, issue, repo.side);
        // tasks.repo references repos.name, so an unresolvable repo is a task and issue with none.
        const repoless = seedQueued(db, issue, repo.base, { repo: null });
        const missing = 999_999;
        const group = [good, open, truest, unqueued, reviewed, offHead, repoless, missing];
        observe(db, group, repo.head);
        const before = snapshot(db);
        const body = refusedWith(await batch(db, { task_ids: group, head_sha: repo.head, verdict: 'pass' }), 'task_not_batchable');
        const reasons = Object.fromEntries((body.tasks ?? []).map((t) => [t.task_id, t.reason.split(/[\s:]/)[0]]));
        assert.deepEqual(reasons, {
          [open]: 'not_closed',
          [truest]: 'not_agile',
          [unqueued]: 'not_queued',
          [reviewed]: 'already_batch_reviewed',
          [offHead]: 'not_ancestor',
          [repoless]: 'repo_unknown',
          [missing]: 'not_found',
        });
        assert.deepEqual(snapshot(db), before, 'nothing is written, the observation included');
        assert.ok(ids(await queueOk(db)).includes(good), 'the good task stays queued');
      } finally {
        db.close();
      }
    });

    it('the ancestor check reads the task\'s repo: a commit absent from it is not an ancestor', async () => {
      const { db, issue } = batchDb();
      try {
        const a = seedQueued(db, issue, repo.base);
        const foreign = seedQueued(db, issue, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
        observe(db, [a, foreign], repo.head);
        const body = refusedWith(await batch(db, { task_ids: [a, foreign], head_sha: repo.head, verdict: 'pass' }), 'task_not_batchable');
        assert.deepEqual(body.tasks?.map((t) => t.task_id), [foreign]);
        assert.match(body.tasks[0].reason, /^not_ancestor/);
        const later = seedQueued(db, issue, repo.head);
        observe(db, [later], repo.base);
        const behind = refusedWith(await batch(db, { task_ids: [later], head_sha: repo.base, verdict: 'pass' }), 'task_not_batchable');
        assert.match(behind.tasks![0].reason, /^not_ancestor/, 'a head that predates the task\'s commit does not contain it');
        assert.equal(batchRows(db).length, 0);
      } finally {
        db.close();
      }
    });
  });

  describe('SC3: batch-reviewed leaves review_queue, agile_review_queued and issue_close\'s refusal', () => {
    it('a batch-reviewed task leaves all three; its queued sibling stays in all three', async () => {
      const { db, issue } = batchDb();
      try {
        const reviewed = seedQueued(db, issue, repo.base, { updatedAt: iso(-25 * HOUR) });
        const queued = seedQueued(db, issue, repo.head, { updatedAt: iso(-25 * HOUR) });
        assert.ok(!(await observedBatch(db, [reviewed], repo.head, 'pass')).isError);

        assert.deepEqual(ids(await queueOk(db)), [queued]);

        const contract = DATA_CONTRACTS.filter(isSqlContract).find((c): c is SqlContract => c.id === 'agile_review_queued')!;
        const report = runDataContracts(trajectoryDbReader(db), [contract], { env: {} });
        assert.equal(report.violations.find((v) => v.id === 'agile_review_queued')?.actual, 1);

        assert.deepEqual(closedTasksWithoutReview(db, issue).map((t) => t.id), [queued]);
        const _spawnFn = () => ({ status: 0, stdout: '', stderr: '' });
        const closeIssue = async () =>
          (await issueTools(db, '/tmp/.claude/tmb/trajectory.db').handlers['issue_close']({ agent: 'bro', issue_id: String(issue), _spawnFn })) as RawResult;
        const refused = await closeIssue();
        assert.equal(refused.isError, true);
        const body = JSON.parse(refused.content[0].text) as { error: string; tasks: Array<{ task_id: number }> };
        assert.equal(body.error, 'tasks_without_review');
        assert.deepEqual(body.tasks.map((t) => t.task_id), [queued]);

        assert.ok(!(await observedBatch(db, [queued], repo.head, 'pass')).isError);
        assert.equal(runDataContracts(trajectoryDbReader(db), [contract], { env: {} }).violations.length, 0);
        const closed = await closeIssue();
        assert.ok(!closed.isError, closed.content[0].text);
      } finally {
        db.close();
      }
    });

    it('a failed batch verdict leaves the task in all three', async () => {
      const { db, issue } = batchDb();
      try {
        const a = seedQueued(db, issue, repo.base, { updatedAt: iso(-25 * HOUR) });
        assert.ok(!(await observedBatch(db, [a], repo.head, 'fail')).isError);
        assert.deepEqual(ids(await queueOk(db)), [a]);
        const contract = DATA_CONTRACTS.filter(isSqlContract).find((c): c is SqlContract => c.id === 'agile_review_queued')!;
        assert.equal(runDataContracts(trajectoryDbReader(db), [contract], { env: {} }).violations.find((v) => v.id === 'agile_review_queued')?.actual, 1);
        assert.deepEqual(closedTasksWithoutReview(db, issue).map((t) => t.id), [a]);
      } finally {
        db.close();
      }
    });

    it('a pass row from any node but code-reviewer, or naming another commit, does not batch-review', async () => {
      const { db, issue } = batchDb();
      try {
        const a = seedQueued(db, issue, repo.base);
        const forge = (fromNode: string, commit: string) =>
          db.run(
            `INSERT INTO audit (issue_id, from_node, event_type, summary, content_json, created_at) VALUES (?, ?, 'review_batch_recorded', 'f', ?, ?)`,
            [issue, fromNode, JSON.stringify({ task_ids: [a], commit_shas: [commit], verdict: 'pass' }), iso()],
          );
        forge('bro', repo.base);
        forge('code-reviewer', repo.head);
        db.run(
          `INSERT INTO audit (issue_id, from_node, event_type, summary, content_json, created_at) VALUES (?, 'code-reviewer', 'review_batch_recorded', 'bad', 'not json', ?)`,
          [issue, iso()],
        );
        assert.deepEqual(ids(await queueOk(db)), [a]);
      } finally {
        db.close();
      }
    });
  });
});
