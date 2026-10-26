// task_brief locations (GH 1906): the files and symbols a spec names in
// backticks, resolved against the world-model symbol index at read time so a
// swe reads by line range instead of whole files.
import type { TrajectoryDB } from './db.js';
import { symbolCard, symbolsByName, type RefList, type SymbolRow } from './symbol-index.js';
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
  qualified_name: string;
  kind: string;
  path: string;
  start_line: number;
  end_line: number;
  callers: Neighbour[];
  callees: Neighbour[];
}

export interface BriefLocations {
  files: FileLocation[];
  symbols: SymbolLocation[];
  truncated: boolean;
}

// Backtick spans of a spec: path-shaped spans (with an optional :L or :L-M)
// and identifier-shaped spans (with an optional trailing ()). A span such as
// `Class.method` matches both shapes; it is kept as both and resolves as
// whichever the index knows.
export function extractSpecRefs(spec: string): SpecRefs {
  const paths: PathRef[] = [];
  const identifiers: string[] = [];
  const seenPaths = new Set<string>();
  const seenIdents = new Set<string>();
  for (const m of spec.matchAll(SPAN_RE)) {
    const span = m[1]!.trim();
    const p = PATH_RE.exec(span);
    if (p) {
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

function capToSize(loc: BriefLocations, maxChars: number): BriefLocations {
  const fits = () => JSON.stringify(loc).length <= maxChars;
  if (fits()) return loc;
  loc.truncated = true;
  for (let i = loc.files.length - 1; i >= 0 && !fits(); i--) loc.files[i]!.symbols = [];
  while (!fits() && loc.symbols.length > 0) loc.symbols.pop();
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

  const refs = extractSpecRefs(spec);
  let truncated = false;
  const files: FileLocation[] = [];
  const named = new Set<string>();
  for (const ref of refs.paths) {
    const hit = resolvePath(db, repo, ref.path);
    if (!hit || named.has(hit.path)) continue;
    named.add(hit.path);
    if (files.length >= MAX_FILES) {
      truncated = true;
      continue;
    }
    files.push({ path: hit.path, purpose: hit.purpose ? frameUntrusted('file-purpose', hit.purpose) : '', symbols: fileSymbols(db, repo, hit.path, ref) });
  }

  const rank = (s: SymbolRow) => (named.has(s.path) ? 0 : underFiles(s.path, taskFiles) ? 1 : 2);
  const picked: SymbolRow[] = [];
  const seen = new Set<number>();
  for (const name of refs.identifiers) {
    const matches = symbolsByName(db, repo, name)
      .filter((s) => s.kind !== 'module' && !seen.has(s.id))
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
  const symbols = picked.slice(0, MAX_SYMBOLS).map((s): SymbolLocation => {
    const card = symbolCard(db, s);
    return {
      qualified_name: s.qualified_name,
      kind: s.kind,
      path: s.path,
      start_line: s.start_line,
      end_line: s.end_line,
      callers: neighbours(card.callers),
      callees: neighbours(card.callees),
    };
  });
  return capToSize({ files, symbols, truncated }, maxChars);
}
