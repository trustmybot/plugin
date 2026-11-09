import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tempDB } from './helpers.js';
import { issueTools } from '../tools/issues.js';
import { configTools } from '../tools/config.js';
import { upsertRepoRemotes } from '../repos/remotes.js';
import { issueSyncMarker } from '../sync/issue_sync.js';

type RawResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

async function call(
  handlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>>,
  name: string,
  args: Record<string, unknown>,
): Promise<RawResult> {
  const handler = handlers[name];
  assert.ok(handler, `Handler not found: ${name}`);
  return handler(args) as unknown as RawResult;
}

function parseResult(result: RawResult) {
  return JSON.parse(result.content[0].text);
}

async function seedIssue(
  handlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>>,
  description = 'short desc',
) {
  const result = await call(handlers, 'issue_create', {
    labels: ['Bug', 'Priority: High'],
    agent: 'bro',
    objective: 'seed issue',
    description,
  });
  return parseResult(result as RawResult);
}

describe('issue_update_description', () => {
  it('happy path — updates description and advances updated_at', async () => {
    const db = tempDB();
    const tools = issueTools(db);

    const issue = await seedIssue(tools.handlers, 'original description');
    const originalUpdatedAt = issue.updated_at;

    await new Promise((r) => setTimeout(r, 5));

    const result = await call(tools.handlers, 'issue_update_description', {
      agent: 'bro',
      issue_id: String(issue.id),
      description: 'updated full description with lots more content',
    });
    assert.ok(!result.isError, `Expected no error, got: ${JSON.stringify(parseResult(result))}`);
    const updated = parseResult(result);
    assert.ok(!('description' in updated), 'description is not echoed by default');
    assert.equal(updated.objective, 'seed issue');
    const stored = db.get<{ description: string }>('SELECT description FROM issues WHERE id = ?', [issue.id]);
    assert.equal(stored?.description, 'updated full description with lots more content');
    assert.ok(
      updated.updated_at >= originalUpdatedAt,
      `updated_at should be >= original: ${updated.updated_at} vs ${originalUpdatedAt}`,
    );

    db.close();
  });

  it('include_description: true echoes the new description', async () => {
    const db = tempDB();
    const tools = issueTools(db);

    const issue = await seedIssue(tools.handlers, 'original description');
    const result = await call(tools.handlers, 'issue_update_description', {
      agent: 'bro',
      issue_id: String(issue.id),
      description: 'opted-in body',
      include_description: true,
    });
    assert.ok(!result.isError, `Expected no error, got: ${JSON.stringify(parseResult(result))}`);
    assert.equal(parseResult(result).description, 'opted-in body');

    db.close();
  });

  it('missing issue — returns clear not_found error', async () => {
    const db = tempDB();
    const tools = issueTools(db);

    const result = await call(tools.handlers, 'issue_update_description', {
      agent: 'bro',
      issue_id: '99999',
      description: 'does not matter',
    });
    assert.ok(result.isError, 'Should be an error result');
    const data = parseResult(result);
    assert.match(data.error, /not_found/);

    db.close();
  });

  it('empty description is allowed — sets to empty string', async () => {
    const db = tempDB();
    const tools = issueTools(db);

    const issue = await seedIssue(tools.handlers, 'some content');

    const result = await call(tools.handlers, 'issue_update_description', {
      agent: 'bro',
      issue_id: String(issue.id),
      description: '',
      include_description: true,
    });
    assert.ok(!result.isError, `Expected no error, got: ${JSON.stringify(parseResult(result))}`);
    const updated = parseResult(result);
    assert.equal(updated.description, '');

    db.close();
  });

  it('oversize description (>1MB) is rejected with clear error', async () => {
    const db = tempDB();
    const tools = issueTools(db);

    const issue = await seedIssue(tools.handlers);
    const oversizeDescription = 'a'.repeat(1024 * 1024 + 1);

    const result = await call(tools.handlers, 'issue_update_description', {
      agent: 'bro',
      issue_id: String(issue.id),
      description: oversizeDescription,
    });
    assert.ok(result.isError, 'Should be an error result for oversize description');
    const data = parseResult(result);
    assert.match(data.error, /1MB/);

    db.close();
  });

  it('role enforcement — bro passes, others are forbidden', async () => {
    const db = tempDB();
    const tools = issueTools(db);

    const issue = await seedIssue(tools.handlers);

    for (const wrongRole of ['swe', 'architect', 'code-reviewer', 'unknown']) {
      const result = await call(tools.handlers, 'issue_update_description', {
        agent: wrongRole,
        issue_id: String(issue.id),
        description: 'attempted update',
      });
      assert.ok(result.isError, `${wrongRole} should be forbidden`);
      const data = parseResult(result);
      assert.equal(data.error, 'forbidden', `Expected forbidden for ${wrongRole}`);
    }

    const broResult = await call(tools.handlers, 'issue_update_description', {
      agent: 'bro',
      issue_id: String(issue.id),
      description: 'bro can update',
    });
    assert.ok(!broResult.isError, `bro should succeed, got: ${JSON.stringify(parseResult(broResult))}`);

    db.close();
  });
});

