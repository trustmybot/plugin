// Daily shadow compare of the world model (GH 2584). After startup_catchup,
// at most one repo whose newest wm_shadow_compare audit row is 24 h old (or
// absent) gets a clean full index built at its live indexed_commit into a
// throwaway TrajectoryDB under os.tmpdir(), removed afterwards, pass or fail.
// The normalized wm_files, wm_symbols and wm_edges rows of the two are then
// compared (equivalence.ts). A mismatch writes a wm_reindex row with mode
// 'mismatch', so the next read or catch-up rebuilds the repo in full
// (mismatchPending in freshness.ts). The live DB gets only the audit rows.
// When indexed_commit moves during the compare the verdict is 'skipped'.
// Nothing is filed anywhere else; every error is logged, never thrown.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TrajectoryDB } from '../db.js';
import { WorldModelGraph } from '../graph.js';
import { serverLog } from '../logger.js';
import { insertAudit } from '../tools/audit.js';
import { scannedAtNow, walkRepoAtCommit, type ScanOutput } from '../tools/scan-walk.js';
import { persistRepoReindex } from '../tools/scan.js';
import { compare, describeMismatch, snapshot, type Mismatch, type WmTable } from './equivalence.js';
import { recordReindex } from './freshness.js';

export const SHADOW_COMPARE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const SHADOW_BUILD_TIMEOUT_MS = 10 * 60 * 1000;

export type ShadowVerdict = 'match' | 'mismatch' | 'skipped';
// moved: indexed_commit changed during the compare; error: the clean build or
// the compare failed.
export type ShadowSkip = 'moved' | 'error';

export interface ShadowCompareResult {
  repo: string;
  commit: string;
  verdict: ShadowVerdict;
  tables: WmTable[];
  ms: number;
  reason: ShadowSkip | null;
  error: string | null;
  // The temp directory the clean index was built in, removed before return.
  temp_dir: string;
}

// Test seam: runs once the temp DB is open, before the clean build.
export const shadowCompareHooks: { beforeBuild?: (repo: string) => Promise<void> | void } = {};

let clock: () => number = () => Date.now();
let running: Promise<ShadowCompareResult | null> | null = null;

function indexedCommitOf(db: TrajectoryDB, repo: string): string | null {
  return db.get<{ c: string | null }>(`SELECT indexed_commit AS c FROM repos WHERE name = ?`, [repo])?.c ?? null;
}

// A stamp from the future (a clock set back) or unreadable opens the window.
function due(last: string | null, nowMs: number): boolean {
  if (!last) return true;
  const elapsed = nowMs - Date.parse(last);
  return !(elapsed >= 0 && elapsed < SHADOW_COMPARE_INTERVAL_MS);
}

// The indexed repo whose newest wm_shadow_compare row is oldest, when that
// row is absent or SHADOW_COMPARE_INTERVAL_MS old; null when none is due.
export function shadowCompareDue(db: TrajectoryDB, nowMs: number): string | null {
  const rows = db.all<{ name: string; last: string | null }>(
    `SELECT r.name AS name,
            (SELECT a.created_at FROM audit a WHERE a.event_type = 'wm_shadow_compare' AND a.repo = r.name
              ORDER BY a.id DESC LIMIT 1) AS last
       FROM repos r
      WHERE r.indexed_commit IS NOT NULL
      ORDER BY last IS NOT NULL, last, r.name`,
  );
  return rows.find((r) => due(r.last, nowMs))?.name ?? null;
}

