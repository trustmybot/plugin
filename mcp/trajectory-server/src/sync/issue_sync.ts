import { spawnSync, SpawnSyncOptions } from 'node:child_process';
import { SUBPROCESS_TIMEOUT_MS } from '../utils/timeouts.js';
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

function parseRemoteIid(stdout: string, _kind: 'github' | 'gitlab'): number | null {
  // #2875: glab ≥1.40 (2026-Q1) switched issue_create stdout from
  //   `https://gitlab.com/o/r/-/issues/42`
  // to
  //   `https://gitlab.com/o/r/-/work_items/42`
  // Accept both URL forms plus the older bare-iid form `#42` (some gh
  // versions and the glab --output=text shape). Single pattern handles
  // both backends — the URL host + provider mapping is decided upstream
  // by the caller's `kind` arg, so the parser only needs the trailing iid.
  const match = stdout.match(/(?:#|\/(?:issues|work_items)\/)(\d+)/);
  if (match) return parseInt(match[1], 10);
  return null;
}

export interface SyncIssueCreateOpts {
  issueId: number;
  title: string;
  body: string;
  labels?: string[];
  _spawnFn?: SpawnFn;
  _cwd?: string;
}

export interface SyncResult {
  remote_iid: number;
  remote_kind: 'github' | 'gitlab';
}

// #2871: callers need the failure reason to surface in tool responses,
// not just a null. SyncFailure carries enough detail for bro to decide
// whether to retry, fall back, or surface to the Human.
export interface SyncFailure {
  ok: false;
  reason: 'spawn_error' | 'non_zero_exit' | 'parse_failed' | 'no_backend';
  backend: 'gh' | 'glab' | 'both' | null;
  stderr?: string;
  stdout?: string;
  exit_code?: number;
  message?: string;
}

function isFailure(r: SyncResult | SyncFailure): r is SyncFailure {
  return (r as SyncFailure).ok === false;
}

async function createOnBackend(
  backend: 'gh' | 'glab',
  opts: SyncIssueCreateOpts,
  spawnFn: SpawnFn,
): Promise<SyncResult | SyncFailure> {
  const { title, body, labels = [] } = opts;
  const kind = backend === 'gh' ? 'github' : 'gitlab';
  const spawnOpts: SpawnSyncOptions = { timeout: SUBPROCESS_TIMEOUT_MS, encoding: 'utf8' };
  if (opts._cwd) {
    spawnOpts.cwd = opts._cwd;
  }

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
        exit_code: result.status,
      });
      return {
        ok: false,
        reason: 'non_zero_exit',
        backend,
        stderr: result.stderr,
        stdout: result.stdout,
        exit_code: result.status ?? undefined,
      };
    }
    const remote_iid = parseRemoteIid(result.stdout, kind);
    if (remote_iid === null) {
      syncLog({
        event: 'issue_create_parse_failed',
        backend,
        issueId: opts.issueId,
        stdout: result.stdout,
      });
      return {
        ok: false,
        reason: 'parse_failed',
        backend,
        stdout: result.stdout,
        message: `could not parse remote issue id from "${cmd} ${args.join(' ')}" output`,
      };
    }
    return { remote_iid, remote_kind: kind };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    syncLog({
      event: 'issue_create_error',
      backend,
      issueId: opts.issueId,
      error: message,
    });
    return {
      ok: false,
      reason: 'spawn_error',
      backend,
      message,
    };
  }
}

export async function syncIssueCreate(
  opts: SyncIssueCreateOpts & { _backend?: 'gh' | 'glab' | 'both' },
): Promise<SyncResult | SyncFailure> {
  const spawnFn = opts._spawnFn ?? defaultSpawnFn;
  const backend = opts._backend;

  if (!backend) {
    return {
      ok: false,
      reason: 'no_backend',
      backend: null,
      message: 'no remote backend configured (issue_sync key resolved to null)',
    };
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
    if (!isFailure(ghResult)) return ghResult;
    return createOnBackend('glab', opts, spawnFn);
  }
  return {
    ok: false,
    reason: 'no_backend',
    backend: null,
    message: `unrecognised backend "${backend}"`,
  };
}

export { isFailure as isSyncFailure };

export interface SyncIssueCloseOpts {
  remote_iid: number;
  remote_kind: 'github' | 'gitlab';
  _spawnFn?: SpawnFn;
  _cwd?: string;
}

export interface SyncCloseResult {
  ok: boolean;
  reason?: 'spawn_error' | 'non_zero_exit';
  stderr?: string;
  stdout?: string;
  exit_code?: number;
  message?: string;
}

export async function syncIssueClose(opts: SyncIssueCloseOpts): Promise<SyncCloseResult> {
  const spawnFn = opts._spawnFn ?? defaultSpawnFn;
  const { remote_iid, remote_kind } = opts;
  const spawnOpts: SpawnSyncOptions = { timeout: SUBPROCESS_TIMEOUT_MS, encoding: 'utf8' };
  if (opts._cwd) {
    spawnOpts.cwd = opts._cwd;
  }

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
        exit_code: result.status,
      });
      return {
        ok: false,
        reason: 'non_zero_exit',
        stderr: result.stderr,
        stdout: result.stdout,
        exit_code: result.status ?? undefined,
      };
    }
    return { ok: true };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    syncLog({
      event: 'issue_close_error',
      remote_kind,
      remote_iid,
      error: message,
    });
    return { ok: false, reason: 'spawn_error', message };
  }
}
