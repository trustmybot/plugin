// GH 2228: reconcileRemoteCloses / issue_reconcile_remote close open DB issues
// whose linked GitHub/GitLab issue is closed. Every gh/glab call goes through a
// stubbed spawn: no real CLI runs and nothing is written to a remote.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tempDB } from './helpers.js';
import type { TrajectoryDB } from '../db.js';
import { GH_RECONCILE_BATCH, reconcileRemoteCloses } from '../sync/issue-reconcile.js';
import type { SpawnFn } from '../sync/issue_sync.js';
import { issueTools } from '../tools/issues.js';
import { setRemoteSync, upsertRepoRemotes } from '../repos/remotes.js';

type RawResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type Spawned = { cmd: string; args: string[] };

interface Remote {
  gh: Map<number, 'OPEN' | 'CLOSED'>;
  gl: Map<number, 'opened' | 'closed'>;
  ghFails?: boolean;
  glFails?: Set<number>;
}

function stub(remote: Remote): { spawned: Spawned[]; spawnFn: SpawnFn } {
  const spawned: Spawned[] = [];
  const spawnFn: SpawnFn = (cmd, args) => {
    spawned.push({ cmd, args });
    if (args[0] === 'auth' && args[1] === 'status') return { status: 0, stdout: '', stderr: '' };
    if (cmd === 'gh' && args[0] === 'api' && args[1] === 'graphql') {
      if (remote.ghFails) return { status: 1, stdout: '', stderr: 'HTTP 502' };
      const query = args[args.indexOf('-f') + 1]!;
      const repository: Record<string, { state: string } | null> = {};
      for (const m of query.matchAll(/i(\d+): issue\(number: (\d+)\)/g)) {
        const state = remote.gh.get(Number(m[2]));
        repository[`i${m[1]}`] = state ? { state } : null;
      }
      const missing = Object.values(repository).some((v) => v === null);
      return {
        status: missing ? 1 : 0,
        stdout: JSON.stringify({ data: { repository }, ...(missing ? { errors: [{ type: 'NOT_FOUND' }] } : {}) }),
        stderr: missing ? 'gh: Could not resolve to an Issue' : '',
      };
    }
    if (cmd === 'glab' && args[0] === 'issue' && args[1] === 'view') {
      const iid = Number(args[2]);
      if (remote.glFails?.has(iid)) return { status: 1, stdout: '', stderr: '404 Not Found' };
      const state = remote.gl.get(iid);
      if (!state) return { status: 1, stdout: '', stderr: '404 Not Found' };
      return { status: 0, stdout: JSON.stringify({ iid, state }), stderr: '' };
    }
    throw new Error(`unexpected spawn: ${cmd} ${args.join(' ')}`);
  };
  return { spawned, spawnFn };
}

function remoteWrites(spawned: Spawned[]): Spawned[] {
  return spawned.filter(
    (s) => !(s.args[0] === 'auth' || (s.args[0] === 'api' && s.args[1] === 'graphql') || (s.args[0] === 'issue' && s.args[1] === 'view')),
  );
}

function setIssueSync(db: TrajectoryDB, value: string): void {
  db.run(`INSERT OR REPLACE INTO plugin_config (key, value_json) VALUES ('issue_sync', ?)`, [JSON.stringify(value)]);
}

function registerRepo(db: TrajectoryDB): void {
  db.run(`INSERT INTO repos (name, path) VALUES ('app', '/tmp/app')`);
  upsertRepoRemotes(db, 'app', [
    { name: 'origin', provider: 'github', url: 'https://github.com/owner/repo.git' },
    { name: 'gitlab', provider: 'gitlab', url: 'https://gitlab.com/owner/repo.git' },
  ]);
  setRemoteSync(db, 'app', ['github', 'gitlab']);
}

function seedIssue(db: TrajectoryDB, links: { gh?: number; gl?: number } = {}): number {
  const t = '2026-01-01T00:00:00.000Z';
  db.run(
    `INSERT INTO issues (objective, status, created_at, updated_at, repo, gh_iid, gl_iid) VALUES ('reconcile', 'open', ?, ?, 'app', ?, ?)`,
    [t, t, links.gh ?? null, links.gl ?? null],
  );
  return db.get<{ id: number }>('SELECT MAX(id) AS id FROM issues')!.id;
}

