// GH 2513: syncRemotePrs / issue_reconcile_remote read GitHub PRs into prs and
// pr_closes. Every gh call goes through a stubbed spawn: no real CLI runs and
// nothing is written to a remote.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tempDB } from './helpers.js';
import type { TrajectoryDB } from '../db.js';
import type { SpawnSyncOptions } from 'node:child_process';
import { PR_FULL_LIMIT, PR_SYNC_MAX_BUFFER, PR_SYNC_TIMEOUT_MS, syncRemotePrs } from '../sync/pr-sync.js';
import { SUBPROCESS_TIMEOUT_MS } from '../utils/timeouts.js';
import type { SpawnFn } from '../sync/issue_sync.js';
import { issueTools } from '../tools/issues.js';
import { setRemoteSync, upsertRepoRemotes } from '../repos/remotes.js';

type RawResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type Spawned = { cmd: string; args: string[] };
type Reply = { status: number | null; stdout: string; stderr: string } | Error;

const T0 = '2026-03-01T10:00:00Z';
const ref = (number: number, owner = 'owner', name = 'repo') => ({
  number,
  url: `https://github.com/${owner}/${name}/issues/${number}`,
  repository: { name, owner: { login: owner } },
});

const THREE_PRS = [
  {
    number: 5,
    state: 'MERGED',
    createdAt: T0,
    mergedAt: '2026-03-01T16:00:00Z',
    updatedAt: '2026-03-01T16:00:00Z',
    closingIssuesReferences: [ref(10), ref(11), ref(99, 'someone', 'else')],
  },
  { number: 6, state: 'OPEN', createdAt: T0, mergedAt: null, updatedAt: '2026-03-02T09:00:00Z', closingIssuesReferences: [] },
  { number: 7, state: 'CLOSED', createdAt: T0, mergedAt: null, updatedAt: '2026-03-01T12:00:00Z', closingIssuesReferences: [] },
];

function stub(replies: Reply[]): { spawned: Spawned[]; spawnFn: SpawnFn } {
  const spawned: Spawned[] = [];
  const queue = [...replies];
  const spawnFn: SpawnFn = (cmd, args) => {
    spawned.push({ cmd, args });
    if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') {
      const reply = queue.shift() ?? { status: 0, stdout: '[]', stderr: '' };
      if (reply instanceof Error) throw reply;
      return reply;
    }
    throw new Error(`unexpected spawn: ${cmd} ${args.join(' ')}`);
  };
  return { spawned, spawnFn };
}

const listed = (prs: unknown[]): Reply => ({ status: 0, stdout: JSON.stringify(prs), stderr: '' });

const flag = (args: string[], name: string): string | undefined => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

function setIssueSync(db: TrajectoryDB, value: string): void {
  db.run(`INSERT OR REPLACE INTO plugin_config (key, value_json) VALUES ('issue_sync', ?)`, [JSON.stringify(value)]);
}

function registerRepo(db: TrajectoryDB, name = 'app', url = 'https://github.com/owner/repo.git'): void {
  db.run(`INSERT INTO repos (name, path) VALUES (?, ?)`, [name, `/tmp/${name}`]);
  upsertRepoRemotes(db, name, [{ name: 'origin', provider: 'github', url }]);
  setRemoteSync(db, name, ['github']);
}

function prRows(db: TrajectoryDB): Array<Record<string, unknown>> {
  return db
    .all<Record<string, unknown>>('SELECT repo, number, state, created_at, merged_at, updated_at, synced_at FROM prs ORDER BY number')
    .map((r) => ({ ...r }));
}

function closes(db: TrajectoryDB): Array<[number, number]> {
  return db
    .all<{ number: number; issue_number: number }>(
      'SELECT p.number, c.issue_number FROM pr_closes c JOIN prs p ON p.id = c.pr_id ORDER BY p.number, c.issue_number',
    )
    .map((r) => [r.number, r.issue_number]);
}

