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
// Each reindex writes one wm_reindex audit row, and its state to wm_freshness:
// 'running' before its work, then 'idle'/'ok' in the transaction that stamps
// the commit, or 'failed'/'error'. freshnessBlock reads that row back.
import type { TrajectoryDB } from '../db.js';
import { nowISO, TARGET_SCHEMA_VERSION } from '../db.js';
import type { WorldModelGraph } from '../graph.js';
import { WorldModelGraph as Graph } from '../graph.js';
import { serverLog } from '../logger.js';
import { isGeneratedPath } from '../parsing/extract.js';
import { EXTRACTOR_VERSION } from '../symbol-index.js';
import { insertAudit } from '../tools/audit.js';
import { blobMd5, scannedAtNow, walkRepoAtCommit, type ScanFile, type ScanOutput } from '../tools/scan-walk.js';
import { persistRepoReindex, type ReindexScope, type ScanError } from '../tools/scan.js';
import { CommitContent, commitExists, diffNameStatus, lastCommitByPath, lsTree } from '../utils/git-objects.js';
import { runGit } from '../utils/git-run.js';
import { resolveIndexTargetRef, targetBranchOf } from '../utils/index-target.js';
import { liveLock, releaseLock, scanLockPath, tryLock } from '../utils/scan-lock.js';

export type ReindexMode = 'incremental' | 'full';
export type FullReason = 'null_stamp' | 'unreachable' | 'stamp_changed' | 'mismatch' | 'scan' | 'range_failed';
export type ReindexReason = 'ref_moved' | FullReason;
export type ReindexTrigger = 'read' | 'startup_catchup' | 'scan' | 'spawn' | 'hook';
// The trigger as wm_freshness and the freshness block name it (decision 2487).
export type BlockTrigger = 'read' | 'spawn' | 'startup' | 'scan' | 'hook' | 'fetch';
export type ReindexState = 'idle' | 'running' | 'failed';
export type ReindexOutcome = 'ok' | 'error';

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
  // The ref `target` was resolved from, recorded as wm_freshness.target_ref.
  targetRef?: string | null;
  // Wait for another holder of the lock rather than answer stale.
  wait?: boolean;
}

export interface FreshnessBlock {
  indexed_commit: string | null;
  target_ref: string | null;
  target_commit: string | null;
  stale: boolean;
  reindex: {
    state: ReindexState;
    mode: ReindexMode | null;
    trigger: BlockTrigger | null;
    started_at: string | null;
    finished_at: string | null;
    elapsed_ms: number | null;
    outcome: ReindexOutcome | null;
  };
  needs_review_count: number;
}

interface FreshnessRow {
  target_ref: string | null;
  target_commit: string | null;
  reindex_state: ReindexState;
  reindex_mode: ReindexMode | null;
  reindex_trigger: BlockTrigger | null;
  reindex_started_at: string | null;
  reindex_finished_at: string | null;
  reindex_elapsed_ms: number | null;
  reindex_outcome: ReindexOutcome | null;
}

