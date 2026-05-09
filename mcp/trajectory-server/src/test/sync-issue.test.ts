import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SpawnSyncOptions } from 'node:child_process';
import { syncIssueCreate, syncIssueClose, isSyncFailure } from '../sync/issue_sync.js';

export type SpawnFn = (
  cmd: string,
  args: string[],
  opts: SpawnSyncOptions,
) => { status: number | null; stdout: string; stderr: string };

export function makeSpawnFn(responses: Array<{ status: number; stdout: string; stderr: string }>): SpawnFn {
  let index = 0;
  return (_cmd, _args, _opts) => {
    const response = responses[index] ?? { status: 1, stdout: '', stderr: 'no more responses' };
    index++;
    return response;
  };
}

describe('syncIssueCreate', () => {
  it('returns SyncFailure(no_backend) when backend is not set', async () => {
    const result = await syncIssueCreate({
      issueId: 1,
      title: 'Test',
      body: 'Body',
    });
    assert.ok(isSyncFailure(result));
    assert.equal(result.reason, 'no_backend');
  });

  it('parses github URL from gh stdout', async () => {
    const spawnFn = makeSpawnFn([
      {
        status: 0,
        stdout: 'https://github.com/owner/repo/issues/42\n',
        stderr: '',
      },
    ]);
    const result = await syncIssueCreate({
      issueId: 1,
      title: 'Test',
      body: 'Body',
      _backend: 'gh',
      _spawnFn: spawnFn,
    });
    assert.ok(!isSyncFailure(result));
    assert.equal(result.remote_iid, 42);
    assert.equal(result.remote_kind, 'github');
  });

  it('parses gitlab URL from glab stdout', async () => {
    const spawnFn = makeSpawnFn([
      {
        status: 0,
        stdout: 'https://gitlab.com/owner/repo/-/issues/77\n',
        stderr: '',
      },
    ]);
    const result = await syncIssueCreate({
      issueId: 1,
      title: 'Test',
      body: 'Body',
      _backend: 'glab',
      _spawnFn: spawnFn,
    });
    assert.ok(!isSyncFailure(result));
    assert.equal(result.remote_iid, 77);
    assert.equal(result.remote_kind, 'gitlab');
  });

  it('returns SyncFailure with stderr+exit_code when command fails (#2871)', async () => {
    const spawnFn = makeSpawnFn([
      { status: 1, stdout: '', stderr: 'auth error' },
    ]);
    const result = await syncIssueCreate({
      issueId: 1,
      title: 'Test',
      body: 'Body',
      _backend: 'gh',
      _spawnFn: spawnFn,
    });
    assert.ok(isSyncFailure(result));
    assert.equal(result.reason, 'non_zero_exit');
    assert.equal(result.exit_code, 1);
    assert.equal(result.stderr, 'auth error');
    assert.equal(result.backend, 'gh');
  });

  it('returns SyncFailure with parse_failed reason when stdout is unrecognised (#2871)', async () => {
    const spawnFn = makeSpawnFn([
      { status: 0, stdout: 'unexpected output\n', stderr: '' },
    ]);
    const result = await syncIssueCreate({
      issueId: 1,
      title: 'Test',
      body: 'Body',
      _backend: 'gh',
      _spawnFn: spawnFn,
    });
    assert.ok(isSyncFailure(result));
    assert.equal(result.reason, 'parse_failed');
    assert.equal(result.stdout, 'unexpected output\n');
  });

  it('for both backend, uses gh result when gh succeeds', async () => {
    const spawnFn = makeSpawnFn([
      {
        status: 0,
        stdout: 'https://github.com/owner/repo/issues/10\n',
        stderr: '',
      },
    ]);
    const result = await syncIssueCreate({
      issueId: 1,
      title: 'Test',
      body: 'Body',
      _backend: 'both',
      _spawnFn: spawnFn,
    });
    assert.ok(!isSyncFailure(result));
    assert.equal(result.remote_iid, 10);
    assert.equal(result.remote_kind, 'github');
  });

  it('for both backend, falls back to glab when gh fails', async () => {
    const spawnFn = makeSpawnFn([
      { status: 1, stdout: '', stderr: 'gh error' },
      {
        status: 0,
        stdout: 'https://gitlab.com/owner/repo/-/issues/55\n',
        stderr: '',
      },
    ]);
    const result = await syncIssueCreate({
      issueId: 1,
      title: 'Test',
      body: 'Body',
      _backend: 'both',
      _spawnFn: spawnFn,
    });
    assert.ok(!isSyncFailure(result));
    assert.equal(result.remote_iid, 55);
    assert.equal(result.remote_kind, 'gitlab');
  });

  it('passes labels as separate arguments for gh', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const spawnFn: SpawnFn = (cmd, args, _opts) => {
      calls.push({ cmd, args });
      return { status: 0, stdout: 'https://github.com/owner/repo/issues/1\n', stderr: '' };
    };
    await syncIssueCreate({
      issueId: 1,
      title: 'Test',
      body: 'Body',
      labels: ['bug', 'feature'],
      _backend: 'gh',
      _spawnFn: spawnFn,
    });
    assert.ok(calls.length > 0);
    const ghCall = calls[0];
    assert.ok(ghCall !== undefined);
    assert.equal(ghCall.cmd, 'gh');
    assert.ok(ghCall.args.includes('--label'));
    assert.ok(ghCall.args.includes('bug'));
    assert.ok(ghCall.args.includes('feature'));
  });

  it('syncIssueCreate emits issue_sync_active warning before spawn', async () => {
    const syncLogPath = join(homedir(), '.claude', 'tmb', 'logs', 'issue-sync.log');
    const priorSize = existsSync(syncLogPath) ? readFileSync(syncLogPath, 'utf8').length : 0;

    const spawnFn: SpawnFn = (_cmd, _args, _opts) => ({
      status: 0,
      stdout: 'https://github.com/x/y/issues/42\n',
      stderr: '',
    });

    await syncIssueCreate({
      issueId: 99,
      title: 'Blast-radius test issue',
      body: 'Body',
      _backend: 'gh',
      _spawnFn: spawnFn,
    });

    assert.ok(existsSync(syncLogPath), 'issue-sync.log should exist after syncIssueCreate');
    const newContent = readFileSync(syncLogPath, 'utf8').slice(priorSize);
    const newLines = newContent.trim().split('\n').filter(Boolean);
    assert.ok(newLines.length > 0, 'at least one new log line should be written');
    const warningEntry = newLines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((entry) => entry['kind'] === 'issue_sync_active');
    assert.ok(warningEntry !== undefined, 'issue_sync_active entry should be present');
    assert.equal(warningEntry['backend'], 'gh');
    assert.equal(warningEntry['issue_id'], 99);
    assert.equal(warningEntry['title'], 'Blast-radius test issue');
  });
});

