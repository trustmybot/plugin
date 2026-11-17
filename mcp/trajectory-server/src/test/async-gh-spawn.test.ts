import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tempDB } from './helpers.js';
import { spawnAsync } from '../utils/spawn-async.js';
import { issueTools } from '../tools/issues.js';
import { configTools } from '../tools/config.js';
import { setRemoteSync, upsertRepoRemotes } from '../repos/remotes.js';
import type { SpawnFn } from '../sync/issue_sync.js';

type RawResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type Handlers = Record<string, (args: Record<string, unknown>) => Promise<unknown>>;

async function call(handlers: Handlers, name: string, args: Record<string, unknown>): Promise<RawResult> {
  const handler = handlers[name];
  assert.ok(handler, `Handler not found: ${name}`);
  return (await handler(args)) as RawResult;
}

function node(script: string): [string, string[]] {
  return [process.execPath, ['-e', script]];
}

describe('spawnAsync (the helper defaultSpawnFn spawns gh/glab through)', () => {
  it('leaves the event loop free while a ~300 ms child runs', async () => {
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 20);
    try {
      const [cmd, args] = node('setTimeout(() => {}, 300)');
      const result = await spawnAsync(cmd, args, { timeout: 10_000, encoding: 'utf8' });
      assert.equal(result.status, 0);
      assert.ok(ticks >= 3, `the interval ticked ${ticks} times during the child; a blocking spawn ticks 0`);
    } finally {
      clearInterval(timer);
    }
  });

  it('returns the exit code, stdout and stderr in the spawnSync shape', async () => {
    const [cmd, args] = node('process.stdout.write("out"); process.stderr.write("err"); process.exit(3)');
    assert.deepEqual(await spawnAsync(cmd, args, { encoding: 'utf8' }), { status: 3, stdout: 'out', stderr: 'err' });
  });

  it('feeds input to stdin, as gh --body-file - needs', async () => {
    const [cmd, args] = node('process.stdin.pipe(process.stdout)');
    const result = await spawnAsync(cmd, args, { encoding: 'utf8', input: 'body text' });
    assert.deepEqual(result, { status: 0, stdout: 'body text', stderr: '' });
  });

  it('reports status null for a child killed by its timeout and for a missing binary', async () => {
    const [cmd, args] = node('setTimeout(() => {}, 5000)');
    assert.equal((await spawnAsync(cmd, args, { timeout: 100, encoding: 'utf8' })).status, null);
    assert.equal((await spawnAsync('tmb-no-such-binary', [], { encoding: 'utf8' })).status, null);
  });
});

describe('issue edit mirror runs its gh and glab calls concurrently', () => {
  // Overlap is proven by both 200 ms spawns being in flight at once, not by a
  // wall-clock bound (the no-wall-clock-asserts lint): run in sequence, the
  // peak is 1 and the edits take 400 ms.
  it('two 200 ms remote edits under issue_sync=both are in flight at the same time', async () => {
    const db = tempDB();
    db.run(`INSERT INTO repos (name, path) VALUES ('app', '/tmp/app')`);
    upsertRepoRemotes(db, 'app', [
      { name: 'origin', provider: 'github', url: 'https://github.com/owner/repo.git' },
      { name: 'gitlab', provider: 'gitlab', url: 'https://gitlab.com/owner/repo.git' },
    ]);
    setRemoteSync(db, 'app', ['github', 'gitlab']);
    await call(configTools(db).handlers, 'config_set', { agent: 'bro', key: 'issue_sync', value: 'both' });
    const tools = issueTools(db).handlers;
    const created = JSON.parse((await call(tools, 'issue_create', {
      agent: 'bro', labels: ['Bug', 'Priority: High'], objective: 'concurrency', description: 'old body',
    })).content[0].text) as { id: number };
    db.run(`UPDATE issues SET gh_iid = 42, gl_iid = 7 WHERE id = ?`, [created.id]);

    const spawned: string[] = [];
    let inFlight = 0;
    let peakInFlight = 0;
    const slowSpawn: SpawnFn = (cmd) => {
      spawned.push(cmd);
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      return new Promise<{ status: number; stdout: string; stderr: string }>((resolve) => {
        setTimeout(() => {
          inFlight -= 1;
          resolve({ status: 0, stdout: '', stderr: '' });
        }, 200);
      });
    };

    const result = await call(tools, 'issue_update_description', {
      agent: 'bro', issue_id: String(created.id), description: 'new body', _spawnFn: slowSpawn,
    });

    const data = JSON.parse(result.content[0].text) as { _sync: unknown };
    assert.deepEqual(data._sync, { synced: true, backends: ['gh', 'glab'] });
    assert.deepEqual(spawned.sort(), ['gh', 'glab']);
    assert.equal(peakInFlight, 2, 'the glab edit must start while the gh edit is still running');
    db.close();
  });
});
