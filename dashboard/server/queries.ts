import type { DatabaseSync } from 'node:sqlite';

type Row = Record<string, unknown>;

const RECENT_LIMIT = 200;

function all(db: DatabaseSync, sql: string, ...params: Array<string | number | null>): Row[] {
  return db.prepare(sql).all(...params) as Row[];
}

function one(db: DatabaseSync, sql: string, ...params: Array<string | number | null>): Row | undefined {
  return db.prepare(sql).get(...params) as Row | undefined;
}

export function dataVersion(db: DatabaseSync): number {
  return Number(one(db, 'PRAGMA data_version')?.['data_version'] ?? 0);
}

export function summary(db: DatabaseSync): Row {
  return {
    issues: one(
      db,
      `SELECT SUM(status = 'open') AS open, SUM(status = 'closed') AS closed
         FROM issues WHERE id > 0`,
    ),
    tasks_by_status: all(
      db,
      `SELECT status, COUNT(*) AS count FROM tasks GROUP BY status ORDER BY count DESC`,
    ),
    open_runs: Number(
      one(db, `SELECT COUNT(*) AS n FROM agent_runs WHERE completed_at IS NULL`)?.['n'] ?? 0,
    ),
    recent_runs: all(
      db,
      `SELECT r.id, r.agent_type, r.task_id, r.issue_id, t.title AS task_title,
              r.started_at, r.completed_at, r.exit_reason, r.duration_ms
         FROM agent_runs r LEFT JOIN tasks t ON t.id = r.task_id
        ORDER BY r.id DESC LIMIT 10`,
    ),
  };
}

export function issues(db: DatabaseSync): Row[] {
  return all(
    db,
    `SELECT i.id, i.objective, i.status, i.repo, i.milestone, i.gh_iid, i.gl_iid,
            i.created_at, i.updated_at, i.closed_at,
            (SELECT COUNT(*) FROM tasks t WHERE t.issue_id = i.id) AS task_count,
            (SELECT COUNT(*) FROM tasks t WHERE t.issue_id = i.id
               AND t.status IN ('completed','closed')) AS tasks_done
       FROM issues i
      WHERE i.id > 0
      ORDER BY i.status = 'open' DESC, i.updated_at DESC`,
  );
}

export function schemaVersion(db: DatabaseSync): number | null {
  const row = one(db, `SELECT schema_version FROM plugin_meta WHERE id = 1`);
  return row ? Number(row['schema_version']) : null;
}

export function issueUpdatedAt(db: DatabaseSync, id: number): string | null {
  const row = one(db, `SELECT updated_at FROM issues WHERE id = ?`, id);
  return row ? String(row['updated_at']) : null;
}

function configStringList(db: DatabaseSync, key: string): string[] | null {
  const row = one(db, `SELECT value_json FROM plugin_config WHERE key = ?`, key);
  if (!row) return null;
  try {
    const parsed: unknown = JSON.parse(String(row['value_json']));
    return Array.isArray(parsed) && parsed.every((v) => typeof v === 'string') ? parsed : null;
  } catch {
    return null;
  }
}

export function issueDetail(db: DatabaseSync, id: number): Row | null {
  const issue = one(db, `SELECT * FROM issues WHERE id = ?`, id);
  if (!issue) return null;
  const repo = issue['repo'] === null ? null : String(issue['repo']);
  return {
    issue,
    label_taxonomy: {
      classification: configStringList(db, 'issue_classification_labels'),
      priority: configStringList(db, 'issue_priority_labels'),
    },
    milestones: all(
      db,
      `SELECT DISTINCT name FROM milestones WHERE repo IS ? OR ? IS NULL ORDER BY name`,
      repo,
      repo,
    ).map((r) => String(r['name'])),
    discussions: all(
      db,
      `SELECT id, author, kind, body, created_at FROM discussions
        WHERE issue_id = ? ORDER BY created_at, id`,
      id,
    ),
    tasks: all(
      db,
      `SELECT id, branch_id, title, status, repo, effort, commit_sha, created_at,
              updated_at, completed_at
         FROM tasks WHERE issue_id = ? ORDER BY id`,
      id,
    ),
  };
}

export function tasks(db: DatabaseSync): Row[] {
  return all(
    db,
    `SELECT t.id, t.issue_id, i.objective AS issue_objective, t.branch_id, t.title,
            t.status, t.repo, t.effort, t.commit_sha, t.created_at, t.updated_at,
            t.completed_at
       FROM tasks t LEFT JOIN issues i ON i.id = t.issue_id
      ORDER BY t.id DESC LIMIT ?`,
    RECENT_LIMIT * 5,
  );
}

export function agentRuns(db: DatabaseSync): Row[] {
  return all(
    db,
    `SELECT r.id, r.agent_type, r.task_id, r.issue_id, t.title AS task_title,
            r.model, r.effort, r.tokens_in, r.tokens_out, r.cache_read_tokens,
            r.cache_creation_tokens, r.tool_uses, r.duration_ms, r.started_at,
            r.completed_at, r.exit_reason
       FROM agent_runs r LEFT JOIN tasks t ON t.id = r.task_id
      ORDER BY r.id DESC LIMIT ?`,
    RECENT_LIMIT,
  );
}