describe('syncIssueCreate cwd injection', () => {
  it('passes _cwd to spawnOpts when tmb_default_repo is configured', async () => {
    const capturedOpts: SpawnSyncOptions[] = [];
    const spawnFn: SpawnFn = (_cmd, _args, opts) => {
      capturedOpts.push(opts);
      return { status: 0, stdout: 'https://github.com/owner/repo/issues/1\n', stderr: '' };
    };
    const result = await syncIssueCreate({
      issueId: 1,
      title: 'Test',
      body: 'Body',
      _backend: 'gh',
      _spawnFn: spawnFn,
      _cwd: '/workspace/plugin',
    });
    assert.ok(result !== null);
    assert.equal(capturedOpts.length, 1);
    assert.ok(capturedOpts[0] !== undefined);
    assert.ok(
      typeof capturedOpts[0]!.cwd === 'string' && (capturedOpts[0]!.cwd as string).endsWith('/plugin'),
      `expected cwd to end with /plugin, got: ${String(capturedOpts[0]!.cwd)}`,
    );
  });

  it('leaves spawnOpts.cwd undefined when _cwd is not provided', async () => {
    const capturedOpts: SpawnSyncOptions[] = [];
    const spawnFn: SpawnFn = (_cmd, _args, opts) => {
      capturedOpts.push(opts);
      return { status: 0, stdout: 'https://github.com/owner/repo/issues/2\n', stderr: '' };
    };
    const result = await syncIssueCreate({
      issueId: 2,
      title: 'Test',
      body: 'Body',
      _backend: 'gh',
      _spawnFn: spawnFn,
    });
    assert.ok(result !== null);
    assert.equal(capturedOpts.length, 1);
    assert.ok(capturedOpts[0] !== undefined);
    assert.equal(capturedOpts[0]!.cwd, undefined, 'cwd should be undefined when _cwd is not provided');
  });
});

describe('syncIssueClose', () => {
  it('returns ok=true when gh close succeeds', async () => {
    const spawnFn = makeSpawnFn([
      { status: 0, stdout: '', stderr: '' },
    ]);
    const result = await syncIssueClose({
      remote_iid: 42,
      remote_kind: 'github',
      _spawnFn: spawnFn,
    });
    assert.equal(result.ok, true);
  });

  it('returns ok=false with stderr+exit_code when glab close fails (#2871)', async () => {
    const spawnFn = makeSpawnFn([
      { status: 1, stdout: '', stderr: 'not found' },
    ]);
    const result = await syncIssueClose({
      remote_iid: 10,
      remote_kind: 'gitlab',
      _spawnFn: spawnFn,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'non_zero_exit');
    assert.equal(result.exit_code, 1);
    assert.equal(result.stderr, 'not found');
  });
});
