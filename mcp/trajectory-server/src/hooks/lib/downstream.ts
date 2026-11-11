/**
 * The direct downstream of indexed symbols for the downstream-context hooks
 * (GH 1990): read-only over wm_symbols and wm_edges, the call-edge callers
 * (calls, instantiates, runs, sources, as symbolCard counts them) of the
 * symbols plus the readers of the tables they write (a table among them
 * counts as written), tests excluded. A stub until GH 1988 exports the
 * world model's own walk.
 *
 * Also the hooks' side of the downstream-context A/B: the task's arm through
 * enrollDownstreamContextAb over the trajectory DB, and the
 * downstream_context_injected marker. Every read returns null on a DB error,
 * so a gate stays silent.
 */
import { DOWNSTREAM_AB_EVENT, DOWNSTREAM_INJECTED_EVENT, enrollDownstreamContextAb, isDownstreamArm, type DownstreamAbStore, type DownstreamArm } from '../../downstream-context-ab.js';
import { DOWNSTREAM_CONTEXT_AB_KEY, parseDownstreamContextAb } from '../../tools/config.js';
import { isDefaultTestPath, type Lane } from '../../utils/test-paths.js';
import { auditAppend } from './audit.js';
import { GATE_READ_ERROR, gateRead, sqlQuote } from './db.js';

export const MAX_REFS = 30;
export const MAX_CHARS = 2000;

const CALL_EDGES = "'calls', 'instantiates', 'runs', 'sources'";

export type DownstreamVia = 'caller' | 'reader';

export interface DownstreamRef {
  readonly id: number;
  readonly qualified_name: string;
  readonly kind: string;
  readonly path: string;
  readonly line: number;
  readonly via: DownstreamVia;
  /** The symbols it calls, or the tables it reads, of those asked about. */
  readonly of: readonly string[];
}

export interface Downstream {
  readonly refs: readonly DownstreamRef[];
  readonly total: number;
}

export interface IndexedSymbol {
  readonly id: number;
  readonly qualified_name: string;
  readonly kind: string;
  readonly path: string;
  readonly line: number;
}

function jsonRows<T>(db: string, sql: string, env: NodeJS.ProcessEnv): T[] | null {
  const out = gateRead(db, sql, env);
  if (out === GATE_READ_ERROR) return null;
  if (out.trim() === '') return [];
  try {
    const parsed: unknown = JSON.parse(out);
    return Array.isArray(parsed) ? (parsed as T[]) : null;
  } catch {
    return null;
  }
}

function idList(ids: readonly number[]): string {
  return [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))].join(', ');
}

const SYMBOL_JSON = "json_group_array(json_object('id', id, 'qualified_name', qualified_name, 'kind', kind, 'path', path, 'line', start_line))";

/** The indexed symbols of one repo-relative file; null on a read error. */
export function symbolsInFile(db: string, repo: string, path: string, env: NodeJS.ProcessEnv = process.env): IndexedSymbol[] | null {
  return jsonRows<IndexedSymbol>(
    db,
    `SELECT ${SYMBOL_JSON} FROM (SELECT * FROM wm_symbols WHERE repo = '${sqlQuote(repo)}' AND path = '${sqlQuote(path)}' ORDER BY start_line, id);`,
    env,
  );
}

/**
 * The non-module symbols of <repo> whose line range meets one of a file's
 * ranges; null on a read error. One read fetches the symbols of every changed
 * path and the ranges meet them here, so the SQL keeps one term per path
 * whatever the number of hunks.
 */
export function symbolsInRanges(
  db: string,
  repo: string,
  ranges: ReadonlyMap<string, readonly (readonly [number, number])[]>,
  env: NodeJS.ProcessEnv = process.env,
): IndexedSymbol[] | null {
  const spansByPath = new Map<string, (readonly [number, number])[]>();
  for (const [path, spans] of ranges) {
    const valid = spans.filter(([from, to]) => Number.isInteger(from) && Number.isInteger(to));
    if (valid.length > 0) spansByPath.set(path, valid);
  }
  if (spansByPath.size === 0) return [];
  const paths = [...spansByPath.keys()].map((p) => `'${sqlQuote(p)}'`).join(', ');
  const rows = jsonRows<IndexedSymbol & { readonly end_line: number }>(
    db,
    `SELECT json_group_array(json_object('id', id, 'qualified_name', qualified_name, 'kind', kind, 'path', path, 'line', start_line, 'end_line', end_line)) FROM (SELECT * FROM wm_symbols WHERE repo = '${sqlQuote(repo)}' AND kind <> 'module' AND path IN (${paths}) ORDER BY path, start_line, id);`,
    env,
  );
  if (rows === null) return null;
  return rows
    .filter((r) => (spansByPath.get(r.path) ?? []).some(([from, to]) => r.line <= to && r.end_line >= from))
    .map(({ id, qualified_name, kind, path, line }) => ({ id, qualified_name, kind, path, line }));
}

