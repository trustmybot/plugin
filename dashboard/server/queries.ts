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

export const INSIGHT_RANGES = { '7d': 7, '30d': 30, '90d': 90, all: null } as const;
export type InsightRange = keyof typeof INSIGHT_RANGES;
export const INSIGHT_AGENTS = ['swe', 'code-reviewer', 'bro'] as const;
export type InsightAgent = (typeof INSIGHT_AGENTS)[number];

export interface InsightFilter {
  range: InsightRange;
  repo: string | null;
  agent: InsightAgent | null;
  model: string | null;
  effort: string | null;
}

const isRange = (v: string): v is InsightRange => Object.hasOwn(INSIGHT_RANGES, v);
const isAgent = (v: string): v is InsightAgent => (INSIGHT_AGENTS as readonly string[]).includes(v);

export function insightFilter(p: URLSearchParams): InsightFilter | { error: string } {
  const range = p.get('range') || '30d';
  if (!isRange(range)) return { error: `range must be one of ${Object.keys(INSIGHT_RANGES).join(', ')}` };
  const agent = p.get('agent') || null;
  if (agent !== null && !isAgent(agent)) return { error: `agent must be one of ${INSIGHT_AGENTS.join(', ')}` };
  return { range, agent, repo: p.get('repo') || null, model: p.get('model') || null, effort: p.get('effort') || null };
}

export const EARLY_DATA_MIN = 20;
const HISTOGRAM_BUCKETS = 10;
const TOP_N = 10;

export interface Metric {
  p50: number | null;
  p95: number | null;
  max: number | null;
  avg: number | null;
}

// Nearest-rank percentile of an ascending array: the value at rank ⌈p·n⌉.
export function nearestRank(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.max(1, Math.ceil(p * sorted.length)) - 1]!;
}

export function metric(values: readonly number[]): Metric {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const early = n < EARLY_DATA_MIN;
  return {
    p50: early ? null : nearestRank(sorted, 0.5),
    p95: early ? null : nearestRank(sorted, 0.95),
    max: n === 0 ? null : sorted[n - 1]!,
    avg: n === 0 ? null : sorted.reduce((s, v) => s + v, 0) / n,
  };
}

export interface Bucket {
  from: number;
  to: number;
  count: number;
}

// At most HISTOGRAM_BUCKETS log-spaced edges spanning [min, max] of `domain`.
export function logEdges(domain: readonly number[]): number[] {
  if (domain.length === 0) return [];
  const lo = Math.max(1, Math.min(...domain));
  const hi = Math.max(lo, ...domain);
  if (hi === lo) return [lo, lo];
  const step = Math.log(hi / lo) / HISTOGRAM_BUCKETS;
  const edges = Array.from({ length: HISTOGRAM_BUCKETS + 1 }, (_, i) => Math.round(lo * Math.exp(step * i)));
  edges[0] = lo;
  edges[HISTOGRAM_BUCKETS] = hi;
  return edges.filter((e, i) => i === 0 || e > edges[i - 1]!);
}

export function histogram(values: readonly number[], edges: readonly number[]): Bucket[] {
  if (edges.length < 2) return [];
  const buckets = edges.slice(0, -1).map((from, i) => ({ from, to: edges[i + 1]!, count: 0 }));
  for (const v of values) {
    const i = buckets.findIndex((b) => v < b.to);
    buckets[i === -1 ? buckets.length - 1 : i]!.count += 1;
  }
  return buckets;
}

interface RunRow {
  id: number;
  agent: InsightAgent;
  task_id: number | null;
  task_title: string | null;
  model: string | null;
  measured: number;
  tokens_in: number;
  tokens_out: number;
  cache_read: number;
  cache_creation: number;
  duration_ms: number;
  tool_uses: number;
}

const AGENT_OF_RUN = `CASE
    WHEN r.agent_type = 'swe' THEN 'swe'
    WHEN r.agent_type = 'code-reviewer' THEN 'code-reviewer'
    WHEN r.agent_type = 'bro' AND r.task_id IS NULL THEN 'bro'
  END`;

const sinceOf = (range: InsightRange, now: Date): string | null => {
  const days = INSIGHT_RANGES[range];
  return days === null ? null : new Date(now.getTime() - days * 86_400_000).toISOString();
};

const context = (r: RunRow) => r.tokens_in + r.cache_read + r.cache_creation;

