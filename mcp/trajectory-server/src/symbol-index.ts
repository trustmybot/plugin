// The L1 symbol index (ADR 0001, GH 1680): wm_symbols and wm_edges, written by
// scan_run and read by world_model_search and world_model_symbol. A file is
// re-parsed only when its wm_files.content_md5 moved past symbols_md5. Calls
// resolve by import, same-file definition, sourced file or unique name;
// resolution is a hint, never a guarantee every caller was found. Resolution
// passes adapted from the GH 1680 MVP.
import { readFileSync } from 'node:fs';
import { basename, join, posix } from 'node:path';
import type { TrajectoryDB } from './db.js';
import { loadParsers, type Parsers } from './parsing/loader.js';
import {
  extractFile,
  inSymbolScope,
  languageOf,
  splitWords,
  STOPWORDS,
  symbolTerms,
  type EdgeKind,
  type Extraction,
  type ExtractedEdge,
  type SourceLanguage,
  type SymbolKind,
} from './parsing/extract.js';
import type { KeywordMatch } from './graph.js';

const MAX_PARSE_BYTES = 1_000_000;
const CARD_LIST_CAP = 50;
const OR_FALLBACK_MIN_HITS = 3;

export interface SymbolIndexStats {
  files_parsed: number;
  files_failed: number;
  symbols: number;
  edges: number;
  edges_resolved: number;
}

export interface SymbolRow {
  id: number;
  repo: string;
  path: string;
  kind: SymbolKind;
  qualified_name: string;
  signature: string;
  doc: string;
  start_line: number;
  end_line: number;
  body_hash: string;
  exported: number;
}

export interface SymbolRef {
  id: number;
  qualified_name: string;
  kind: SymbolKind;
  repo: string;
  path: string;
  line_start: number;
}

export interface RefList {
  refs: SymbolRef[];
  truncated: boolean;
}

export interface SymbolCard {
  symbol: SymbolRow;
  callers: RefList;
  callees: RefList;
  imports: RefList;
  reads_table: RefList;
  writes_table: RefList;
  tests: RefList;
  note?: string;
}

const SYMBOL_COLUMNS =
  's.id, s.repo, s.path, s.kind, s.qualified_name, s.signature, s.doc, s.start_line, s.end_line, s.body_hash, s.exported';

const CALLABLE = new Set<SymbolKind>(['function', 'method', 'class', 'sh_function']);
const TABLE_EDGES = new Set<EdgeKind>(['reads_table', 'writes_table', 'indexes', 'triggers_on']);
const CALL_EDGES: EdgeKind[] = ['calls', 'instantiates', 'runs', 'sources'];

export function isTestPath(path: string): boolean {
  return /(^|\/)(tests?|__tests__)\/|\.test\.[a-z]+$/.test(path);
}

function shortName(kind: SymbolKind, qualifiedName: string): string {
  return kind === 'method' ? qualifiedName.slice(qualifiedName.lastIndexOf('.') + 1) : qualifiedName;
}

interface StaleFile {
  id: number;
  path: string;
  content_md5: string;
}

interface Parsed {
  file: StaleFile;
  extraction: Extraction | null;
}

interface PendingEdge {
  rowid: number;
  from: string;
  edge: ExtractedEdge;
}

function readSource(repoPath: string, relPath: string): string {
  return readFileSync(join(repoPath, relPath), 'utf8');
}

function sourceLanguage(repoPath: string, relPath: string, sizeBytes: number): SourceLanguage | null {
  if (sizeBytes > MAX_PARSE_BYTES) return null;
  return languageOf(relPath, () => {
    try {
      return readSource(repoPath, relPath).slice(0, 120);
    } catch {
      return '';
    }
  });
}

