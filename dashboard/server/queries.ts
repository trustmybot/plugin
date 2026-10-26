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

const LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?';
const HOST = `${LABEL}(?:\\.${LABEL})*`;
const SEGMENT = '(?!\\.+(?:/|$))[A-Za-z0-9_.-]+';
const REPO_PATH = `${SEGMENT}(?:/${SEGMENT})+`;
const REMOTE_FORMS = [
  new RegExp(`^https://(${HOST})/(${REPO_PATH})$`),
  new RegExp(`^git@(${HOST}):(${REPO_PATH})$`),
  new RegExp(`^ssh://git@(${HOST})/(${REPO_PATH})$`),
];

export type WebProvider = 'github' | 'gitlab';

// A git remote URL as its https web base, or null for any form outside the allowlist.
export function remoteWebUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  const trimmed = url.replace(/\/+$/, '').replace(/\.git$/, '');
  for (const form of REMOTE_FORMS) {
    const m = form.exec(trimmed);
    if (m) return `https://${m[1]!.toLowerCase()}/${m[2]!}`;
  }
  return null;
}

interface WebRemote {
  provider: WebProvider;
  base: string;
}

function webRemotes(db: DatabaseSync): Map<string, WebRemote[]> {
  const byRepo = new Map<string, WebRemote[]>();
  const rows = all(
    db,
    `SELECT repo, provider, url FROM repo_remotes
      WHERE provider IN ('github', 'gitlab')
      ORDER BY repo, sync DESC, is_primary DESC, name`,
  );
  for (const r of rows) {
    const base = remoteWebUrl(r['url']);
    if (!base) continue;
    const repo = String(r['repo']);
    const list = byRepo.get(repo) ?? [];
    list.push({ provider: r['provider'] as WebProvider, base });
    byRepo.set(repo, list);
  }
  return byRepo;
}

const present = (v: unknown) => v !== null && v !== undefined;

function issueWebUrl(remotes: Map<string, WebRemote[]>, issue: Row): string | null {
  const provider: WebProvider | null = present(issue['gh_iid']) ? 'github' : present(issue['gl_iid']) ? 'gitlab' : null;
  if (!provider || !present(issue['repo'])) return null;
  return remotes.get(String(issue['repo']))?.find((r) => r.provider === provider)?.base ?? null;
}

export function issues(db: DatabaseSync): Row[] {
  const remotes = webRemotes(db);
  return all(
    db,
    `SELECT i.id, i.objective, i.status, i.repo, i.milestone, i.gh_iid, i.gl_iid,
            i.created_at, i.updated_at, i.closed_at, i.labels,
            (SELECT COUNT(*) FROM tasks t WHERE t.issue_id = i.id) AS task_count,
            (SELECT COUNT(*) FROM tasks t WHERE t.issue_id = i.id
               AND t.status IN ('completed','closed')) AS tasks_done,
            (SELECT COUNT(*) FROM discussions d WHERE d.issue_id = i.id) AS discussion_count
       FROM issues i
      WHERE i.id > 0
      ORDER BY i.status = 'open' DESC, i.updated_at DESC`,
  ).map((i) => ({ ...i, remote_web_url: issueWebUrl(remotes, i) }));
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
    issue: { ...issue, remote_web_url: issueWebUrl(webRemotes(db), issue) },
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
      `SELECT id, author, kind, body, task_id, created_at FROM discussions
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
            t.completed_at,
            (SELECT v.verdict FROM validation_attempts v WHERE v.task_id = t.id
              ORDER BY v.id DESC LIMIT 1) AS last_verdict,
            (SELECT COUNT(*) FROM review_findings f WHERE f.task_id = t.id
               AND f.status = 'open') AS open_findings
       FROM tasks t LEFT JOIN issues i ON i.id = t.issue_id
      ORDER BY t.id DESC LIMIT ?`,
    RECENT_LIMIT * 5,
  );
}

// A JSON text column parsed. On bad JSON the value is null and the raw text is
// returned under `<key>_raw`.
function parseJsonColumn(row: Row, key: string): Row {
  const raw = row[key];
  if (raw === null || raw === undefined) return { [key]: null };
  try {
    return { [key]: JSON.parse(String(raw)) as unknown };
  } catch {
    return { [key]: null, [`${key}_raw`]: String(raw) };
  }
}

