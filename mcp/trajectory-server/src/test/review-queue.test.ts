// review_queue (GH 2225 A3): the unreviewed agile closes, grouped by declared
// files[] overlap, with the doctor's agile_review_queued membership.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TrajectoryDB } from '../db.js';
import { CLOSE_LINTS_PATH } from '../hooks/lib/lint-fingerprint.js';
import { VERIFICATION_DEFAULTS_FILE } from '../tools/verification-defaults.js';
import { tempDB } from './helpers.js';
import { DATA_CONTRACTS, isSqlContract, type SqlContract } from '../data-contracts.js';
import { runDataContracts, trajectoryDbReader } from '../tools/trajectory-doctor.js';
import { groupQueuedTasks, pathsOverlap, reviewQueueTools } from '../tools/review-queue.js';
import { AGILE_QUEUED_SQL, reviewBatchKey } from '../review-sql.js';
import { closedTasksWithoutReview } from '../tools/lifecycle.js';
import { SUITE_LOCK_HELD_ENV } from '../suite-lock.js';
import { issueTools } from '../tools/issues.js';
import { __setGitAsyncRunnerForTests, __setGitRunnerForTests } from '../utils/git-run.js';
import { spawnAsync } from '../utils/spawn-async.js';

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

  // The bro review_batch_handoff row a review_batch_record call cites, as review_batch_handoff writes it.
  function handOff(db: TrajectoryDB, taskIds: number[], headSha: string, opts: { fromNode?: string; featureBranch?: string } = {}): number {
    const res = db.run(
      `INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
       VALUES (-1, ?, ?, 'review_batch_handoff', 'handoff', ?, ?)`,
      [
        opts.featureBranch ?? 'feat/agile',
        opts.fromNode ?? 'bro',
        JSON.stringify({ feature_branch: opts.featureBranch ?? 'feat/agile', head_sha: headSha.toLowerCase(), task_ids: [...new Set(taskIds)].sort((a, b) => a - b) }),
        iso(),
      ],
    );
    return Number(res.lastInsertRowid);
  }

  const newestHandoff = (db: TrajectoryDB): number | undefined =>
    db.get<{ id: number | null }>(`SELECT MAX(id) AS id FROM audit WHERE event_type = 'review_batch_handoff'`)?.id ?? undefined;

  // The row the reviewer-identity-observe hook writes for a review_batch_record call, after bro's hand-off of the same group.
  function observe(db: TrajectoryDB, taskIds: number[], headSha: string, opts: { agentId?: string; observedAt?: string } = {}): number {
    handOff(db, taskIds, headSha);
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

  // Cites the newest hand-off unless args name batch_handoff_id (undefined included).
  async function batch(db: TrajectoryDB, args: Record<string, unknown>): Promise<RawResult> {
    return (await reviewQueueTools(db).handlers['review_batch_record']({
      agent: 'code-reviewer',
      feature_branch: 'feat/agile',
      ...('batch_handoff_id' in args ? {} : { batch_handoff_id: newestHandoff(db) }),
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

    it('T6a SC5: refuses a call citing no batch_handoff_id, an unknown or non-bro one, or a hand-off of other tasks, head or branch', async () => {
      const { db, issue } = batchDb();
      try {
        const a = seedQueued(db, issue, repo.base);
        const b = seedQueued(db, issue, repo.head);
        observe(db, [a, b], repo.head);
        const matching = newestHandoff(db)!;
        const forged = handOff(db, [a, b], repo.head, { fromNode: 'code-reviewer' });
        const otherTasks = handOff(db, [a], repo.head);
        const otherHead = handOff(db, [a, b], repo.base);
        const otherBranch = handOff(db, [a, b], repo.head, { featureBranch: 'feat/other' });
        const before = snapshot(db);
        const call = { task_ids: [a, b], head_sha: repo.head, verdict: 'pass' };
        for (const batch_handoff_id of [undefined, 0, 'x', -3]) refusedWith(await batch(db, { ...call, batch_handoff_id }), 'invalid_args');
        refusedWith(await batch(db, { ...call, batch_handoff_id: 999_999 }), 'batch_handoff_unknown');
        refusedWith(await batch(db, { ...call, batch_handoff_id: forged }), 'batch_handoff_unknown');
        for (const id of [otherTasks, otherHead, otherBranch]) refusedWith(await batch(db, { ...call, batch_handoff_id: id }), 'batch_handoff_mismatch');
        assert.deepEqual(snapshot(db), before, 'nothing is written, the observation included');
        const r = await batch(db, { ...call, batch_handoff_id: matching });
        assert.ok(!r.isError, r.content[0].text);
        assert.equal(batchRows(db)[0].content['batch_handoff_id'], matching);
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

  describe('GH 2225 T5: review_waive_record', () => {
    const FEATURE = 'feat/agile';
    const ANSWER = 'Yes, merge feat/agile without the grouped review';

    // A queued task cli feature-merge merged onto <branch>.
    function seedMerged(db: TrajectoryDB, issue: number, commit: string, branch = FEATURE, opts: SeedOpts = {}): number {
      const id = seedQueued(db, issue, commit, opts);
      db.run(
        `INSERT INTO audit (issue_id, from_node, event_type, summary, content_json, created_at) VALUES (?, 'bro', 'feature_branch_merged', 'm', ?, ?)`,
        [issue, JSON.stringify({ task_id: id, feature_branch: branch, commit_sha: commit, rebased: false }), iso()],
      );
      return id;
    }

    async function waive(db: TrajectoryDB, args: Record<string, unknown> = {}): Promise<RawResult> {
      return (await reviewQueueTools(db).handlers['review_waive_record']({ agent: 'bro', feature_branch: FEATURE, human_answer: ANSWER, ...args })) as RawResult;
    }

    type WaiverRow = { from_node: string; branch_id: string | null; issue_id: number; content: Record<string, unknown> };
    const waiverRows = (db: TrajectoryDB): WaiverRow[] =>
      db
        .all<{ from_node: string; branch_id: string | null; issue_id: number; content_json: string }>(
          `SELECT from_node, branch_id, issue_id, content_json FROM audit WHERE event_type = 'review_waived' ORDER BY id`,
        )
        .map((r) => ({ from_node: r.from_node, branch_id: r.branch_id, issue_id: r.issue_id, content: JSON.parse(r.content_json) as Record<string, unknown> }));

    const auditCount = (db: TrajectoryDB): number => db.get<{ n: number }>('SELECT COUNT(*) AS n FROM audit')!.n;

    describe('SC1: one bro row snapshots the branch\'s queued tasks; a refused call writes nothing', () => {
      it('writes one review_waived row naming every queued task of the branch at its commit, and no other task', async () => {
        const { db, issue } = batchDb();
        try {
          const a = seedMerged(db, issue, repo.base);
          const b = seedMerged(db, issue, repo.head);
          const reviewed = seedMerged(db, issue, repo.base);
          assert.ok(!(await observedBatch(db, [reviewed], repo.head, 'pass')).isError);
          const elsewhere = seedMerged(db, issue, repo.base, 'feat/agile-other');
          const unmerged = seedQueued(db, issue, repo.base);
          const before = auditCount(db);
          const r = await waive(db);
          assert.ok(!r.isError, r.content[0].text);
          assert.deepEqual(JSON.parse(r.content[0].text), {
            audit_id: (JSON.parse(r.content[0].text) as { audit_id: number }).audit_id,
            feature_branch: FEATURE,
            task_ids: [a, b],
            commit_shas: [repo.base, repo.head],
          });
          assert.ok(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit WHERE event_type = 'review_waived'`)!.n > 0);
          assert.equal(auditCount(db), before + 1, 'exactly one row');
          assert.deepEqual(waiverRows(db), [
            {
              from_node: 'bro',
              branch_id: FEATURE,
              issue_id: issue,
              content: { feature_branch: FEATURE, task_ids: [a, b], commit_shas: [repo.base, repo.head], human_answer: ANSWER },
            },
          ]);
          assert.deepEqual(ids(await queueOk(db)), [elsewhere, unmerged].sort((x, y) => x - y));
        } finally {
          db.close();
        }
      });

      it('refuses a caller other than bro, an empty human_answer or feature_branch, and a branch with no queued task', async () => {
        const { db, issue } = batchDb();
        try {
          seedMerged(db, issue, repo.base);
          const before = auditCount(db);
          for (const agent of ['swe', 'code-reviewer', 'pm']) {
            const body = refusedWith(await waive(db, { agent }), 'forbidden');
            assert.deepEqual((body as unknown as { allowed_roles: string[] }).allowed_roles, ['bro']);
          }
          for (const human_answer of ['', '   ', undefined, 42]) refusedWith(await waive(db, { human_answer }), 'invalid_args');
          for (const feature_branch of ['', ' ', undefined]) refusedWith(await waive(db, { feature_branch }), 'invalid_args');
          refusedWith(await waive(db, { feature_branch: 'feat/none' }), 'no_queued_task');
          assert.equal(auditCount(db), before, 'nothing is written');
          assert.ok(!(await waive(db)).isError);
          const after = auditCount(db);
          refusedWith(await waive(db), 'no_queued_task');
          assert.equal(auditCount(db), after, 'a second waiver with nothing left queued writes nothing');
        } finally {
          db.close();
        }
      });
    });

    describe('SC2: a waived task leaves review_queue, agile_review_queued and issue_close\'s refusal', () => {
      it('drops the waived tasks from all three and refuses them to review_batch_record; a task merged after the waiver stays queued', async () => {
        const { db, issue } = batchDb();
        try {
          const a = seedMerged(db, issue, repo.base, FEATURE, { updatedAt: iso(-25 * HOUR) });
          assert.ok(!(await waive(db)).isError);
          const later = seedMerged(db, issue, repo.head, FEATURE, { updatedAt: iso(-25 * HOUR) });

          assert.deepEqual(ids(await queueOk(db)), [later]);
          const contract = DATA_CONTRACTS.filter(isSqlContract).find((c): c is SqlContract => c.id === 'agile_review_queued')!;
          assert.equal(runDataContracts(trajectoryDbReader(db), [contract], { env: {} }).violations.find((v) => v.id === 'agile_review_queued')?.actual, 1);
          assert.deepEqual(closedTasksWithoutReview(db, issue).map((t) => t.id), [later]);
          assert.ok(pushAdmits(db, a), 'the review_queued row stays, so the push guard still admits the waived commit');

          observe(db, [a], repo.head);
          const body = refusedWith(await batch(db, { task_ids: [a], head_sha: repo.head, verdict: 'pass' }), 'task_not_batchable');
          assert.deepEqual(body.tasks?.map((t) => [t.task_id, t.reason.split(':')[0]]), [[a, 'already_waived']]);
          assert.equal(batchRows(db).length, 0);

          assert.ok(!(await waive(db)).isError);
          assert.equal(runDataContracts(trajectoryDbReader(db), [contract], { env: {} }).violations.length, 0);
          assert.equal((await queueOk(db)).total, 0);
          const _spawnFn = () => ({ status: 0, stdout: '', stderr: '' });
          const closed = (await issueTools(db, '/tmp/.claude/tmb/trajectory.db').handlers['issue_close']({ agent: 'bro', issue_id: String(issue), _spawnFn })) as RawResult;
          assert.ok(!closed.isError, closed.content[0].text);
        } finally {
          db.close();
        }
      });

      it('a waived task whose commit moves is queued again; a waiver row from another node, or naming another commit, waives nothing', async () => {
        const { db, issue } = batchDb();
        try {
          const a = seedMerged(db, issue, repo.base);
          assert.ok(!(await waive(db)).isError);
          db.run('UPDATE tasks SET commit_sha = ? WHERE id = ?', [repo.head, a]);
          db.run(
            `INSERT INTO audit (issue_id, from_node, event_type, summary, content_json, created_at) VALUES (?, 'bro', 'review_queued', 'q', ?, ?)`,
            [issue, JSON.stringify({ task_id: a, commit_sha: repo.head }), iso()],
          );
          assert.deepEqual(ids(await queueOk(db)), [a]);
          const forge = (fromNode: string, commit: string) =>
            db.run(
              `INSERT INTO audit (issue_id, from_node, event_type, summary, content_json, created_at) VALUES (?, ?, 'review_waived', 'f', ?, ?)`,
              [issue, fromNode, JSON.stringify({ feature_branch: FEATURE, task_ids: [a], commit_shas: [commit], human_answer: 'Yes' }), iso()],
            );
          forge('swe', repo.head);
          forge('bro', repo.side);
          assert.deepEqual(ids(await queueOk(db)), [a]);
        } finally {
          db.close();
        }
      });
    });

    describe('F39-1: the ancestor checks run before the write transaction', () => {
      it('runs every git merge-base before the transaction opens, with refusals and the pass unchanged', async () => {
        const { db, issue } = batchDb();
        const realTransaction = db.transaction.bind(db);
        let inTransaction = false;
        db.transaction = <T>(fn: () => T): T =>
          realTransaction(() => {
            inTransaction = true;
            try {
              return fn();
            } finally {
              inTransaction = false;
            }
          });
        const ancestorRuns: boolean[] = [];
        __setGitRunnerForTests((args, options) => {
          if (args.includes('merge-base')) ancestorRuns.push(inTransaction);
          return spawnSync('git', args, { timeout: 30_000, ...options });
        });
        try {
          const a = seedQueued(db, issue, repo.base);
          const offHead = seedQueued(db, issue, repo.side);
          observe(db, [a, offHead], repo.head);
          const body = refusedWith(await batch(db, { task_ids: [a, offHead], head_sha: repo.head, verdict: 'pass' }), 'task_not_batchable');
          assert.deepEqual(body.tasks?.map((t) => [t.task_id, t.reason.split(':')[0]]), [[offHead, 'not_ancestor']]);
          assert.ok(!(await observedBatch(db, [a], repo.head, 'pass')).isError);
          assert.ok(ancestorRuns.length >= 3, `each ancestor check ran git (${ancestorRuns.length})`);
          assert.deepEqual(ancestorRuns.filter(Boolean), [], 'no git merge-base ran while the write transaction was open');
        } finally {
          __setGitRunnerForTests();
          db.close();
        }
      });
    });
  });
});

// GH 2225 T6a: review_batch_handoff, bro's hand-off of a group of queued agile
// tasks of a feature branch to one code review at the branch tip.
describe('GH 2225 T6a: review_batch_handoff', () => {
  const FEATURE = 'feat/agile';
  const SESSION = 'session0handoff01';
  const AT_HEAD_LINT = { name: 'at-head', command: 'test -n "$TMB_LINT_BASE_SHA" && grep -q c3 a.txt' };
  // main: base (a.txt, b.txt, c.txt, the close lints). feat/agile: c1 (a.txt), c2 (b.txt), c3 (a.txt), c4 (c.txt).
  // side: off base, no ancestor of feat/agile. feat/bad: off base, its close lint fails.
  // feat/suite-*: off base, a passing close lint and a stub verification-defaults suite each (feat/suite-lint-bad: a failing lint).
  const SUITE_BRANCHES = ['feat/suite-ok', 'feat/suite-bad', 'feat/suite-lint-bad', 'feat/suite-full', 'feat/suite-invalid'] as const;
  type SuiteBranch = (typeof SUITE_BRANCHES)[number];
  let repo: {
    root: string;
    git: (...a: string[]) => string;
    base: string;
    c: string[];
    side: string;
    bad: string;
    suite: Record<SuiteBranch, string>;
    markers: string;
  };

  before(() => {
    const root = mkdtempSync(join(tmpdir(), 'batch-handoff-'));
    const markers = mkdtempSync(join(tmpdir(), 'batch-handoff-markers-'));
    const git = (...a: string[]) => execFileSync('git', ['-C', root, ...a], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }).toString().trim();
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@t.t');
    git('config', 'user.name', 't');
    git('config', 'commit.gpgsign', 'false');
    const commit = (files: Record<string, string>, message: string): string => {
      for (const [path, text] of Object.entries(files)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), text);
      }
      git('add', '.');
      git('commit', '-q', '-m', message);
      return git('rev-parse', 'HEAD');
    };
    const lints = (lint: { name: string; command: string }) => JSON.stringify({ lints: [lint], fingerprint_inputs: [] });
    const base = commit({ 'a.txt': 'base\n', 'b.txt': 'base\n', 'c.txt': 'base\n', [CLOSE_LINTS_PATH]: lints(AT_HEAD_LINT) }, 'base');
    git('checkout', '-q', '-b', FEATURE);
    const c = [commit({ 'a.txt': 'c1\n' }, 'c1'), commit({ 'b.txt': 'c2\n' }, 'c2'), commit({ 'a.txt': 'c3\n' }, 'c3'), commit({ 'c.txt': 'c4\n' }, 'c4')];
    git('checkout', '-q', '-b', 'side', base);
    const side = commit({ 'side.txt': 'side\n' }, 'side');
    git('checkout', '-q', '-b', 'feat/bad', base);
    const bad = commit({ 'd.txt': 'bad\n', [CLOSE_LINTS_PATH]: lints({ name: 'fails', command: 'echo broken; exit 3' }) }, 'bad');
    const passingLint = lints({ name: 'ok', command: 'true' });
    const defaults = (commands: string[]) => JSON.stringify({ version: 1, commands });
    const suiteFiles: Record<SuiteBranch, Record<string, string>> = {
      // suite.txt exists only at this tip, so the first command passes only in a checkout of it.
      'feat/suite-ok': { 'suite.txt': 'tip\n', [CLOSE_LINTS_PATH]: passingLint, [VERIFICATION_DEFAULTS_FILE]: defaults(['test -f suite.txt && echo first', 'echo second']) },
      'feat/suite-bad': {
        [CLOSE_LINTS_PATH]: passingLint,
        [VERIFICATION_DEFAULTS_FILE]: defaults(['echo first ok', 'echo suite broke; exit 5', `touch '${join(markers, 'after-failure')}'`]),
      },
      'feat/suite-lint-bad': {
        [CLOSE_LINTS_PATH]: lints({ name: 'fails', command: 'exit 4' }),
        [VERIFICATION_DEFAULTS_FILE]: defaults([`touch '${join(markers, 'lint-bad-suite')}'`]),
      },
      // A tests/run-all.sh command is a full suite, so it runs holding a suite slot.
      'feat/suite-full': {
        'tests/run-all.sh': 'test -n "$TMB_SUITE_LOCK_HELD"\n',
        [CLOSE_LINTS_PATH]: passingLint,
        [VERIFICATION_DEFAULTS_FILE]: defaults(['bash tests/run-all.sh']),
      },
      'feat/suite-invalid': { [CLOSE_LINTS_PATH]: passingLint, [VERIFICATION_DEFAULTS_FILE]: JSON.stringify({ version: 2, commands: ['true'] }) },
    };
    const suite = {} as Record<SuiteBranch, string>;
    for (const branch of SUITE_BRANCHES) {
      git('checkout', '-q', '-b', branch, base);
      suite[branch] = commit(suiteFiles[branch], branch);
    }
    git('checkout', '-q', 'main');
    repo = { root, git, base, c, side, bad, suite, markers };
  });

  after(() => {
    rmSync(repo.root, { recursive: true, force: true });
    rmSync(repo.markers, { recursive: true, force: true });
  });

  function handoffDb(): { db: TrajectoryDB; issue: number } {
    const db = tempDB();
    db.run(`INSERT INTO repos (name, path, target_branch) VALUES ('app', ?, 'main')`, [repo.root]);
    return { db, issue: seedIssue(db) };
  }

  // A queued agile task cli.js feature-merge moved onto <branch> (null: never merged onto one).
  function seedMerged(db: TrajectoryDB, issue: number, base: string, commit: string, branch: string | null = FEATURE): number {
    const id = seedTask(db, issue, { repo: 'app', base, commit });
    const row = `INSERT INTO audit (issue_id, from_node, event_type, summary, content_json, created_at) VALUES (?, 'bro', ?, 's', ?, ?)`;
    db.run(row, [issue, 'review_queued', JSON.stringify({ task_id: id, commit_sha: commit }), iso()]);
    if (branch !== null) db.run(row, [issue, 'feature_branch_merged', JSON.stringify({ task_id: id, feature_branch: branch, commit_sha: commit, rebased: false }), iso()]);
    return id;
  }

  // t1..t4 on feat/agile at c1..c4, each based on the commit before it.
  function seedBranch(db: TrajectoryDB, issue: number): number[] {
    return repo.c.map((commit, i) => seedMerged(db, issue, i === 0 ? repo.base : repo.c[i - 1], commit));
  }

  async function handoff(db: TrajectoryDB, args: Record<string, unknown>): Promise<RawResult> {
    return (await reviewQueueTools(db).handlers['review_batch_handoff']({ agent: 'bro', feature_branch: FEATURE, session_id: SESSION, ...args })) as RawResult;
  }

  type Refusal = { error: string; tasks?: Array<{ task_id: number; reason: string; shares_with?: number[]; files?: string[] }> };
  function refused(r: RawResult, error: string): Refusal {
    assert.equal(r.isError, true, r.content[0].text);
    const body = JSON.parse(r.content[0].text) as Refusal;
    assert.equal(body.error, error, r.content[0].text);
    return body;
  }

  const auditCount = (db: TrajectoryDB): number => db.get<{ n: number }>('SELECT COUNT(*) AS n FROM audit')!.n;
  const handoffRows = (db: TrajectoryDB): number => db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit WHERE event_type = 'review_batch_handoff'`)!.n;

  // The temporary lint worktree is gone: git lists only the main checkout and no review-batch dir is left.
  function assertNoLintWorktree(): void {
    assert.equal(repo.git('worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length, 1);
    const dir = join(repo.root, '.claude', 'worktrees');
    assert.deepEqual(existsSync(dir) ? readdirSync(dir).filter((d) => d.startsWith('review-batch.')) : [], []);
  }

  describe('SC1: one bro row at the branch tip with its close-lint run, and a batch-anchored reviewer spawn', () => {
    it('hands off a group that keeps every shared file, its lints run at the tip in a temporary worktree', async () => {
      const { db, issue } = handoffDb();
      try {
        const [t1, , t3] = seedBranch(db, issue);
        const before = auditCount(db);
        const r = await handoff(db, { task_ids: [t3, t1] });
        assert.ok(!r.isError, r.content[0].text);
        const out = JSON.parse(r.content[0].text) as {
          batch_handoff_id: number;
          head_sha: string;
          base_sha: string;
          task_ids: number[];
          reviewer_spawn: { prompt: string; effort: string; subagent_type: string };
        };
        const head = repo.c[3];
        assert.notEqual(out.batch_handoff_id, null);
        assert.notEqual(out.head_sha, null);
        assert.notEqual(out.base_sha, null);
        assert.equal(out.head_sha, head);
        assert.equal(out.base_sha, repo.base);
        assert.deepEqual(out.task_ids, [t1, t3]);
        assert.equal(auditCount(db), before + 1, 'exactly one row');

        const row = db.get<{ id: number; from_node: string; branch_id: string; issue_id: number; content_json: string }>(
          `SELECT id, from_node, branch_id, issue_id, content_json FROM audit WHERE event_type = 'review_batch_handoff'`,
        )!;
        assert.equal(row.id, out.batch_handoff_id);
        assert.deepEqual([row.from_node, row.branch_id, row.issue_id], ['bro', FEATURE, issue]);
        const content = JSON.parse(row.content_json) as {
          lint: { fingerprint: string | null; exit_code: number; results: Array<{ name: string; exit_code: number }> };
          [k: string]: unknown;
        };
        assert.notEqual(content.lint.fingerprint, null);
        assert.ok(typeof content.lint.fingerprint === 'string' && content.lint.fingerprint.length > 0);
        assert.deepEqual(
          { ...content, lint: { exit_code: content.lint.exit_code, results: content.lint.results.map(({ name, exit_code }) => ({ name, exit_code })) } },
          {
            feature_branch: FEATURE,
            head_sha: head,
            base_sha: repo.base,
            task_ids: [t1, t3],
            commit_shas: [repo.c[0], repo.c[2]],
            repo: 'app',
            lint: { exit_code: 0, results: [{ name: 'at-head', exit_code: 0 }] },
            suite: { commands: [], passed: true, note: `no ${VERIFICATION_DEFAULTS_FILE} at ${head}, so no suite ran` },
          },
          'the lint passed, so it ran on a checkout of the tip, not the main checkout',
        );
        assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM lint_runs')!.n, 0, 'the batch lint run is not recorded in lint_runs');
        assertNoLintWorktree();

        const anchors = Object.fromEntries(out.reviewer_spawn.prompt.split('\n')[0].split(' ').map((kv) => kv.split('=') as [string, string]));
        assert.deepEqual(anchors, {
          batch_handoff_id: String(out.batch_handoff_id),
          feature_branch: FEATURE,
          head_sha: head,
          repo: 'app',
          repo_path: repo.root,
          subagent_session_id: SESSION,
        });
        assert.equal(out.reviewer_spawn.subagent_type, 'tmb:code-reviewer');
        assert.equal(out.reviewer_spawn.effort, 'medium');
      } finally {
        db.close();
      }
    });
  });

  describe('F81-2: the lint worktree git calls do not block the server', () => {
    it('adds, removes and prunes the temporary worktree through the async git runner', async () => {
      const { db, issue } = handoffDb();
      const worktreeCmd = (args: string[]): string | null => {
        const at = args.indexOf('worktree');
        return at === -1 ? null : args[at + 1];
      };
      const syncWorktree: string[] = [];
      const asyncWorktree: string[] = [];
      __setGitRunnerForTests((args, options) => {
        const cmd = worktreeCmd(args);
        if (cmd) syncWorktree.push(cmd);
        return spawnSync('git', args, { timeout: 30_000, ...options });
      });
      __setGitAsyncRunnerForTests((args, options) => {
        const cmd = worktreeCmd(args);
        if (cmd) asyncWorktree.push(cmd);
        return spawnAsync('git', args, options);
      });
      try {
        const [t1, , t3] = seedBranch(db, issue);
        const r = await handoff(db, { task_ids: [t1, t3] });
        assert.ok(!r.isError, r.content[0].text);
        assert.deepEqual(asyncWorktree, ['add', 'remove', 'prune']);
        assert.deepEqual(syncWorktree, [], 'no worktree git call ran on the blocking runner');
        assertNoLintWorktree();
      } finally {
        __setGitRunnerForTests();
        db.close();
      }
    });
  });

  describe('SC2: a refused hand-off writes nothing', () => {
    it('refuses a caller other than bro, and missing or malformed arguments', async () => {
      const { db, issue } = handoffDb();
      try {
        const [t1] = seedBranch(db, issue);
        const before = auditCount(db);
        for (const agent of ['swe', 'code-reviewer']) refused(await handoff(db, { agent, task_ids: [t1] }), 'forbidden');
        const bad: Array<Record<string, unknown>> = [
          { task_ids: [] },
          { task_ids: ['x'] },
          { task_ids: [t1], session_id: undefined },
          { task_ids: [t1], session_id: 'bad id' },
          { task_ids: [t1], feature_branch: ' ' },
        ];
        for (const args of bad) refused(await handoff(db, args), 'invalid_args');
        assert.equal(auditCount(db), before);
      } finally {
        db.close();
      }
    });

    it('refuses a task not queued on the branch: unknown, never merged onto it, or merged onto another', async () => {
      const { db, issue } = handoffDb();
      try {
        const [t1] = seedBranch(db, issue);
        const unmerged = seedMerged(db, issue, repo.base, repo.c[0], null);
        const elsewhere = seedMerged(db, issue, repo.base, repo.c[0], 'feat/other');
        const before = auditCount(db);
        const body = refused(await handoff(db, { task_ids: [t1, unmerged, elsewhere, 999_999] }), 'task_not_queued');
        assert.deepEqual(body.tasks?.map((t) => t.task_id), [unmerged, elsewhere, 999_999]);
        assert.equal(auditCount(db), before);
      } finally {
        db.close();
      }
    });

    it('refuses a task whose commit is no ancestor of the branch tip', async () => {
      const { db, issue } = handoffDb();
      try {
        const offTip = seedMerged(db, issue, repo.base, repo.side);
        const before = auditCount(db);
        const body = refused(await handoff(db, { task_ids: [offTip] }), 'not_ancestor');
        assert.deepEqual(body.tasks?.map((t) => [t.task_id, t.reason.split(':')[0]]), [[offTip, 'not_ancestor']]);
        assert.equal(auditCount(db), before);
      } finally {
        db.close();
      }
    });

    it('refuses a group that leaves out a queued task sharing a changed file, naming the task, the group tasks and the files', async () => {
      const { db, issue } = handoffDb();
      try {
        const [t1, t2, t3, t4] = seedBranch(db, issue);
        const before = auditCount(db);
        for (const group of [[t1], [t1, t2, t4], [t3]]) {
          const body = refused(await handoff(db, { task_ids: group }), 'group_splits_shared_file');
          const leftOut = group.includes(t1) ? t3 : t1;
          assert.deepEqual(
            body.tasks?.map(({ task_id, shares_with, files }) => ({ task_id, shares_with, files })),
            [{ task_id: leftOut, shares_with: [leftOut === t3 ? t1 : t3], files: ['a.txt'] }],
          );
        }
        assert.equal(auditCount(db), before);
        assertNoLintWorktree();
        assert.ok(!(await handoff(db, { task_ids: [t2] })).isError, 'a task sharing no changed file may go alone');
        assert.ok(!(await handoff(db, { task_ids: [t1, t2, t3, t4] })).isError, 'the whole branch keeps every shared file');
      } finally {
        db.close();
      }
    });

    it('refuses when the close lints fail on the branch tip, and removes the lint worktree', async () => {
      const { db, issue } = handoffDb();
      try {
        const t = seedMerged(db, issue, repo.base, repo.bad, 'feat/bad');
        const before = auditCount(db);
        const r = await handoff(db, { feature_branch: 'feat/bad', task_ids: [t] });
        refused(r, 'lint_failed');
        assert.match(r.content[0].text, /Lint fails exited 3/);
        assert.equal(auditCount(db), before);
        assertNoLintWorktree();
      } finally {
        db.close();
      }
    });
  });

  // Sets each process.env key for the call (undefined unsets it), restoring the old values after.
  async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
    const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
    const apply = (values: Record<string, string | undefined>): void => {
      for (const [k, v] of Object.entries(values)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    };
    apply(vars);
    try {
      return await fn();
    } finally {
      apply(saved);
    }
  }

  async function suiteHandoff(db: TrajectoryDB, issue: number, branch: SuiteBranch): Promise<RawResult> {
    const t = seedMerged(db, issue, repo.base, repo.suite[branch], branch);
    return handoff(db, { feature_branch: branch, task_ids: [t] });
  }

  type SuiteBody = { suite?: { commands: string[]; passed: boolean; failed_command?: string; exit_code?: number; tail?: string } };

  describe('decision #320 item 2: the verification-defaults suite runs at the tip after the close lints', () => {
    it('runs every command in the temporary worktree and records suite {commands, passed} in the result and the row', async () => {
      const { db, issue } = handoffDb();
      try {
        const r = await suiteHandoff(db, issue, 'feat/suite-ok');
        assert.ok(!r.isError, r.content[0].text);
        const commands = ['test -f suite.txt && echo first', 'echo second'];
        assert.deepEqual((JSON.parse(r.content[0].text) as SuiteBody).suite, { commands, passed: true });
        const row = db.get<{ passed_type: string; commands: string }>(
          `SELECT json_type(content_json, '$.suite.passed') AS passed_type, json_extract(content_json, '$.suite.commands') AS commands
             FROM audit WHERE event_type = 'review_batch_handoff'`,
        )!;
        assert.equal(row.passed_type, 'true', 'the row records $.suite.passed true');
        assert.deepEqual(JSON.parse(row.commands), commands);
        assertNoLintWorktree();
      } finally {
        db.close();
      }
    });

    it('refuses suite_failed with the failing command and its output tail, runs no later command, and writes nothing', async () => {
      const { db, issue } = handoffDb();
      try {
        const r = await suiteHandoff(db, issue, 'feat/suite-bad');
        const body = refused(r, 'suite_failed') as Refusal & SuiteBody;
        assert.equal(body.suite?.passed, false);
        assert.equal(body.suite?.failed_command, 'echo suite broke; exit 5');
        assert.equal(body.suite?.exit_code, 5);
        assert.equal(body.suite?.tail, 'suite broke');
        assert.equal(existsSync(join(repo.markers, 'after-failure')), false, 'the command after the failing one did not run');
        assert.equal(handoffRows(db), 0, 'no review_batch_handoff row');
        assertNoLintWorktree();
      } finally {
        db.close();
      }
    });

    it('runs no suite when the close lints fail', async () => {
      const { db, issue } = handoffDb();
      try {
        refused(await suiteHandoff(db, issue, 'feat/suite-lint-bad'), 'lint_failed');
        assert.equal(existsSync(join(repo.markers, 'lint-bad-suite')), false);
        assertNoLintWorktree();
      } finally {
        db.close();
      }
    });

    it('runs a full-suite command holding a suite slot, and releases it after', async () => {
      const { db, issue } = handoffDb();
      const lockDir = mkdtempSync(join(tmpdir(), 'batch-handoff-lock-'));
      try {
        const r = await withEnv({ TMB_SUITE_LOCK_DIR: lockDir, [SUITE_LOCK_HELD_ENV]: undefined, TMB_TEST_SUITE_SLOTS: '1' }, () => suiteHandoff(db, issue, 'feat/suite-full'));
        assert.ok(!r.isError, r.content[0].text);
        assert.equal(existsSync(join(lockDir, 'slot-0')), false, 'the slot is released');
      } finally {
        rmSync(lockDir, { recursive: true, force: true });
        db.close();
      }
    });

    it('refuses suite_slot_busy when every suite slot stays held, and writes nothing', async () => {
      const { db, issue } = handoffDb();
      const lockDir = mkdtempSync(join(tmpdir(), 'batch-handoff-lock-'));
      try {
        mkdirSync(join(lockDir, 'slot-0'));
        const holder = { pid: process.pid, pgid: null, worktree: '/elsewhere', command: 'bash tests/run-all.sh', started: iso() };
        writeFileSync(join(lockDir, 'slot-0', 'holder'), JSON.stringify(holder));
        const env = { TMB_SUITE_LOCK_DIR: lockDir, [SUITE_LOCK_HELD_ENV]: undefined, TMB_TEST_SUITE_SLOTS: '1', TMB_VERIFICATION_TIMEOUT_S: '1' };
        refused(await withEnv(env, () => suiteHandoff(db, issue, 'feat/suite-full')), 'suite_slot_busy');
        assert.equal(handoffRows(db), 0, 'no review_batch_handoff row');
        assertNoLintWorktree();
      } finally {
        rmSync(lockDir, { recursive: true, force: true });
        db.close();
      }
    });

    it('refuses an invalid verification-defaults file at the tip', async () => {
      const { db, issue } = handoffDb();
      try {
        const r = await suiteHandoff(db, issue, 'feat/suite-invalid');
        refused(r, 'verification_defaults_invalid');
        assert.match(r.content[0].text, /version must be 1/);
      } finally {
        db.close();
      }
    });
  });

  describe('decision #320 item 4: review_queue feature_branch filter', () => {
    it('returns only the queued tasks merged onto the branch; omitted, every task', async () => {
      const { db, issue } = handoffDb();
      try {
        const onFeature = seedBranch(db, issue);
        const other = seedMerged(db, issue, repo.base, repo.side, 'feat/other');
        const unmerged = seedMerged(db, issue, repo.base, repo.side, null);
        const filtered = await queueOk(db, { feature_branch: FEATURE });
        assert.deepEqual(ids(filtered), onFeature);
        assert.equal(filtered.total, onFeature.length);
        assert.deepEqual(ids(await queueOk(db, { feature_branch: 'feat/other' })), [other]);
        assert.deepEqual(ids(await queueOk(db, { feature_branch: 'feat/none' })), []);
        assert.deepEqual(ids(await queueOk(db)), [...onFeature, other, unmerged]);
      } finally {
        db.close();
      }
    });

    it('refuses an empty or non-string feature_branch with invalid_args', async () => {
      const { db } = handoffDb();
      try {
        for (const feature_branch of ['', '  ', 42, null]) {
          const r = await queue(db, { feature_branch });
          assert.equal(r.isError, true, r.content[0].text);
          assert.equal((JSON.parse(r.content[0].text) as { error: string }).error, 'invalid_args');
        }
      } finally {
        db.close();
      }
    });
  });
});