function agentStats(runs: RunRow[], agent: InsightAgent, edges: number[]): Row {
  const all = runs.filter((r) => r.agent === agent);
  const measured = all.filter((r) => r.measured === 1);
  const contextSum = measured.reduce((s, r) => s + context(r), 0);
  const cacheRead = measured.reduce((s, r) => s + r.cache_read, 0);
  const hit = metric(measured.map((r) => (context(r) > 0 ? r.cache_read / context(r) : 0)));
  return {
    agent,
    per: agent === 'bro' ? 'session' : 'run',
    n: measured.length,
    total: all.length,
    tokens_out: metric(measured.map((r) => r.tokens_out)),
    context: metric(measured.map(context)),
    cache_hit: { ...hit, avg: contextSum > 0 ? cacheRead / contextSum : null },
    duration_ms: metric(measured.map((r) => r.duration_ms)),
    tool_uses: metric(measured.map((r) => r.tool_uses)),
    histogram: histogram(measured.map((r) => r.tokens_out), edges),
  };
}

function priceOf(prices: ReadonlyMap<string, ModelPrice>, r: RunRow): number | null {
  const price = r.model === null ? undefined : prices.get(r.model);
  if (!price) return null;
  return (
    (r.tokens_in * price.input + r.tokens_out * price.output + r.cache_read * price.cache_read + r.cache_creation * price.cache_creation) /
    1_000_000
  );
}

interface ModelPrice {
  input: number;
  output: number;
  cache_read: number;
  cache_creation: number;
}

const PRICE_FIELDS = ['input', 'output', 'cache_read', 'cache_creation'] as const;

// plugin_config.model_prices (USD per 1M tokens) as in the trajectory server's
// readModelPrices: an entry counts only with all four fields numeric.
export function modelPrices(db: DatabaseSync): Map<string, ModelPrice> {
  const prices = new Map<string, ModelPrice>();
  const row = one(db, `SELECT value_json FROM plugin_config WHERE key = 'model_prices'`);
  if (!row) return prices;
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(row['value_json']));
  } catch {
    return prices;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return prices;
  for (const [model, entry] of Object.entries(parsed as Record<string, unknown>)) {
    if (entry === null || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (PRICE_FIELDS.every((f) => typeof e[f] === 'number' && Number.isFinite(e[f]))) {
      prices.set(model, { input: e['input'] as number, output: e['output'] as number, cache_read: e['cache_read'] as number, cache_creation: e['cache_creation'] as number });
    }
  }
  return prices;
}

function costOf(db: DatabaseSync, runs: RunRow[]): Row {
  const prices = modelPrices(db);
  const measured = runs.filter((r) => r.measured === 1);
  if (prices.size === 0) return { priced: false, by_agent: [], by_model: [], unpriced_runs: measured.length };
  const byAgent = new Map<string, { usd: number; runs: number }>();
  const byModel = new Map<string, { usd: number; runs: number }>();
  let unpriced = 0;
  for (const r of measured) {
    const usd = priceOf(prices, r);
    if (usd === null) {
      unpriced += 1;
      continue;
    }
    for (const [map, key] of [[byAgent, r.agent], [byModel, r.model!]] as const) {
      const g = map.get(key) ?? { usd: 0, runs: 0 };
      g.usd += usd;
      g.runs += 1;
      map.set(key, g);
    }
  }
  const list = (map: Map<string, { usd: number; runs: number }>, key: string) =>
    [...map].map(([k, g]) => ({ [key]: k, usd: Math.round(g.usd * 10_000) / 10_000, runs: g.runs })).sort((a, b) => b.usd - a.usd);
  return { priced: true, by_agent: list(byAgent, 'agent'), by_model: list(byModel, 'model'), unpriced_runs: unpriced };
}

const wrapsWhole = (s: string): boolean => {
  if (!s.startsWith('(') || !s.endsWith(')')) return false;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth += 1;
    else if (s[i] === ')') depth -= 1;
    if (depth === 0 && i < s.length - 1) return false;
  }
  return depth === 0;
};

// One key for a verification command and its subshell form (GH 1948): trim,
// strip parentheses only while one pair wraps the whole string, collapse spaces.
export function normalizeCommand(command: string): string {
  let s = command.trim();
  while (wrapsWhole(s)) s = s.slice(1, -1).trim();
  return s.replace(/\s+/g, ' ');
}

