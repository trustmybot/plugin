import type { DatabaseSync } from 'node:sqlite';

type Row = Record<string, unknown>;

const HISTORY_DEFAULT = 20;
const HISTORY_MAX = 100;

export interface Freshness {
  indexed_commit: string | null;
  target_ref: string | null;
  target_commit: string | null;
  stale: boolean;
  reindex: {
    state: string;
    mode: string | null;
    trigger: string | null;
    started_at: string | null;
    finished_at: string | null;
    elapsed_ms: number | null;
    outcome: string | null;
  };
  needs_review_count: number;
}

function one(db: DatabaseSync, sql: string, ...params: string[]): Row | undefined {
  return db.prepare(sql).get(...params) as Row | undefined;
}

const text = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function hasTable(db: DatabaseSync, name: string): boolean {
  return one(db, `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`, name) !== undefined;
}

function freshnessReady(db: DatabaseSync): boolean {
  const n = one(db, `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('wm_freshness', 'wm_concepts')`);
  if (Number(n?.['n'] ?? 0) !== 2) return false;
  return db.prepare('PRAGMA table_info(repos)').all().some((c) => (c as Row)['name'] === 'indexed_commit');
}

export function wmRepos(db: DatabaseSync): string[] {
  if (!hasTable(db, 'wm_directories')) return [];
  return (db.prepare('SELECT DISTINCT repo FROM wm_directories ORDER BY repo').all() as Row[]).map((r) => String(r['repo']));
}

// `repo` ?? the first world-model repo by name, as each world-model endpoint picks it.
export function resolveRepo(db: DatabaseSync, repo: string | null): string | null {
  return repo ?? wmRepos(db)[0] ?? null;
}

// How fresh the repo's index is, read from repos.indexed_commit and the
// wm_freshness row; null on a DB that has neither yet.
export function freshnessBlock(db: DatabaseSync, repo: string | null): Freshness | null {
  if (repo === null || !freshnessReady(db)) return null;
  const indexed = text(one(db, 'SELECT indexed_commit FROM repos WHERE name = ?', repo)?.['indexed_commit']);
  const f = one(db, 'SELECT * FROM wm_freshness WHERE repo = ?', repo) ?? {};
  const review = one(db, `SELECT COUNT(*) AS n FROM wm_concepts WHERE repo = ? AND status IN ('suspect','broken')`, repo);
  const targetCommit = text(f['target_commit']);
  const state = text(f['reindex_state']) ?? 'idle';
  return {
    indexed_commit: indexed,
    target_ref: text(f['target_ref']),
    target_commit: targetCommit,
    stale: indexed === null || indexed !== targetCommit || state === 'running',
    reindex: {
      state,
      mode: text(f['reindex_mode']),
      trigger: text(f['reindex_trigger']),
      started_at: text(f['reindex_started_at']),
      finished_at: text(f['reindex_finished_at']),
      elapsed_ms: num(f['reindex_elapsed_ms']),
      outcome: text(f['reindex_outcome']),
    },
    needs_review_count: Number(review?.['n'] ?? 0),
  };
}

export function freshnessFor(db: DatabaseSync, repo: string | null): Freshness | null {
  return freshnessBlock(db, resolveRepo(db, repo));
}

export function clampHistory(raw: string | null): number {
  if (raw === null || raw.trim() === '') return HISTORY_DEFAULT;
  const n = Number(raw);
  return Number.isInteger(n) ? Math.min(Math.max(n, 1), HISTORY_MAX) : HISTORY_DEFAULT;
}

function parseObject(raw: unknown): Row {
  try {
    const v: unknown = JSON.parse(String(raw));
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Row) : {};
  } catch {
    return {};
  }
}

export function worldModelStatus(db: DatabaseSync, limit: number): Row {
  const repos = wmRepos(db).map((repo) => ({ repo, freshness: freshnessBlock(db, repo) }));
  const rows = db
    .prepare(`SELECT id, created_at, repo, content_json FROM audit WHERE event_type = 'wm_reindex' ORDER BY id DESC LIMIT ?`)
    .all(limit) as Row[];
  const history = rows.map(({ id, created_at, repo, content_json }) => ({ id, created_at, repo, ...parseObject(content_json) }));
  return { repos, history };
}

// Adds `freshness` to a JSON object body without re-serialising it.
export function withFreshness(body: string, freshness: Freshness | null): string {
  return `${body.slice(0, body.lastIndexOf('}'))},"freshness":${JSON.stringify(freshness)}}`;
}
