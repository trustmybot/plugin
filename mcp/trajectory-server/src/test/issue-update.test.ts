import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tempDB } from './helpers.js';
import { issueTools } from '../tools/issues.js';
import { configTools } from '../tools/config.js';
import { setRemoteSync, upsertRepoRemotes } from '../repos/remotes.js';

type RawResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type Handlers = Record<string, (args: Record<string, unknown>) => Promise<unknown>>;

const VALID_LABELS = ['Bug', 'Priority: High'];

async function call(handlers: Handlers, name: string, args: Record<string, unknown>): Promise<RawResult> {
  const handler = handlers[name];
  assert.ok(handler, `Handler not found: ${name}`);
  return handler(args) as unknown as RawResult;
}

function parseResult(result: RawResult) {
  return JSON.parse(result.content[0]!.text);
}

function registerSoleRepo(
  db: ReturnType<typeof tempDB>,
  remotes: Array<{ name: string; provider: string; url: string }> = [
    { name: 'origin', provider: 'github', url: 'https://github.com/owner/repo.git' },
    { name: 'gitlab', provider: 'gitlab', url: 'https://gitlab.com/owner/repo.git' },
  ],
): void {
  db.run(`INSERT INTO repos (name, path) VALUES ('app', '/tmp/app')`);
  upsertRepoRemotes(db, 'app', remotes);
}

async function seed(db: ReturnType<typeof tempDB>, tools: ReturnType<typeof issueTools>): Promise<number> {
  const created = await call(tools.handlers, 'issue_create', { agent: 'bro', objective: 'seed', labels: VALID_LABELS });
  const id = parseResult(created).id as number;
  assert.ok(id);
  return id;
}

async function setSync(db: ReturnType<typeof tempDB>, value: string): Promise<void> {
  await call(configTools(db).handlers, 'config_set', { agent: 'bro', key: 'issue_sync', value });
}

function recordingSpawn() {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const spawnFn = (cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    return { status: 0, stdout: '', stderr: '' };
  };
  return { calls, spawnFn };
}

