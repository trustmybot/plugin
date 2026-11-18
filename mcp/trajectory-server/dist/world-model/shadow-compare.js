// Daily shadow compare of the world model (GH 2584). After startup_catchup,
// at most one repo whose newest wm_shadow_compare audit row is 24 h old (or
// absent) gets a clean full index built at its live indexed_commit into a
// throwaway TrajectoryDB under os.tmpdir(), removed afterwards, pass or fail.
// The normalized wm_files, wm_symbols and wm_edges rows of the two are then
// compared (equivalence.ts). A mismatch writes a wm_reindex row with mode
// 'mismatch' and the repo's indexed_stamp, so every reindex of the repo
// rebuilds it in full until that stamp changes (mismatchPending in
// freshness.ts). The live DB gets only the audit rows.
// When indexed_commit moves during the compare the verdict is 'skipped'.
// Nothing is filed anywhere else; every error is logged, never thrown.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TrajectoryDB } from '../db.js';
import { WorldModelGraph } from '../graph.js';
import { serverLog } from '../logger.js';
import { insertAudit } from '../tools/audit.js';
import { scannedAtNow, walkRepoAtCommit } from '../tools/scan-walk.js';
import { persistRepoReindex } from '../tools/scan.js';
import { compare, describeMismatch, snapshot } from './equivalence.js';
import { recordReindex } from './freshness.js';
export const SHADOW_COMPARE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const SHADOW_BUILD_TIMEOUT_MS = 10 * 60 * 1000;
// Test seam: runs once the temp DB is open, before the clean build.
export const shadowCompareHooks = {};
let clock = () => Date.now();
let running = null;
function indexedCommitOf(db, repo) {
    return db.get(`SELECT indexed_commit AS c FROM repos WHERE name = ?`, [repo])?.c ?? null;
}
// A stamp from the future (a clock set back) or unreadable opens the window.
function due(last, nowMs) {
    if (!last)
        return true;
    const elapsed = nowMs - Date.parse(last);
    return !(elapsed >= 0 && elapsed < SHADOW_COMPARE_INTERVAL_MS);
}
// The indexed repo whose newest wm_shadow_compare row is oldest, when that
// row is absent or SHADOW_COMPARE_INTERVAL_MS old; null when none is due.
export function shadowCompareDue(db, nowMs) {
    const rows = db.all(`SELECT r.name AS name,
            (SELECT a.created_at FROM audit a WHERE a.event_type = 'wm_shadow_compare' AND a.repo = r.name
              ORDER BY a.id DESC LIMIT 1) AS last
       FROM repos r
      WHERE r.indexed_commit IS NOT NULL
      ORDER BY last IS NOT NULL, last, r.name`);
    return rows.find((r) => due(r.last, nowMs))?.name ?? null;
}
async function buildClean(shadow, repo, path, commit) {
    shadow.run(`INSERT INTO repos (name, path) VALUES (?, ?)`, [repo, path]);
    await shadowCompareHooks.beforeBuild?.(repo);
    const out = await walkRepoAtCommit(path, commit, SHADOW_BUILD_TIMEOUT_MS, repo);
    try {
        const output = {
            session_dir: path,
            scanned_at: scannedAtNow(),
            repos: [out.repo],
            files: out.files,
            contents: out.content ? new Map([[repo, out.content]]) : new Map(),
        };
        const stats = await persistRepoReindex(shadow, new WorldModelGraph(shadow), output);
        if (stats.errors.length > 0) {
            throw new Error(`clean rebuild failed: ${stats.errors.map((e) => `${e.stage}: ${e.error}`).join('; ')}`);
        }
    }
    finally {
        out.content?.close();
    }
}
function summaryOf(r) {
    const at = `World model of ${r.repo} at ${r.commit.slice(0, 12)}`;
    switch (r.verdict) {
        case 'match':
            return `${at} matches a clean rebuild (${r.ms} ms)`;
        case 'mismatch':
            return `${at} differs from a clean rebuild in ${r.tables.join(', ')} (${r.ms} ms)`;
        case 'skipped':
            return `${at}: shadow compare skipped (${r.reason}${r.error ? `: ${r.error}` : ''})`;
    }
}
function record(db, r, mismatches, nowMs) {
    const differs = mismatches.length > 0;
    db.transaction(() => {
        const stamp = db.get(`SELECT indexed_stamp AS s FROM repos WHERE name = ?`, [r.repo])?.s ?? null;
        if (differs) {
            recordReindex(db, {
                repo: r.repo,
                mode: 'mismatch',
                reason: 'mismatch',
                trigger: 'startup_catchup',
                from_commit: r.commit,
                to_commit: r.commit,
                files_diffed: 0,
                files_parsed: 0,
                dirs_touched: 0,
                concepts_flagged: 0,
                ms: r.ms,
                stamp,
            });
        }
        insertAudit(db, {
            issue_id: -1,
            from_node: 'system',
            event_type: 'wm_shadow_compare',
            summary: summaryOf(r),
            content_json: JSON.stringify({ repo: r.repo, commit: r.commit, stamp, verdict: r.verdict, tables: r.tables, ms: r.ms, reason: r.reason, error: r.error }),
            repo: r.repo,
            created_at: new Date(nowMs).toISOString(),
        });
    });
    if (differs) {
        serverLog({
            event: 'wm_shadow_mismatch',
            repo: r.repo,
            commit: r.commit,
            tables: r.tables,
            detail: describeMismatch(`${r.repo}@${r.commit.slice(0, 12)}`, mismatches),
        });
    }
}
// One shadow compare of `repo` at its live indexed_commit; null when the repo
// has no stamp. Never throws.
export async function runShadowCompare(db, repo, opts = {}) {
    const nowMs = opts.now ?? clock();
    const started = Date.now();
    let path;
    let commit;
    let dir;
    try {
        const live = db.get(`SELECT path, indexed_commit FROM repos WHERE name = ?`, [repo]);
        if (!live?.indexed_commit)
            return null;
        path = live.path;
        commit = live.indexed_commit;
        dir = mkdtempSync(join(tmpdir(), 'tmb-wm-shadow-'));
    }
    catch (e) {
        serverLog({ event: 'wm_shadow_compare_error', repo, error: e.message });
        return null;
    }
    const result = (verdict, extra = {}) => ({
        repo,
        commit,
        verdict,
        tables: [],
        ms: Date.now() - started,
        reason: null,
        error: null,
        temp_dir: dir,
        ...extra,
    });
    let res;
    let mismatches = [];
    let shadow = null;
    try {
        shadow = new TrajectoryDB(join(dir, 'trajectory.db'));
        await buildClean(shadow, repo, path, commit);
        if (indexedCommitOf(db, repo) !== commit) {
            res = result('skipped', { reason: 'moved' });
        }
        else {
            const liveRows = snapshot(db, repo);
            if (indexedCommitOf(db, repo) !== commit) {
                res = result('skipped', { reason: 'moved' });
            }
            else {
                mismatches = compare(liveRows, snapshot(shadow, repo));
                res = mismatches.length > 0 ? result('mismatch', { tables: mismatches.map((m) => m.table) }) : result('match');
            }
        }
    }
    catch (e) {
        const error = e.message;
        serverLog({ event: 'wm_shadow_compare_error', repo, commit, error });
        res = result('skipped', { reason: 'error', error });
    }
    finally {
        for (const cleanup of [() => shadow?.close(), () => rmSync(dir, { recursive: true, force: true })]) {
            try {
                cleanup();
            }
            catch (e) {
                serverLog({ event: 'wm_shadow_compare_error', repo, commit, error: e.message });
            }
        }
    }
    try {
        record(db, res, mismatches, nowMs);
    }
    catch (e) {
        serverLog({ event: 'wm_shadow_compare_error', repo, commit, error: e.message });
    }
    return res;
}
// From startup_catchup: start the compare of the one repo due, if any, in the
// background, and return its name. One compare runs at a time per process.
export function startShadowCompare(db) {
    if (running)
        return null;
    let repo;
    try {
        repo = shadowCompareDue(db, clock());
    }
    catch (e) {
        serverLog({ event: 'wm_shadow_compare_error', error: e.message });
        return null;
    }
    if (!repo)
        return null;
    const run = runShadowCompare(db, repo);
    running = run;
    void run.then(() => {
        if (running === run)
            running = null;
    });
    return repo;
}
// Wait for the background compare this process started, if one runs.
export async function shadowCompareIdle() {
    await running;
}
export function __setShadowCompareClockForTests(now) {
    clock = now ?? (() => Date.now());
}
//# sourceMappingURL=shadow-compare.js.map