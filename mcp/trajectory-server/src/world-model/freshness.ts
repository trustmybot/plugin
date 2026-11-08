// Freshness of a repo's world model (GH 2584). The index is built from git
// objects at one commit, stamped in repos.indexed_commit (and
// repos.indexed_stamp, the extractor and schema version it was built with).
// Before a world_model_* read answers, and before a task spawn returns,
// ensureFresh compares the stamp with the target and brings the index there;
// the caller waits for it:
//   - no-op: the stamp is the target and current; no walk, no writes.
//   - incremental: the stamp is a reachable commit; only the paths
//     `git diff <indexed> <target>` names are re-parsed, whatever their number.
//   - full: the stamp is NULL, unreachable or from another extractor or schema
//     version, or the repo's newest wm_reindex verdict is a mismatch; the repo
//     is rebuilt from the target's tree. /scan is scan_run's full rebuild.
//
// One reindex per repo runs at a time: in this process callers share the
// running one; across processes scan.<repo>.lock beside the DB (and the
// workspace scan.lock) guards it. A reader that finds another process holding
// either answers from the current index at once, with the diff's paths (every
// path when a full rebuild is pending) marked stale; a spawn waits instead.
// Each reindex writes one wm_reindex audit row.
import type { TrajectoryDB } from '../db.js';
import { TARGET_SCHEMA_VERSION } from '../db.js';
import type { WorldModelGraph } from '../graph.js';
import { WorldModelGraph as Graph } from '../graph.js';
import { isGeneratedPath } from '../parsing/extract.js';
import { EXTRACTOR_VERSION } from '../symbol-index.js';
import { insertAudit } from '../tools/audit.js';
import { blobMd5, scannedAtNow, walkRepoAtCommit, type ScanFile, type ScanOutput } from '../tools/scan-walk.js';
import { persistRepoReindex, type ReindexScope } from '../tools/scan.js';
import { CommitContent, commitExists, diffNameStatus, lastCommitByPath, lsTree } from '../utils/git-objects.js';
import { resolveIndexTarget } from '../utils/index-target.js';
import { liveLock, releaseLock, scanLockPath, tryLock } from '../utils/scan-lock.js';

export type ReindexMode = 'incremental' | 'full';
export type FullReason = 'null_stamp' | 'unreachable' | 'stamp_changed' | 'mismatch' | 'scan' | 'range_failed';
export type ReindexReason = 'ref_moved' | FullReason;
export type ReindexTrigger = 'read' | 'startup_catchup' | 'scan' | 'spawn';

const REPO_REBUILD_TIMEOUT_MS = 10 * 60 * 1000;
const LOCK_WAIT_MS = 10 * 60 * 1000;
const LOCK_POLL_MS = 100;

export interface Freshness {
  repo: string;
  indexed_commit: string | null;
  target_commit: string | null;
  // Paths whose cards may be out of date because another process is still
  // reindexing them; 'all' marks every path.
  stale: 'all' | ReadonlySet<string>;
  mode?: ReindexMode;
}

export interface FreshnessOptions {
  dbPath: string;
  trigger?: ReindexTrigger;
  target?: string | null;
  // Wait for another holder of the lock rather than answer stale.
  wait?: boolean;
}

export interface ReindexRow {
  repo: string;
  mode: ReindexMode;
  reason: ReindexReason;
  trigger: ReindexTrigger;
  from_commit: string | null;
  to_commit: string;
  files_diffed: number;
  files_parsed: number;
  dirs_touched: number;
  ms: number;
}

interface RepoState {
  path: string;
  indexed_commit: string | null;
  indexed_stamp: string | null;
}

const NOTHING: ReadonlySet<string> = new Set();
const inflight = new Map<string, Promise<ReindexMode | undefined>>();

export function indexStamp(): string {
  return `${EXTRACTOR_VERSION}:${TARGET_SCHEMA_VERSION}`;
}

export function triggerOfSource(source: string): ReindexTrigger {
  return source === 'startup_catchup' ? 'startup_catchup' : 'scan';
}

export function isStale(fresh: Freshness | null | undefined, relPath: string): boolean {
  if (!fresh) return false;
  return fresh.stale === 'all' || fresh.stale.has(relPath);
}

export function freshnessFields(fresh: Freshness | null | undefined): { indexed_commit: string | null; target_commit: string | null } | Record<string, never> {
  return fresh ? { indexed_commit: fresh.indexed_commit, target_commit: fresh.target_commit } : {};
}

export function recordReindex(db: TrajectoryDB, row: ReindexRow): void {
  insertAudit(db, {
    issue_id: -1,
    from_node: 'system',
    event_type: 'wm_reindex',
    summary: `World model of ${row.repo} reindexed to ${row.to_commit.slice(0, 12)} (${row.mode}, ${row.reason}, ${row.trigger}): ${row.files_diffed} paths diffed, ${row.files_parsed} parsed, ${row.dirs_touched} dirs in ${row.ms} ms`,
    content_json: JSON.stringify(row),
    repo: row.repo,
  });
}

