import { spawnSync, SpawnSyncOptions } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const logDir = join(homedir(), '.claude', 'tmb', 'logs');
const syncLogPath = join(logDir, 'issue-sync.log');

try {
  mkdirSync(logDir, { recursive: true });
} catch {
  // Log dir creation failed; logging becomes a no-op.
}

function syncLog(entry: Record<string, unknown>): void {
  try {
    const line = JSON.stringify({ ...entry, ts: new Date().toISOString() }) + '\n';
    appendFileSync(syncLogPath, line);
  } catch {
    // Swallow all errors — logging must never break the caller.
  }
}

type SpawnFn = (
  cmd: string,
  args: string[],
  opts: SpawnSyncOptions,
) => { status: number | null; stdout: string; stderr: string };

function defaultSpawnFn(
  cmd: string,
  args: string[],
  opts: SpawnSyncOptions,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(cmd, args, opts);
  return {
    status: result.status,
    stdout: result.stdout ? String(result.stdout) : '',
    stderr: result.stderr ? String(result.stderr) : '',
  };
}

function parseRemoteIid(stdout: string, kind: 'github' | 'gitlab'): number | null {
  const trimmed = stdout.trim();
  if (kind === 'github') {
    // gh issue create returns a URL like https://github.com/owner/repo/issues/42
    const match = trimmed.match(/\/issues\/(\d+)/);
    if (match) return parseInt(match[1], 10);
  } else {
    // glab issue create returns a URL like https://gitlab.com/owner/repo/-/issues/42
    const match = trimmed.match(/\/issues\/(\d+)/);
    if (match) return parseInt(match[1], 10);
  }
  return null;
}

export interface SyncIssueCreateOpts {
  issueId: number;
  title: string;
  body: string;
  labels?: string[];
  _spawnFn?: SpawnFn;
}

export interface SyncResult {
  remote_iid: number;
  remote_kind: 'github' | 'gitlab';
}

async function createOnBackend(
  backend: 'gh' | 'glab',
  opts: SyncIssueCreateOpts,
  spawnFn: SpawnFn,
): Promise<SyncResult | null> {
  const { title, body, labels = [] } = opts;
  const kind = backend === 'gh' ? 'github' : 'gitlab';
  const spawnOpts: SpawnSyncOptions = { timeout: 5000, encoding: 'utf8' };

  let cmd: string;
  let args: string[];
  if (backend === 'gh') {
    cmd = 'gh';
    args = ['issue', 'create', '--title', title, '--body', body];
    for (const label of labels) {
      args.push('--label', label);
    }
  } else {
    cmd = 'glab';
    args = ['issue', 'create', '--title', title, '--description', body];
    for (const label of labels) {
      args.push('--label', label);
    }
  }

  try {
    const result = spawnFn(cmd, args, spawnOpts);
    if (result.status !== 0) {
      syncLog({
        event: 'issue_create_failed',
        backend,
        issueId: opts.issueId,
        stderr: result.stderr,
      });
      return null;
    }
    const remote_iid = parseRemoteIid(result.stdout, kind);
    if (remote_iid === null) {
      syncLog({
        event: 'issue_create_parse_failed',
        backend,
        issueId: opts.issueId,
        stdout: result.stdout,
      });
      return null;
    }
    return { remote_iid, remote_kind: kind };
  } catch (e) {
    syncLog({
      event: 'issue_create_error',
      backend,
      issueId: opts.issueId,
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

export async function syncIssueCreate(
  opts: SyncIssueCreateOpts & { _backend?: 'gh' | 'glab' | 'both' },
): Promise<SyncResult | null> {
  const spawnFn = opts._spawnFn ?? defaultSpawnFn;
  const backend = opts._backend;

  if (!backend) {
    return null;
  }

  syncLog({
    kind: 'issue_sync_active',
    backend,
    issue_id: opts.issueId,
    title: opts.title,
  });

  if (backend === 'gh') {
    return createOnBackend('gh', opts, spawnFn);
  }
  if (backend === 'glab') {
    return createOnBackend('glab', opts, spawnFn);
  }
  if (backend === 'both') {
    const ghResult = await createOnBackend('gh', opts, spawnFn);
    if (ghResult) return ghResult;
    return createOnBackend('glab', opts, spawnFn);
  }
  return null;
}

export interface SyncIssueCloseOpts {
  remote_iid: number;
  remote_kind: 'github' | 'gitlab';
  _spawnFn?: SpawnFn;
}

export async function syncIssueClose(opts: SyncIssueCloseOpts): Promise<boolean> {
  const spawnFn = opts._spawnFn ?? defaultSpawnFn;
  const { remote_iid, remote_kind } = opts;
  const spawnOpts: SpawnSyncOptions = { timeout: 5000, encoding: 'utf8' };

  let cmd: string;
  let args: string[];
  if (remote_kind === 'github') {
    cmd = 'gh';
    args = ['issue', 'close', String(remote_iid)];
  } else {
    cmd = 'glab';
    args = ['issue', 'close', String(remote_iid)];
  }

  try {
    const result = spawnFn(cmd, args, spawnOpts);
    if (result.status !== 0) {
      syncLog({
        event: 'issue_close_failed',
        remote_kind,
        remote_iid,
        stderr: result.stderr,
      });
      return false;
    }
    return true;
  } catch (e) {
    syncLog({
      event: 'issue_close_error',
      remote_kind,
      remote_iid,
      error: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}
