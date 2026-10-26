import { spawnSync, SpawnSyncOptions } from 'node:child_process';
import { SUBPROCESS_TIMEOUT_MS } from '../utils/timeouts.js';
import { liveCliBlockReason, liveCliBlockedMessage } from '../utils/live-cli-guard.js';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveClaudeLogDir } from '../platform.js';

function resolveLogDir(): string {
  if (process.env.TMB_SYNC_LOG_DIR) return process.env.TMB_SYNC_LOG_DIR;
  return resolveClaudeLogDir();
}

const readyLogDirs = new Set<string>();

function syncLog(entry: Record<string, unknown>): void {
  try {
    const logDir = resolveLogDir();
    if (!readyLogDirs.has(logDir)) {
      mkdirSync(logDir, { recursive: true });
      readyLogDirs.add(logDir);
    }
    const line = JSON.stringify({ ...entry, ts: new Date().toISOString() }) + '\n';
    appendFileSync(join(logDir, 'issue-sync.log'), line);
  } catch {
    // Swallow all errors — logging must never break the caller.
  }
}

export type SpawnFn = (
  cmd: string,
  args: string[],
  opts: SpawnSyncOptions,
) => { status: number | null; stdout: string; stderr: string };

export function defaultSpawnFn(
  cmd: string,
  args: string[],
  opts: SpawnSyncOptions,
): { status: number | null; stdout: string; stderr: string } {
  const blockReason = liveCliBlockReason();
  if (blockReason) {
    const message = liveCliBlockedMessage(blockReason, cmd, args);
    syncLog({ event: 'live_cli_blocked', cmd, args, reason: blockReason });
    return { status: null, stdout: '', stderr: message };
  }
  const result = spawnSync(cmd, args, opts);
  return {
    status: result.status,
    stdout: result.stdout ? String(result.stdout) : '',
    stderr: result.stderr ? String(result.stderr) : '',
  };
}

interface ParsedIid {
  iid: number;
  host: string;
  repoPath: string;
}

function parseRemoteIid(stdout: string, _kind: 'github' | 'gitlab'): ParsedIid | null {
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    const urlMatch = trimmed.match(
      /https?:\/\/([^/]+)\/([^/]+(?:\/[^/]+)+?)\/-?\/?(?:issues|work_items)\/(\d+)/,
    );
    if (urlMatch) {
      const host = urlMatch[1]!;
      const repoPath = urlMatch[2]!;
      const iid = parseInt(urlMatch[3]!, 10);
      return { iid, host, repoPath };
    }
  }
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (/^#\d+$/.test(trimmed)) {
      const iid = parseInt(trimmed.slice(1), 10);
      return { iid, host: '', repoPath: '' };
    }
  }
  return null;
}

function extractRemoteHostAndRepo(remoteUrl: string): { host: string; repoPath: string } | null {
  if (!remoteUrl) return null;
  const httpMatch = remoteUrl.match(/https?:\/\/([^/]+)\/([^/]+(?:\/[^/]+)+?)(?:\.git)?$/);
  if (httpMatch) return { host: httpMatch[1]!, repoPath: httpMatch[2]! };
  const sshMatch = remoteUrl.match(/git@([^:]+):(.+?)(?:\.git)?$/);
  if (sshMatch) return { host: sshMatch[1]!, repoPath: sshMatch[2]! };
  return null;
}