function repoState(db: TrajectoryDB, repo: string): RepoState | null {
  return db.get<RepoState>(`SELECT path, indexed_commit, indexed_stamp FROM repos WHERE name = ?`, [repo]) ?? null;
}

// A mismatch verdict (the shadow rebuild's) with no full rebuild after it.
function mismatchPending(db: TrajectoryDB, repo: string): boolean {
  const row = db.get<{ mode: string | null }>(
    `SELECT json_extract(content_json, '$.mode') AS mode FROM audit
      WHERE event_type = 'wm_reindex' AND repo = ?
        AND json_extract(content_json, '$.mode') IN ('mismatch', 'full')
      ORDER BY id DESC LIMIT 1`,
    [repo],
  );
  return row?.mode === 'mismatch';
}

function current(db: TrajectoryDB, repo: string, state: RepoState, target: string): boolean {
  return state.indexed_commit === target && state.indexed_stamp === indexStamp() && !mismatchPending(db, repo);
}

// Why the incremental path cannot be trusted for this repo, or null when it can.
export function fullRebuildReason(db: TrajectoryDB, repo: string, state: RepoState): FullReason | null {
  if (!state.indexed_commit) return 'null_stamp';
  if (state.indexed_stamp !== indexStamp()) return 'stamp_changed';
  if (!commitExists(state.path, state.indexed_commit)) return 'unreachable';
  if (mismatchPending(db, repo)) return 'mismatch';
  return null;
}

// The paths that differ between two commits, or 'all' when git cannot say.
export function diffPaths(repoPath: string, from: string | null, to: string | null): 'all' | ReadonlySet<string> {
  if (!from || !to) return 'all';
  if (from === to) return NOTHING;
  const diff = diffNameStatus(repoPath, from, to);
  return diff === null ? 'all' : new Set(diff.map((d) => d.path));
}

function fresh(repo: string, commit: string | null, target: string | null, mode?: ReindexMode): Freshness {
  return { repo, indexed_commit: commit, target_commit: target, stale: NOTHING, ...(mode ? { mode } : {}) };
}

function heldElsewhere(db: TrajectoryDB, repo: string, state: RepoState, target: string): Freshness {
  const stale = fullRebuildReason(db, repo, state) ? 'all' : diffPaths(state.path, state.indexed_commit, target);
  return { repo, indexed_commit: state.indexed_commit, target_commit: target, stale };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Take the repo's lock: false when another process holds it (or a workspace
// scan runs) and the caller does not wait, or the wait ran out.
async function takeLock(dbPath: string, repoLock: string, wait: boolean): Promise<boolean> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    if (!liveLock(scanLockPath(dbPath)) && tryLock(repoLock)) return true;
    if (!wait || Date.now() >= deadline) return false;
    await sleep(LOCK_POLL_MS);
  }
}

// Bring `repo` to its target (opts.target, else origin/<target branch>, else
// HEAD) and say how fresh the answer is.
export async function ensureFresh(
  db: TrajectoryDB,
  graph: WorldModelGraph,
  repo: string,
  opts: FreshnessOptions,
): Promise<Freshness> {
  let state = repoState(db, repo);
  if (!state) return fresh(repo, null, null);
  const target = opts.target === undefined ? resolveIndexTarget(db, repo, state.path) : opts.target;
  if (!target) return fresh(repo, state.indexed_commit, null);
  if (current(db, repo, state, target)) return fresh(repo, target, target);

  for (;;) {
    const running = inflight.get(repo);
    if (!running) break;
    await running.catch(() => undefined);
    state = repoState(db, repo);
    if (!state) return fresh(repo, null, target);
    if (current(db, repo, state, target)) return fresh(repo, target, target);
  }

  const repoLock = scanLockPath(opts.dbPath, repo);
  const run = (async () => {
    if (!(await takeLock(opts.dbPath, repoLock, opts.wait === true))) return null;
    try {
      return await reindexLocked(db, graph, repo, target, opts.trigger ?? 'read');
    } finally {
      releaseLock(repoLock);
    }
  })();
  const shared = run.then((mode) => mode ?? undefined);
  shared.catch(() => undefined);
  inflight.set(repo, shared);
  let mode: ReindexMode | null | undefined;
  try {
    mode = await run;
  } finally {
    if (inflight.get(repo) === shared) inflight.delete(repo);
  }
  if (mode === null) return heldElsewhere(db, repo, repoState(db, repo) ?? state, target);
  const after = repoState(db, repo);
  return fresh(repo, after?.indexed_commit ?? null, target, mode);
}

