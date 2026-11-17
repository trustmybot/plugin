import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tempDB } from './helpers.js';
import type { TrajectoryDB } from '../db.js';
import { remoteSyncGate } from '../sync/backend.js';
import { issueTools, syncIssueCloseRemotes } from '../tools/issues.js';
import { compositeTools } from '../tools/composites.js';
import { setRemoteSync, upsertRepoRemotes } from '../repos/remotes.js';

type RawResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type Handlers = Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
type Spawned = { cmd: string; args: string[] };

const DB_PATH = '/tmp/.claude/tmb/trajectory.db';

function parse(r: RawResult): Record<string, unknown> {
  return JSON.parse(r.content[0]!.text) as Record<string, unknown>;
}

async function call(handlers: Handlers, name: string, args: Record<string, unknown>): Promise<RawResult> {
  const h = handlers[name];
  assert.ok(h, `handler not found: ${name}`);
  return (await h(args)) as RawResult;
}

function makeSpawnFn(): {
  spawned: Spawned[];
  _spawnFn: (cmd: string, args: string[]) => { status: number; stdout: string; stderr: string };
} {
  const spawned: Spawned[] = [];
  return {
    spawned,
    _spawnFn: (cmd, args) => {
      spawned.push({ cmd, args });
      return { status: 0, stdout: '', stderr: '' };
    },
  };
}

function remoteCloses(spawned: Spawned[]): Spawned[] {
  return spawned.filter((s) => s.args[0] === 'issue' && s.args[1] === 'close');
}

function setIssueSync(db: TrajectoryDB, value: string): void {
  db.run(`INSERT OR REPLACE INTO plugin_config (key, value_json) VALUES ('issue_sync', ?)`, [JSON.stringify(value)]);
}

function registerRepo(
  db: TrajectoryDB,
  providers: Array<'github' | 'gitlab'> = ['github', 'gitlab'],
  synced: Array<'github' | 'gitlab'> = providers,
): void {
  const remotes = providers.map((provider, i) => ({
    name: i === 0 ? 'origin' : provider,
    provider,
    url: provider === 'github' ? 'https://github.com/owner/repo.git' : 'https://gitlab.com/owner/repo.git',
  }));
  db.run(`INSERT INTO repos (name, path) VALUES ('app', '/tmp/app')`);
  upsertRepoRemotes(db, 'app', remotes);
  setRemoteSync(db, 'app', synced);
}

function seedLinkedIssue(db: TrajectoryDB, links: { gh?: number; gl?: number } = { gh: 42 }): number {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO issues (objective, status, created_at, updated_at, repo, gh_iid, gl_iid) VALUES ('gate', 'open', ?, ?, 'app', ?, ?)`,
    [now, now, links.gh ?? null, links.gl ?? null],
  );
  return db.get<{ id: number }>('SELECT MAX(id) AS id FROM issues')!.id;
}

function seedClosableTask(db: TrajectoryDB, issueId: number, status: 'completed' | 'pending'): number {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO tasks (issue_id, branch_id, description, status, commit_sha, created_at, updated_at)
     VALUES (?, 'fix/gate', 'd', ?, ?, ?, ?)`,
    [issueId, status, status === 'completed' ? 'abc1234' : null, now, now],
  );
  const taskId = db.get<{ id: number }>('SELECT MAX(id) AS id FROM tasks')!.id;
  const earlier = new Date(Date.now() - 60_000).toISOString();
  const later = new Date(Date.now() - 30_000).toISOString();
  db.run(
    `INSERT INTO audit (issue_id, from_node, event_type, summary, content_json, created_at) VALUES (?, 'bro', 'bro_verification_pass', 'ok', ?, ?)`,
    [issueId, JSON.stringify({ task_id: taskId, commit_sha: 'abc1234' }), earlier],
  );
  db.run(
    `INSERT INTO validation_attempts (task_id, attempt_n, agent, verdict, mcp_available, created_at) VALUES (?, 1, 'code-reviewer', 'pass', 1, ?)`,
    [taskId, later],
  );
  return taskId;
}