describe('issue_update', () => {
  it('errors when no field is given', async () => {
    const db = tempDB();
    const tools = issueTools(db);
    const id = await seed(db, tools);
    const result = await call(tools.handlers, 'issue_update', { agent: 'bro', issue_id: String(id) });
    assert.ok(result.isError);
    assert.match(parseResult(result).error, /no_fields/);
    db.close();
  });

  it('rejects labels outside the taxonomy and names issue_update', async () => {
    const db = tempDB();
    const tools = issueTools(db);
    const id = await seed(db, tools);
    const result = await call(tools.handlers, 'issue_update', { agent: 'bro', issue_id: String(id), labels: ['nonsense'] });
    assert.ok(result.isError);
    assert.match(parseResult(result).error, /missing_required_labels: issue_update requires/);
    db.close();
  });

  it('updates only the given column, creates the milestones row and writes one audit row', async () => {
    const db = tempDB();
    registerSoleRepo(db);
    const tools = issueTools(db);
    const id = await seed(db, tools);

    const result = await call(tools.handlers, 'issue_update', { agent: 'bro', issue_id: String(id), milestone: 'v9.9.9' });
    const data = parseResult(result);
    assert.ok(!result.isError, data.error);
    assert.equal(data.milestone, 'v9.9.9');
    assert.equal(data.objective, 'seed');
    assert.equal(data._sync.sync_skipped, true);
    assert.equal(data._sync.reason, 'no_remote_iid');

    const ms = db.get<{ name: string }>(`SELECT name FROM milestones WHERE name = 'v9.9.9' AND repo = 'app'`);
    assert.ok(ms, 'milestones row created');
    const labels = db.get<{ labels: string }>('SELECT labels FROM issues WHERE id = ?', [id]);
    assert.deepEqual(JSON.parse(labels!.labels), VALID_LABELS);

    const audits = db.all<{ content_json: string }>(
      `SELECT content_json FROM audit WHERE issue_id = ? AND event_type = 'issue_updated'`,
      [id],
    );
    assert.equal(audits.length, 1);
    const content = JSON.parse(audits[0]!.content_json);
    assert.deepEqual(content.changed, ['milestone']);
    assert.equal(content.before.milestone, null);
    assert.equal(content.after.milestone, 'v9.9.9');
    db.close();
  });

  it('spawns nothing without a remote iid', async () => {
    const db = tempDB();
    registerSoleRepo(db);
    await setSync(db, 'gh');
    const tools = issueTools(db);
    const id = await seed(db, tools);
    const { calls, spawnFn } = recordingSpawn();
    const result = await call(tools.handlers, 'issue_update', { agent: 'bro', issue_id: String(id), milestone: 'm1', _spawnFn: spawnFn });
    assert.equal(parseResult(result)._sync.reason, 'no_remote_iid');
    assert.equal(calls.length, 0);
    db.close();
  });

  it('mirrors milestone, label add/remove and title to gh', async () => {
    const db = tempDB();
    registerSoleRepo(db, [{ name: 'origin', provider: 'github', url: 'https://github.com/owner/repo.git' }]);
    await setSync(db, 'gh');
    const tools = issueTools(db);
    const id = await seed(db, tools);
    db.run('UPDATE issues SET gh_iid = 42, remote_kind = ? WHERE id = ?', ['github', id]);
    const { calls, spawnFn } = recordingSpawn();

    const result = await call(tools.handlers, 'issue_update', {
      agent: 'bro',
      issue_id: String(id),
      milestone: 'v1.2.0',
      labels: ['Feature', 'Priority: High'],
      objective: 'renamed',
      _spawnFn: spawnFn,
    });
    const data = parseResult(result);
    assert.ok(!result.isError, data.error);
    assert.equal(data._sync.synced, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.cmd, 'gh');
    assert.deepEqual(calls[0]!.args, [
      'issue', 'edit', '42',
      '--repo', calls[0]!.args[4]!,
      '--milestone', 'v1.2.0',
      '--add-label', 'Feature',
      '--remove-label', 'Bug',
      '--title', 'renamed',
    ]);
    assert.match(calls[0]!.args[4]!, /owner\/repo$/);
    db.close();
  });

  it('mirrors to glab with its flag names', async () => {
    const db = tempDB();
    registerSoleRepo(db, [{ name: 'gitlab', provider: 'gitlab', url: 'https://gitlab.com/owner/repo.git' }]);
    await setSync(db, 'glab');
    const tools = issueTools(db);
    const id = await seed(db, tools);
    db.run('UPDATE issues SET gl_iid = 7, remote_kind = ? WHERE id = ?', ['gitlab', id]);
    const { calls, spawnFn } = recordingSpawn();

    const result = await call(tools.handlers, 'issue_update', {
      agent: 'bro',
      issue_id: String(id),
      milestone: 'v1.2.0',
      labels: ['Feature', 'Priority: High'],
      _spawnFn: spawnFn,
    });
    assert.equal(parseResult(result)._sync.synced, true);
    assert.equal(calls[0]!.cmd, 'glab');
    const args = calls[0]!.args;
    assert.deepEqual(args.slice(0, 3), ['issue', 'update', '7']);
    assert.equal(args[args.indexOf('-m') + 1], 'v1.2.0');
    assert.equal(args[args.indexOf('--label') + 1], 'Feature');
    assert.equal(args[args.indexOf('--unlabel') + 1], 'Bug');
    assert.ok(args.includes('-R'));
    db.close();
  });

  it('reports a failed remote edit while keeping the local update', async () => {
    const db = tempDB();
    registerSoleRepo(db, [{ name: 'origin', provider: 'github', url: 'https://github.com/owner/repo.git' }]);
    await setSync(db, 'gh');
    const tools = issueTools(db);
    const id = await seed(db, tools);
    db.run('UPDATE issues SET gh_iid = 42, remote_kind = ? WHERE id = ?', ['github', id]);
    const result = await call(tools.handlers, 'issue_update', {
      agent: 'bro',
      issue_id: String(id),
      milestone: 'm2',
      _spawnFn: () => ({ status: 1, stdout: '', stderr: 'boom' }),
    });
    const data = parseResult(result);
    assert.equal(data._sync.sync_failed, true);
    assert.equal(data.milestone, 'm2');
    db.close();
  });
});

