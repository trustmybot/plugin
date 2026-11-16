// review_queue (GH 2225 A3): the unreviewed agile closes, grouped by declared
// files[] overlap, with the doctor's agile_review_queued membership.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { TrajectoryDB } from '../db.js';
import { tempDB } from './helpers.js';
import { DATA_CONTRACTS, isSqlContract, type SqlContract } from '../data-contracts.js';
import { runDataContracts, trajectoryDbReader } from '../tools/trajectory-doctor.js';
import { groupQueuedTasks, pathsOverlap, reviewQueueTools } from '../tools/review-queue.js';

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