// Resolve a relative import specifier against the importing file, trying the
// TS-on-disk forms of a '.js' specifier.
export function resolveImport(fromFile: string, spec: string | null, fileSet: Set<string>): string | null {
  if (!spec || !spec.startsWith('.')) return null;
  const base = posix.normalize(posix.join(posix.dirname(fromFile), spec));
  const stem = base.replace(/\.(m?js|ts)$/, '');
  for (const c of [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.js`, `${stem}.mjs`, `${stem}/index.ts`, `${stem}/index.js`]) {
    if (fileSet.has(c)) return c;
  }
  return null;
}

class SymbolWriter {
  constructor(
    private readonly db: TrajectoryDB,
    private readonly repo: string,
  ) {}

  // Upsert one file's symbols by (kind, qualified_name) so unchanged symbols
  // keep their ids, drop the ones that disappeared, and replace its edges.
  writeFile(path: string, extraction: Extraction): PendingEdge[] {
    const existing = new Map(
      this.db
        .all<SymbolRow & { terms: string }>(
          `SELECT ${SYMBOL_COLUMNS}, s.terms FROM wm_symbols s WHERE s.repo = ? AND s.path = ?`,
          [this.repo, path],
        )
        .map((r) => [`${r.kind}\u0000${r.qualified_name}`, r]),
    );
    this.db.run(
      `DELETE FROM wm_edges WHERE src_id IN (SELECT id FROM wm_symbols WHERE repo = ? AND path = ?)`,
      [this.repo, path],
    );
    const ids = extraction.symbols.map((s) => {
      const terms = symbolTerms(s.kind, s.qualified_name, path);
      const key = `${s.kind}\u0000${s.qualified_name}`;
      const row = existing.get(key);
      if (!row) {
        return Number(
          this.db.run(
            `INSERT INTO wm_symbols (repo, path, kind, qualified_name, signature, doc, start_line, end_line, body_hash, exported, terms)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [this.repo, path, s.kind, s.qualified_name, s.signature, s.doc, s.start_line, s.end_line, s.body_hash, s.exported, terms],
          ).lastInsertRowid,
        );
      }
      existing.delete(key);
      const changed =
        row.signature !== s.signature ||
        row.doc !== s.doc ||
        Number(row.start_line) !== s.start_line ||
        Number(row.end_line) !== s.end_line ||
        row.body_hash !== s.body_hash ||
        Number(row.exported) !== s.exported ||
        row.terms !== terms;
      if (changed) {
        this.db.run(
          `UPDATE wm_symbols SET signature = ?, doc = ?, start_line = ?, end_line = ?, body_hash = ?, exported = ?, terms = ? WHERE id = ?`,
          [s.signature, s.doc, s.start_line, s.end_line, s.body_hash, s.exported, terms, row.id],
        );
      }
      return Number(row.id);
    });
    for (const gone of existing.values()) this.db.run(`DELETE FROM wm_symbols WHERE id = ?`, [gone.id]);
    return extraction.edges.map((edge) => ({
      rowid: Number(
        this.db.run(`INSERT INTO wm_edges (src_id, dst_name, kind, resolution, line) VALUES (?, ?, ?, 'unresolved', ?)`, [
          ids[edge.src],
          edge.dst_name,
          edge.kind,
          edge.line,
        ]).lastInsertRowid,
      ),
      from: path,
      edge,
    }));
  }
}

interface Candidate {
  id: number;
  path: string;
  kind: SymbolKind;
}

class Resolver {
  private readonly byName = new Map<string, Candidate[]>();
  private readonly modules = new Map<string, number>();
  private readonly byBase = new Map<string, Candidate[]>();
  private readonly fileSet = new Set<string>();
  private readonly importMap = new Map<string, Map<string, string>>();
  private readonly sourced = new Map<string, string[]>();