async function readBackVerify(
  backend: 'gh' | 'glab',
  iid: number,
  spawnFn: SpawnFn,
  spawnOpts: SpawnSyncOptions,
  repoSlug?: string,
): Promise<{ ok: boolean; reason?: string }> {
  try {
    let result: { status: number | null; stdout: string; stderr: string };
    if (backend === 'gh') {
      const args = ['issue', 'view', String(iid), '--json', 'number,url'];
      if (repoSlug) args.push('--repo', repoSlug);
      result = spawnFn('gh', args, spawnOpts);
    } else {
      const args = ['issue', 'view', String(iid)];
      if (repoSlug) args.push('-R', repoSlug);
      result = spawnFn('glab', args, spawnOpts);
    }
    if (result.status !== 0) {
      return { ok: false, reason: 'read_back_non_zero_exit' };
    }
    if (backend === 'gh') {
      let parsed: { number?: number; url?: string };
      try {
        parsed = JSON.parse(result.stdout) as { number?: number; url?: string };
      } catch {
        return { ok: false, reason: 'read_back_parse_failed' };
      }
      if (parsed.url && parsed.url.includes('/pull/')) {
        return { ok: false, reason: 'read_back_is_pr' };
      }
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: 'read_back_error' };
  }
}

// Extract the `owner/repo` slug (the `--repo` / `-R` argument value) from a
// configured remote URL, including the host so gh/glab target the exact repo
// rather than inferring it from process.cwd(). Returns null when the URL can't
// be parsed (the caller then omits the flag and falls back to _cwd).
export function repoSlugFromRemoteUrl(remoteUrl: string): string | null {
  const parsed = extractRemoteHostAndRepo(remoteUrl);
  if (!parsed) return null;
  const repoPath = parsed.repoPath.replace(/\.git$/, '');
  return `${parsed.host}/${repoPath}`;
}

// Stamped on every remote body so a retry can find the issue a create whose
// result was lost already made (GH 1863). created_at is the per-workspace nonce.
const MARKER_OPEN = '<!-- ';
const MARKER_CLOSE = ' -->';

export function issueSyncMarker(issueId: number, createdAt: string): string {
  return `${MARKER_OPEN}tmb-issue:${issueId}:${createdAt}${MARKER_CLOSE}`;
}

function withMarker(body: string, marker: string | undefined): string {
  if (!marker) return body;
  return body === '' ? marker : `${body}\n\n${marker}`;
}

export interface SyncIssueCreateOpts {
  issueId: number;
  title: string;
  body: string;
  marker?: string;
  labels?: string[];
  milestone?: string;
  _spawnFn?: SpawnFn;
  _cwd?: string;
  _remoteUrl?: string;
  // Explicit gh `--repo` / glab `-R` target (owner/repo, optionally host-
  // qualified), derived from the issue's repo remotes (#155/#146). When set the
  // create/close commands target this repo explicitly rather than process.cwd().
  _repoSlug?: string;
}

export interface SyncResult {
  remote_iid: number;
  remote_kind: 'github' | 'gitlab';
  // Requested labels that do not exist in the remote taxonomy and were dropped
  // from the remote create (#36). Undefined when nothing was dropped.
  unknown_labels?: string[];
}

// Fetch the remote label taxonomy for a backend (one probe per create, no
// persistent cache — #36). Returns the set of existing label names, or null
// when the taxonomy can't be determined (probe failed / unparseable) so the
// caller falls back to passing every requested label through unchanged rather
// than stripping them all.
async function fetchRemoteLabelNames(
  backend: 'gh' | 'glab',
  spawnFn: SpawnFn,
  spawnOpts: SpawnSyncOptions,
  repoSlug?: string,
): Promise<Set<string> | null> {
  try {
    let result: { status: number | null; stdout: string; stderr: string };
    if (backend === 'gh') {
      const args = ['label', 'list', '--json', 'name'];
      if (repoSlug) args.push('--repo', repoSlug);
      result = spawnFn('gh', args, spawnOpts);
    } else {
      const args = ['label', 'list', '-F', 'json'];
      if (repoSlug) args.push('-R', repoSlug);
      result = spawnFn('glab', args, spawnOpts);
    }
    if (result.status !== 0) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      return null;
    }
    if (!Array.isArray(parsed)) return null;
    const names = new Set<string>();
    for (const entry of parsed) {
      if (entry && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string') {
        names.add((entry as { name: string }).name);
      }
    }
    return names;
  } catch {
    return null;
  }
}