interface Hit {
  id: number;
  qualified_name: string;
  kind: string;
  path: string;
  line: number;
  via: DownstreamVia;
  of: string;
  lane: Lane | null;
}

/** The lane the scan stored for the hit's file; a path with no wm_files row falls back to the default rules. */
function inTestLane(h: Hit): boolean {
  return h.lane === null || h.lane === undefined ? isDefaultTestPath(h.path) : h.lane === 'test';
}

/**
 * The direct downstream of <symbolIds> in <repo>: callers over call edges and
 * readers of the tables the symbols write, less tests, the symbols themselves
 * and refs in <skipPaths>, ordered by path and line; null on a read error.
 */
export function directDownstream(
  db: string,
  repo: string,
  symbolIds: readonly number[],
  env: NodeJS.ProcessEnv = process.env,
  skipPaths: readonly string[] = [],
): Downstream | null {
  const ids = idList(symbolIds);
  if (ids === '') return { refs: [], total: 0 };
  const sql = `WITH t AS (SELECT id, kind FROM wm_symbols WHERE repo = '${sqlQuote(repo)}' AND id IN (${ids})),
tables AS (
  SELECT e.dst_id AS id FROM wm_edges e JOIN t ON t.id = e.src_id JOIN wm_symbols tb ON tb.id = e.dst_id
   WHERE e.kind = 'writes_table' AND tb.kind = 'sql_table'
  UNION SELECT id FROM t WHERE kind = 'sql_table'
),
hits AS (
  SELECT o.id, o.qualified_name, o.kind, o.path, o.start_line AS line, 'caller' AS via, s.qualified_name AS of_name
    FROM wm_edges e JOIN t ON t.id = e.dst_id JOIN wm_symbols s ON s.id = e.dst_id JOIN wm_symbols o ON o.id = e.src_id
   WHERE e.kind IN (${CALL_EDGES}) AND o.id NOT IN (SELECT id FROM t)
  UNION
  SELECT o.id, o.qualified_name, o.kind, o.path, o.start_line, 'reader', tb.qualified_name
    FROM wm_edges e JOIN tables ON tables.id = e.dst_id JOIN wm_symbols tb ON tb.id = e.dst_id JOIN wm_symbols o ON o.id = e.src_id
   WHERE e.kind = 'reads_table' AND o.id NOT IN (SELECT id FROM t)
)
SELECT json_group_array(json_object('id', id, 'qualified_name', qualified_name, 'kind', kind, 'path', path, 'line', line, 'via', via, 'of', of_name, 'lane', lane))
  FROM (SELECT h.*, f.lane FROM hits h LEFT JOIN wm_files f ON f.repo = '${sqlQuote(repo)}' AND f.path = h.path
         ORDER BY h.path, h.line, h.id, h.via, h.of_name);`;
  const hits = jsonRows<Hit>(db, sql, env);
  if (hits === null) return null;
  const skip = new Set(skipPaths);
  const merged = new Map<string, { ref: Omit<DownstreamRef, 'of'>; of: string[] }>();
  for (const h of hits) {
    if (typeof h.path !== 'string' || inTestLane(h) || skip.has(h.path)) continue;
    const key = `${h.via}:${h.id}`;
    const entry = merged.get(key) ?? { ref: { id: h.id, qualified_name: h.qualified_name, kind: h.kind, path: h.path, line: h.line, via: h.via }, of: [] };
    if (!entry.of.includes(h.of)) entry.of.push(h.of);
    merged.set(key, entry);
  }
  const refs = [...merged.values()].map(({ ref, of }) => ({ ...ref, of }));
  return { refs, total: refs.length };
}

function refLine(r: DownstreamRef): string {
  const why = r.via === 'caller' ? `calls ${r.of.join(', ')}` : `reads table ${r.of.join(', ')}`;
  return `- ${r.path}:${r.line} ${r.qualified_name} (${why})`;
}

export function symbolLine(s: IndexedSymbol): string {
  return `- ${s.path}:${s.line} ${s.qualified_name} (${s.kind})`;
}

export interface Section {
  readonly title: string;
  readonly lines: readonly string[];
}

/**
 * Sections of up to MAX_REFS lines each, the whole within MAX_CHARS: a line
 * that would pass either cap is left out, and a section that leaves lines out
 * says how many it shows of its total.
 */
export function capSections(head: string, sections: readonly Section[]): { text: string; shown: number[] } {
  let text = head;
  const shown: number[] = [];
  for (const section of sections) {
    const footerRoom = 40;
    let block = `\n${section.title} (${section.lines.length}):`;
    let n = 0;
    for (const line of section.lines) {
      if (n >= MAX_REFS || text.length + block.length + line.length + 1 + footerRoom > MAX_CHARS) break;
      block += `\n${line}`;
      n += 1;
    }
    if (n < section.lines.length) block += `\n… ${n} of ${section.lines.length} shown`;
    if (text.length + block.length > MAX_CHARS) break;
    text += block;
    shown.push(n);
  }
  return { text, shown };
}