  constructor(db: TrajectoryDB, repo: string, pending: PendingEdge[]) {
    for (const s of db.all<{ id: number; path: string; kind: SymbolKind; qualified_name: string }>(
      `SELECT id, path, kind, qualified_name FROM wm_symbols WHERE repo = ?`,
      [repo],
    )) {
      const c = { id: Number(s.id), path: s.path, kind: s.kind };
      if (s.kind === 'module') {
        this.modules.set(s.path, c.id);
        this.fileSet.add(s.path);
        push(this.byBase, basename(s.path), c);
      } else {
        push(this.byName, shortName(s.kind, s.qualified_name), c);
      }
    }
    for (const { from, edge } of pending) {
      if (edge.kind === 'imports') {
        const target = resolveImport(from, edge.hint, this.fileSet);
        if (target) {
          const m = this.importMap.get(from) ?? new Map<string, string>();
          m.set(edge.dst_name, target);
          this.importMap.set(from, m);
        }
      } else if (edge.kind === 'sources') {
        const cands = this.byBase.get(edge.dst_name) ?? [];
        const pick = cands.find((c) => posix.dirname(c.path) === posix.dirname(from)) ?? cands[0];
        if (pick) push(this.sourced, from, pick.path);
      }
    }
  }

  resolve(from: string, edge: ExtractedEdge): { dst: number; how: 'exact' | 'name' } | null {
    if (edge.kind === 'imports') {
      const target = resolveImport(from, edge.hint, this.fileSet);
      if (!target) return null;
      const hit = (this.byName.get(edge.dst_name) ?? []).find((c) => c.path === target);
      const dst = hit?.id ?? this.modules.get(target);
      return dst === undefined ? null : { dst, how: 'exact' };
    }
    if (edge.kind === 'runs' || edge.kind === 'sources') {
      const cands = this.byBase.get(edge.dst_name) ?? [];
      const pick =
        cands.find((c) => posix.dirname(c.path) === posix.dirname(from)) ?? (cands.length === 1 ? cands[0] : undefined);
      return pick ? { dst: pick.id, how: cands.length === 1 ? 'exact' : 'name' } : null;
    }
    if (TABLE_EDGES.has(edge.kind)) {
      const cands = (this.byName.get(edge.dst_name) ?? []).filter((c) => c.kind === 'sql_table');
      const pick =
        cands.find((c) => c.path.endsWith('.sql') && !isTestPath(c.path)) ??
        cands.find((c) => !isTestPath(c.path)) ??
        cands[0];
      return pick ? { dst: pick.id, how: 'name' } : null;
    }
    const cands = (this.byName.get(edge.dst_name) ?? []).filter((c) => CALLABLE.has(c.kind));
    const member = edge.hint !== null && edge.hint !== 'this';
    const same = cands.find((c) => c.path === from);
    const viaImport = this.importMap.get(from)?.get(edge.dst_name);
    const viaSource = (this.sourced.get(from) ?? []).map((p) => cands.find((c) => c.path === p)).find(Boolean);
    if (same && !member) return { dst: same.id, how: 'exact' };
    if (viaImport) {
      const hit = cands.find((c) => c.path === viaImport);
      if (hit) return { dst: hit.id, how: 'exact' };
    } else if (viaSource) return { dst: viaSource.id, how: 'exact' };
    const unique = cands.filter((c) => !isTestPath(c.path) && (!member || c.kind === 'method'));
    return unique.length === 1 && edge.dst_name.length >= 4 ? { dst: unique[0]!.id, how: 'name' } : null;
  }
}

