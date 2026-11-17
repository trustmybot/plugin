import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempDB } from './helpers.js';
import { spawnAsync } from '../utils/spawn-async.js';
import { findOnPath } from '../tools/cheatcode-runtime.js';
import { fetchBaseStage } from '../tools/env-gate.js';
import { checkoutLag } from '../tools/world_model.js';
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

const MIB = 1024 * 1024;
const GIT_SETUP_TIMEOUT_MS = 30_000;

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

  it('caps stdout at spawnSync\'s 1 MiB when no maxBuffer is given; an explicit maxBuffer wins', async () => {
    const [cmd, args] = node(`process.stdout.write('x'.repeat(${MIB + 1024}))`);
    assert.equal((await spawnAsync(cmd, args, { encoding: 'utf8' })).status, null);
    const roomy = await spawnAsync(cmd, args, { encoding: 'utf8', maxBuffer: 4 * MIB });
    assert.equal(roomy.status, 0);
    assert.equal(roomy.stdout.length, MIB + 1024);
  });
});

describe('the server\'s long-running git spawns leave the event loop free', () => {
  // A git on PATH that sleeps ~300 ms before a fetch or rev-list, then runs
  // the real git, so the calls under test go through runGitAsync's real spawn.
  let ws: string;
  let repo: string;
  let savedPath: string | undefined;
  const git = (...a: string[]): string =>
    execFileSync('git', ['-C', repo, '-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...a], { encoding: 'utf8', timeout: GIT_SETUP_TIMEOUT_MS });

  before(() => {
    ws = mkdtempSync(join(tmpdir(), 'async-git-spawn-'));
    const realGit = findOnPath('git', { projectRoot: ws });
    assert.ok(realGit, 'git is on PATH');
    const bin = join(ws, 'bin');
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'git'),
      `#!/bin/sh\ncase " $* " in *" fetch "*|*" rev-list "*) sleep 0.3 ;; esac\nexec "${realGit}" "$@"\n`,
    );
    chmodSync(join(bin, 'git'), 0o755);
    const origin = join(ws, 'origin.git');
    repo = join(ws, 'repo');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { timeout: GIT_SETUP_TIMEOUT_MS });
    execFileSync('git', ['init', '-q', '-b', 'main', repo], { timeout: GIT_SETUP_TIMEOUT_MS });
    git('commit', '-q', '--allow-empty', '-m', 'base');
    git('commit', '-q', '--allow-empty', '-m', 'merged lane');
    git('remote', 'add', 'origin', origin);
    git('push', '-q', 'origin', 'main');
    git('reset', '-q', '--hard', 'HEAD~1');
    savedPath = process.env['PATH'];
    process.env['PATH'] = `${bin}:${savedPath ?? ''}`;
  });

  after(() => {
    process.env['PATH'] = savedPath;
    rmSync(ws, { recursive: true, force: true });
  });

  async function ticksDuring<T>(run: () => Promise<T>): Promise<{ ticks: number; value: T }> {
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 20);
    try {
      const value = await run();
      return { ticks, value };
    } finally {
      clearInterval(timer);
    }
  }

  it('fetchBaseStage: the interval keeps ticking during a slow git fetch', async () => {
    const { ticks, value } = await ticksDuring(() => fetchBaseStage(repo, 'main'));
    assert.deepEqual(value, { ok: true, report: { stage: 'fetch', status: 'pass' } });
    assert.ok(ticks >= 3, `the interval ticked ${ticks} times during the fetch; a blocking spawn ticks 0`);
  });

  it('checkoutLag: the interval keeps ticking during a slow git rev-list', async () => {
    const db = tempDB();
    try {
      db.run(`INSERT INTO repos (name, path, target_branch) VALUES ('app', ?, 'main')`, [repo]);
      const { ticks, value } = await ticksDuring(() => checkoutLag(db, 'app'));
      assert.deepEqual(value, { checkout_behind_upstream: 1, upstream: 'origin/main' });
      assert.ok(ticks >= 3, `the interval ticked ${ticks} times during the rev-list; a blocking spawn ticks 0`);
    } finally {
      db.close();
    }
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