describe('issue_update_description remote mirror (GH 2067)', () => {
  type Spawned = { cmd: string; args: string[]; input: unknown };
  type Db = ReturnType<typeof tempDB>;

  function recordingSpawn(status = 0, stderr = '') {
    const calls: Spawned[] = [];
    const spawnFn = (cmd: string, args: string[], opts: { input?: unknown }) => {
      calls.push({ cmd, args, input: opts.input });
      return { status, stdout: '', stderr };
    };
    return { calls, spawnFn };
  }

  async function syncedIssue(db: Db, backend: 'gh' | 'glab'): Promise<{ id: number; marker: string }> {
    db.run(`INSERT INTO repos (name, path) VALUES ('app', '/tmp/app')`);
    upsertRepoRemotes(db, 'app', backend === 'gh'
      ? [{ name: 'origin', provider: 'github', url: 'https://github.com/owner/repo.git' }]
      : [{ name: 'gitlab', provider: 'gitlab', url: 'https://gitlab.com/owner/repo.git' }]);
    await call(configTools(db).handlers, 'config_set', { agent: 'bro', key: 'issue_sync', value: backend });
    const issue = await seedIssue(issueTools(db).handlers, 'old body');
    if (backend === 'gh') db.run(`UPDATE issues SET gh_iid = 42, remote_kind = 'github' WHERE id = ?`, [issue.id]);
    else db.run(`UPDATE issues SET gl_iid = 7, remote_kind = 'gitlab' WHERE id = ?`, [issue.id]);
    const row = db.get<{ created_at: string }>('SELECT created_at FROM issues WHERE id = ?', [issue.id]);
    return { id: issue.id as number, marker: issueSyncMarker(issue.id as number, row!.created_at) };
  }

  it('gh: edits the body from stdin with the tmb-issue marker appended', async () => {
    const db = tempDB();
    const { id, marker } = await syncedIssue(db, 'gh');
    const { calls, spawnFn } = recordingSpawn();

    const result = await call(issueTools(db).handlers, 'issue_update_description', {
      agent: 'bro', issue_id: String(id), description: 'new plan', _spawnFn: spawnFn,
    });
    const data = parseResult(result);
    assert.ok(!result.isError, data.error);
    assert.deepEqual(data._sync, { synced: true, backends: ['gh'] });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.cmd, 'gh');
    assert.deepEqual(calls[0]!.args, ['issue', 'edit', '42', '--repo', 'github.com/owner/repo', '--body-file', '-']);
    assert.equal(calls[0]!.input, `new plan\n\n${marker}`);
    db.close();
  });

  it('glab: updates the body with -d and the marker appended', async () => {
    const db = tempDB();
    const { id, marker } = await syncedIssue(db, 'glab');
    const { calls, spawnFn } = recordingSpawn();

    const result = await call(issueTools(db).handlers, 'issue_update_description', {
      agent: 'bro', issue_id: String(id), description: 'new plan', _spawnFn: spawnFn,
    });
    assert.deepEqual(parseResult(result)._sync, { synced: true, backends: ['glab'] });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.cmd, 'glab');
    assert.deepEqual(calls[0]!.args, ['issue', 'update', '7', '-R', 'gitlab.com/owner/repo', '-d', `new plan\n\n${marker}`]);
    assert.equal(calls[0]!.input, undefined);
    db.close();
  });

  it('a failed remote edit keeps the local description and reports sync_failed', async () => {
    const db = tempDB();
    const { id } = await syncedIssue(db, 'gh');
    const { spawnFn } = recordingSpawn(1, 'boom');

    const result = await call(issueTools(db).handlers, 'issue_update_description', {
      agent: 'bro', issue_id: String(id), description: 'kept locally', _spawnFn: spawnFn,
    });
    const data = parseResult(result);
    assert.ok(!result.isError, data.error);
    assert.equal(data._sync.sync_failed, true);
    assert.equal(data._sync.reason, 'non_zero_exit');
    assert.equal(data._sync.exit_code, 1);
    assert.equal(data._sync.stderr, 'boom');
    const stored = db.get<{ description: string }>('SELECT description FROM issues WHERE id = ?', [id]);
    assert.equal(stored?.description, 'kept locally');
    db.close();
  });

  it('a local-only issue spawns nothing and reports no_remote_iid', async () => {
    const db = tempDB();
    const { id } = await syncedIssue(db, 'gh');
    db.run('UPDATE issues SET gh_iid = NULL, remote_kind = NULL WHERE id = ?', [id]);
    const { calls, spawnFn } = recordingSpawn();

    const result = await call(issueTools(db).handlers, 'issue_update_description', {
      agent: 'bro', issue_id: String(id), description: 'local only', _spawnFn: spawnFn,
    });
    const data = parseResult(result);
    assert.equal(data._sync.sync_skipped, true);
    assert.equal(data._sync.reason, 'no_remote_iid');
    assert.equal(calls.length, 0);
    db.close();
  });

  it('spawns only after a transaction wrapped around the call commits', async () => {
    const db = tempDB();
    const { id } = await syncedIssue(db, 'gh');
    const { calls, spawnFn } = recordingSpawn();
    const handler = issueTools(db).handlers['issue_update_description']!;

    const step = db.transaction(() => {
      const pending = handler({ agent: 'bro', issue_id: String(id), description: 'in tx', _spawnFn: spawnFn });
      return { pending, spawnedInside: calls.length };
    });
    assert.equal(step.spawnedInside, 0);
    assert.equal(parseResult(await step.pending as RawResult)._sync.synced, true);
    assert.equal(calls.length, 1);
    db.close();
  });
});