export function taskDetail(db: DatabaseSync, id: number): Row | null {
  const task = one(
    db,
    `SELECT id, issue_id, branch_id, parent_branch_id, title, status, spec_body, commit_sha,
            repo, effort, files, verification, completion_report, created_at, updated_at,
            completed_at
       FROM tasks WHERE id = ?`,
    id,
  );
  if (!task) return null;
  const remote = present(task['repo']) ? webRemotes(db).get(String(task['repo']))?.[0] : undefined;
  const commands = db.prepare(
    `SELECT ordinal, command, exit_code, elapsed_s, output_tail
       FROM verification_run_commands WHERE run_id = ? ORDER BY ordinal`,
  );
  const runs = all(
    db,
    `SELECT id, commit_sha, source, started_at, finished_at, exit_code, budget_s, timed_out
       FROM verification_runs WHERE task_id = ? ORDER BY started_at DESC, id DESC`,
    id,
  );
  return {
    task: {
      ...task,
      ...parseJsonColumn(task, 'files'),
      ...parseJsonColumn(task, 'verification'),
      ...parseJsonColumn(task, 'completion_report'),
      remote_web_url: remote?.base ?? null,
      remote_provider: remote?.provider ?? null,
    },
    issue: one(db, `SELECT id, objective FROM issues WHERE id = ?`, Number(task['issue_id'])) ?? null,
    validations: all(
      db,
      `SELECT id, attempt_n, agent, verdict, feedback, mcp_available, created_at
         FROM validation_attempts WHERE task_id = ? ORDER BY attempt_n, id`,
      id,
    ),
    findings: all(
      db,
      `SELECT id, attempt_n, criterion_id, probe_cmd, expected, observed, status, created_at,
              resolved_at
         FROM review_findings WHERE task_id = ? ORDER BY attempt_n, created_at, id`,
      id,
    ),
    verifications: runs.map((r) => ({ ...r, commands: commands.all(Number(r['id'])) as Row[] })),
    agent_runs: all(
      db,
      `SELECT id, agent_type, model, effort, tokens_in, tokens_out, cache_read_tokens,
              cache_creation_tokens, tool_uses, duration_ms, started_at, completed_at,
              exit_reason
         FROM agent_runs WHERE task_id = ? ORDER BY id`,
      id,
    ),
  };
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

const SUMMARY_MAX = 160;
const HR_LINE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;

// One plain line from a world-model summary: the `<untrusted-content>` framing
// and markdown syntax removed, the first non-empty line, at most SUMMARY_MAX
// characters.
export function summaryLine(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const line = raw
    .replace(/<\/?untrusted-content[^>]*>/g, ' ')
    .split('\n')
    .filter((l) => !HR_LINE.test(l))
    .map((l) =>
      l
        .replace(/^\s{0,3}#{1,6}\s+/, '')
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/(\*\*|__)(.+?)\1/g, '$2')
        .replace(/(^|[^\w*])[*_]([^*_\s][^*_]*?)[*_](?=[^\w*]|$)/g, '$1$2')
        .replace(/`+/g, '')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .find((l) => l !== '');
  if (line === undefined) return '';
  return line.length > SUMMARY_MAX ? `${line.slice(0, SUMMARY_MAX - 1).trimEnd()}…` : line;
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
  return { available: true, repos, nodes: nodes.map((n) => ({ ...n, summary: summaryLine(n['summary']) })) };
}

const GRAPH_KINDS = ['calls', 'imports', 'runs', 'sources', 'instantiates'];

function symbolGraphAvailable(db: DatabaseSync): boolean {
  const found = one(
    db,
    `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('wm_symbols', 'wm_edges')`,
  );
  return Number(found?.['n'] ?? 0) === 2;
}

interface FilePair {
  src: number;
  dst: number;
  kind: string;
  weight: number;
  top: number;
}

// The repo's symbol edges rolled up to one edge per ordered file pair: weight
// is the number of symbol edges, kind the heaviest kind among them. `files`
// holds only files that appear in an edge; `src`/`dst` index into it.
export function graph(db: DatabaseSync, repo: string | null): Row {
  if (!worldModelAvailable(db) || !symbolGraphAvailable(db)) {
    return { available: false, repo: null, repos: [], files: [], edges: [] };
  }
  const repos = all(db, `SELECT DISTINCT repo FROM wm_directories ORDER BY repo`).map((r) => String(r['repo']));
  const target = repo ?? repos[0];
  if (target === undefined) return { available: true, repo: null, repos, files: [], edges: [] };
  const rows = all(
    db,
    `SELECT s.path AS src, d.path AS dst, e.kind AS kind, COUNT(*) AS weight,
            sf.purpose AS src_purpose, df.purpose AS dst_purpose
       FROM wm_edges e
       JOIN wm_symbols s ON s.id = e.src_id
       JOIN wm_symbols d ON d.id = e.dst_id
       LEFT JOIN wm_files sf ON sf.repo = s.repo AND sf.path = s.path
       LEFT JOIN wm_files df ON df.repo = d.repo AND df.path = d.path
      WHERE s.repo = ? AND d.repo = s.repo AND s.path <> d.path
        AND e.kind IN (${GRAPH_KINDS.map(() => '?').join(', ')})
      GROUP BY s.path, d.path, e.kind
      ORDER BY s.path, d.path, weight DESC, e.kind`,
    target,
    ...GRAPH_KINDS,
  );
  const index = new Map<string, number>();
  const files: Array<{ path: string; purpose: string }> = [];
  const fileOf = (path: string, purpose: unknown): number => {
    let i = index.get(path);
    if (i === undefined) {
      i = files.length;
      index.set(path, i);
      files.push({ path, purpose: summaryLine(purpose) ?? '' });
    }
    return i;
  };
  const pairs = new Map<string, FilePair>();
  for (const r of rows) {
    const src = fileOf(String(r['src']), r['src_purpose']);
    const dst = fileOf(String(r['dst']), r['dst_purpose']);
    const kind = String(r['kind']);
    const weight = Number(r['weight']);
    const pair = pairs.get(`${src}>${dst}`);
    if (!pair) pairs.set(`${src}>${dst}`, { src, dst, kind, weight, top: weight });
    else {
      pair.weight += weight;
      if (weight > pair.top) {
        pair.kind = kind;
        pair.top = weight;
      }
    }
  }
  const edges = [...pairs.values()].map(({ src, dst, kind, weight }) => ({ src, dst, kind, weight }));
  return { available: true, repo: target, repos, files, edges };
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
  return { available: true, hits: hits.map((h) => ({ ...h, text: summaryLine(h['text']) })) };
}