function seedTask(db: TrajectoryDB, issueId: number, status: string): number {
  const t = '2026-01-01T00:00:00.000Z';
  db.run(
    `INSERT INTO tasks (issue_id, branch_id, description, status, created_at, updated_at) VALUES (?, ?, 'd', ?, ?, ?)`,
    [issueId, `fix/t-${Math.random().toString(36).slice(2)}`, status, t, t],
  );
  return db.get<{ id: number }>('SELECT MAX(id) AS id FROM tasks')!.id;
}

function issueRow(db: TrajectoryDB, id: number): { status: string; closed_at: string | null; updated_at: string } {
  return db.get<{ status: string; closed_at: string | null; updated_at: string }>(
    'SELECT status, closed_at, updated_at FROM issues WHERE id = ?',
    [id],
  )!;
}

function audits(db: TrajectoryDB, type: string, issueId?: number): Array<{ issue_id: number; from_node: string; content: Record<string, unknown> }> {
  return db
    .all<{ issue_id: number; from_node: string; content_json: string }>(
      'SELECT issue_id, from_node, content_json FROM audit WHERE event_type = ? AND (? IS NULL OR issue_id = ?) ORDER BY id',
      [type, issueId ?? null, issueId ?? null],
    )
    .map((r) => ({ issue_id: r.issue_id, from_node: r.from_node, content: JSON.parse(r.content_json) as Record<string, unknown> }));
}

function snapshot(db: TrajectoryDB): string {
  return JSON.stringify({
    issues: db.all('SELECT * FROM issues ORDER BY id'),
    tasks: db.all('SELECT id, status, updated_at FROM tasks ORDER BY id'),
    audit: db.all('SELECT id, event_type FROM audit ORDER BY id'),
  });
}

let savedEnv: string | undefined;
beforeEach(() => {
  savedEnv = process.env.TMB_DISABLE_REMOTE_SYNC;
  delete process.env.TMB_DISABLE_REMOTE_SYNC;
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.TMB_DISABLE_REMOTE_SYNC;
  else process.env.TMB_DISABLE_REMOTE_SYNC = savedEnv;
});