// Verify a remote issue exists before adopting its iid onto a local row (#36),
// and read back its milestone title and label names for the adopt path.
// gh: `gh issue view <iid> --repo <slug> --json number,title,state,milestone,labels`
// — a PR iid makes `gh issue view` exit non-zero, so PRs are rejected
// implicitly. glab: `glab issue view <iid> -R <slug> --output json`; a glab
// stdout that is not JSON still verifies (existence is the exit status).
// Returns { ok:false, reason } on any failure so the caller can surface a
// named error and create nothing.
export interface RemoteIssueVerification {
  ok: boolean;
  reason?: string;
  milestone?: string | null;
  labels?: string[];
}

function parseRemoteMetadata(stdout: string): { milestone: string | null; labels: string[] } | null {
  let parsed: { milestone?: unknown; labels?: unknown };
  try {
    parsed = JSON.parse(stdout) as { milestone?: unknown; labels?: unknown };
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const m = parsed.milestone;
  let milestone: string | null = null;
  if (typeof m === 'string' && m !== '') milestone = m;
  else if (m && typeof m === 'object' && typeof (m as { title?: unknown }).title === 'string') {
    milestone = (m as { title: string }).title || null;
  }
  const labels: string[] = [];
  if (Array.isArray(parsed.labels)) {
    for (const l of parsed.labels) {
      if (typeof l === 'string') labels.push(l);
      else if (l && typeof l === 'object' && typeof (l as { name?: unknown }).name === 'string') {
        labels.push((l as { name: string }).name);
      }
    }
  }
  return { milestone, labels };
}

export async function verifyRemoteIssue(
  backend: 'gh' | 'glab',
  iid: number,
  opts: { spawnFn?: SpawnFn; cwd?: string; repoSlug?: string } = {},
): Promise<RemoteIssueVerification> {
  const spawnFn = opts.spawnFn ?? defaultSpawnFn;
  const spawnOpts: SpawnSyncOptions = { timeout: SUBPROCESS_TIMEOUT_MS, encoding: 'utf8' };
  if (opts.cwd) spawnOpts.cwd = opts.cwd;
  try {
    let result: { status: number | null; stdout: string; stderr: string };
    if (backend === 'gh') {
      const args = ['issue', 'view', String(iid), '--json', 'number,title,state,milestone,labels'];
      if (opts.repoSlug) args.push('--repo', opts.repoSlug);
      result = spawnFn('gh', args, spawnOpts);
    } else {
      const args = ['issue', 'view', String(iid), '--output', 'json'];
      if (opts.repoSlug) args.push('-R', opts.repoSlug);
      result = spawnFn('glab', args, spawnOpts);
    }
    if (result.status !== 0) return { ok: false, reason: 'not_found_or_error' };
    if (backend === 'gh') {
      let parsed: { number?: unknown };
      try {
        parsed = JSON.parse(result.stdout) as { number?: unknown };
      } catch {
        return { ok: false, reason: 'parse_failed' };
      }
      if (typeof parsed.number !== 'number') return { ok: false, reason: 'parse_failed' };
    }
    const metadata = parseRemoteMetadata(result.stdout);
    return metadata ? { ok: true, ...metadata } : { ok: true };
  } catch {
    return { ok: false, reason: 'spawn_error' };
  }
}

// 'unknown': the remote may hold the issue (timeout, silent non-zero exit, no
// iid parsed, read-back failed after an iid was parsed). 'failed': it does not.
export type SyncOutcome = 'failed' | 'unknown';

export interface SyncFailure {
  ok: false;
  reason: 'spawn_error' | 'non_zero_exit' | 'parse_failed' | 'no_backend' | 'verify_failed';
  outcome: SyncOutcome;
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
  const { title, labels = [], milestone } = opts;
  const body = withMarker(opts.body, opts.marker);
  const kind = backend === 'gh' ? 'github' : 'gitlab';
  const spawnOpts: SpawnSyncOptions = { timeout: SUBPROCESS_TIMEOUT_MS, encoding: 'utf8' };
  if (opts._cwd) {
    spawnOpts.cwd = opts._cwd;
  }

  // Label pre-validation (#36): split the requested labels against the remote's
  // actual taxonomy and create with only the valid subset, so one unknown label
  // no longer fails the whole create. When the taxonomy can't be fetched, pass
  // every label through unchanged (prior behaviour). An empty valid subset still
  // creates the issue with no labels. The full requested set stays on the local
  // row (the caller persists it) — this only shapes the remote command.
  let effectiveLabels = labels;
  let unknownLabels: string[] = [];
  if (labels.length > 0) {
    const known = await fetchRemoteLabelNames(backend, spawnFn, spawnOpts, opts._repoSlug);
    if (known !== null) {
      effectiveLabels = labels.filter((l) => known.has(l));
      unknownLabels = labels.filter((l) => !known.has(l));
      if (unknownLabels.length > 0) {
        syncLog({
          event: 'issue_create_labels_filtered',
          backend,
          issueId: opts.issueId,
          unknown: unknownLabels,
          kept: effectiveLabels,
        });
      }
    }
  }

  let cmd: string;
  let args: string[];
  if (backend === 'gh') {
    cmd = 'gh';
    args = ['issue', 'create', '--title', title, '--body', body];
    if (opts._repoSlug) {
      args.push('--repo', opts._repoSlug);
    }
    for (const label of effectiveLabels) {
      args.push('--label', label);
    }
    if (milestone) {
      args.push('--milestone', milestone);
    }
  } else {
    cmd = 'glab';
    args = ['issue', 'create', '--title', title, '--description', body];
    if (opts._repoSlug) {
      args.push('-R', opts._repoSlug);
    }
    for (const label of effectiveLabels) {
      args.push('--label', label);
    }
    if (milestone) {
      args.push('--milestone', milestone);
    }
  }

  try {
    const result = spawnFn(cmd, args, spawnOpts);
    if (result.status !== 0) {
      const silent = result.stdout.trim() === '' && result.stderr.trim() === '';
      const outcome: SyncOutcome = result.status === null || silent ? 'unknown' : 'failed';
      syncLog({
        event: 'issue_create_failed',
        backend,
        issueId: opts.issueId,
        outcome,
        stderr: result.stderr,
        exit_code: result.status,
      });
      return {
        ok: false,
        reason: 'non_zero_exit',
        outcome,
        backend,
        stderr: result.stderr,
        stdout: result.stdout,
        exit_code: result.status ?? undefined,
      };
    }
    const parsed = parseRemoteIid(result.stdout, kind);
    if (parsed === null) {
      syncLog({
        event: 'issue_create_parse_failed',
        backend,
        issueId: opts.issueId,
        outcome: 'unknown',
        stdout: result.stdout,
      });
      return {
        ok: false,
        reason: 'parse_failed',
        outcome: 'unknown',
        backend,
        stdout: result.stdout,
        message: `could not parse remote issue id from "${cmd} ${args.join(' ')}" output`,
      };
    }

    if (opts._remoteUrl && parsed.host) {
      const configured = extractRemoteHostAndRepo(opts._remoteUrl);
      if (configured) {
        const hostMismatch = parsed.host !== configured.host;
        const repoMismatch = parsed.repoPath.replace(/\.git$/, '') !== configured.repoPath.replace(/\.git$/, '');
        if (hostMismatch || repoMismatch) {
          syncLog({
            event: 'issue_create_verify_failed',
            backend,
            issueId: opts.issueId,
            reason: 'host_repo_mismatch',
            outcome: 'failed',
            parsed_host: parsed.host,
            parsed_repo: parsed.repoPath,
            configured_host: configured.host,
            configured_repo: configured.repoPath,
            stdout: result.stdout,
          });
          return {
            ok: false,
            reason: 'verify_failed',
            outcome: 'failed',
            backend,
            stdout: result.stdout,
            message: `remote iid host/repo mismatch: got ${parsed.host}/${parsed.repoPath}, expected ${configured.host}/${configured.repoPath}`,
          };
        }
      }
    }

    const verifyResult = await readBackVerify(backend, parsed.iid, spawnFn, spawnOpts, opts._repoSlug);
    if (!verifyResult.ok) {
      syncLog({
        event: 'issue_create_verify_failed',
        backend,
        issueId: opts.issueId,
        reason: verifyResult.reason,
        outcome: 'unknown',
        iid: parsed.iid,
        stdout: result.stdout,
      });
      return {
        ok: false,
        reason: 'verify_failed',
        outcome: 'unknown',
        backend,
        stdout: result.stdout,
        message: `read-back verify failed for iid ${parsed.iid}: ${verifyResult.reason}`,
      };
    }

    syncLog({
      event: 'issue_create_success',
      backend,
      issueId: opts.issueId,
      iid: parsed.iid,
      stdout: result.stdout,
    });

    return {
      remote_iid: parsed.iid,
      remote_kind: kind,
      unknown_labels: unknownLabels.length > 0 ? unknownLabels : undefined,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    syncLog({
      event: 'issue_create_error',
      backend,
      issueId: opts.issueId,
      outcome: 'failed',
      error: message,
    });
    return {
      ok: false,
      reason: 'spawn_error',
      outcome: 'failed',
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
      outcome: 'failed',
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
  return {
    ok: false,
    reason: 'no_backend',
    outcome: 'failed',
    backend: null,
    message: `unrecognised backend "${backend}" — use issue_create for dual-backend creates`,
  };
}

export { isFailure as isSyncFailure };

export type MarkerLookupResult =
  | { ok: true; iids: number[] }
  | { ok: false; reason: 'non_zero_exit' | 'parse_failed' | 'spawn_error'; exit_code?: number; stderr?: string; message?: string };

const MARKER_LOOKUP_LIMIT = 50;

function markerToken(marker: string): string {
  if (!marker.startsWith(MARKER_OPEN) || !marker.endsWith(MARKER_CLOSE)) return marker;
  return marker.slice(MARKER_OPEN.length, marker.length - MARKER_CLOSE.length);
}

function markerListArgs(backend: 'gh' | 'glab', repoSlug: string | undefined, search: string | null): string[] {
  if (backend === 'gh') {
    const args = ['issue', 'list', '--state', 'all', '--limit', String(MARKER_LOOKUP_LIMIT), '--json', 'number,body'];
    if (search !== null) args.push('--search', `"${search}" in:body`);
    if (repoSlug) args.push('--repo', repoSlug);
    return args;
  }
  const args = ['issue', 'list', '--all', '--per-page', String(MARKER_LOOKUP_LIMIT), '--output', 'json'];
  if (search !== null) args.push('--search', search, '--in', 'description');
  if (repoSlug) args.push('-R', repoSlug);
  return args;
}

function matchMarker(backend: 'gh' | 'glab', stdout: string, marker: string): number[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const iidKey = backend === 'gh' ? 'number' : 'iid';
  const bodyKey = backend === 'gh' ? 'body' : 'description';
  const iids: number[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const iid = (entry as Record<string, unknown>)[iidKey];
    const text = (entry as Record<string, unknown>)[bodyKey];
    if (typeof iid === 'number' && typeof text === 'string' && text.includes(marker)) iids.push(iid);
  }
  return iids;
}

// Remote issues whose body carries `marker`, lowest iid first (GH 1863). The
// newest-50 list needs no search index; the --search list covers older issues.
export async function findIssuesByMarker(
  backend: 'gh' | 'glab',
  marker: string,
  opts: { spawnFn?: SpawnFn; cwd?: string; repoSlug?: string } = {},
): Promise<MarkerLookupResult> {
  const spawnFn = opts.spawnFn ?? defaultSpawnFn;
  const spawnOpts: SpawnSyncOptions = { timeout: SUBPROCESS_TIMEOUT_MS, encoding: 'utf8' };
  if (opts.cwd) spawnOpts.cwd = opts.cwd;
  for (const search of [null, markerToken(marker)]) {
    let result: { status: number | null; stdout: string; stderr: string };
    try {
      result = spawnFn(backend, markerListArgs(backend, opts.repoSlug, search), spawnOpts);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      syncLog({ event: 'issue_marker_lookup_error', backend, marker, error: message });
      return { ok: false, reason: 'spawn_error', message };
    }
    if (result.status !== 0) {
      syncLog({ event: 'issue_marker_lookup_failed', backend, marker, exit_code: result.status, stderr: result.stderr });
      return { ok: false, reason: 'non_zero_exit', exit_code: result.status ?? undefined, stderr: result.stderr };
    }
    const iids = matchMarker(backend, result.stdout, marker);
    if (iids === null) {
      syncLog({ event: 'issue_marker_lookup_parse_failed', backend, marker, stdout: result.stdout });
      return { ok: false, reason: 'parse_failed', message: `could not parse "${backend} issue list" output` };
    }
    if (iids.length > 0) {
      const sorted = [...new Set(iids)].sort((a, b) => a - b);
      syncLog({ event: 'issue_marker_lookup_match', backend, marker, iids: sorted, searched: search !== null });
      return { ok: true, iids: sorted };
    }
  }
  return { ok: true, iids: [] };
}

export interface SyncIssueCloseOpts {
  remote_iid: number;
  remote_kind: 'github' | 'gitlab';
  _spawnFn?: SpawnFn;
  _cwd?: string;
  // Explicit gh `--repo` / glab `-R` target derived from the issue's repo
  // remotes (#155/#146) — target the exact repo, never process.cwd().
  _repoSlug?: string;
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
    if (opts._repoSlug) {
      args.push('--repo', opts._repoSlug);
    }
  } else {
    cmd = 'glab';
    args = ['issue', 'close', String(remote_iid)];
    if (opts._repoSlug) {
      args.push('-R', opts._repoSlug);
    }
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

export interface SyncIssueUpdateFields {
  milestone?: string;
  labels?: { add: string[]; remove: string[] };
  title?: string;
}

export interface SyncIssueUpdateOpts {
  spawnFn?: SpawnFn;
  cwd?: string;
  repoSlug?: string;
}

export async function syncIssueUpdate(
  backend: 'gh' | 'glab',
  iid: number,
  fields: SyncIssueUpdateFields,
  opts: SyncIssueUpdateOpts = {},
): Promise<SyncCloseResult> {
  const spawnFn = opts.spawnFn ?? defaultSpawnFn;
  const spawnOpts: SpawnSyncOptions = { timeout: SUBPROCESS_TIMEOUT_MS, encoding: 'utf8' };
  if (opts.cwd) spawnOpts.cwd = opts.cwd;

  const args: string[] = backend === 'gh' ? ['issue', 'edit', String(iid)] : ['issue', 'update', String(iid)];
  if (opts.repoSlug) args.push(backend === 'gh' ? '--repo' : '-R', opts.repoSlug);
  if (fields.milestone !== undefined) args.push(backend === 'gh' ? '--milestone' : '-m', fields.milestone);
  if (fields.labels) {
    const addFlag = backend === 'gh' ? '--add-label' : '--label';
    const removeFlag = backend === 'gh' ? '--remove-label' : '--unlabel';
    for (const l of fields.labels.add) args.push(addFlag, l);
    for (const l of fields.labels.remove) args.push(removeFlag, l);
  }
  if (fields.title !== undefined) args.push(backend === 'gh' ? '--title' : '-t', fields.title);

  try {
    const result = spawnFn(backend, args, spawnOpts);
    if (result.status !== 0) {
      syncLog({ event: 'issue_update_failed', backend, remote_iid: iid, stderr: result.stderr, exit_code: result.status });
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
    syncLog({ event: 'issue_update_error', backend, remote_iid: iid, error: message });
    return { ok: false, reason: 'spawn_error', message };
  }
}