export function downstreamLines(ds: Downstream): string[] {
  return ds.refs.map(refLine);
}

/** The task row fields a hook's audit rows need; null on a read error or no row. */
export function taskAnchor(db: string, taskId: number, env: NodeJS.ProcessEnv = process.env): { issueId: string; branchId: string } | null {
  const rows = jsonRows<{ issue_id: number; branch_id: string }>(
    db,
    `SELECT json_group_array(json_object('issue_id', issue_id, 'branch_id', branch_id)) FROM tasks WHERE id = ${taskId};`,
    env,
  );
  const row = rows?.[0];
  return row ? { issueId: String(row.issue_id), branchId: row.branch_id ?? '' } : null;
}

const LABEL_WHERE = (label: string, taskId?: number) =>
  `event_type = '${DOWNSTREAM_AB_EVENT}' AND json_valid(content_json) AND json_extract(content_json, '$.label') = '${sqlQuote(label)}'` +
  (taskId === undefined ? '' : ` AND CAST(json_extract(content_json, '$.task_id') AS INTEGER) = ${taskId}`);

/** The hooks' DownstreamAbStore over the trajectory DB, enrolling as hook:<gate>. */
export function hookAbStore(db: string, gate: string, env: NodeJS.ProcessEnv = process.env): DownstreamAbStore {
  return {
    config() {
      const out = gateRead(db, `SELECT value_json FROM plugin_config WHERE key = '${DOWNSTREAM_CONTEXT_AB_KEY}';`, env);
      return out === GATE_READ_ERROR ? null : parseDownstreamContextAb(out);
    },
    enrolledArm(label, task) {
      const out = gateRead(db, `SELECT json_extract(content_json, '$.arm') FROM audit WHERE ${LABEL_WHERE(label, task)} ORDER BY id LIMIT 1;`, env);
      if (out === GATE_READ_ERROR) return null;
      if (out === '') return 'none';
      return isDownstreamArm(out) ? out : null;
    },
    enrolledCount(label) {
      const out = gateRead(db, `SELECT COUNT(DISTINCT CAST(json_extract(content_json, '$.task_id') AS INTEGER)) FROM audit WHERE ${LABEL_WHERE(label)};`, env);
      return out === GATE_READ_ERROR || !/^[0-9]+$/.test(out) ? null : Number(out);
    },
    enroll(label, arm, task) {
      const anchor = taskAnchor(db, task, env);
      if (!anchor) return false;
      const written = auditAppend(
        db,
        {
          issueId: anchor.issueId,
          branchId: anchor.branchId,
          fromNode: `hook:${gate}`,
          eventType: 'downstream_context_ab_enrolled',
          summary: `Task ${task} enrolled in downstream-context A/B '${label}' at ${arm}.`,
          contentJson: JSON.stringify({ label, arm, task_id: task }),
          dedupePaths: ['$.label', '$.task_id'],
        },
        { caller: gate, env },
      );
      return written.ok;
    },
  };
}

/** The task's A/B arm, enrolling it when due; null when the A/B is off for it. */
export function downstreamArm(db: string, gate: string, taskId: number, env: NodeJS.ProcessEnv = process.env): DownstreamArm | null {
  return enrollDownstreamContextAb(hookAbStore(db, gate, env), taskId);
}

/** Whether a downstream_context_injected row already matches every key of <match>; null on a read error. */
export function injectedBefore(db: string, match: Readonly<Record<string, string | number>>, env: NodeJS.ProcessEnv = process.env): boolean | null {
  const conds = Object.entries(match).map(([k, v]) =>
    typeof v === 'number' ? `CAST(json_extract(content_json, '$.${k}') AS INTEGER) = ${v}` : `json_extract(content_json, '$.${k}') = '${sqlQuote(v)}'`,
  );
  const out = gateRead(db, `SELECT COUNT(*) FROM audit WHERE event_type = '${DOWNSTREAM_INJECTED_EVENT}' AND json_valid(content_json) AND ${conds.join(' AND ')};`, env);
  return out === GATE_READ_ERROR ? null : out !== '0';
}

/** Writes the downstream_context_injected marker, deduplicated on <dedupe> keys of <content>. */
export function recordInjected(
  db: string,
  gate: string,
  taskId: number,
  content: Readonly<Record<string, unknown>>,
  dedupe: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const anchor = taskAnchor(db, taskId, env);
  if (!anchor) return false;
  return auditAppend(
    db,
    {
      issueId: anchor.issueId,
      branchId: anchor.branchId,
      fromNode: `hook:${gate}`,
      eventType: 'downstream_context_injected',
      summary: `${gate} injected the direct downstream for task ${taskId}.`,
      contentJson: JSON.stringify({ task_id: taskId, ...content }),
      dedupePaths: dedupe.map((k) => `$.${k}`),
    },
    { caller: gate, env },
  ).ok;
}