describe('reconcileRemoteCloses (GH 2228)', () => {
  it('closes an open issue whose remote is CLOSED and has no live task; leaves remote OPEN, read errors and unlinked issues open', () => {
    const db = tempDB();
    setIssueSync(db, 'both');
    registerRepo(db);
    const closedGh = seedIssue(db, { gh: 10 });
    const openGh = seedIssue(db, { gh: 11 });
    const closedGl = seedIssue(db, { gl: 20 });
    const failedGl = seedIssue(db, { gl: 21 });
    const unlinked = seedIssue(db);
    const finishedTask = seedTask(db, closedGh, 'closed');
    const { spawned, spawnFn } = stub({
      gh: new Map([[10, 'CLOSED'], [11, 'OPEN']]),
      gl: new Map([[20, 'closed']]),
      glFails: new Set([21]),
    });

    const result = reconcileRemoteCloses(db, { _spawnFn: spawnFn });

    assert.equal(result.skipped, undefined);
    assert.equal(result.checked, 4);
    assert.deepEqual(result.closed, [
      { issue_id: closedGh, remote_kind: 'github', remote_iid: 10 },
      { issue_id: closedGl, remote_kind: 'gitlab', remote_iid: 20 },
    ]);
    assert.deepEqual(result.deferred, []);
    assert.deepEqual(result.errors.map((e) => [e.issue_id, e.remote_kind, e.remote_iid, e.reason]), [[failedGl, 'gitlab', 21, 'read_failed']]);

    for (const id of [closedGh, closedGl]) {
      const row = issueRow(db, id);
      assert.equal(row.status, 'closed');
      assert.ok(row.closed_at, 'closed_at set');
      assert.equal(row.updated_at, row.closed_at);
    }
    for (const id of [openGh, failedGl, unlinked]) assert.equal(issueRow(db, id).status, 'open', `issue ${id} stays open`);
    assert.equal(db.get<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [finishedTask])!.status, 'closed');

    assert.deepEqual(audits(db, 'issue_closed_from_remote', closedGh), [
      { issue_id: closedGh, from_node: 'bro', content: { remote_kind: 'github', remote_iid: 10 } },
    ]);
    assert.deepEqual(audits(db, 'issue_closed_from_remote').map((a) => a.issue_id), [closedGh, closedGl]);

    const graphql = spawned.filter((s) => s.cmd === 'gh' && s.args[1] === 'graphql');
    assert.equal(graphql.length, 1, 'one gh api graphql call for the repo');
    const graphqlArgs = graphql[0]!.args;
    assert.equal(graphqlArgs[graphqlArgs.indexOf('--hostname') + 1], 'github.com', 'gh api graphql targets --hostname github.com');
    assert.match(graphql[0]!.args.at(-1)!, /repository\(owner: "owner", name: "repo"\)/);
    const glView = spawned.find((s) => s.cmd === 'glab' && s.args[2] === '20')!;
    assert.deepEqual(glView.args, ['issue', 'view', '20', '-R', 'gitlab.com/owner/repo', '--output', 'json']);
    assert.deepEqual(remoteWrites(spawned), [], 'reconcile never writes to the remote');

    const again = reconcileRemoteCloses(db, { _spawnFn: spawnFn });
    assert.deepEqual(again.closed, [], 'closed issues are no longer checked');
    assert.equal(audits(db, 'issue_closed_from_remote').length, 2);
  });

  it('a failed gh batch reports every issue in it as an error and closes nothing', () => {
    const db = tempDB();
    setIssueSync(db, 'gh');
    registerRepo(db);
    const a = seedIssue(db, { gh: 1 });
    const b = seedIssue(db, { gh: 2 });
    const { spawnFn } = stub({ gh: new Map([[1, 'CLOSED'], [2, 'CLOSED']]), gl: new Map(), ghFails: true });

    const result = reconcileRemoteCloses(db, { _spawnFn: spawnFn });

    assert.deepEqual(result.closed, []);
    assert.deepEqual(result.errors.map((e) => [e.issue_id, e.reason]), [[a, 'read_failed'], [b, 'read_failed']]);
    assert.equal(issueRow(db, a).status, 'open');
    assert.equal(issueRow(db, b).status, 'open');
    assert.deepEqual(audits(db, 'issue_closed_from_remote'), []);
  });

  it('a gh alias that resolves to no issue is a not_found error for that issue only', () => {
    const db = tempDB();
    setIssueSync(db, 'gh');
    registerRepo(db);
    const gone = seedIssue(db, { gh: 404 });
    const closed = seedIssue(db, { gh: 5 });
    const { spawnFn } = stub({ gh: new Map([[5, 'CLOSED']]), gl: new Map() });

    const result = reconcileRemoteCloses(db, { _spawnFn: spawnFn });

    assert.deepEqual(result.closed.map((c) => c.issue_id), [closed]);
    assert.deepEqual(result.errors.map((e) => [e.issue_id, e.reason]), [[gone, 'not_found']]);
    assert.equal(issueRow(db, gone).status, 'open');
  });

  it('an issue linked to both remotes closes only when neither is open', () => {
    const db = tempDB();
    setIssueSync(db, 'both');
    registerRepo(db);
    const halfOpen = seedIssue(db, { gh: 7, gl: 8 });
    const bothClosed = seedIssue(db, { gh: 9, gl: 10 });
    const { spawnFn } = stub({ gh: new Map([[7, 'CLOSED'], [9, 'CLOSED']]), gl: new Map([[8, 'opened'], [10, 'closed']]) });

    const result = reconcileRemoteCloses(db, { _spawnFn: spawnFn });

    assert.deepEqual(result.closed, [{ issue_id: bothClosed, remote_kind: 'github', remote_iid: 9 }]);
    assert.equal(issueRow(db, halfOpen).status, 'open');
    assert.equal(audits(db, 'issue_closed_from_remote').length, 1);
  });

  it(`reads GitHub state in batches of at most ${GH_RECONCILE_BATCH} issue numbers`, () => {
    const db = tempDB();
    setIssueSync(db, 'gh');
    registerRepo(db);
    const remote: Remote = { gh: new Map(), gl: new Map() };
    for (let n = 1; n <= GH_RECONCILE_BATCH + 1; n++) {
      seedIssue(db, { gh: n });
      remote.gh.set(n, 'OPEN');
    }
    const { spawned, spawnFn } = stub(remote);

    const result = reconcileRemoteCloses(db, { _spawnFn: spawnFn });

    const graphql = spawned.filter((s) => s.cmd === 'gh' && s.args[1] === 'graphql');
    assert.equal(graphql.length, 2);
    assert.equal([...graphql[0]!.args.at(-1)!.matchAll(/issue\(number:/g)].length, GH_RECONCILE_BATCH);
    assert.equal([...graphql[1]!.args.at(-1)!.matchAll(/issue\(number:/g)].length, 1);
    assert.equal(result.checked, GH_RECONCILE_BATCH + 1);
    assert.deepEqual(result.closed, []);
    assert.deepEqual(result.errors, []);
  });

  it('skips with the gate reason and spawns nothing when issue sync is off or env-disabled', () => {
    const db = tempDB();
    registerRepo(db);
    const issue = seedIssue(db, { gh: 3 });
    const { spawned, spawnFn } = stub({ gh: new Map([[3, 'CLOSED']]), gl: new Map() });
    const before = snapshot(db);

    db.run(`DELETE FROM plugin_config WHERE key = 'issue_sync'`);
    assert.deepEqual(reconcileRemoteCloses(db, { _spawnFn: spawnFn }), { checked: 0, closed: [], deferred: [], errors: [], skipped: 'issue_sync_off' });

    setIssueSync(db, 'both');
    process.env.TMB_DISABLE_REMOTE_SYNC = '1';
    assert.equal(reconcileRemoteCloses(db, { _spawnFn: spawnFn }).skipped, 'env_disabled');
    delete process.env.TMB_DISABLE_REMOTE_SYNC;

    setIssueSync(db, 'off');
    assert.equal(reconcileRemoteCloses(db, { _spawnFn: spawnFn }).skipped, 'issue_sync_off');

    assert.deepEqual(spawned, []);
    assert.equal(snapshot(db), before, 'a skipped reconcile writes nothing');
    assert.equal(issueRow(db, issue).status, 'open');
  });

  it("skips with no_backend under 'auto' when no CLI is usable", () => {
    const db = tempDB();
    setIssueSync(db, 'auto');
    registerRepo(db);
    seedIssue(db, { gh: 3 });
    const spawned: Spawned[] = [];
    const spawnFn: SpawnFn = (cmd, args) => {
      spawned.push({ cmd, args });
      return { status: 1, stdout: '', stderr: 'not logged in' };
    };

    const result = reconcileRemoteCloses(db, { _spawnFn: spawnFn });

    assert.equal(result.skipped, 'no_backend');
    assert.ok(spawned.every((s) => s.args[0] === 'auth'), 'only the availability probe ran');
  });

  it('defers a remote-closed issue with live tasks, one audit row across two runs, then closes it once they close', () => {
    const db = tempDB();
    setIssueSync(db, 'gh');
    registerRepo(db);
    const issue = seedIssue(db, { gh: 30 });
    const live = seedTask(db, issue, 'running');
    seedTask(db, issue, 'closed');
    const { spawnFn } = stub({ gh: new Map([[30, 'CLOSED']]), gl: new Map() });

    const first = reconcileRemoteCloses(db, { _spawnFn: spawnFn });
    const second = reconcileRemoteCloses(db, { _spawnFn: spawnFn });

    for (const r of [first, second]) {
      assert.deepEqual(r.closed, []);
      assert.deepEqual(r.deferred, [{ issue_id: issue, blocking_task_ids: [live] }]);
    }
    assert.equal(issueRow(db, issue).status, 'open');
    assert.deepEqual(audits(db, 'issue_remote_closed_local_open'), [
      { issue_id: issue, from_node: 'bro', content: { remote_kind: 'github', remote_iid: 30, blocking_task_ids: [live] } },
    ]);

    const another = seedTask(db, issue, 'pending');
    reconcileRemoteCloses(db, { _spawnFn: spawnFn });
    assert.deepEqual(
      audits(db, 'issue_remote_closed_local_open').map((a) => a.content['blocking_task_ids']),
      [[live], [live, another]],
      'a changed blocking set writes a new row',
    );

    db.run(`UPDATE tasks SET status = 'closed' WHERE issue_id = ?`, [issue]);
    const last = reconcileRemoteCloses(db, { _spawnFn: spawnFn });
    assert.deepEqual(last.closed, [{ issue_id: issue, remote_kind: 'github', remote_iid: 30 }]);
    assert.equal(issueRow(db, issue).status, 'closed');
    assert.equal(audits(db, 'issue_closed_from_remote', issue).length, 1);
  });

  it('never checks the system issue or other ids at or below 0', () => {
    const db = tempDB();
    setIssueSync(db, 'gh');
    registerRepo(db);
    db.run(`UPDATE issues SET gh_iid = 1, repo = 'app', status = 'open' WHERE id = -1`);
    const { spawned, spawnFn } = stub({ gh: new Map([[1, 'CLOSED']]), gl: new Map() });

    const result = reconcileRemoteCloses(db, { _spawnFn: spawnFn });

    assert.equal(result.checked, 0);
    assert.deepEqual(spawned.filter((s) => s.args[1] === 'graphql'), []);
    assert.equal(db.get<{ status: string }>('SELECT status FROM issues WHERE id = -1')!.status, 'open');
  });
});

describe('issue_reconcile_remote tool (GH 2228)', () => {
  async function call(db: TrajectoryDB, args: Record<string, unknown>): Promise<RawResult> {
    const tools = issueTools(db, '/tmp/.claude/tmb/trajectory.db');
    return (await tools.handlers['issue_reconcile_remote']!(args)) as RawResult;
  }

  it('is defined bro-only with an optional dry_run boolean', () => {
    const def = issueTools(tempDB()).definitions.find((d) => d.name === 'issue_reconcile_remote');
    assert.ok(def);
    const props = def.inputSchema.properties as Record<string, { type?: string; enum?: string[] }>;
    assert.deepEqual(props['agent']!.enum, ['bro']);
    assert.equal(props['dry_run']!.type, 'boolean');
    assert.deepEqual(def.inputSchema.required, ['agent']);
  });

  it('is forbidden to swe', async () => {
    const db = tempDB();
    const r = await call(db, { agent: 'swe' });
    assert.equal(r.isError, true);
  });

  it('dry_run reports what would close and defer and changes no row', async () => {
    const db = tempDB();
    setIssueSync(db, 'gh');
    registerRepo(db);
    const closable = seedIssue(db, { gh: 40 });
    const blocked = seedIssue(db, { gh: 41 });
    const live = seedTask(db, blocked, 'needs_validation');
    const { spawned, spawnFn } = stub({ gh: new Map([[40, 'CLOSED'], [41, 'CLOSED']]), gl: new Map() });
    const before = snapshot(db);

    const r = await call(db, { agent: 'bro', dry_run: true, _spawnFn: spawnFn });

    assert.equal(r.isError, undefined);
    const body = JSON.parse(r.content[0]!.text) as Record<string, unknown>;
    assert.deepEqual(body, {
      checked: 2,
      closed: [{ issue_id: closable, remote_kind: 'github', remote_iid: 40 }],
      deferred: [{ issue_id: blocked, blocking_task_ids: [live] }],
      errors: [],
      dry_run: true,
    });
    assert.equal(snapshot(db), before, 'dry_run writes nothing');
    assert.deepEqual(remoteWrites(spawned), []);
  });

  it('without dry_run closes and returns {checked, closed, deferred, errors}', async () => {
    const db = tempDB();
    setIssueSync(db, 'gh');
    registerRepo(db);
    const closable = seedIssue(db, { gh: 50 });
    const { spawnFn } = stub({ gh: new Map([[50, 'CLOSED']]), gl: new Map() });

    const r = await call(db, { agent: 'bro', _spawnFn: spawnFn });

    const body = JSON.parse(r.content[0]!.text) as Record<string, unknown>;
    assert.deepEqual(body, { checked: 1, closed: [{ issue_id: closable, remote_kind: 'github', remote_iid: 50 }], deferred: [], errors: [] });
    assert.equal(issueRow(db, closable).status, 'closed');
  });

  it('returns skipped when the gate is off', async () => {
    const db = tempDB();
    registerRepo(db);
    seedIssue(db, { gh: 60 });
    const r = await call(db, { agent: 'bro' });
    assert.equal((JSON.parse(r.content[0]!.text) as { skipped?: string }).skipped, 'issue_sync_off');
  });

  it('rejects a non-boolean dry_run', async () => {
    const r = await call(tempDB(), { agent: 'bro', dry_run: 'yes' });
    assert.equal(r.isError, true);
  });
});
