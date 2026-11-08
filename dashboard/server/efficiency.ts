import { execFileSync } from 'node:child_process';
import { isAbsolute } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { nearestRank, sinceOf, type InsightFilter } from './queries.ts';

type Row = Record<string, unknown>;

export const CODE_TYPES = ['feat', 'fix', 'test', 'refactor', 'perf', 'chore'] as const;
export const TASK_TYPES = [...CODE_TYPES, 'docs'] as const;
export type TaskType = (typeof TASK_TYPES)[number] | 'other';

export const FEW_MIN = 3;
const SHA = /^[0-9a-f]{7,40}$/;
const SUBJECT_TYPE = /^\W*([a-z]+)(\([^)]*\))?!?:/;
const NUMSTAT_LINE = /^(\d+|-)\t(\d+|-)\t(.+)$/;
const GIT_TIMEOUT_MS = 15_000;
const GIT_MAX_BUFFER = 32 * 1024 * 1024;

const LOCKFILES = new Set(['bun.lock', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']);
const GENERATED_FILES = new Set(['data-contracts.json']);
const GENERATED_PATHS = new Set(['docs/contributing/ENUMS.md', 'docs/architecture/ERD.md', 'docs/reference/CONFIG_KEYS.md']);
const GENERATED_DIRS = new Set(['dist', 'build']);
const DOC_FILE = /\.(md|mdx|txt|rst)$/;

const isTaskType = (v: string): v is (typeof TASK_TYPES)[number] => (TASK_TYPES as readonly string[]).includes(v);

export function commitType(subject: string): TaskType {
  const type = subject.match(SUBJECT_TYPE)?.[1];
  return type !== undefined && isTaskType(type) ? type : 'other';
}

// The post-rename path of a numstat entry: `a/{b => c}/d` is `a/c/d`, `x => y` is `y`.
export function numstatPath(raw: string): string {
  const braced = raw.replace(/\{[^{}]* => ([^{}]*)\}/g, '$1').replace(/\/{2,}/g, '/');
  const arrow = braced.indexOf(' => ');
  return arrow === -1 ? braced : braced.slice(arrow + 4);
}

export function isGenerated(path: string): boolean {
  const parts = path.split('/');
  const name = parts[parts.length - 1]!;
  return (
    parts.slice(0, -1).some((p) => GENERATED_DIRS.has(p)) ||
    name.endsWith('.map') ||
    name.includes('.min.') ||
    LOCKFILES.has(name) ||
    GENERATED_FILES.has(name) ||
    GENERATED_PATHS.has(path)
  );
}

export const isDoc = (path: string): boolean => DOC_FILE.test(path) || path.split('/').slice(0, -1).includes('docs');

export interface NumstatFile {
  path: string;
  added: number;
  deleted: number;
}

export interface Numstat {
  subject: string;
  files: NumstatFile[];
}

export function parseNumstat(out: string): Numstat {
  const [subject = '', ...rest] = out.split('\n');
  const files: NumstatFile[] = [];
  for (const line of rest) {
    const m = line.match(NUMSTAT_LINE);
    if (!m || m[1] === '-' || m[2] === '-') continue;
    files.push({ path: numstatPath(m[3]!), added: Number(m[1]), deleted: Number(m[2]) });
  }
  return { subject, files };
}

export function linesOf(stat: Numstat, type: TaskType): number {
  return stat.files
    .filter((f) => !isGenerated(f.path) && (type === 'docs' || !isDoc(f.path)))
    .reduce((s, f) => s + f.added + f.deleted, 0);
}

const numstats = new Map<string, Numstat>();

function numstatOf(repo: string, path: string, sha: string): Numstat | null {
  const key = `${repo}:${sha}`;
  const cached = numstats.get(key);
  if (cached) return cached;
  let out: string;
  try {
    out = execFileSync('git', ['-C', path, '-c', 'core.quotePath=false', 'show', '--no-color', '--numstat', '--format=%s', sha], {
      encoding: 'utf8',
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
    });
  } catch {
    return null;
  }
  const stat = parseNumstat(out);
  numstats.set(key, stat);
  return stat;
}

interface TaskRow {
  id: number;
  repo: string | null;
  repo_path: string | null;
  commit_sha: string;
  completed_at: string;
  swe_runs: number;
  fails: number;
  tokens_in: number;
  tokens_out: number;
  cache_read: number;
  cache_creation: number;
  duration_ms: number;
}

interface TaskFacts {
  type: TaskType;
  week: string;
  lines: number;
  tokens: number;
  context: number;
  cache_read: number;
  cost: number;
  seconds: number;
  first: boolean;
}

const pad = (n: number) => String(n).padStart(2, '0');

// The local-time Monday of an ISO 8601 week, as YYYY-MM-DD.
export function localMonday(at: string): string | null {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return null;
  const m = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
  return `${m.getFullYear()}-${pad(m.getMonth() + 1)}-${pad(m.getDate())}`;
}

const sum = (tasks: readonly TaskFacts[], v: (t: TaskFacts) => number) => tasks.reduce((s, t) => s + v(t), 0);
const pooled = (tasks: readonly TaskFacts[], v: (t: TaskFacts) => number) => (tasks.length === 0 ? null : sum(tasks, v) / sum(tasks, (t) => t.lines));
const median = (tasks: readonly TaskFacts[]) => nearestRank(tasks.map((t) => t.tokens / t.lines).sort((a, b) => a - b), 0.5);
const share = (part: number, whole: number) => (whole === 0 ? null : part / whole);

export interface Group {
  n: number;
  zero_line: number;
  few: boolean;
  first_pass_rate: number | null;
  fp_tok_line: number | null;
  fp_tok_line_median: number | null;
  rw_tok_line: number | null;
  rw_tok_line_median: number | null;
  rework_share: number | null;
  cache_hit: number | null;
  fp_sec_line: number | null;
  rw_sec_line: number | null;
}

// Pooled values are Σ over Σlines; medians are nearest-rank over per-task
// tokens per line. Under FEW_MIN tasks every metric is null.
export function groupOf(all: readonly TaskFacts[]): Group {
  const tasks = all.filter((t) => t.lines > 0);
  const n = tasks.length;
  const few = n < FEW_MIN;
  const fp = tasks.filter((t) => t.first);
  const rw = tasks.filter((t) => !t.first);
  const metric = <T>(v: () => T) => (few ? null : v());
  return {
    n,
    zero_line: all.length - n,
    few,
    first_pass_rate: metric(() => fp.length / n),
    fp_tok_line: metric(() => pooled(fp, (t) => t.tokens)),
    fp_tok_line_median: metric(() => median(fp)),
    rw_tok_line: metric(() => pooled(rw, (t) => t.tokens)),
    rw_tok_line_median: metric(() => median(rw)),
    rework_share: metric(() => share(sum(rw, (t) => t.cost), sum(tasks, (t) => t.cost))),
    cache_hit: metric(() => share(sum(tasks, (t) => t.cache_read), sum(tasks, (t) => t.context))),
    fp_sec_line: metric(() => pooled(fp, (t) => t.seconds)),
    rw_sec_line: metric(() => pooled(rw, (t) => t.seconds)),
  };
}

function grouped<K extends string>(tasks: readonly TaskFacts[], key: (t: TaskFacts) => K): Array<[K, Group]> {
  const by = new Map<K, TaskFacts[]>();
  for (const t of tasks) {
    const list = by.get(key(t));
    if (list) list.push(t);
    else by.set(key(t), [t]);
  }
  return [...by].map(([k, list]) => [k, groupOf(list)]);
}

const fewLast = (a: Group, b: Group) => Number(a.few) - Number(b.few);

function taskRows(db: DatabaseSync, f: InsightFilter, since: string | null): TaskRow[] {
  return db
    .prepare(
      `SELECT t.id, t.repo, r.path AS repo_path, t.commit_sha, t.completed_at,
              COALESCE(a.swe_runs, 0) AS swe_runs, COALESCE(v.fails, 0) AS fails,
              COALESCE(a.tokens_in, 0) AS tokens_in, COALESCE(a.tokens_out, 0) AS tokens_out,
              COALESCE(a.cache_read, 0) AS cache_read, COALESCE(a.cache_creation, 0) AS cache_creation,
              COALESCE(a.duration_ms, 0) AS duration_ms
         FROM tasks t
         LEFT JOIN repos r ON r.name = t.repo
         LEFT JOIN (
           SELECT task_id, SUM(agent_type = 'swe') AS swe_runs,
                  SUM(COALESCE(tokens_in, 0)) AS tokens_in, SUM(COALESCE(tokens_out, 0)) AS tokens_out,
                  SUM(COALESCE(cache_read_tokens, 0)) AS cache_read, SUM(COALESCE(cache_creation_tokens, 0)) AS cache_creation,
                  SUM(COALESCE(duration_ms, 0)) AS duration_ms
             FROM agent_runs WHERE agent_type IN ('swe', 'code-reviewer') AND task_id IS NOT NULL GROUP BY task_id
         ) a ON a.task_id = t.id
         LEFT JOIN (SELECT task_id, COUNT(*) AS fails FROM validation_attempts WHERE verdict = 'fail' GROUP BY task_id) v ON v.task_id = t.id
        WHERE t.status = 'closed' AND t.commit_sha IS NOT NULL AND t.completed_at IS NOT NULL
          AND (? IS NULL OR t.completed_at >= ?)
          AND (? IS NULL OR t.repo = ?) AND (? IS NULL OR t.effort = ?)
        ORDER BY t.id`,
    )
    .all(since, since, f.repo, f.repo, f.effort, f.effort) as unknown as TaskRow[];
}

function factsOf(r: TaskRow): TaskFacts | null {
  const week = localMonday(r.completed_at);
  if (!SHA.test(r.commit_sha) || r.repo === null || r.repo_path === null || !isAbsolute(r.repo_path) || week === null) return null;
  const stat = numstatOf(r.repo, r.repo_path, r.commit_sha);
  if (stat === null) return null;
  const type = commitType(stat.subject);
  const context = r.tokens_in + r.cache_read + r.cache_creation;
  return {
    type,
    week,
    lines: linesOf(stat, type),
    tokens: context + r.tokens_out,
    context,
    cache_read: r.cache_read,
    cost: r.tokens_in + 0.1 * r.cache_read + 1.25 * r.cache_creation + 5 * r.tokens_out,
    seconds: r.duration_ms / 1000,
    first: r.swe_runs === 1 && r.fails === 0,
  };
}

// GET /api/insights/efficiency: tokens per changed line of closed tasks by
// commit type and by local ISO week (code types only). Read-only: git runs
// `show --numstat` through execFile, never a shell.
export function efficiency(db: DatabaseSync, f: InsightFilter, now: Date = new Date()): Row {
  const since = sinceOf(f.range, now);
  const facts: TaskFacts[] = [];
  let skipped = 0;
  for (const r of taskRows(db, f, since)) {
    const t = factsOf(r);
    if (t === null) skipped += 1;
    else facts.push(t);
  }
  const types = grouped(facts, (t) => t.type);
  const code = types.filter(([k]) => k !== 'docs').sort(([ka, a], [kb, b]) => fewLast(a, b) || b.n - a.n || ka.localeCompare(kb));
  const docs = types.filter(([k]) => k === 'docs');
  const weeks = grouped(
    facts.filter((t) => t.type !== 'docs'),
    (t) => t.week,
  ).sort(([ka, a], [kb, b]) => fewLast(a, b) || ka.localeCompare(kb));
  return {
    range: { key: f.range, since, until: now.toISOString() },
    filters: { repo: f.repo, effort: f.effort },
    by_type: [...code, ...docs].map(([type, g]) => ({ type, ...g })),
    by_week: weeks.map(([week, g]) => ({ week, ...g })),
    skipped,
  };
}