function snapshot(db: TrajectoryDB): string {
  return JSON.stringify({ prs: db.all('SELECT * FROM prs ORDER BY id'), closes: db.all('SELECT * FROM pr_closes ORDER BY pr_id, issue_number') });
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

describe('syncRemotePrs (GH 2513)', () => {
  it('writes one prs row per PR with merged_at only on the merged one, and its same-repo closing issues to pr_closes', () => {
    const db = tempDB();
    setIssueSync(db, 'gh');
    registerRepo(db);
    const { spawned, spawnFn } = stub([listed(THREE_PRS)]);

    const result = syncRemotePrs(db, { _spawnFn: spawnFn });

    assert.deepEqual(result, { repos: 1, upserted: 3, errors: [] });
    const rows = prRows(db);
    assert.deepEqual(
      rows.map(({ synced_at: _s, ...r }) => r),
      [
        { repo: 'app', number: 5, state: 'merged', created_at: T0, merged_at: '2026-03-01T16:00:00Z', updated_at: '2026-03-01T16:00:00Z' },
        { repo: 'app', number: 6, state: 'open', created_at: T0, merged_at: null, updated_at: '2026-03-02T09:00:00Z' },
        { repo: 'app', number: 7, state: 'closed', created_at: T0, merged_at: null, updated_at: '2026-03-01T12:00:00Z' },
      ],
    );
    for (const r of rows) {
      assert.ok(r['created_at'] && r['updated_at'] && r['synced_at'], `PR ${String(r['number'])} has its timestamps`);
    }
    assert.deepEqual(closes(db), [[5, 10], [5, 11]], 'the other repository\'s #99 is skipped');
    assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM pr_closes')!.n, 2);

    assert.equal(spawned.length, 1);
    const args = spawned[0]!.args;
    assert.deepEqual(args.slice(0, 4), ['pr', 'list', '-R', 'github.com/owner/repo']);
    assert.equal(flag(args, '--state'), 'all');
    assert.equal(flag(args, '--json'), 'number,state,createdAt,mergedAt,updatedAt,closingIssuesReferences');
    assert.equal(flag(args, '--limit'), '5000');
    assert.equal(flag(args, '--search'), undefined, 'the first sync reads every PR');
  });

  it('a second run searches from the newest updated_at date and updates rows in place, replacing pr_closes', () => {
    const db = tempDB();
    setIssueSync(db, 'gh');
    registerRepo(db);
    const merged = { ...THREE_PRS[1]!, state: 'MERGED', mergedAt: '2026-03-03T08:00:00Z', updatedAt: '2026-03-03T08:00:00Z', closingIssuesReferences: [ref(12)] };
    const retargeted = { ...THREE_PRS[0]!, closingIssuesReferences: [ref(11)] };
    const { spawned, spawnFn } = stub([listed(THREE_PRS), listed([retargeted, merged])]);

    syncRemotePrs(db, { _spawnFn: spawnFn });
    const firstIds = db.all<{ id: number }>('SELECT id FROM prs ORDER BY number').map((r) => r.id);
    const result = syncRemotePrs(db, { _spawnFn: spawnFn });

    assert.deepEqual(result, { repos: 1, upserted: 2, errors: [] });
    const args = spawned[1]!.args;
    assert.equal(flag(args, '--limit'), '1000');
    assert.equal(flag(args, '--search'), 'updated:>=2026-03-02 sort:updated-asc');
    assert.deepEqual(db.all<{ id: number }>('SELECT id FROM prs ORDER BY number').map((r) => r.id), firstIds, 'no duplicate rows, same ids');
    const six = prRows(db).find((r) => r['number'] === 6)!;
    assert.equal(six['state'], 'merged');
    assert.equal(six['merged_at'], '2026-03-03T08:00:00Z');
    assert.equal(six['updated_at'], '2026-03-03T08:00:00Z');
    assert.deepEqual(closes(db), [[5, 11], [6, 12]]);
  });

  it('spawns only gh pr list, never a remote write', () => {
    const db = tempDB();
    setIssueSync(db, 'auto');
    registerRepo(db);
    registerRepo(db, 'lib', 'git@github.com:owner/lib.git');
    const spawned: Spawned[] = [];
    const spawnFn: SpawnFn = (cmd, args) => {
      spawned.push({ cmd, args });
      if (args[0] === 'auth' && args[1] === 'status') return { status: 0, stdout: '', stderr: '' };
      if (cmd === 'glab') return { status: 1, stdout: '', stderr: 'not installed' };
      return { status: 0, stdout: JSON.stringify(THREE_PRS), stderr: '' };
    };

    const result = syncRemotePrs(db, { _spawnFn: spawnFn });

    assert.equal(result.repos, 2);
    const reads = spawned.filter((s) => !(s.args[0] === 'auth' && s.args[1] === 'status'));
    assert.ok(reads.length === 2);
    for (const s of reads) assert.deepEqual([s.cmd, s.args[0], s.args[1]], ['gh', 'pr', 'list']);
    assert.deepEqual(reads.map((s) => s.args[3]), ['github.com/owner/repo', 'github.com/owner/lib']);
  });

  it('with the remote-sync gate off spawns nothing, writes nothing and returns {skipped}', () => {
    const db = tempDB();
    registerRepo(db);
    const { spawned, spawnFn } = stub([listed(THREE_PRS)]);

    assert.deepEqual(syncRemotePrs(db, { _spawnFn: spawnFn }), { repos: 0, upserted: 0, errors: [], skipped: 'issue_sync_off' });
    setIssueSync(db, 'gh');
    process.env.TMB_DISABLE_REMOTE_SYNC = '1';
    assert.equal(syncRemotePrs(db, { _spawnFn: spawnFn }).skipped, 'env_disabled');

    assert.deepEqual(spawned, []);
    assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM prs')!.n, 0);
  });

  it('dry_run reads and counts but writes no row', () => {
    const db = tempDB();
    setIssueSync(db, 'gh');
    registerRepo(db);
    const { spawnFn } = stub([listed(THREE_PRS)]);

    assert.deepEqual(syncRemotePrs(db, { dryRun: true, _spawnFn: spawnFn }), { repos: 1, upserted: 3, errors: [], dry_run: true });
    assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM prs')!.n, 0);
    assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM pr_closes')!.n, 0);
  });

  it('gives gh pr list a timeout and maxBuffer sized for a full PR listing, not the 5 s / 1 MiB defaults', () => {
    const db = tempDB();
    setIssueSync(db, 'gh');
    registerRepo(db);
    const seen: SpawnSyncOptions[] = [];
    const { spawnFn: inner } = stub([listed(THREE_PRS), listed([])]);
    const spawnFn: SpawnFn = (cmd, args, opts) => {
      if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') seen.push(opts);
      return inner(cmd, args, opts);
    };

    syncRemotePrs(db, { _spawnFn: spawnFn });
    syncRemotePrs(db, { _spawnFn: spawnFn });

    assert.equal(seen.length, 2, 'the full and the incremental read');
    for (const opts of seen) {
      assert.equal(opts.timeout, PR_SYNC_TIMEOUT_MS);
      assert.ok((opts.timeout ?? 0) > SUBPROCESS_TIMEOUT_MS);
      assert.equal(opts.maxBuffer, PR_SYNC_MAX_BUFFER);
      assert.ok((opts.maxBuffer ?? 0) >= 8 * 1024 * 1024);
      assert.equal(opts.cwd, '/tmp/app');
      assert.equal(opts.encoding, 'utf8');
    }
  });

  it('a gh failure, a throw or unparseable output lands in errors[] and leaves existing rows untouched', () => {
    const db = tempDB();
    setIssueSync(db, 'gh');
    registerRepo(db);
    const { spawnFn } = stub([
      listed(THREE_PRS),
      { status: 1, stdout: '', stderr: 'HTTP 502' },
      new Error('spawn gh ENOENT'),
      { status: 0, stdout: 'not json', stderr: '' },
    ]);
    syncRemotePrs(db, { _spawnFn: spawnFn });
    const before = snapshot(db);

    const failed = syncRemotePrs(db, { _spawnFn: spawnFn });
    const thrown = syncRemotePrs(db, { _spawnFn: spawnFn });
    const garbled = syncRemotePrs(db, { _spawnFn: spawnFn });

    assert.deepEqual(failed, { repos: 1, upserted: 0, errors: [{ repo: 'app', reason: 'read_failed', message: 'HTTP 502' }] });
    assert.deepEqual(thrown.errors, [{ repo: 'app', reason: 'read_failed', message: 'spawn gh ENOENT' }]);
    assert.deepEqual(garbled.errors.map((e) => e.reason), ['parse_failed']);
    assert.equal(snapshot(db), before);
  });

  it('skips malformed entries with one parse_failed error, reports a full page as truncated, and flags an unparseable slug', () => {
    const db = tempDB();
    setIssueSync(db, 'gh');
    registerRepo(db);
    const malformed = [THREE_PRS[1], { number: 0, state: 'OPEN', createdAt: T0, updatedAt: T0 }, { ...THREE_PRS[0], mergedAt: null }, { number: 9, state: 'DRAFT', createdAt: T0, updatedAt: T0 }];
    const page = Array.from({ length: PR_FULL_LIMIT }, (_, i) => ({ number: i + 1, state: 'OPEN', createdAt: T0, updatedAt: T0, closingIssuesReferences: [] }));
    const { spawnFn } = stub([listed(malformed), listed(page)]);

    const first = syncRemotePrs(db, { _spawnFn: spawnFn });
    assert.deepEqual(first, { repos: 1, upserted: 1, errors: [{ repo: 'app', reason: 'parse_failed', message: '3 malformed PR entries skipped' }] });
    db.run('DELETE FROM prs');
    const full = syncRemotePrs(db, { _spawnFn: spawnFn });
    assert.equal(full.upserted, PR_FULL_LIMIT);
    assert.deepEqual(full.errors.map((e) => e.reason), ['truncated']);

    const other = tempDB();
    setIssueSync(other, 'gh');
    registerRepo(other, 'odd', 'https://github.com/');
    const odd = syncRemotePrs(other, { _spawnFn: stub([]).spawnFn });
    assert.equal(odd.upserted, 0);
    assert.deepEqual(odd.errors.map((e) => [e.repo, e.reason]), [['odd', 'slug_unresolved']]);
  });
});

describe('issue_reconcile_remote returns prs (GH 2513)', () => {
  it('runs the PR sync through the handler and returns its counts under prs', async () => {
    const db = tempDB();
    setIssueSync(db, 'gh');
    registerRepo(db);
    const { spawned, spawnFn } = stub([listed(THREE_PRS)]);
    const tools = issueTools(db, '/tmp/.claude/tmb/trajectory.db');

    const r = (await tools.handlers['issue_reconcile_remote']!({ agent: 'bro', _spawnFn: spawnFn })) as RawResult;

    assert.equal(r.isError, undefined);
    const body = JSON.parse(r.content[0]!.text) as { checked: number; prs: { repos: number; upserted: number; errors: unknown[] } };
    assert.equal(body.checked, 0);
    assert.ok(body.prs.upserted > 0);
    assert.deepEqual(body.prs, { repos: 1, upserted: 3, errors: [] });
    assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM prs')!.n, 3);
    for (const s of spawned) assert.deepEqual([s.cmd, s.args[0], s.args[1]], ['gh', 'pr', 'list']);
  });
});