// One reindex as wm_freshness records it.
export interface ReindexRun {
  mode: ReindexMode;
  trigger: ReindexTrigger;
  startedMs: number;
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

export function blockTrigger(trigger: ReindexTrigger): BlockTrigger {
  return trigger === 'startup_catchup' ? 'startup' : trigger;
}

// How fresh `repo`'s index is (decision 2487), read from the DB alone with the
// dashboard reader's semantics (dashboard/server/freshness.ts): no wm_freshness
// row reads as state 'idle' with every other field null.
export function freshnessBlock(db: TrajectoryDB, repo: string | null): FreshnessBlock | null {
  if (!repo) return null;
  const indexed = db.get<{ indexed_commit: string | null }>(`SELECT indexed_commit FROM repos WHERE name = ?`, [repo])?.indexed_commit ?? null;
  const f = db.get<FreshnessRow>(
    `SELECT target_ref, target_commit, reindex_state, reindex_mode, reindex_trigger, reindex_started_at,
            reindex_finished_at, reindex_elapsed_ms, reindex_outcome
       FROM wm_freshness WHERE repo = ?`,
    [repo],
  );
  const review = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM wm_concepts WHERE repo = ? AND status IN ('suspect','broken')`, [repo]);
  const targetCommit = f?.target_commit ?? null;
  const state = f?.reindex_state ?? 'idle';
  const elapsed = f?.reindex_elapsed_ms;
  return {
    indexed_commit: indexed,
    target_ref: f?.target_ref ?? null,
    target_commit: targetCommit,
    stale: indexed === null || indexed !== targetCommit || state === 'running',
    reindex: {
      state,
      mode: f?.reindex_mode ?? null,
      trigger: f?.reindex_trigger ?? null,
      started_at: f?.reindex_started_at ?? null,
      finished_at: f?.reindex_finished_at ?? null,
      elapsed_ms: elapsed === null || elapsed === undefined ? null : Number(elapsed),
      outcome: f?.reindex_outcome ?? null,
    },
    needs_review_count: Number(review?.n ?? 0),
  };
}

// The repo's resolved target, written only when the ref or commit changed.
export function recordTarget(db: TrajectoryDB, repo: string, ref: string | null, commit: string): void {
  try {
    const row = db.get<{ target_ref: string | null; target_commit: string | null }>(
      `SELECT target_ref, target_commit FROM wm_freshness WHERE repo = ?`,
      [repo],
    );
    if (row && row.target_ref === ref && row.target_commit === commit) return;
    db.run(
      `INSERT INTO wm_freshness (repo, target_ref, target_commit, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(repo) DO UPDATE SET
         target_ref = excluded.target_ref, target_commit = excluded.target_commit, updated_at = excluded.updated_at`,
      [repo, ref, commit, nowISO()],
    );
  } catch (e) {
    serverLog({ event: 'wm_freshness_target_error', repo, error: (e as Error).message });
  }
}

// A reindex of `repo` begins: state 'running', the finish fields cleared.
export function markReindexStart(db: TrajectoryDB, repo: string, run: ReindexRun): void {
  db.run(
    `INSERT INTO wm_freshness (repo, reindex_state, reindex_mode, reindex_trigger, reindex_started_at, updated_at)
     VALUES (?, 'running', ?, ?, ?, ?)
     ON CONFLICT(repo) DO UPDATE SET
       reindex_state = 'running', reindex_mode = excluded.reindex_mode, reindex_trigger = excluded.reindex_trigger,
       reindex_started_at = excluded.reindex_started_at, reindex_finished_at = NULL, reindex_elapsed_ms = NULL,
       reindex_outcome = NULL, updated_at = excluded.updated_at`,
    [repo, run.mode, blockTrigger(run.trigger), new Date(run.startedMs).toISOString(), nowISO()],
  );
}

// A reindex of `repo` ends: 'idle'/'ok' when it committed with no stage error,
// else 'failed'/'error'. A target given is written with it.
export function markReindexFinish(db: TrajectoryDB, repo: string, run: ReindexRun, ok: boolean, target?: { ref: string | null; commit: string }): void {
  const finished = Date.now();
  db.run(
    `INSERT INTO wm_freshness (repo, target_ref, target_commit, reindex_state, reindex_mode, reindex_trigger,
                               reindex_started_at, reindex_finished_at, reindex_elapsed_ms, reindex_outcome, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(repo) DO UPDATE SET
       target_ref = CASE WHEN ? THEN excluded.target_ref ELSE target_ref END,
       target_commit = CASE WHEN ? THEN excluded.target_commit ELSE target_commit END,
       reindex_state = excluded.reindex_state, reindex_mode = excluded.reindex_mode,
       reindex_trigger = excluded.reindex_trigger, reindex_started_at = excluded.reindex_started_at,
       reindex_finished_at = excluded.reindex_finished_at, reindex_elapsed_ms = excluded.reindex_elapsed_ms,
       reindex_outcome = excluded.reindex_outcome, updated_at = excluded.updated_at`,
    [
      repo,
      target?.ref ?? null,
      target?.commit ?? null,
      ok ? 'idle' : 'failed',
      run.mode,
      blockTrigger(run.trigger),
      new Date(run.startedMs).toISOString(),
      new Date(finished).toISOString(),
      Math.max(0, finished - run.startedMs),
      ok ? 'ok' : 'error',
      nowISO(),
      target ? 1 : 0,
      target ? 1 : 0,
    ],
  );
}

// markReindexFinish(…, false) that never throws, for a reindex already failing.
export function markReindexFailed(db: TrajectoryDB, repo: string, run: ReindexRun): void {
  try {
    markReindexFinish(db, repo, run, false);
  } catch (e) {
    serverLog({ event: 'wm_freshness_finish_error', repo, error: (e as Error).message });
  }
}

// At server start: a 'running' row no live process is reindexing (neither the
// workspace scan lock nor the repo's lock is held) was left by a process that
// died mid-reindex; it becomes 'failed'/'error', finished_at the time it was
// found and elapsed_ms unknown. Returns the repos it marked.
export function sweepStaleReindexes(db: TrajectoryDB, dbPath: string): string[] {
  if (liveLock(scanLockPath(dbPath))) return [];
  const swept: string[] = [];
  for (const { repo } of db.all<{ repo: string }>(`SELECT repo FROM wm_freshness WHERE reindex_state = 'running' ORDER BY repo`)) {
    if (liveLock(scanLockPath(dbPath, repo))) continue;
    const now = nowISO();
    db.run(
      `UPDATE wm_freshness SET reindex_state = 'failed', reindex_outcome = 'error', reindex_finished_at = ?,
              reindex_elapsed_ms = NULL, updated_at = ?
        WHERE repo = ? AND reindex_state = 'running'`,
      [now, now, repo],
    );
    swept.push(repo);
  }
  return swept;
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
  const resolved: { ref: string | null; commit: string } | null =
    opts.target === undefined
      ? resolveIndexTargetRef(db, repo, state.path)
      : opts.target
        ? { ref: opts.targetRef ?? null, commit: opts.target }
        : null;
  if (!resolved) return fresh(repo, state.indexed_commit, null);
  const target = resolved.commit;
  recordTarget(db, repo, resolved.ref, target);
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
  const run: ReindexRun = { mode: reason ? 'full' : 'incremental', trigger, startedMs: started };
  const finish = (errors: ScanError[]) => markReindexFinish(db, repo, run, errors.length === 0);
  markReindexStart(db, repo, run);
  try {
    if (!reason) {
      const range = await reindexRange(db, graph, repo, state.path, state.indexed_commit!, target, finish);
      if (range) {
        recordReindex(db, { repo, mode: 'incremental', reason: 'ref_moved', trigger, from_commit: state.indexed_commit, to_commit: target, ...range, ms: Date.now() - started });
        return 'incremental';
      }
      reason = 'range_failed';
      run.mode = 'full';
      markReindexStart(db, repo, run);
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
      const stats = await persistRepoReindex(db, graph, output, undefined, finish);
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
  } catch (e) {
    markReindexFailed(db, repo, run);
    throw e;
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
  onApply: (errors: ScanError[]) => void,
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
    const stats = await persistRepoReindex(db, graph, out, scope, onApply);
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

const REF_MOVE_FETCH_TIMEOUT_MS = 5000;

// The ref-move hook's detached child (hooks/ref-move-reindex.ts): after a
// forge merge it first fetches origin/<target branch>, which the merge moved
// on the remote only, then brings the repo to its target without waiting for
// a lock another process holds.
export async function reindexOnRefMove(
  db: TrajectoryDB,
  graph: WorldModelGraph,
  repo: string,
  opts: { dbPath: string; fetch?: boolean },
): Promise<Freshness | null> {
  const path = repoState(db, repo)?.path;
  if (!path) return null;
  if (opts.fetch) {
    runGit(path, ['fetch', '-q', 'origin', targetBranchOf(db, repo, path)], {
      timeout: REF_MOVE_FETCH_TIMEOUT_MS,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
  }
  return ensureFresh(db, graph, repo, { dbPath: opts.dbPath, trigger: 'hook', wait: false });
}

// Test seam: wait for any reindex this process is running.
export async function reindexIdle(): Promise<void> {
  await Promise.all([...inflight.values()].map((p) => p.catch(() => undefined)));
}