function push<V>(map: Map<string, V[]>, key: string, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

// An edge whose target was deleted (ON DELETE SET NULL) no longer resolves.
export function markOrphanedEdges(db: TrajectoryDB): void {
  db.run(`UPDATE wm_edges SET resolution = 'unresolved' WHERE dst_id IS NULL AND resolution <> 'unresolved'`);
}

export function deleteFileSymbols(db: TrajectoryDB, repo: string, path: string): void {
  db.run(`DELETE FROM wm_symbols WHERE repo = ? AND path = ?`, [repo, path]);
}

// Bring one repo's symbols up to date with its wm_files rows. The grammars
// load on the first call that has a stale TS/JS or shell file to parse.
export async function indexRepoSymbols(db: TrajectoryDB, repo: string, repoPath: string): Promise<SymbolIndexStats> {
  const stale = db
    .all<StaleFile & { size_bytes: number }>(
      `SELECT id, path, content_md5, size_bytes FROM wm_files WHERE repo = ? AND symbols_md5 IS NOT content_md5 ORDER BY path`,
      [repo],
    )
    .filter((f) => inSymbolScope(f.path));
  const jobs = stale.map((f) => ({ file: f, lang: sourceLanguage(repoPath, f.path, Number(f.size_bytes)) }));
  const parsers: Parsers | null = jobs.some((j) => j.lang !== null && j.lang !== 'sql') ? await loadParsers() : null;

  let failed = 0;
  const parsed: Parsed[] = [];
  for (const { file, lang } of jobs) {
    if (lang === null) {
      parsed.push({ file, extraction: null });
      continue;
    }
    try {
      parsed.push({ file, extraction: extractFile(parsers, file.path, lang, readSource(repoPath, file.path)) });
    } catch {
      failed++;
    }
  }

  return db.transaction(() => {
    const writer = new SymbolWriter(db, repo);
    const pending: PendingEdge[] = [];
    let symbols = 0;
    for (const { file, extraction } of parsed) {
      if (extraction) {
        pending.push(...writer.writeFile(file.path, extraction));
        symbols += extraction.symbols.length;
      } else {
        deleteFileSymbols(db, repo, file.path);
      }
      db.run(`UPDATE wm_files SET symbols_md5 = content_md5 WHERE id = ?`, [file.id]);
    }
    let resolved = 0;
    if (pending.length > 0) {
      const resolver = new Resolver(db, repo, pending);
      for (const p of pending) {
        const hit = resolver.resolve(p.from, p.edge);
        if (!hit) continue;
        db.run(`UPDATE wm_edges SET dst_id = ?, resolution = ? WHERE rowid = ?`, [hit.dst, hit.how, p.rowid]);
        resolved++;
      }
    }
    markOrphanedEdges(db);
    return {
      files_parsed: parsed.filter((p) => p.extraction !== null).length,
      files_failed: failed,
      symbols,
      edges: pending.length,
      edges_resolved: resolved,
    };
  });
}

export type ScoredSymbol = SymbolRow & { score: number };

// The distinct non-stopword words of a query, each quoted for FTS5.
function queryWords(query: string): string[] {
  return [...new Set(splitWords(query).split(' ').filter((w) => w.length > 1 && !STOPWORDS.has(w)))];
}

// bm25 over wm_symbols_fts with a name match weighted above a signature or
// doc match: every word first, then any word when that finds fewer than 3.
// Module rows are left to the file hits. CROSS JOIN keeps the FTS match as the
// outer loop.
export function keywordSearchSymbols(
  db: TrajectoryDB,
  repo: string,
  query: string,
  limit: number,
): { hits: ScoredSymbol[]; match: KeywordMatch } {
  const words = queryWords(query);
  if (words.length === 0) return { hits: [], match: 'all_terms' };
  const search = (op: 'AND' | 'OR') =>
    db.all<SymbolRow & { rank: number }>(
      `SELECT ${SYMBOL_COLUMNS}, bm25(wm_symbols_fts, 10.0, 3.0, 4.0) AS rank
         FROM wm_symbols_fts CROSS JOIN wm_symbols s ON s.id = wm_symbols_fts.rowid
        WHERE wm_symbols_fts MATCH ? AND s.repo = ? AND s.kind <> 'module'
        ORDER BY rank, s.id
        LIMIT ?`,
      [words.map((w) => `"${w}"`).join(` ${op} `), repo, limit],
    );
  const all = search('AND');
  const toHit = (r: SymbolRow & { rank: number }): ScoredSymbol => ({ ...normalizeRow(r), score: -r.rank });
  if (all.length >= OR_FALLBACK_MIN_HITS || words.length < 2) return { hits: all.map(toHit), match: 'all_terms' };
  const seen = new Set(all.map((r) => r.id));
  const any = search('OR').filter((r) => !seen.has(r.id));
  return { hits: [...all, ...any].slice(0, limit).map(toHit), match: any.length > 0 ? 'any_term' : 'all_terms' };
}

function normalizeRow<T extends SymbolRow>(r: T): SymbolRow {
  return {
    id: Number(r.id),
    repo: r.repo,
    path: r.path,
    kind: r.kind,
    qualified_name: r.qualified_name,
    signature: r.signature,
    doc: r.doc,
    start_line: Number(r.start_line),
    end_line: Number(r.end_line),
    body_hash: r.body_hash,
    exported: Number(r.exported),
  };
}

export function symbolById(db: TrajectoryDB, id: number): SymbolRow | null {
  const row = db.get<SymbolRow>(`SELECT ${SYMBOL_COLUMNS} FROM wm_symbols s WHERE s.id = ?`, [id]);
  return row ? normalizeRow(row) : null;
}

// Symbols named qualifiedName in repo (optionally in one file), definitions
// before the per-file module row.
export function symbolsByName(db: TrajectoryDB, repo: string, qualifiedName: string, path?: string): SymbolRow[] {
  return db
    .all<SymbolRow>(
      `SELECT ${SYMBOL_COLUMNS} FROM wm_symbols s
        WHERE s.repo = ? AND s.qualified_name = ? AND (? IS NULL OR s.path = ?)
        ORDER BY s.kind = 'module', s.path, s.kind`,
      [repo, qualifiedName, path ?? null, path ?? null],
    )
    .map(normalizeRow);
}

interface EdgeEnd {
  edge_kind: EdgeKind;
  resolution: string;
  id: number | null;
  qualified_name: string | null;
  kind: SymbolKind | null;
  repo: string | null;
  path: string | null;
  start_line: number | null;
}

function refList(rows: EdgeEnd[]): RefList {
  const unique = new Map<number, SymbolRef>();
  for (const r of rows) {
    if (r.id === null || unique.has(Number(r.id))) continue;
    unique.set(Number(r.id), {
      id: Number(r.id),
      qualified_name: r.qualified_name!,
      kind: r.kind!,
      repo: r.repo!,
      path: r.path!,
      line_start: Number(r.start_line),
    });
  }
  const refs = [...unique.values()];
  return { refs: refs.slice(0, CARD_LIST_CAP), truncated: refs.length > CARD_LIST_CAP };
}

// A symbol card: who calls it, what it calls and imports, the tables it reads
// and writes (for a table, who reads and writes it) and the tests that
// reference it.
export function symbolCard(db: TrajectoryDB, symbol: SymbolRow): SymbolCard {
  const inbound = db.all<EdgeEnd>(
    `SELECT e.kind AS edge_kind, e.resolution, o.id, o.qualified_name, o.kind, o.repo, o.path, o.start_line
       FROM wm_edges e JOIN wm_symbols o ON o.id = e.src_id
      WHERE e.dst_id = ?
      ORDER BY o.path, o.start_line`,
    [symbol.id],
  );
  const outbound = db.all<EdgeEnd>(
    `SELECT e.kind AS edge_kind, e.resolution, o.id, o.qualified_name, o.kind, o.repo, o.path, o.start_line
       FROM wm_edges e LEFT JOIN wm_symbols o ON o.id = e.dst_id
      WHERE e.src_id = ?
      ORDER BY e.line`,
    [symbol.id],
  );
  const isTable = symbol.kind === 'sql_table';
  const tableSide = isTable ? inbound : outbound;
  const of = (rows: EdgeEnd[], kinds: EdgeKind[]) => rows.filter((r) => kinds.includes(r.edge_kind));
  const card: SymbolCard = {
    symbol,
    callers: refList(of(inbound, CALL_EDGES).filter((r) => r.path !== null && !isTestPath(r.path))),
    callees: refList(of(outbound, CALL_EDGES)),
    imports: refList(of(symbol.kind === 'module' ? outbound : inbound, ['imports'])),
    reads_table: refList(of(tableSide, ['reads_table'])),
    writes_table: refList(of(tableSide, ['writes_table'])),
    tests: refList(inbound.filter((r) => r.path !== null && isTestPath(r.path))),
  };
  if ([...inbound, ...outbound].some((r) => r.resolution !== 'exact')) card.note = 'found by name; not all callers';
  return card;
}