// Under the repo's lock: re-read the stamp, since another process may have
// brought it to the target meanwhile, then run the path it needs.
async function reindexLocked(
  db: TrajectoryDB,
  graph: WorldModelGraph,
  repo: string,
  target: string,
  trigger: ReindexTrigger,
): Promise<ReindexMode | undefined> {
  const state = repoState(db, repo);
  if (!state || current(db, repo, state, target)) return undefined;
  const started = Date.now();
  let reason: FullReason | null = fullRebuildReason(db, repo, state);
  if (!reason) {
    const range = await reindexRange(db, graph, repo, state.path, state.indexed_commit!, target);
    if (range) {
      recordReindex(db, { repo, mode: 'incremental', reason: 'ref_moved', trigger, from_commit: state.indexed_commit, to_commit: target, ...range, ms: Date.now() - started });
      return 'incremental';
    }
    reason = 'range_failed';
  }
  const out = await walkRepoAtCommit(state.path, target, REPO_REBUILD_TIMEOUT_MS, repo);
  try {
    const output: ScanOutput = {
      session_dir: state.path,
      scanned_at: scannedAtNow(),
      repos: [out.repo],
      files: out.files,
      contents: out.content ? new Map([[repo, out.content]]) : new Map(),
    };
    const stats = await persistRepoReindex(db, graph, output);
    recordReindex(db, {
      repo,
      mode: 'full',
      reason,
      trigger,
      from_commit: state.indexed_commit ?? '',
      to_commit: target,
      files_diffed: out.files.length,
      files_parsed: stats.files_parsed,
      dirs_touched: stats.dirs_touched,
      ms: Date.now() - started,
    });
  } finally {
    out.content?.close();
  }
  return 'full';
}

function dirOf(relPath: string): string {
  const i = relPath.lastIndexOf('/');
  return i >= 0 ? relPath.slice(0, i) : '';
}

// The incremental path: the commit's tree for the file list, md5s re-read only
// for the paths the diff names (and any tracked path the index lacks), the
// directories holding a diffed path and their ancestors rewritten. null when
// git cannot list the tree or the diff, so the caller rebuilds the repo.
async function reindexRange(
  db: TrajectoryDB,
  graph: WorldModelGraph,
  repo: string,
  repoPath: string,
  from: string,
  to: string,
): Promise<{ files_diffed: number; files_parsed: number; dirs_touched: number } | null> {
  const tree = lsTree(repoPath, to);
  const diff = tree ? diffNameStatus(repoPath, from, to) : null;
  if (!tree || !diff) return null;
  const diffed = new Set(diff.map((d) => d.path));
  const stored = new Map(graph.allFilesForRepo(repo).map((f) => [Graph.relativeFilePath(f), f]));
  const lastBy = lastCommitByPath(repoPath, `${from}..${to}`);
  const content = new CommitContent(repoPath, to, tree, true);
  try {
    const changed = new Set<string>();
    const files: ScanFile[] = [];
    for (const [rel, entry] of tree) {
      const prev = stored.get(rel);
      const generated = isGeneratedPath(rel);
      const reread = diffed.has(rel) || (!prev && (!generated || rel.endsWith('.map')));
      if (!reread) {
        files.push({
          repo,
          path: rel,
          content_md5: prev?.content_md5 ?? '',
          size_bytes: prev?.size_bytes ?? entry.size,
          last_commit_sha: prev?.last_commit_sha ?? '',
        });
        continue;
      }
      if (!generated) changed.add(rel);
      files.push({
        repo,
        path: rel,
        content_md5: blobMd5(await content.read(rel)),
        size_bytes: entry.size,
        last_commit_sha: lastBy.get(rel) ?? prev?.last_commit_sha ?? '',
      });
    }
    const dirs = new Set<string>();
    for (const path of [...diffed, ...changed]) {
      let dir = dirOf(path);
      for (;;) {
        dirs.add(`${repo} ${dir}`);
        if (dir === '') break;
        dir = dirOf(dir);
      }
    }
    const scope: ReindexScope = { changed, dirs };
    const out: ScanOutput = {
      session_dir: repoPath,
      scanned_at: scannedAtNow(),
      repos: [{ name: repo, path: repoPath, file_count: files.length, commit: to }],
      files,
      contents: new Map([[repo, content]]),
    };
    const stats = await persistRepoReindex(db, graph, out, scope);
    return { files_diffed: diff.length, files_parsed: stats.files_parsed, dirs_touched: stats.dirs_touched };
  } finally {
    content.close();
  }
}

export interface CatchUpResult {
  repo: string;
  indexed_commit: string | null;
  target_commit: string | null;
  mode: ReindexMode | null;
  held: boolean;
}

// startup_catchup: each known repo brought to its target, one at a time.
export async function catchUpRepos(
  db: TrajectoryDB,
  graph: WorldModelGraph,
  opts: { dbPath: string; trigger: ReindexTrigger },
): Promise<CatchUpResult[]> {
  const results: CatchUpResult[] = [];
  for (const { name } of db.all<{ name: string }>(`SELECT name FROM repos ORDER BY name`)) {
    try {
      const f = await ensureFresh(db, graph, name, { dbPath: opts.dbPath, trigger: opts.trigger });
      results.push({
        repo: name,
        indexed_commit: f.indexed_commit,
        target_commit: f.target_commit,
        mode: f.mode ?? null,
        held: f.stale === 'all' || f.stale.size > 0,
      });
    } catch {
      results.push({ repo: name, indexed_commit: null, target_commit: null, mode: null, held: false });
    }
  }
  return results;
}

// Test seam: wait for any reindex this process is running.
export async function reindexIdle(): Promise<void> {
  await Promise.all([...inflight.values()].map((p) => p.catch(() => undefined)));
}