function qualityOf(db: DatabaseSync, f: InsightFilter, since: string | null): Row {
  const taskWhere = `(? IS NULL OR t.repo = ?) AND (? IS NULL OR t.effort = ?)`;
  const taskArgs = [f.repo, f.repo, f.effort, f.effort];
  const attempts = all(
    db,
    `SELECT v.task_id, v.attempt_n, v.verdict FROM validation_attempts v JOIN tasks t ON t.id = v.task_id
      WHERE (? IS NULL OR v.created_at >= ?) AND ${taskWhere}
      ORDER BY v.task_id, v.attempt_n, v.id`,
    since,
    since,
    ...taskArgs,
  );
  const verdicts = { pass: 0, fail: 0, escalate: 0 };
  const perTask = new Map<number, { first: string; count: number }>();
  for (const a of attempts) {
    const verdict = String(a['verdict']) as keyof typeof verdicts;
    if (verdict in verdicts) verdicts[verdict] += 1;
    const id = Number(a['task_id']);
    const t = perTask.get(id);
    if (t) t.count += 1;
    else perTask.set(id, { first: verdict, count: 1 });
  }
  const attemptCounts = new Map<number, number>();
  for (const t of perTask.values()) attemptCounts.set(t.count, (attemptCounts.get(t.count) ?? 0) + 1);
  const verification = one(
    db,
    `SELECT COUNT(*) AS total, COALESCE(SUM(r.exit_code = 0), 0) AS passed
       FROM verification_runs r JOIN tasks t ON t.id = r.task_id
      WHERE r.exit_code IS NOT NULL AND (? IS NULL OR r.started_at >= ?) AND ${taskWhere}`,
    since,
    since,
    ...taskArgs,
  );
  const commands = new Map<string, number[]>();
  for (const c of all(
    db,
    `SELECT c.command, c.elapsed_s FROM verification_run_commands c
       JOIN verification_runs r ON r.id = c.run_id JOIN tasks t ON t.id = r.task_id
      WHERE c.elapsed_s IS NOT NULL AND (? IS NULL OR r.started_at >= ?) AND ${taskWhere}`,
    since,
    since,
    ...taskArgs,
  )) {
    const command = normalizeCommand(String(c['command']));
    const list = commands.get(command) ?? [];
    list.push(Number(c['elapsed_s']));
    commands.set(command, list);
  }
  const slowest = [...commands]
    .map(([command, values]) => {
      const sorted = [...values].sort((a, b) => a - b);
      return { command, n: sorted.length, ...metric(sorted), rank: nearestRank(sorted, 0.95)! };
    })
    .sort((a, b) => b.rank - a.rank || a.command.localeCompare(b.command))
    .slice(0, TOP_N)
    .map(({ rank: _rank, ...c }) => c);
  return {
    first_pass: { passed: [...perTask.values()].filter((t) => t.first === 'pass').length, total: perTask.size },
    attempts: [...attemptCounts].sort((a, b) => a[0] - b[0]).map(([attempts, tasks]) => ({ attempts, tasks })),
    verdicts,
    verification: { passed: Number(verification?.['passed'] ?? 0), total: Number(verification?.['total'] ?? 0) },
    slowest_commands: slowest,
  };
}

function throughputOf(db: DatabaseSync, f: InsightFilter, since: string | null): Row[] {
  return all(
    db,
    `SELECT substr(COALESCE(t.completed_at, t.updated_at), 1, 10) AS day, COUNT(*) AS closed
       FROM tasks t
      WHERE t.status = 'closed' AND (? IS NULL OR COALESCE(t.completed_at, t.updated_at) >= ?)
        AND (? IS NULL OR t.repo = ?) AND (? IS NULL OR t.effort = ?)
      GROUP BY day ORDER BY day`,
    since,
    since,
    f.repo,
    f.repo,
    f.effort,
    f.effort,
  ).map((r) => ({ day: String(r['day']), closed: Number(r['closed']) }));
}

const IDLE_MIN_MS = 30 * 60_000;
const IDLE_TOOL_USES_PER_MIN = 1;
const IDLE_TOKENS_OUT_PER_MIN = 500;

