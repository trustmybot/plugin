import type { DatabaseSync } from 'node:sqlite';
import type { TrajectoryDB } from '../../mcp/trajectory-server/src/db.ts';
import { derivedChain, getConcept, searchConcepts } from '../../mcp/trajectory-server/src/world-model/concepts.ts';
import { outsideConceptLane } from '../../mcp/trajectory-server/src/symbol-index.ts';
import { schemaVersion } from './queries.ts';

const CONCEPTS_SCHEMA_VERSION = 45;
const CONCEPT_TABLES = ['wm_concepts', 'wm_concept_steps', 'wm_concepts_fts', 'wm_symbols', 'wm_symbols_fts', 'wm_edges'];
const MIN_QUERY_LENGTH = 2;
const MAX_STEPS = 50;
const GRAPH_EDGES = ['calls', 'sources', 'runs', 'imports'];

const LIMITS = {
  search: { fallback: 20, max: 50 },
  graph: { fallback: 60, max: 120 },
  neighbourhood: { fallback: 40, max: 100 },
} as const;

export interface ApiReply {
  status: number;
  body: unknown;
}

type NodeId = number | string;

export interface GraphNode {
  id: NodeId;
  label: string;
  repo: string;
  path: string;
  dir: string;
  kind: string;
  line_start: number | null;
  step_ordinal: number | null;
}

export interface GraphEdge {
  src: NodeId;
  dst: NodeId;
  kind: string;
}

interface SymbolLite {
  id: number;
  repo: string;
  path: string;
  kind: string;
  qualified_name: string;
  start_line: number | null;
}

interface StepAnchor {
  id: number | null;
  repo: string;
  path: string;
  kind: string;
  qualified_name?: string;
  line_start: number | null;
}

// The concept functions only read; this hands them the dashboard's read-only
// connection behind the two TrajectoryDB methods they call, so nothing opens
// the DB for writing or applies the schema.
function readOnly(db: DatabaseSync): TrajectoryDB {
  const params = (p?: unknown[]) => (p ?? []) as never[];
  const reader = {
    get: <T>(sql: string, p?: unknown[]) => db.prepare(sql).get(...params(p)) as T | undefined,
    all: <T>(sql: string, p?: unknown[]) => db.prepare(sql).all(...params(p)) as T[],
  };
  return reader as unknown as TrajectoryDB;
}