async function buildClean(shadow: TrajectoryDB, repo: string, path: string, commit: string): Promise<void> {
  shadow.run(`INSERT INTO repos (name, path) VALUES (?, ?)`, [repo, path]);
  await shadowCompareHooks.beforeBuild?.(repo);
  const out = await walkRepoAtCommit(path, commit, SHADOW_BUILD_TIMEOUT_MS, repo);
  try {
    const output: ScanOutput = {
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
  } finally {
    out.content?.close();
  }
}

function summaryOf(r: ShadowCompareResult): string {
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

function record(db: TrajectoryDB, r: ShadowCompareResult, mismatches: Mismatch[], nowMs: number): void {
  const differs = mismatches.length > 0;
  db.transaction(() => {
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
      });
    }
    insertAudit(db, {
      issue_id: -1,
      from_node: 'system',
      event_type: 'wm_shadow_compare',
      summary: summaryOf(r),
      content_json: JSON.stringify({ repo: r.repo, commit: r.commit, verdict: r.verdict, tables: r.tables, ms: r.ms, reason: r.reason, error: r.error }),
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
export async function runShadowCompare(db: TrajectoryDB, repo: string, opts: { now?: number } = {}): Promise<ShadowCompareResult | null> {
  const nowMs = opts.now ?? clock();
  const started = Date.now();
  let path: string;
  let commit: string;
  let dir: string;
  try {
    const live = db.get<{ path: string; indexed_commit: string | null }>(`SELECT path, indexed_commit FROM repos WHERE name = ?`, [repo]);
    if (!live?.indexed_commit) return null;
    path = live.path;
    commit = live.indexed_commit;
    dir = mkdtempSync(join(tmpdir(), 'tmb-wm-shadow-'));
  } catch (e) {
    serverLog({ event: 'wm_shadow_compare_error', repo, error: (e as Error).message });
    return null;
  }
  const result = (verdict: ShadowVerdict, extra: Partial<ShadowCompareResult> = {}): ShadowCompareResult => ({
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
  let res: ShadowCompareResult;
  let mismatches: Mismatch[] = [];
  let shadow: TrajectoryDB | null = null;
  try {
    shadow = new TrajectoryDB(join(dir, 'trajectory.db'));
    await buildClean(shadow, repo, path, commit);
    if (indexedCommitOf(db, repo) !== commit) {
      res = result('skipped', { reason: 'moved' });
    } else {
      const liveRows = snapshot(db, repo);
      if (indexedCommitOf(db, repo) !== commit) {
        res = result('skipped', { reason: 'moved' });
      } else {
        mismatches = compare(liveRows, snapshot(shadow, repo));
        res = mismatches.length > 0 ? result('mismatch', { tables: mismatches.map((m) => m.table) }) : result('match');
      }
    }
  } catch (e) {
    const error = (e as Error).message;
    serverLog({ event: 'wm_shadow_compare_error', repo, commit, error });
    res = result('skipped', { reason: 'error', error });
  } finally {
    for (const cleanup of [() => shadow?.close(), () => rmSync(dir, { recursive: true, force: true })]) {
      try {
        cleanup();
      } catch (e) {
        serverLog({ event: 'wm_shadow_compare_error', repo, commit, error: (e as Error).message });
      }
    }
  }
  try {
    record(db, res, mismatches, nowMs);
  } catch (e) {
    serverLog({ event: 'wm_shadow_compare_error', repo, commit, error: (e as Error).message });
  }
  return res;
}

// From startup_catchup: start the compare of the one repo due, if any, in the
// background, and return its name. One compare runs at a time per process.
export function startShadowCompare(db: TrajectoryDB): string | null {
  if (running) return null;
  let repo: string | null;
  try {
    repo = shadowCompareDue(db, clock());
  } catch (e) {
    serverLog({ event: 'wm_shadow_compare_error', error: (e as Error).message });
    return null;
  }
  if (!repo) return null;
  const run = runShadowCompare(db, repo);
  running = run;
  void run.then(() => {
    if (running === run) running = null;
  });
  return repo;
}

// Wait for the background compare this process started, if one runs.
export async function shadowCompareIdle(): Promise<void> {
  await running;
}

export function __setShadowCompareClockForTests(now?: () => number): void {
  clock = now ?? (() => Date.now());
}
