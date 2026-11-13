// Freshness of a repo's world model (GH 2584). The index is built from git
// objects at one commit, stamped in repos.indexed_commit (and
// repos.indexed_stamp, the extractor and schema version it was built with).
// Before a world_model_* read answers, and before a task spawn returns,
// ensureFresh compares the stamp with the target and brings the index there;
// the caller waits for it. A read and the startup catch-up first fetch
// origin/<target branch>, at most once per 10 minutes per repo
// (fetchTargetIfDue); task_provision fetches whatever the window
// (fetchTargetNow). Then:
//   - no-op: the stamp is the target and current; no walk, no writes.
//   - incremental: the stamp is a reachable commit; only the paths
//     `git diff <indexed> <target>` names are re-parsed, whatever their number.
//   - full: the stamp is NULL, unreachable or from another extractor or schema
//     version, or a shadow-compare mismatch holds for the repo's stamp
//     (mismatchPending); the repo is rebuilt from the target's tree. /scan is
//     scan_run's full rebuild.
//
// One reindex per repo runs at a time: in this process callers share the
// running one; across processes scan.<repo>.lock beside the DB (and the
// workspace scan.lock) guards it. A reader that finds another process holding
// either answers from the current index at once, with the diff's paths (every
// path when a full rebuild is pending) marked stale; a spawn waits instead.
// Each reindex writes one wm_reindex audit row, and its state to wm_freshness:
// 'running' before its work, then 'idle'/'ok' in the transaction that stamps
// the commit, or 'failed'/'error'. freshnessBlock reads that row back.
import { execFile } from 'node:child_process';
import { nowISO, TARGET_SCHEMA_VERSION } from '../db.js';
import { WorldModelGraph as Graph } from '../graph.js';
import { serverLog } from '../logger.js';
import { isGeneratedPath } from '../parsing/extract.js';
import { EXTRACTOR_VERSION } from '../symbol-index.js';
import { normalizeAgent } from '../middleware/agent-scope.js';
import { insertAudit } from '../tools/audit.js';
import { blobMd5, scannedAtNow, walkRepoAtCommit } from '../tools/scan-walk.js';
import { persistRepoReindex } from '../tools/scan.js';
import { CommitContent, commitExists, diffNameStatus, lastCommitByPath, logOrder, lsTree, resolveRefCommit } from '../utils/git-objects.js';
import { runGit } from '../utils/git-run.js';
import { resolveIndexTargetRef, targetBranchOf } from '../utils/index-target.js';
import { liveLock, releaseLock, scanLockPath, tryLock } from '../utils/scan-lock.js';
const REPO_REBUILD_TIMEOUT_MS = 10 * 60 * 1000;
const LOCK_WAIT_MS = 10 * 60 * 1000;
const LOCK_POLL_MS = 100;
const NOTHING = new Set();
const inflight = new Map();
let stampForTests = null;
export function indexStamp() {
    return stampForTests ?? `${EXTRACTOR_VERSION}:${TARGET_SCHEMA_VERSION}`;
}
// Test seam: stand in for an extractor or schema version bump.
export function __setIndexStampForTests(stamp) {
    stampForTests = stamp ?? null;
}
export function triggerOfSource(source) {
    return source === 'startup_catchup' ? 'startup_catchup' : 'scan';
}
export function isStale(fresh, relPath) {
    if (!fresh)
        return false;
    return fresh.stale === 'all' || fresh.stale.has(relPath);
}
export function freshnessFields(fresh) {
    return fresh ? { indexed_commit: fresh.indexed_commit, target_commit: fresh.target_commit } : {};
}
export function recordReindex(db, row) {
    insertAudit(db, {
        issue_id: -1,
        from_node: 'system',
        event_type: 'wm_reindex',
        summary: row.mode === 'mismatch'
            ? `World model of ${row.repo} at ${row.to_commit.slice(0, 12)} differs from a clean rebuild (shadow compare, ${row.trigger}); the next reindex rebuilds it in full`
            : `World model of ${row.repo} reindexed to ${row.to_commit.slice(0, 12)} (${row.mode}, ${row.reason}, ${row.trigger}): ${row.files_diffed} paths diffed, ${row.files_parsed} parsed, ${row.dirs_touched} dirs in ${row.ms} ms`,
        content_json: JSON.stringify(row),
        repo: row.repo,
    });
}
export function blockTrigger(trigger) {
    return trigger === 'startup_catchup' ? 'startup' : trigger;
}
// How fresh `repo`'s index is (decision 2487), read from the DB alone with the
// dashboard reader's semantics (dashboard/server/freshness.ts): no wm_freshness
// row reads as state 'idle' with every other field null.
export function freshnessBlock(db, repo) {
    if (!repo)
        return null;
    const indexed = db.get(`SELECT indexed_commit FROM repos WHERE name = ?`, [repo])?.indexed_commit ?? null;
    const f = db.get(`SELECT target_ref, target_commit, reindex_state, reindex_mode, reindex_trigger, reindex_started_at,
            reindex_finished_at, reindex_elapsed_ms, reindex_outcome
       FROM wm_freshness WHERE repo = ?`, [repo]);
    const review = db.get(`SELECT (SELECT COUNT(*) FROM wm_concepts WHERE repo = ? AND status IN ('suspect','broken'))
          + (SELECT COUNT(*) FROM wm_directories WHERE repo = ? AND readme_review_pending = 1) AS n`, [repo, repo]);
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
export function recordTarget(db, repo, ref, commit) {
    try {
        const row = db.get(`SELECT target_ref, target_commit FROM wm_freshness WHERE repo = ?`, [repo]);
        if (row && row.target_ref === ref && row.target_commit === commit)
            return;
        db.run(`INSERT INTO wm_freshness (repo, target_ref, target_commit, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(repo) DO UPDATE SET
         target_ref = excluded.target_ref, target_commit = excluded.target_commit, updated_at = excluded.updated_at`, [repo, ref, commit, nowISO()]);
    }
    catch (e) {
        serverLog({ event: 'wm_freshness_target_error', repo, error: e.message });
    }
}
// A reindex of `repo` begins: state 'running', the finish fields cleared.
export function markReindexStart(db, repo, run) {
    db.run(`INSERT INTO wm_freshness (repo, reindex_state, reindex_mode, reindex_trigger, reindex_started_at, updated_at)
     VALUES (?, 'running', ?, ?, ?, ?)
     ON CONFLICT(repo) DO UPDATE SET
       reindex_state = 'running', reindex_mode = excluded.reindex_mode, reindex_trigger = excluded.reindex_trigger,
       reindex_started_at = excluded.reindex_started_at, reindex_finished_at = NULL, reindex_elapsed_ms = NULL,
       reindex_outcome = NULL, updated_at = excluded.updated_at`, [repo, run.mode, blockTrigger(run.trigger), new Date(run.startedMs).toISOString(), nowISO()]);
}
// A reindex of `repo` ends: 'idle'/'ok' when it committed with no stage error,
// else 'failed'/'error'. A target given is written with it.
export function markReindexFinish(db, repo, run, ok, target) {
    const finished = Date.now();
    db.run(`INSERT INTO wm_freshness (repo, target_ref, target_commit, reindex_state, reindex_mode, reindex_trigger,
                               reindex_started_at, reindex_finished_at, reindex_elapsed_ms, reindex_outcome, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(repo) DO UPDATE SET
       target_ref = CASE WHEN ? THEN excluded.target_ref ELSE target_ref END,
       target_commit = CASE WHEN ? THEN excluded.target_commit ELSE target_commit END,
       reindex_state = excluded.reindex_state, reindex_mode = excluded.reindex_mode,
       reindex_trigger = excluded.reindex_trigger, reindex_started_at = excluded.reindex_started_at,
       reindex_finished_at = excluded.reindex_finished_at, reindex_elapsed_ms = excluded.reindex_elapsed_ms,
       reindex_outcome = excluded.reindex_outcome, updated_at = excluded.updated_at`, [
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
    ]);
}
// markReindexFinish(…, false) that never throws, for a reindex already failing.
export function markReindexFailed(db, repo, run) {
    try {
        markReindexFinish(db, repo, run, false);
    }
    catch (e) {
        serverLog({ event: 'wm_freshness_finish_error', repo, error: e.message });
    }
}
// At server start: a 'running' row no live process is reindexing (neither the
// workspace scan lock nor the repo's lock is held) was left by a process that
// died mid-reindex; it becomes 'failed'/'error', finished_at the time it was
// found and elapsed_ms unknown. Returns the repos it marked.
export function sweepStaleReindexes(db, dbPath) {
    if (liveLock(scanLockPath(dbPath)))
        return [];
    const swept = [];
    for (const { repo } of db.all(`SELECT repo FROM wm_freshness WHERE reindex_state = 'running' ORDER BY repo`)) {
        if (liveLock(scanLockPath(dbPath, repo)))
            continue;
        const now = nowISO();
        db.run(`UPDATE wm_freshness SET reindex_state = 'failed', reindex_outcome = 'error', reindex_finished_at = ?,
              reindex_elapsed_ms = NULL, updated_at = ?
        WHERE repo = ? AND reindex_state = 'running'`, [now, now, repo]);
        swept.push(repo);
    }
    return swept;
}
function repoState(db, repo) {
    return db.get(`SELECT path, indexed_commit, indexed_stamp FROM repos WHERE name = ?`, [repo]) ?? null;
}
// A mismatch verdict (the daily shadow compare's, shadow-compare.ts) with no
// full rebuild after it: the index at its commit is suspect, so even a read
// at the target rebuilds it.
function mismatchUnrepaired(db, repo) {
    const row = db.get(`SELECT json_extract(content_json, '$.mode') AS mode FROM audit
      WHERE event_type = 'wm_reindex' AND repo = ?
        AND json_extract(content_json, '$.mode') IN ('mismatch', 'full')
      ORDER BY id DESC LIMIT 1`, [repo]);
    return row?.mode === 'mismatch';
}
// The repo's newest mismatch verdict holds: every reindex of it is a full
// rebuild that reparses every file, while repos.indexed_stamp is the stamp
// the verdict was written under (a new extractor or schema version ends it)
// and no clean shadow compare under another stamp came after it. A verdict
// with no stamp (written before stamps were recorded) holds until the next
// full rebuild.
export function mismatchPending(db, repo) {
    const verdict = db.get(`SELECT id, json_extract(content_json, '$.stamp') AS stamp FROM audit
      WHERE event_type = 'wm_reindex' AND repo = ? AND json_extract(content_json, '$.mode') = 'mismatch'
      ORDER BY id DESC LIMIT 1`, [repo]);
    if (!verdict)
        return false;
    if (verdict.stamp === null)
        return mismatchUnrepaired(db, repo);
    if (repoState(db, repo)?.indexed_stamp !== verdict.stamp)
        return false;
    const cleared = db.get(`SELECT 1 FROM audit
      WHERE event_type = 'wm_shadow_compare' AND repo = ? AND id > ?
        AND json_extract(content_json, '$.verdict') = 'match'
        AND json_extract(content_json, '$.stamp') <> ?
      LIMIT 1`, [repo, verdict.id, verdict.stamp]);
    return !cleared;
}
function current(db, repo, state, target) {
    return state.indexed_commit === target && state.indexed_stamp === indexStamp() && !mismatchUnrepaired(db, repo);
}
// Why the incremental path cannot be trusted for this repo, or null when it can.
export function fullRebuildReason(db, repo, state) {
    if (!state.indexed_commit)
        return 'null_stamp';
    if (state.indexed_stamp !== indexStamp())
        return 'stamp_changed';
    if (!commitExists(state.path, state.indexed_commit))
        return 'unreachable';
    if (mismatchPending(db, repo))
        return 'mismatch';
    return null;
}
// The paths that differ between two commits, or 'all' when git cannot say.
export function diffPaths(repoPath, from, to) {
    if (!from || !to)
        return 'all';
    if (from === to)
        return NOTHING;
    const diff = diffNameStatus(repoPath, from, to);
    return diff === null ? 'all' : new Set(diff.map((d) => d.path));
}
function fresh(repo, commit, target, mode) {
    return { repo, indexed_commit: commit, target_commit: target, stale: NOTHING, ...(mode ? { mode } : {}) };
}
function heldElsewhere(db, repo, state, target) {
    const stale = fullRebuildReason(db, repo, state) ? 'all' : diffPaths(state.path, state.indexed_commit, target);
    return { repo, indexed_commit: state.indexed_commit, target_commit: target, stale };
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
// Take the repo's lock: false when another process holds it (or a workspace
// scan runs) and the caller does not wait, or the wait ran out.
async function takeLock(dbPath, repoLock, wait) {
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
        if (!liveLock(scanLockPath(dbPath)) && tryLock(repoLock))
            return true;
        if (!wait || Date.now() >= deadline)
            return false;
        await sleep(LOCK_POLL_MS);
    }
}
// Bring `repo` to its target (opts.target, else origin/<target branch>, else
// HEAD) and say how fresh the answer is.
export async function ensureFresh(db, graph, repo, opts) {
    let state = repoState(db, repo);
    if (!state)
        return fresh(repo, null, null);
    const resolved = opts.target === undefined
        ? resolveIndexTargetRef(db, repo, state.path)
        : opts.target
            ? { ref: opts.targetRef ?? null, commit: opts.target }
            : null;
    if (!resolved)
        return fresh(repo, state.indexed_commit, null);
    const target = resolved.commit;
    recordTarget(db, repo, resolved.ref, target);
    if (current(db, repo, state, target))
        return fresh(repo, target, target);
    for (;;) {
        const running = inflight.get(repo);
        if (!running)
            break;
        await running.catch(() => undefined);
        state = repoState(db, repo);
        if (!state)
            return fresh(repo, null, target);
        if (current(db, repo, state, target))
            return fresh(repo, target, target);
    }
    const repoLock = scanLockPath(opts.dbPath, repo);
    const run = (async () => {
        if (!(await takeLock(opts.dbPath, repoLock, opts.wait === true)))
            return null;
        try {
            return await reindexLocked(db, graph, repo, target, opts.trigger ?? 'read');
        }
        finally {
            releaseLock(repoLock);
        }
    })();
    const shared = run.then((mode) => mode ?? undefined);
    shared.catch(() => undefined);
    inflight.set(repo, shared);
    let mode;
    try {
        mode = await run;
    }
    finally {
        if (inflight.get(repo) === shared)
            inflight.delete(repo);
    }
    if (mode === null)
        return heldElsewhere(db, repo, repoState(db, repo) ?? state, target);
    const after = repoState(db, repo);
    return fresh(repo, after?.indexed_commit ?? null, target, mode);
}
// Under the repo's lock: re-read the stamp, since another process may have
// brought it to the target meanwhile, then run the path it needs.
async function reindexLocked(db, graph, repo, target, trigger) {
    const state = repoState(db, repo);
    if (!state || current(db, repo, state, target))
        return undefined;
    const started = Date.now();
    let reason = fullRebuildReason(db, repo, state);
    const reparse = mismatchPending(db, repo);
    const run = { mode: reason ? 'full' : 'incremental', trigger, startedMs: started };
    const finish = (errors) => markReindexFinish(db, repo, run, errors.length === 0);
    markReindexStart(db, repo, run);
    try {
        if (!reason) {
            const range = await reindexRange(db, graph, repo, state.path, state.indexed_commit, target, finish);
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
            const output = {
                session_dir: state.path,
                scanned_at: scannedAtNow(),
                repos: [out.repo],
                files: out.files,
                contents: out.content ? new Map([[repo, out.content]]) : new Map(),
            };
            const stats = await persistRepoReindex(db, graph, output, undefined, finish, { reparse });
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
                concepts_flagged: stats.concepts_flagged,
                ms: Date.now() - started,
            });
        }
        finally {
            out.content?.close();
        }
    }
    catch (e) {
        markReindexFailed(db, repo, run);
        throw e;
    }
    return 'full';
}
function dirOf(relPath) {
    const i = relPath.lastIndexOf('/');
    return i >= 0 ? relPath.slice(0, i) : '';
}
// A path's last_commit_sha after a reindex of from..to: of the range's newest
// commit touching it and the stored one, whichever `git log <to>` lists first,
// the commit a clean scan names (a merge can bring in an older-dated side
// commit, or touch a path without changing it). The range's when the order is
// unknown; the stored one for a path the range does not touch.
function newestLastCommit(repoPath, inRange, stored) {
    const rivals = [];
    for (const [rel, sha] of inRange) {
        const prevSha = stored.get(rel)?.last_commit_sha;
        if (prevSha && prevSha !== sha)
            rivals.push(sha, prevSha);
    }
    const rank = rivals.length ? logOrder(repoPath, rivals) : null;
    return (rel, prev) => {
        const sha = inRange.get(rel);
        const prevSha = prev?.last_commit_sha ?? '';
        if (!sha)
            return prevSha;
        const a = rank?.get(sha);
        const b = rank?.get(prevSha);
        return a !== undefined && b !== undefined && b < a ? prevSha : sha;
    };
}
// The incremental path: the commit's tree for the file list, md5s re-read only
// for the paths the diff names (and any tracked path the index lacks), the
// directories holding a diffed path and their ancestors rewritten. null when
// git cannot list the tree or the diff, so the caller rebuilds the repo.
async function reindexRange(db, graph, repo, repoPath, from, to, onApply) {
    const tree = lsTree(repoPath, to);
    const diff = tree ? diffNameStatus(repoPath, from, to) : null;
    if (!tree || !diff)
        return null;
    const diffed = new Set(diff.map((d) => d.path));
    const stored = new Map(graph.allFilesForRepo(repo).map((f) => [Graph.relativeFilePath(f), f]));
    const lastCommit = newestLastCommit(repoPath, lastCommitByPath(repoPath, `${from}..${to}`), stored);
    const content = new CommitContent(repoPath, to, tree, true);
    try {
        const changed = new Set();
        const files = [];
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
                    last_commit_sha: lastCommit(rel, prev),
                });
                continue;
            }
            if (!generated)
                changed.add(rel);
            files.push({
                repo,
                path: rel,
                content_md5: blobMd5(await content.read(rel)),
                size_bytes: entry.size,
                last_commit_sha: lastCommit(rel, prev),
            });
        }
        const dirs = new Set();
        for (const path of [...diffed, ...changed]) {
            let dir = dirOf(path);
            for (;;) {
                dirs.add(`${repo} ${dir}`);
                if (dir === '')
                    break;
                dir = dirOf(dir);
            }
        }
        const scope = { changed, dirs };
        const out = {
            session_dir: repoPath,
            scanned_at: scannedAtNow(),
            repos: [{ name: repo, path: repoPath, file_count: files.length, commit: to }],
            files,
            contents: new Map([[repo, content]]),
        };
        const stats = await persistRepoReindex(db, graph, out, scope, onApply);
        return { files_diffed: diff.length, files_parsed: stats.files_parsed, dirs_touched: stats.dirs_touched, concepts_flagged: stats.concepts_flagged };
    }
    finally {
        content.close();
    }
}
// startup_catchup: each known repo brought to its target, one at a time, after
// the periodic fetch of origin/<target branch> when it is due. A failed fetch
// is logged and the repo reindexes to the local ref.
export async function catchUpRepos(db, graph, opts) {
    const results = [];
    for (const { name } of db.all(`SELECT name FROM repos ORDER BY name`)) {
        try {
            await fetchTargetIfDue(db, name, { agent: null });
            const f = await ensureFresh(db, graph, name, { dbPath: opts.dbPath, trigger: opts.trigger });
            results.push({
                repo: name,
                indexed_commit: f.indexed_commit,
                target_commit: f.target_commit,
                mode: f.mode ?? null,
                held: f.stale === 'all' || f.stale.size > 0,
            });
        }
        catch {
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
export async function reindexOnRefMove(db, graph, repo, opts) {
    const path = repoState(db, repo)?.path;
    if (!path)
        return null;
    if (opts.fetch) {
        runGit(path, ['fetch', '-q', 'origin', targetBranchOf(db, repo, path)], {
            timeout: REF_MOVE_FETCH_TIMEOUT_MS,
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        });
        stampTargetFetched(db, repo, Date.now());
    }
    return ensureFresh(db, graph, repo, { dbPath: opts.dbPath, trigger: 'hook', wait: false });
}
export const TARGET_FETCH_TTL_MS = 10 * 60 * 1000;
export const TARGET_FETCH_TIMEOUT_MS = 5000;
// Their worktree base is pinned at spawn (decision 2479).
const NO_FETCH_ROLES = new Set(['swe', 'code-reviewer']);
const execGitFetch = (args, opts) => new Promise((resolve, reject) => {
    execFile('git', args, { cwd: opts.cwd, env: opts.env, signal: opts.signal, killSignal: 'SIGKILL', encoding: 'utf8' }, (error, _stdout, stderr) => {
        if (error)
            reject(new Error(stderr.trim() || error.message));
        else
            resolve();
    });
});
let fetchRunner = execGitFetch;
let fetchTimeoutMs = TARGET_FETCH_TIMEOUT_MS;
const fetching = new Map();
export function stampTargetFetched(db, repo, nowMs) {
    try {
        db.run(`INSERT INTO wm_freshness (repo, target_fetched_at, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(repo) DO UPDATE SET target_fetched_at = excluded.target_fetched_at, updated_at = excluded.updated_at`, [repo, new Date(nowMs).toISOString(), nowISO()]);
    }
    catch (e) {
        serverLog({ event: 'wm_target_fetch_stamp_error', repo, error: e.message });
    }
}
// A stamp from the future (a clock set back) or unreadable opens the window.
function fetchDue(db, repo, nowMs) {
    const at = db.get(`SELECT target_fetched_at AS at FROM wm_freshness WHERE repo = ?`, [repo])?.at;
    if (!at)
        return true;
    const elapsed = nowMs - Date.parse(at);
    return !(elapsed >= 0 && elapsed < TARGET_FETCH_TTL_MS);
}
function hasOrigin(repoPath) {
    const res = runGit(repoPath, ['remote', 'get-url', 'origin']);
    return res.status === 0 && res.stdout.trim() !== '';
}
async function runFetchCapped(args, cwd) {
    const ac = new AbortController();
    let timer;
    const cap = new Promise((_, reject) => {
        timer = setTimeout(() => {
            ac.abort();
            reject(new Error(`git fetch ran past ${fetchTimeoutMs} ms`));
        }, fetchTimeoutMs);
    });
    try {
        await Promise.race([fetchRunner(args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, signal: ac.signal }), cap]);
    }
    finally {
        clearTimeout(timer);
    }
}
async function fetchTarget(db, repo, repoPath, nowMs) {
    const branch = targetBranchOf(db, repo, repoPath);
    const ref = `refs/remotes/origin/${branch}`;
    const before = resolveRefCommit(repoPath, ref);
    stampTargetFetched(db, repo, nowMs);
    try {
        await runFetchCapped(['-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=5', 'fetch', '-q', 'origin', branch], repoPath);
    }
    catch (e) {
        const error = e.message;
        serverLog({ event: 'wm_target_fetch_failed', repo, branch, error });
        return { result: 'failed', branch, error };
    }
    return { result: resolveRefCommit(repoPath, ref) === before ? 'unchanged' : 'moved', branch, error: null };
}
const SKIPPED = { result: 'skipped', branch: null, error: null };
async function fetchTargetShared(db, repo, opts) {
    try {
        if (NO_FETCH_ROLES.has(normalizeAgent(opts.agent)))
            return SKIPPED;
        if (process.env['TMB_WM_INDEX_TARGET'])
            return SKIPPED;
        const running = fetching.get(repo);
        if (running)
            return await running;
        const nowMs = opts.now ?? Date.now();
        const path = repoState(db, repo)?.path;
        if (!path || (!opts.force && !fetchDue(db, repo, nowMs)) || !hasOrigin(path))
            return SKIPPED;
        const run = fetchTarget(db, repo, path, nowMs);
        fetching.set(repo, run);
        try {
            return await run;
        }
        finally {
            if (fetching.get(repo) === run)
                fetching.delete(repo);
        }
    }
    catch (e) {
        const error = e.message;
        serverLog({ event: 'wm_target_fetch_failed', repo, error });
        return { result: 'failed', branch: null, error };
    }
}
// Before a world_model_* read and each startup catch-up reindex: fetch origin/<target branch> at most once per
// TARGET_FETCH_TTL_MS per repo, the window shared through
// wm_freshness.target_fetched_at, stamped on every attempt. Callers in this
// process share one in-flight fetch. Never throws.
export async function fetchTargetIfDue(db, repo, opts) {
    return (await fetchTargetShared(db, repo, { ...opts, force: false })).result;
}
// Before task_provision plans against the world model (GH 2958): the same
// capped fetch with the TTL window ignored, so the base resolves against a
// just-fetched origin/<target branch>. Never throws.
export async function fetchTargetNow(db, repo, opts) {
    return fetchTargetShared(db, repo, { ...opts, force: true });
}
export function __setTargetFetchForTests(opts = {}) {
    fetchRunner = opts.runner ?? execGitFetch;
    fetchTimeoutMs = opts.timeoutMs ?? TARGET_FETCH_TIMEOUT_MS;
}
// Test seam: wait for any reindex this process is running.
export async function reindexIdle() {
    await Promise.all([...inflight.values()].map((p) => p.catch(() => undefined)));
}
//# sourceMappingURL=freshness.js.map