export function conceptsAvailable(db: DatabaseSync): boolean {
  if ((schemaVersion(db) ?? 0) < CONCEPTS_SCHEMA_VERSION) return false;
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN (SELECT value FROM json_each(?))`)
    .get(JSON.stringify(CONCEPT_TABLES)) as { n: number } | undefined;
  return Number(row?.n ?? 0) === CONCEPT_TABLES.length;
}

function clamp(raw: string | null, { fallback, max }: { fallback: number; max: number }): number {
  if (raw === null || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) ? Math.min(Math.max(n, 1), max) : fallback;
}

const dirOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const baseOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);

function symbolNode(s: SymbolLite, stepOrdinal: number | null): GraphNode {
  return {
    id: Number(s.id),
    label: s.kind === 'module' ? baseOf(s.path) : s.qualified_name,
    repo: s.repo,
    path: s.path,
    dir: dirOf(s.path),
    kind: s.kind,
    line_start: s.start_line === null ? null : Number(s.start_line),
    step_ordinal: stepOrdinal,
  };
}

function fileNode(a: StepAnchor, stepOrdinal: number): GraphNode {
  return {
    id: `file:${a.repo}:${a.path}`,
    label: baseOf(a.path),
    repo: a.repo,
    path: a.path,
    dir: dirOf(a.path),
    kind: 'file',
    line_start: null,
    step_ordinal: stepOrdinal,
  };
}

function symbolLite(db: DatabaseSync, id: number): SymbolLite | null {
  const row = db
    .prepare(`SELECT id, repo, path, kind, qualified_name, start_line FROM wm_symbols WHERE id = ?`)
    .get(id) as SymbolLite | undefined;
  return row ?? null;
}

function neighbourIds(db: DatabaseSync, id: number): number[] {
  const rows = db
    .prepare(
      `SELECT CASE WHEN e.src_id = ? THEN e.dst_id ELSE e.src_id END AS other
         FROM wm_edges e
        WHERE (e.src_id = ? OR e.dst_id = ?) AND e.dst_id IS NOT NULL AND e.resolution = 'exact'
          AND e.kind IN (SELECT value FROM json_each(?))
        ORDER BY e.line, e.rowid`,
    )
    .all(id, id, id, JSON.stringify(GRAPH_EDGES)) as Array<{ other: number }>;
  return [...new Set(rows.map((r) => Number(r.other)).filter((o) => o !== id))];
}

function edgesAmong(db: DatabaseSync, ids: number[]): GraphEdge[] {
  if (ids.length === 0) return [];
  const set = JSON.stringify(ids);
  const rows = db
    .prepare(
      `SELECT DISTINCT e.src_id AS src, e.dst_id AS dst, e.kind
         FROM wm_edges e
        WHERE e.resolution = 'exact' AND e.src_id <> e.dst_id
          AND e.kind IN (SELECT value FROM json_each(?))
          AND e.src_id IN (SELECT value FROM json_each(?))
          AND e.dst_id IN (SELECT value FROM json_each(?))
        ORDER BY e.src_id, e.dst_id, e.kind`,
    )
    .all(JSON.stringify(GRAPH_EDGES), set, set) as Array<{ src: number; dst: number; kind: string }>;
  return rows.map((r) => ({ src: Number(r.src), dst: Number(r.dst), kind: r.kind }));
}

// The centre nodes are always kept; their 1-hop neighbours (test and fixture
// paths dropped) fill the rest of `limit` in centre order.
function buildGraph(db: DatabaseSync, centres: GraphNode[], limit: number) {
  const nodes = new Map<NodeId, GraphNode>();
  for (const c of centres) if (!nodes.has(c.id)) nodes.set(c.id, c);
  let truncated = false;
  for (const c of centres) {
    if (typeof c.id !== 'number') continue;
    for (const other of neighbourIds(db, c.id)) {
      if (nodes.has(other)) continue;
      const s = symbolLite(db, other);
      if (!s || outsideConceptLane(s.path)) continue;
      if (nodes.size >= limit) {
        truncated = true;
        break;
      }
      nodes.set(other, symbolNode(s, null));
    }
  }
  const ids = [...nodes.keys()].filter((k): k is number => typeof k === 'number');
  return { nodes: [...nodes.values()], edges: edgesAmong(db, ids), truncated };
}

function conceptGraph(db: DatabaseSync, id: number, limit: number): ApiReply {
  const concept = getConcept(readOnly(db), id);
  if (!concept) return { status: 404, body: { error: 'concept not found' } };
  const centres: GraphNode[] = [];
  for (const step of concept.steps.slice(0, MAX_STEPS)) {
    const anchor = step.symbol as StepAnchor | null;
    if (!anchor) continue;
    if (anchor.id === null || anchor.kind === 'file') {
      centres.push(fileNode(anchor, step.ordinal));
      continue;
    }
    if (centres.some((c) => c.id === anchor.id)) continue;
    const s = symbolLite(db, anchor.id);
    if (s) centres.push(symbolNode(s, step.ordinal));
  }
  return { status: 200, body: buildGraph(db, centres, limit) };
}

function neighbourhood(db: DatabaseSync, id: number, limit: number): ApiReply {
  const s = symbolLite(db, id);
  if (!s) return { status: 404, body: { error: 'symbol not found' } };
  return { status: 200, body: buildGraph(db, [symbolNode(s, null)], limit) };
}

function conceptDetail(db: DatabaseSync, id: number): ApiReply {
  const concept = getConcept(readOnly(db), id);
  if (!concept) return { status: 404, body: { error: 'concept not found' } };
  return {
    status: 200,
    body: { available: true, ...concept, steps: concept.steps.slice(0, MAX_STEPS), steps_truncated: concept.steps.length > MAX_STEPS },
  };
}

function search(db: DatabaseSync, params: URLSearchParams): ApiReply {
  const repos = (
    db.prepare(`SELECT repo FROM wm_concepts UNION SELECT repo FROM wm_symbols ORDER BY repo`).all() as Array<{ repo: string }>
  ).map((r) => r.repo);
  const repo = params.get('repo') || repos[0];
  const q = (params.get('q') ?? '').trim();
  if (repo === undefined || q.length < MIN_QUERY_LENGTH) {
    return { status: 200, body: { available: true, repos, repo: repo ?? null, concepts: [], derived: null } };
  }
  const trajectory = readOnly(db);
  const concepts = searchConcepts(trajectory, repo, q, clamp(params.get('limit'), LIMITS.search));
  const derived = concepts.length === 0 ? derivedChain(trajectory, repo, q) : null;
  return { status: 200, body: { available: true, repos, repo, concepts, derived } };
}

const positiveId = (raw: string | undefined) => (raw !== undefined && /^[1-9]\d*$/.test(raw) ? Number(raw) : null);

// GET /api/concepts[/:id[/graph]] and /api/symbols/:id/neighbourhood; null
// for any other path.
export function conceptsApi(db: DatabaseSync, url: URL): ApiReply | null {
  const parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
  const [resource, rawId, sub] = parts;
  if (resource !== 'concepts' && resource !== 'symbols') return null;
  const notFound: ApiReply = { status: 404, body: { error: 'unknown endpoint' } };
  if (resource === 'symbols' && (parts.length !== 3 || sub !== 'neighbourhood')) return notFound;
  if (resource === 'concepts' && (parts.length > 3 || (parts.length === 3 && sub !== 'graph'))) return notFound;
  if (!conceptsAvailable(db)) return { status: 200, body: { available: false, repos: [], concepts: [], derived: null } };
  if (parts.length === 1) return search(db, url.searchParams);
  const id = positiveId(rawId);
  if (id === null) return { status: 404, body: { error: `${resource === 'symbols' ? 'symbol' : 'concept'} not found` } };
  const limit = url.searchParams.get('limit');
  if (resource === 'symbols') return neighbourhood(db, id, clamp(limit, LIMITS.neighbourhood));
  return sub === 'graph' ? conceptGraph(db, id, clamp(limit, LIMITS.graph)) : conceptDetail(db, id);
}