// A run that sat open far longer than it worked (GH 1948): at least 30 min,
// under 1 tool use and under 500 output tokens a minute.
export function likelyIdle(r: { duration_ms: number; tool_uses: number; tokens_out: number }): boolean {
  if (!(r.duration_ms >= IDLE_MIN_MS)) return false;
  const minutes = r.duration_ms / 60_000;
  return r.tool_uses / minutes < IDLE_TOOL_USES_PER_MIN && r.tokens_out / minutes < IDLE_TOKENS_OUT_PER_MIN;
}

function outliersOf(runs: RunRow[]): Row {
  const perRun = runs.filter((r) => r.measured === 1 && r.agent !== 'bro');
  const row = (r: RunRow, value: number) => ({ run_id: r.id, agent: r.agent, task_id: r.task_id, task_title: r.task_title, value });
  const byValue = (a: { value: number; run_id: number }, b: { value: number; run_id: number }) => b.value - a.value || a.run_id - b.run_id;
  const top = (value: (r: RunRow) => number) => perRun.map((r) => row(r, value(r))).sort(byValue).slice(0, TOP_N);
  const durations = perRun
    .map((r) => ({ ...row(r, r.duration_ms), tool_uses: r.tool_uses, tokens_out: r.tokens_out, idle: likelyIdle(r) }))
    .sort(byValue);
  const duration_ms = [...durations.filter((r) => !r.idle).slice(0, TOP_N), ...durations.filter((r) => r.idle).slice(0, TOP_N)];
  return { tokens_out: top((r) => r.tokens_out), context: top(context), duration_ms };
}

// GET /api/insights: per-agent token, time and cost stats, review and
// verification quality, closed-task throughput and the top runs, over the
// filter's range. Runs whose usage_source is NULL or 'unmeasured' count in
// `total` but in no statistic.
export function insights(db: DatabaseSync, f: InsightFilter, now: Date = new Date()): Row {
  const since = sinceOf(f.range, now);
  const rows = all(
    db,
    `SELECT * FROM (
       SELECT r.id, ${AGENT_OF_RUN} AS agent, r.task_id, t.title AS task_title, r.model,
              (r.usage_source IS NOT NULL AND r.usage_source <> 'unmeasured') AS measured,
              COALESCE(r.tokens_in, 0) AS tokens_in, COALESCE(r.tokens_out, 0) AS tokens_out,
              COALESCE(r.cache_read_tokens, 0) AS cache_read, COALESCE(r.cache_creation_tokens, 0) AS cache_creation,
              r.duration_ms, r.tool_uses
         FROM agent_runs r LEFT JOIN tasks t ON t.id = r.task_id
        WHERE (? IS NULL OR COALESCE(r.started_at, r.completed_at) >= ?)
          AND (? IS NULL OR r.repo = ?) AND (? IS NULL OR r.model = ?) AND (? IS NULL OR r.effort = ?)
     ) WHERE agent IS NOT NULL AND (? IS NULL OR agent = ?)
     ORDER BY id`,
    since,
    since,
    f.repo,
    f.repo,
    f.model,
    f.model,
    f.effort,
    f.effort,
    f.agent,
    f.agent,
  ) as unknown as RunRow[];
  const perRunTokens = rows.filter((r) => r.measured === 1 && r.agent !== 'bro').map((r) => r.tokens_out);
  const broTokens = rows.filter((r) => r.measured === 1 && r.agent === 'bro').map((r) => r.tokens_out);
  const sharedEdges = logEdges(perRunTokens);
  const broEdges = logEdges(broTokens);
  const names = (sql: string) => all(db, sql).map((r) => String(r['v']));
  return {
    range: { key: f.range, since, until: now.toISOString() },
    filters: { repo: f.repo, agent: f.agent, model: f.model, effort: f.effort },
    options: {
      repos: names(`SELECT DISTINCT repo AS v FROM agent_runs WHERE repo IS NOT NULL ORDER BY repo`),
      models: names(`SELECT DISTINCT model AS v FROM agent_runs WHERE model IS NOT NULL ORDER BY model`),
    },
    agents: INSIGHT_AGENTS.map((a) => agentStats(rows, a, a === 'bro' ? broEdges : sharedEdges)),
    cost: costOf(db, rows),
    quality: qualityOf(db, f, since),
    throughput: throughputOf(db, f, since),
    outliers: outliersOf(rows),
  };
}