function skipAudits(db: TrajectoryDB): Array<{ issue_id: number; content: Record<string, unknown> }> {
  return db
    .all<{ issue_id: number; content_json: string }>(
      `SELECT issue_id, content_json FROM audit WHERE event_type = 'issue_close_remote_skipped' ORDER BY id`,
    )
    .map((r) => ({ issue_id: r.issue_id, content: JSON.parse(r.content_json) as Record<string, unknown> }));
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

describe('remoteSyncGate', () => {
  it('is off with issue_sync_off when the key is unset or off', async () => {
    const db = tempDB();
    db.run(`DELETE FROM plugin_config WHERE key = 'issue_sync'`);
    assert.deepEqual(await remoteSyncGate(db), { enabled: false, reason: 'issue_sync_off' });
    setIssueSync(db, 'off');
    assert.deepEqual(await remoteSyncGate(db), { enabled: false, reason: 'issue_sync_off' });
    db.close();
  });

  it('env_disabled wins over issue_sync=auto and an injected spawn', async () => {
    const db = tempDB();
    setIssueSync(db, 'auto');
    process.env.TMB_DISABLE_REMOTE_SYNC = 'true';
    const { _spawnFn } = makeSpawnFn();
    assert.deepEqual(await remoteSyncGate(db, { repoRemotes: { github: true, gitlab: false }, spawnFn: _spawnFn }), {
      enabled: false,
      reason: 'env_disabled',
    });
    db.close();
  });

  it('auto with no usable remote is no_backend; with a github remote it is enabled', async () => {
    const db = tempDB();
    setIssueSync(db, 'auto');
    const { _spawnFn } = makeSpawnFn();
    assert.deepEqual(await remoteSyncGate(db, { repoRemotes: null, spawnFn: _spawnFn }), { enabled: false, reason: 'no_backend' });
    assert.deepEqual(await remoteSyncGate(db, { repoRemotes: { github: true, gitlab: false }, spawnFn: _spawnFn }), { enabled: true });
    db.close();
  });
});

describe('issue_close remote sync gate', () => {
  it("issue_sync='off': no spawn, one issue_close_remote_skipped row, result carries the skip", async () => {
    const db = tempDB();
    registerRepo(db);
    setIssueSync(db, 'off');
    const issueId = seedLinkedIssue(db, { gh: 42 });
    const { spawned, _spawnFn } = makeSpawnFn();

    const r = await call(issueTools(db, DB_PATH).handlers, 'issue_close', { agent: 'bro', issue_id: String(issueId), _spawnFn });
    assert.ok(!r.isError, JSON.stringify(parse(r)));
    assert.deepEqual(parse(r)['remote'], {
      synced: false,
      skipped: 'issue_sync_off',
      remotes: [{ remote_kind: 'github', remote_iid: 42, closed: false }],
    });
    assert.equal(spawned.length, 0);
    assert.deepEqual(skipAudits(db), [
      { issue_id: issueId, content: { reason: 'issue_sync_off', remotes: [{ remote_kind: 'github', remote_iid: 42 }] } },
    ]);
    db.close();
  });

  it("TMB_DISABLE_REMOTE_SYNC=1 with issue_sync='auto': skipped with env_disabled", async () => {
    const db = tempDB();
    registerRepo(db);
    setIssueSync(db, 'auto');
    process.env.TMB_DISABLE_REMOTE_SYNC = '1';
    const issueId = seedLinkedIssue(db, { gh: 42 });
    const { spawned, _spawnFn } = makeSpawnFn();

    const r = await call(issueTools(db, DB_PATH).handlers, 'issue_close', { agent: 'bro', issue_id: String(issueId), _spawnFn });
    assert.ok(!r.isError, JSON.stringify(parse(r)));
    assert.equal((parse(r)['remote'] as Record<string, unknown>)['skipped'], 'env_disabled');
    assert.equal(spawned.length, 0);
    assert.equal(skipAudits(db)[0]!.content['reason'], 'env_disabled');
    db.close();
  });

  it("issue_sync='auto' with no configured remote: skipped with no_backend", async () => {
    const db = tempDB();
    registerRepo(db, []);
    setIssueSync(db, 'auto');
    const issueId = seedLinkedIssue(db, { gh: 42 });
    const { spawned, _spawnFn } = makeSpawnFn();

    const r = await call(issueTools(db, DB_PATH).handlers, 'issue_close', { agent: 'bro', issue_id: String(issueId), _spawnFn });
    assert.ok(!r.isError, JSON.stringify(parse(r)));
    assert.equal((parse(r)['remote'] as Record<string, unknown>)['skipped'], 'no_backend');
    assert.equal(remoteCloses(spawned).length, 0);
    assert.equal(skipAudits(db)[0]!.content['reason'], 'no_backend');
    db.close();
  });

  it("issue_sync='auto' + remotes + mocked spawn: one issue close per linked remote", async () => {
    const db = tempDB();
    registerRepo(db);
    setIssueSync(db, 'auto');
    const issueId = seedLinkedIssue(db, { gh: 42, gl: 7 });
    const { spawned, _spawnFn } = makeSpawnFn();

    const r = await call(issueTools(db, DB_PATH).handlers, 'issue_close', { agent: 'bro', issue_id: String(issueId), _spawnFn });
    assert.ok(!r.isError, JSON.stringify(parse(r)));
    assert.deepEqual(parse(r)['remote'], {
      synced: true,
      remotes: [
        { remote_kind: 'github', remote_iid: 42, closed: true },
        { remote_kind: 'gitlab', remote_iid: 7, closed: true },
      ],
    });
    assert.deepEqual(remoteCloses(spawned), [
      { cmd: 'gh', args: ['issue', 'close', '42', '--repo', 'github.com/owner/repo'] },
      { cmd: 'glab', args: ['issue', 'close', '7', '-R', 'gitlab.com/owner/repo'] },
    ]);
    assert.equal(skipAudits(db).length, 0);
    db.close();
  });

  it('an issue with no remote link spawns nothing and audits nothing', async () => {
    const db = tempDB();
    registerRepo(db);
    setIssueSync(db, 'auto');
    const issueId = seedLinkedIssue(db, {});
    const { spawned, _spawnFn } = makeSpawnFn();

    const out = await syncIssueCloseRemotes(db, DB_PATH, issueId, _spawnFn);
    assert.deepEqual(out, { synced: false, remotes: [] });
    assert.equal(spawned.length, 0);
    assert.equal(skipAudits(db).length, 0);
    db.close();
  });
});

async function atomicClose(
  db: TrajectoryDB,
  taskId: number,
  _spawnFn: ReturnType<typeof makeSpawnFn>['_spawnFn'],
  closeIssueIfLast = true,
): Promise<Record<string, unknown>> {
  const r = await call(compositeTools(db, DB_PATH).handlers, 'bro_atomic_close', {
    agent: 'bro', task_id: String(taskId), commit_sha: 'abc1234', verification_summary: 'ok',
    close_issue_if_last_task: closeIssueIfLast, waive_scope_gate: true, scope_waiver_reason: 'test fixture: scope not under test', _spawnFn,
  });
  assert.ok(!r.isError, JSON.stringify(parse(r)));
  return parse(r);
}

async function recover(
  db: TrajectoryDB,
  taskId: number,
  _spawnFn: ReturnType<typeof makeSpawnFn>['_spawnFn'],
): Promise<Record<string, unknown>> {
  const r = await call(compositeTools(db, DB_PATH).handlers, 'task_recover', {
    agent: 'bro', task_id: String(taskId), commit_sha: 'abc1234', close_issue_if_last_task: true, _spawnFn,
  });
  assert.ok(!r.isError, JSON.stringify(parse(r)));
  return parse(r);
}

function localIssueStatus(db: TrajectoryDB, issueId: number): string {
  return db.get<{ status: string }>('SELECT status FROM issues WHERE id = ?', [issueId])!.status;
}

describe('bro_atomic_close and task_recover close neither the issue nor its remote twin (GH 3115, GH 3234)', () => {
  it("bro_atomic_close with issue_sync='auto' + a github remote: issue stays open, deferred to merge, no remote spawn", async () => {
    const db = tempDB();
    registerRepo(db, ['github']);
    setIssueSync(db, 'auto');
    const issueId = seedLinkedIssue(db, { gh: 42 });
    const taskId = seedClosableTask(db, issueId, 'completed');
    const { spawned, _spawnFn } = makeSpawnFn();

    const out = await atomicClose(db, taskId, _spawnFn);
    assert.equal(out['issue_closed'], false);
    assert.equal(out['issue_close_deferred'], 'merge');
    assert.equal(localIssueStatus(db, issueId), 'open');
    assert.equal('remote' in out, false);
    assert.deepEqual(remoteCloses(spawned), []);
    assert.equal(spawned.length, 0, 'not even the gate probe runs');
    assert.equal(skipAudits(db).length, 0);
    db.close();
  });

  it("bro_atomic_close with issue_sync='off': same deferral, no skip audit", async () => {
    const db = tempDB();
    registerRepo(db);
    setIssueSync(db, 'off');
    const issueId = seedLinkedIssue(db, { gh: 42 });
    const taskId = seedClosableTask(db, issueId, 'completed');
    const { spawned, _spawnFn } = makeSpawnFn();

    const out = await atomicClose(db, taskId, _spawnFn);
    assert.equal(out['issue_closed'], false);
    assert.equal(out['issue_close_deferred'], 'merge');
    assert.equal(localIssueStatus(db, issueId), 'open');
    assert.equal(spawned.length, 0);
    assert.equal(skipAudits(db).length, 0);
    db.close();
  });

  it('bro_atomic_close on an unlinked issue defers to merge the same way', async () => {
    const db = tempDB();
    registerRepo(db, ['github']);
    setIssueSync(db, 'auto');
    const issueId = seedLinkedIssue(db, {});
    const taskId = seedClosableTask(db, issueId, 'completed');
    const { spawned, _spawnFn } = makeSpawnFn();

    const out = await atomicClose(db, taskId, _spawnFn);
    assert.equal(out['issue_closed'], false);
    assert.equal(out['issue_close_deferred'], 'merge');
    assert.equal(localIssueStatus(db, issueId), 'open');
    assert.equal(spawned.length, 0);
    db.close();
  });

  it('bro_atomic_close without close_issue_if_last_task reports no readiness and returns no remote key', async () => {
    const db = tempDB();
    registerRepo(db, ['github']);
    setIssueSync(db, 'auto');
    const issueId = seedLinkedIssue(db, { gh: 42 });
    const taskId = seedClosableTask(db, issueId, 'completed');
    const { spawned, _spawnFn } = makeSpawnFn();

    const out = await atomicClose(db, taskId, _spawnFn, false);
    assert.equal(out['issue_closed'], false);
    assert.equal('issue_close_deferred' in out, false);
    assert.equal('remote' in out, false);
    assert.equal(spawned.length, 0);
    db.close();
  });

  it("task_recover with issue_sync='auto' + a github remote: issue stays open, deferred to merge, no remote spawn", async () => {
    const db = tempDB();
    registerRepo(db, ['github']);
    setIssueSync(db, 'auto');
    const issueId = seedLinkedIssue(db, { gh: 42 });
    const taskId = seedClosableTask(db, issueId, 'pending');
    const { spawned, _spawnFn } = makeSpawnFn();

    const out = await recover(db, taskId, _spawnFn);
    assert.equal(out['issue_closed'], false);
    assert.equal(out['issue_close_deferred'], 'merge');
    assert.equal(localIssueStatus(db, issueId), 'open');
    assert.equal('remote' in out, false);
    assert.deepEqual(remoteCloses(spawned), []);
    assert.equal(skipAudits(db).length, 0);
    db.close();
  });

  it('task_recover with TMB_DISABLE_REMOTE_SYNC=1: same deferral, no skip audit', async () => {
    const db = tempDB();
    registerRepo(db, ['github']);
    setIssueSync(db, 'auto');
    process.env.TMB_DISABLE_REMOTE_SYNC = '1';
    const issueId = seedLinkedIssue(db, { gh: 42 });
    const taskId = seedClosableTask(db, issueId, 'pending');
    const { spawned, _spawnFn } = makeSpawnFn();

    const out = await recover(db, taskId, _spawnFn);
    assert.equal(out['issue_close_deferred'], 'merge');
    assert.equal(localIssueStatus(db, issueId), 'open');
    assert.equal(spawned.length, 0);
    assert.equal(skipAudits(db).length, 0);
    db.close();
  });
});

describe('remote close follows the onboard Remote choice (GH 1590)', () => {
  it('github chosen, gitlab not: only the gh twin closes, the gl twin is skipped not_synced', async () => {
    const db = tempDB();
    registerRepo(db, ['github', 'gitlab'], ['github']);
    setIssueSync(db, 'auto');
    const issueId = seedLinkedIssue(db, { gh: 42, gl: 7 });
    const { spawned, _spawnFn } = makeSpawnFn();

    const r = await call(issueTools(db, DB_PATH).handlers, 'issue_close', { agent: 'bro', issue_id: String(issueId), _spawnFn });
    assert.ok(!r.isError, JSON.stringify(parse(r)));
    assert.deepEqual(parse(r)['remote'], {
      synced: true,
      remotes: [
        { remote_kind: 'github', remote_iid: 42, closed: true },
        { remote_kind: 'gitlab', remote_iid: 7, closed: false, skipped: 'not_synced' },
      ],
    });
    assert.deepEqual(remoteCloses(spawned), [
      { cmd: 'gh', args: ['issue', 'close', '42', '--repo', 'github.com/owner/repo'] },
    ]);
    assert.deepEqual(spawned.filter((s) => s.cmd === 'glab').map((s) => s.args), [['auth', 'status']], 'only the auto availability probe');
    db.close();
  });

  it('an issue linked only to the unchosen provider spawns nothing and is not synced', async () => {
    const db = tempDB();
    registerRepo(db, ['github', 'gitlab'], ['github']);
    setIssueSync(db, 'both');
    const issueId = seedLinkedIssue(db, { gl: 7 });
    const { spawned, _spawnFn } = makeSpawnFn();

    const out = await syncIssueCloseRemotes(db, DB_PATH, issueId, _spawnFn);
    assert.deepEqual(out, {
      synced: false,
      remotes: [{ remote_kind: 'gitlab', remote_iid: 7, closed: false, skipped: 'not_synced' }],
    });
    assert.equal(remoteCloses(spawned).length, 0);
    db.close();
  });

  it('bro_atomic_close closes neither twin and defers the close to merge', async () => {
    const db = tempDB();
    registerRepo(db, ['github', 'gitlab'], ['github']);
    setIssueSync(db, 'auto');
    const issueId = seedLinkedIssue(db, { gh: 42, gl: 7 });
    const taskId = seedClosableTask(db, issueId, 'completed');
    const { spawned, _spawnFn } = makeSpawnFn();

    const out = await atomicClose(db, taskId, _spawnFn);
    assert.equal(out['issue_closed'], false);
    assert.equal(out['issue_close_deferred'], 'merge');
    assert.equal('remote' in out, false);
    assert.deepEqual(remoteCloses(spawned), []);
    db.close();
  });

  it('task_recover closes neither twin and defers the close to merge', async () => {
    const db = tempDB();
    registerRepo(db, ['github', 'gitlab'], ['gitlab']);
    setIssueSync(db, 'auto');
    const issueId = seedLinkedIssue(db, { gh: 42, gl: 7 });
    const taskId = seedClosableTask(db, issueId, 'pending');
    const { spawned, _spawnFn } = makeSpawnFn();

    const out = await recover(db, taskId, _spawnFn);
    assert.equal(out['issue_close_deferred'], 'merge');
    assert.equal('remote' in out, false);
    assert.deepEqual(remoteCloses(spawned), []);
    db.close();
  });
});

describe('remote close skip reasons (GH 1601)', () => {
  it("an issue whose repo is unresolvable under explicit issue_sync='gh' reports repo_unresolved, not not_synced", async () => {
    const db = tempDB();
    registerRepo(db, ['github']);
    db.run(`INSERT INTO repos (name, path) VALUES ('lib', '/tmp/lib')`);
    setIssueSync(db, 'gh');
    const issueId = seedLinkedIssue(db, { gh: 42 });
    db.run(`UPDATE issues SET repo = NULL WHERE id = ?`, [issueId]);
    const { spawned, _spawnFn } = makeSpawnFn();

    const r = await call(issueTools(db, DB_PATH).handlers, 'issue_close', { agent: 'bro', issue_id: String(issueId), _spawnFn });
    assert.ok(!r.isError, JSON.stringify(parse(r)));
    assert.deepEqual(parse(r)['remote'], {
      synced: false,
      remotes: [{ remote_kind: 'github', remote_iid: 42, closed: false, skipped: 'repo_unresolved' }],
    });
    assert.equal(remoteCloses(spawned).length, 0);
    db.close();
  });
});
