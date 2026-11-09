// task_brief locations (GH 1906): the files and symbols a spec names in
// backticks, resolved against the world-model symbol index at read time so a
// swe reads by line range instead of whole files.
import type { TrajectoryDB } from './db.js';
import { symbolCard, symbolsByName, type RefList, type SymbolRow } from './symbol-index.js';
import { isTestPath } from './utils/test-paths.js';
import { frameUntrusted } from './utils/untrusted.js';

export const LOCATIONS_MAX_CHARS = 6000;
const MAX_FILES = 10;
const MAX_FILE_SYMBOLS = 12;
const MAX_SYMBOLS = 25;
const MAX_MATCHES_PER_NAME = 3;
const MAX_NEIGHBOURS = 3;

const SPAN_RE = /`([^`\n]+)`/g;
const PATH_RE = /^((?:[\w.@$-]+\/)*[\w.@$-]*[\w@$-]\.[A-Za-z0-9]+)(?::(\d+)(?:-(\d+))?)?$/;
const IDENT_RE = /^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)(?:\(\))?$/;
const FILE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'md', 'sh', 'py', 'yml', 'yaml', 'toml', 'sql', 'css', 'html', 'txt',
]);

function isPathSpan(path: string, isIndexedPath?: (path: string) => boolean): boolean {
  if (path.includes('/')) return true;
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return FILE_EXTENSIONS.has(ext) || (isIndexedPath?.(path) ?? false);
}

export interface PathRef {
  path: string;
  start?: number;
  end?: number;
}

export interface SpecRefs {
  paths: PathRef[];
  identifiers: string[];
}

export interface FileSymbol {
  qualified_name: string;
  kind: string;
  start_line: number;
  end_line: number;
}

export interface FileLocation {
  path: string;
  purpose: string;
  symbols: FileSymbol[];
}

export interface Neighbour {
  qualified_name: string;
  path: string;
  line_start: number;
}

export interface SymbolLocation {
  id: number;
  qualified_name: string;
  kind: string;
  path: string;
  start_line: number;
  end_line: number;
  caller_count: number;
  callers_truncated: boolean;
  callers_hint?: string;
  callers: Neighbour[];
  callees: Neighbour[];
}

export interface BriefLocations {
  files: FileLocation[];
  symbols: SymbolLocation[];
  truncated: boolean;
  unresolved_paths?: string[];
}

// Backtick spans of a spec: path-shaped spans (with an optional :L or :L-M)
// and identifier-shaped spans (with an optional trailing ()). A span such as
// `Class.method` matches both shapes; a span with no `/` is a path only when
// it ends in a known file extension or isIndexedPath holds it as a file.
export function extractSpecRefs(spec: string, isIndexedPath?: (path: string) => boolean): SpecRefs {
  const paths: PathRef[] = [];
  const identifiers: string[] = [];
  const seenPaths = new Set<string>();
  const seenIdents = new Set<string>();
  for (const m of spec.matchAll(SPAN_RE)) {
    const span = m[1]!.trim();
    const p = PATH_RE.exec(span);
    if (p && isPathSpan(p[1]!, isIndexedPath)) {
      const start = p[2] ? Number(p[2]) : undefined;
      const end = p[3] ? Number(p[3]) : start;
      const key = `${p[1]}:${start ?? ''}-${end ?? ''}`;
      if (!seenPaths.has(key)) {
        seenPaths.add(key);
        paths.push({ path: p[1]!, ...(start !== undefined ? { start, end } : {}) });
      }
    }
    const id = IDENT_RE.exec(span);
    if (id && !seenIdents.has(id[1]!)) {
      seenIdents.add(id[1]!);
      identifiers.push(id[1]!);
    }
  }
  return { paths, identifiers };
}

function underFiles(path: string, files: string[]): boolean {
  return files.some((f) => {
    const entry = f.replace(/^\.\//, '');
    if (entry === '' || entry === '.') return true;
    if (entry.endsWith('/')) return path.startsWith(entry);
    return path === entry || path.startsWith(`${entry}/`);
  });
}

function neighbours(list: RefList): Neighbour[] {
  return list.refs.slice(0, MAX_NEIGHBOURS).map((r) => ({ qualified_name: r.qualified_name, path: r.path, line_start: r.line_start }));
}

function fileSymbols(db: TrajectoryDB, repo: string, path: string, ref: PathRef): FileSymbol[] {
  const rows = db
    .all<{ qualified_name: string; kind: string; start_line: number | null; end_line: number | null }>(
      `SELECT qualified_name, kind, start_line, end_line FROM wm_symbols
        WHERE repo = ? AND path = ? AND kind <> 'module'
        ORDER BY start_line, id`,
      [repo, path],
    )
    .map((r) => ({ qualified_name: r.qualified_name, kind: r.kind, start_line: Number(r.start_line), end_line: Number(r.end_line) }));
  if (rows.length <= MAX_FILE_SYMBOLS || ref.start === undefined) return rows.slice(0, MAX_FILE_SYMBOLS);
  const lo = ref.start;
  const hi = ref.end ?? ref.start;
  const distance = (s: FileSymbol) => (s.end_line < lo ? lo - s.end_line : s.start_line > hi ? s.start_line - hi : 0);
  const nearest = new Set(
    rows
      .map((s, i) => ({ i, d: distance(s) }))
      .sort((a, b) => a.d - b.d || a.i - b.i)
      .slice(0, MAX_FILE_SYMBOLS)
      .map((x) => x.i),
  );
  return rows.filter((_, i) => nearest.has(i));
}

// Exact repo-relative match first, else the one wm_files path the span is a
// suffix of; an ambiguous or unknown span resolves to nothing.
function resolvePath(db: TrajectoryDB, repo: string, path: string): { path: string; purpose: string } | null {
  const exact = db.get<{ path: string; purpose: string }>('SELECT path, purpose FROM wm_files WHERE repo = ? AND path = ?', [repo, path]);
  if (exact) return { path: exact.path, purpose: exact.purpose };
  const suffix = db.all<{ path: string; purpose: string }>(
    `SELECT path, purpose FROM wm_files WHERE repo = ? AND substr(path, -length(?)) = ? LIMIT 2`,
    [repo, `/${path}`, `/${path}`],
  );
  return suffix.length === 1 ? { path: suffix[0]!.path, purpose: suffix[0]!.purpose } : null;
}

// Drop order: rank-2 symbols, rank-1 symbols, named files' symbol lists from
// the last file, rank-0 symbols, then files; each tier from its last entry.
function capToSize(loc: BriefLocations, ranks: number[], maxChars: number): BriefLocations {
  const fits = () => JSON.stringify(loc).length <= maxChars;
  if (fits()) return loc;
  loc.truncated = true;
  const dropRank = (r: number) => {
    for (let i = loc.symbols.length - 1; i >= 0 && !fits(); i--) {
      if (ranks[i] !== r) continue;
      loc.symbols.splice(i, 1);
      ranks.splice(i, 1);
    }
  };
  dropRank(2);
  dropRank(1);
  for (let i = loc.files.length - 1; i >= 0 && !fits(); i--) loc.files[i]!.symbols = [];
  dropRank(0);
  while (!fits() && loc.files.length > 0) loc.files.pop();
  return loc;
}

// The locations block of a task brief: null when the repo has no world-model
// rows, else the spec's resolved files and symbols, within maxChars.
export function briefLocations(
  db: TrajectoryDB,
  repo: string,
  spec: string,
  taskFiles: string[],
  maxChars: number = LOCATIONS_MAX_CHARS,
): BriefLocations | null {
  if (!repo) return null;
  const any = db.get<{ n: number }>(
    `SELECT (SELECT COUNT(*) FROM (SELECT 1 FROM wm_files WHERE repo = ? LIMIT 1))
          + (SELECT COUNT(*) FROM (SELECT 1 FROM wm_symbols WHERE repo = ? LIMIT 1)) AS n`,
    [repo, repo],
  );
  if (!any || Number(any.n) === 0) return null;

  const refs = extractSpecRefs(
    spec,
    (path) => db.get('SELECT 1 FROM wm_files WHERE repo = ? AND path = ?', [repo, path]) !== undefined,
  );
  let truncated = false;
  const files: FileLocation[] = [];
  const named = new Set<string>();
  const unresolved: string[] = [];
  for (const ref of refs.paths) {
    const hit = resolvePath(db, repo, ref.path);
    if (!hit) {
      if (!unresolved.includes(ref.path) && unresolved.length < MAX_FILES) unresolved.push(ref.path);
      continue;
    }
    if (named.has(hit.path)) continue;
    named.add(hit.path);
    if (files.length >= MAX_FILES) {
      truncated = true;
      continue;
    }
    files.push({ path: hit.path, purpose: hit.purpose ? frameUntrusted('file-purpose', hit.purpose) : '', symbols: fileSymbols(db, repo, hit.path, ref) });
  }

  const rank = (s: SymbolRow) => (named.has(s.path) ? 0 : underFiles(s.path, taskFiles) ? 1 : 2);
  const admitted = (s: SymbolRow) => rank(s) < 2 || (s.exported === 1 && !isTestPath(s.path));
  const picked: SymbolRow[] = [];
  const seen = new Set<number>();
  for (const name of refs.identifiers) {
    const matches = symbolsByName(db, repo, name)
      .filter((s) => s.kind !== 'module' && !seen.has(s.id) && admitted(s))
      .map((s, i) => ({ s, i }))
      .sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i)
      .slice(0, MAX_MATCHES_PER_NAME)
      .map((x) => x.s);
    for (const s of matches) {
      seen.add(s.id);
      picked.push(s);
    }
  }
  if (picked.length > MAX_SYMBOLS) truncated = true;
  const kept = picked.slice(0, MAX_SYMBOLS);
  const symbols = kept.map((s): SymbolLocation => {
    const card = symbolCard(db, s);
    const callers = neighbours(card.callers);
    const callersTruncated = card.callers.total > callers.length;
    return {
      id: s.id,
      qualified_name: s.qualified_name,
      kind: s.kind,
      path: s.path,
      start_line: s.start_line,
      end_line: s.end_line,
      caller_count: card.callers.total,
      callers_truncated: callersTruncated,
      ...(callersTruncated ? { callers_hint: `world_model_symbol(id=${s.id}, impact=1) lists every caller` } : {}),
      callers,
      callees: neighbours(card.callees),
    };
  });
  const loc: BriefLocations = { files, symbols, truncated, ...(unresolved.length > 0 ? { unresolved_paths: unresolved } : {}) };
  return capToSize(loc, kept.map(rank), maxChars);
}

export const CONCEPTS_MAX_CHARS = 3000;
const MAX_CONCEPTS = 5;
const MAX_CONCEPT_ANCHORS = 5;
const CONCEPT_BODY_CHARS = 500;

export interface ConceptAnchor {
  ordinal: number;
  path: string;
  qualified_name: string;
  trust: string;
}

export interface BriefConcept {
  id: number;
  name: string;
  kind: string;
  status: string;
  status_reason: string | null;
  flagged: boolean;
  body: string;
  anchors: ConceptAnchor[];
}

export interface BriefConcepts {
  items: BriefConcept[];
  truncated: boolean;
}

// The L2 concepts whose steps anchor to the task: a step path under files[],
// a path locations names, or a (path, qualified_name) locations resolved.
// Retired concepts never show; suspect and broken ones follow verified ones,
// flagged, so they never read as fact.
export function briefConcepts(
  db: TrajectoryDB,
  repo: string,
  taskFiles: string[],
  locations: BriefLocations | null,
  maxChars: number = CONCEPTS_MAX_CHARS,
): BriefConcepts | null {
  if (!locations) return null;
  const namedPaths = new Set(locations.files.map((f) => f.path));
  const namedSymbols = new Set(locations.symbols.map((s) => `${s.path}\0${s.qualified_name}`));
  const rows = db.all<{
    concept_id: number;
    name: string;
    kind: string;
    status: string;
    status_reason: string | null;
    body: string;
    ordinal: number;
    path: string;
    qualified_name: string;
    trust: string;
  }>(
    `SELECT c.id AS concept_id, c.name, c.kind, c.status, c.status_reason, c.body,
            s.ordinal, s.path, s.qualified_name, s.trust
       FROM wm_concept_steps s JOIN wm_concepts c ON c.id = s.concept_id
      WHERE s.repo = ? AND c.repo = ? AND c.status <> 'retired'
      ORDER BY c.id, s.ordinal`,
    [repo, repo],
  );
  const matched = new Map<number, { row: (typeof rows)[number]; anchors: ConceptAnchor[] }>();
  for (const r of rows) {
    const hit =
      underFiles(r.path, taskFiles) || namedPaths.has(r.path) || (r.qualified_name !== '' && namedSymbols.has(`${r.path}\0${r.qualified_name}`));
    if (!hit) continue;
    const entry = matched.get(r.concept_id) ?? { row: r, anchors: [] };
    entry.anchors.push({ ordinal: Number(r.ordinal), path: r.path, qualified_name: r.qualified_name, trust: r.trust });
    matched.set(r.concept_id, entry);
  }
  const ranked = [...matched.values()].sort(
    (a, b) =>
      Number(a.row.status !== 'verified') - Number(b.row.status !== 'verified') ||
      b.anchors.length - a.anchors.length ||
      a.row.concept_id - b.row.concept_id,
  );
  const items = ranked.slice(0, MAX_CONCEPTS).map(
    ({ row, anchors }): BriefConcept => ({
      id: row.concept_id,
      name: row.name,
      kind: row.kind,
      status: row.status,
      status_reason: row.status_reason,
      flagged: row.status !== 'verified',
      body: frameUntrusted('concept-body', row.body.slice(0, CONCEPT_BODY_CHARS)),
      anchors: anchors.slice(0, MAX_CONCEPT_ANCHORS),
    }),
  );
  const out: BriefConcepts = { items, truncated: ranked.length > items.length };
  const fits = () => JSON.stringify(out).length <= maxChars;
  while (!fits() && out.items.length > 0) {
    out.items.pop();
    out.truncated = true;
  }
  return out;
}