export function gates(db: DatabaseSync): Row {
  return {
    validations: all(
      db,
      `SELECT v.id, v.task_id, t.title AS task_title, v.attempt_n, v.agent, v.verdict,
              v.feedback, v.mcp_available, v.created_at
         FROM validation_attempts v LEFT JOIN tasks t ON t.id = v.task_id
        ORDER BY v.id DESC LIMIT ?`,
      RECENT_LIMIT,
    ),
    verifications: all(
      db,
      `SELECT r.id, r.task_id, t.title AS task_title, r.commit_sha, r.source,
              r.started_at, r.finished_at, r.exit_code, r.timed_out,
              (SELECT COUNT(*) FROM verification_run_commands c WHERE c.run_id = r.id) AS commands,
              (SELECT COUNT(*) FROM verification_run_commands c
                WHERE c.run_id = r.id AND c.exit_code <> 0) AS failed_commands
         FROM verification_runs r LEFT JOIN tasks t ON t.id = r.task_id
        ORDER BY r.id DESC LIMIT ?`,
      RECENT_LIMIT,
    ),
  };
}

export function audit(db: DatabaseSync, limit: number): Row[] {
  return all(
    db,
    `SELECT id, issue_id, branch_id, from_node, event_type, summary, created_at
       FROM audit ORDER BY id DESC LIMIT ?`,
    limit,
  );
}

const WM_TABLE_COUNT = 4;
const WM_DEFAULT_DEPTH = 2;
const WM_MAX_DEPTH = 5;
const WM_DEFAULT_HITS = 20;
const WM_MAX_HITS = 100;

function worldModelAvailable(db: DatabaseSync): boolean {
  const found = one(
    db,
    `SELECT COUNT(*) AS n FROM sqlite_master
      WHERE type = 'table'
        AND name IN ('wm_directories', 'wm_files', 'wm_directories_fts', 'wm_files_fts')`,
  );
  return Number(found?.['n'] ?? 0) === WM_TABLE_COUNT;
}

export function clampDepth(raw: string | null): number {
  if (raw === null || raw.trim() === '') return WM_DEFAULT_DEPTH;
  const n = Number(raw);
  return Number.isInteger(n) ? Math.min(Math.max(n, 0), WM_MAX_DEPTH) : WM_DEFAULT_DEPTH;
}

export function clampHits(raw: string | null): number {
  if (raw === null || raw.trim() === '') return WM_DEFAULT_HITS;
  const n = Number(raw);
  return Number.isInteger(n) ? Math.min(Math.max(n, 1), WM_MAX_HITS) : WM_DEFAULT_HITS;
}

// The directory at `path` (default: the repo root) plus its descendants down to
// `depth` levels below it. `repo` defaults to the first repo by name.
export function worldModel(db: DatabaseSync, repo: string | null, path: string, depth: number): Row {
  if (!worldModelAvailable(db)) return { available: false, repos: [], nodes: [] };
  const repos = all(db, `SELECT DISTINCT repo FROM wm_directories ORDER BY repo`).map((r) => String(r['repo']));
  const target = repo ?? repos[0];
  if (target === undefined) return { available: true, repos, nodes: [] };
  const nodes = all(
    db,
    `WITH RECURSIVE sub(id, path, lvl) AS (
       SELECT id, path, 0 FROM wm_directories WHERE repo = ? AND path = ?
       UNION
       SELECT c.id, c.path, s.lvl + 1
         FROM wm_directories c JOIN sub s ON c.parent_path = s.path
        WHERE c.repo = ? AND c.path <> s.path AND s.lvl < ?
     )
     SELECT d.repo, d.path, d.parent_path, d.summary, d.file_count
       FROM wm_directories d
      WHERE d.id IN (SELECT id FROM sub)
      ORDER BY d.path`,
    target,
    path,
    target,
    depth,
  );
  return { available: true, repos, nodes };
}

export function ftsPhrase(raw: string): string {
  return `"${raw.replace(/"/g, '""')}"`;
}

// FTS5 hits over directory path + summary and file path + purpose, best bm25
// first. The whole query is one FTS phrase, so FTS syntax in it is plain text.
export function worldModelSearch(db: DatabaseSync, query: string, limit: number): Row {
  if (!worldModelAvailable(db)) return { available: false, hits: [] };
  if (query.trim() === '') return { available: true, hits: [] };
  const phrase = ftsPhrase(query.trim());
  const hits = all(
    db,
    `SELECT kind, repo, path, text, rank FROM (
       SELECT 'directory' AS kind, d.repo AS repo, d.path AS path, d.summary AS text,
              bm25(wm_directories_fts) AS rank
         FROM wm_directories_fts JOIN wm_directories d ON d.id = wm_directories_fts.rowid
        WHERE wm_directories_fts MATCH ?
       UNION ALL
       SELECT 'file', f.repo, f.path, f.purpose, bm25(wm_files_fts)
         FROM wm_files_fts JOIN wm_files f ON f.id = wm_files_fts.rowid
        WHERE wm_files_fts MATCH ?
     )
     ORDER BY rank, path
     LIMIT ?`,
    phrase,
    phrase,
    limit,
  );
  return { available: true, hits };
}