describe('issue_adopt_remote metadata copy', () => {
  const remoteView = (milestone: string | null, labels: string[]) => (_cmd: string, args: string[]) => {
    if (args[0] === 'issue' && args[1] === 'view') {
      return {
        status: 0,
        stdout: JSON.stringify({
          number: 42,
          title: 't',
          state: 'OPEN',
          milestone: milestone ? { title: milestone } : null,
          labels: labels.map((name) => ({ name })),
        }),
        stderr: '',
      };
    }
    return { status: 1, stdout: '', stderr: 'unexpected' };
  };

  it('fills empty local milestone and labels from the remote', async () => {
    const db = tempDB();
    registerSoleRepo(db, [{ name: 'origin', provider: 'github', url: 'https://github.com/owner/repo.git' }]);
    const tools = issueTools(db);
    const id = await seed(db, tools);
    db.run(`UPDATE issues SET labels = NULL, milestone = NULL WHERE id = ?`, [id]);

    const result = await call(tools.handlers, 'issue_adopt_remote', {
      agent: 'bro',
      issue_id: String(id),
      remote_iid: 42,
      _spawnFn: remoteView('v1.2.0', ['Feature', 'Priority: Low']),
    });
    assert.ok(!result.isError, parseResult(result).error);
    const row = db.get<{ milestone: string; labels: string }>('SELECT milestone, labels FROM issues WHERE id = ?', [id]);
    assert.equal(row?.milestone, 'v1.2.0');
    assert.deepEqual(JSON.parse(row!.labels), ['Feature', 'Priority: Low']);
    const audit = db.get<{ content_json: string }>(
      `SELECT content_json FROM audit WHERE issue_id = ? AND event_type = 'issue_adopted'`,
      [id],
    );
    const content = JSON.parse(audit!.content_json);
    assert.equal(content.milestone, 'v1.2.0');
    assert.deepEqual(content.labels, ['Feature', 'Priority: Low']);
    db.close();
  });

  it('leaves set local milestone and labels alone', async () => {
    const db = tempDB();
    registerSoleRepo(db, [{ name: 'origin', provider: 'github', url: 'https://github.com/owner/repo.git' }]);
    const tools = issueTools(db);
    const id = await seed(db, tools);
    await call(tools.handlers, 'issue_update', { agent: 'bro', issue_id: String(id), milestone: 'local-ms' });

    await call(tools.handlers, 'issue_adopt_remote', {
      agent: 'bro',
      issue_id: String(id),
      remote_iid: 42,
      _spawnFn: remoteView('remote-ms', ['Feature', 'Priority: Low']),
    });
    const row = db.get<{ milestone: string; labels: string }>('SELECT milestone, labels FROM issues WHERE id = ?', [id]);
    assert.equal(row?.milestone, 'local-ms');
    assert.deepEqual(JSON.parse(row!.labels), VALID_LABELS);
    db.close();
  });
});


describe('issue_update skip reasons (GH 1601)', () => {
  it('an issue linked only on an unsynced provider reports not_synced with the /onboard hint', async () => {
    const db = tempDB();
    registerSoleRepo(db);
    setRemoteSync(db, 'app', ['gitlab']);
    const tools = issueTools(db);
    const id = await seed(db, tools);
    await setSync(db, 'gh');
    db.run('UPDATE issues SET gh_iid = 42 WHERE id = ?', [id]);
    const { calls, spawnFn } = recordingSpawn();

    const result = await call(tools.handlers, 'issue_update', { agent: 'bro', issue_id: String(id), objective: 'renamed', _spawnFn: spawnFn });
    const sync = parseResult(result)._sync;
    assert.equal(sync.sync_skipped, true);
    assert.equal(sync.reason, 'not_synced');
    assert.match(sync.hint, /\/onboard/);
    assert.equal(calls.length, 0);
    db.close();
  });

  for (const [label, synced] of [
    ['both remotes synced', ['github', 'gitlab']],
    ['only GitLab synced', ['gitlab']],
  ] as const) {
    it(`issue_sync=gh with a GitLab-only link and ${label} reports no_remote_iid`, async () => {
      const db = tempDB();
      registerSoleRepo(db);
      setRemoteSync(db, 'app', synced);
      const tools = issueTools(db);
      const id = await seed(db, tools);
      await setSync(db, 'gh');
      db.run('UPDATE issues SET gl_iid = 7 WHERE id = ?', [id]);
      const { calls, spawnFn } = recordingSpawn();

      const result = await call(tools.handlers, 'issue_update', { agent: 'bro', issue_id: String(id), objective: 'renamed', _spawnFn: spawnFn });
      const sync = parseResult(result)._sync;
      assert.equal(sync.sync_skipped, true);
      assert.equal(sync.reason, 'no_remote_iid');
      assert.equal(calls.length, 0);
      db.close();
    });
  }
});
