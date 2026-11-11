// The L1 symbol index (GH 1680): wm_symbols and wm_edges, written by
// scan_run and read by world_model_search and world_model_symbol. A file is
// re-parsed only when its symbols_md5 differs from content_md5 salted with
// EXTRACTOR_VERSION, so a version bump re-parses every file once. A file
// whose read or extraction throws loses its symbols, is stamped with
// FAILED_SUFFIX and is named in failed_paths; it is retried only when its
// content or the version changes (GH 1858). Calls
// resolve by import, same-file definition, sourced file or unique name, and a
// member call only to the method named by its receiver's type (GH 1838);
// resolution is a hint, never a guarantee every caller was found. Resolution
// passes adapted from the GH 1680 MVP. hooks/hooks.json is indexed as 'hook'
// rows (parsing/hooks.ts), and a pass re-resolves the non-exact edges of
// unchanged files that name a symbol this pass inserted or deleted (GH 1680). A
// generated bundle with a sibling source map gets a 'module' row of its own,
// re-read only when the map changes, with a 'bundles' edge to each in-repo
// source the map lists (GH 2284). A manifest, task file or CI file the env
// readers recognise is indexed as 'runner' rows with name-only 'covers' edges
// to the directories each command checks (parsing/runners.ts, GH 2326).
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join, posix } from 'node:path';
import { promisify } from 'node:util';
import type { TrajectoryDB } from './db.js';
import { loadParsers, type Parsers } from './parsing/loader.js';
import {
  extractFile,
  inSymbolScope,
  isGeneratedPath,
  languageOf,
  needsParser,
  splitWords,
  STOPWORDS,
  symbolTerms,
  clip,
  oneLine,
  type EdgeKind,
  type Extraction,
  type ExtractedEdge,
  type SourceLanguage,
  type SymbolKind,
} from './parsing/extract.js';
import { extractHooks, HOOKS_PATH, ROUTER_TABLE_PATH, ROUTER_TABLE_SOURCE } from './parsing/hooks.js';
import { extractRunners, repoPaths, type RepoPaths } from './parsing/runners.js';
import { envReaderFor } from './env/collect.js';
import type { KeywordMatch } from './graph.js';
import { isTestPath } from './utils/test-paths.js';

export const EXTRACTOR_VERSION = 15;
const MAX_PARSE_BYTES = 1_000_000;
const CARD_LIST_CAP = 50;
const execFileAsync = promisify(execFile);
export const IMPACT_REF_CAP = 200;
export const IMPACT_MAX_DEPTH = 5;
const OR_FALLBACK_MIN_HITS = 3;
export const FAILED_SUFFIX = ':failed';
export const FAILED_PATHS_CAP = 20;
const FAILED_ERROR_MAX = 200;

export interface FailedPath {
  path: string;
  error: string;
}

export interface SymbolIndexStats {
  files_parsed: number;
  files_failed: number;
  symbols: number;
  edges: number;
  edges_resolved: number;
  failed_paths?: FailedPath[];
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
  run_order: number | null;
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
  total: number;
  truncated: boolean;
}

export interface ImpactRef extends SymbolRef {
  via: 'call' | `table:${string}`;
}

export interface ImpactLevel {
  depth: number;
  refs: ImpactRef[];
  total: number;
}

export interface SymbolImpact {
  depth: number;
  levels: ImpactLevel[];
  tests: SymbolRef[];
  truncated: boolean;
}

export interface SymbolCard {
  symbol: SymbolRow & { stale: boolean };
  callers: RefList;
  callees: RefList;
  imports: RefList;
  reads_table: RefList;
  writes_table: RefList;
  tests: RefList;
  bundled_by: RefList;
  reads_config: ConfigKeyList;
  note?: string;
}

export interface ConfigKeyRef {
  key: string;
  line: number;
}

export interface ConfigKeyList {
  refs: ConfigKeyRef[];
  total: number;
  truncated: boolean;
}

export interface ConfigReader {
  qualified_name: string;
  kind: SymbolKind;
  repo: string;
  path: string;
  line: number;
}

export interface BundleMap {
  path: string;
  content_md5: string;
}

const SYMBOL_COLUMNS =
  's.id, s.repo, s.path, s.kind, s.qualified_name, s.signature, s.doc, s.start_line, s.end_line, s.body_hash, s.exported, s.run_order';

const CALLABLE = new Set<SymbolKind>(['function', 'method', 'class', 'sh_function']);
const TABLE_EDGES = new Set<EdgeKind>(['reads_table', 'writes_table', 'indexes', 'triggers_on']);
const TABLE_EDGES_JSON = JSON.stringify([...TABLE_EDGES]);
const CALL_EDGES: EdgeKind[] = ['calls', 'instantiates', 'runs', 'sources'];
// Edges stored by name alone (dst_id NULL, resolution 'name') that no
// resolution pass rebinds or resets: neither a plugin_config key nor a
// directory a runner covers is a symbol.
const NAME_ONLY_EDGES = new Set<EdgeKind>(['reads_config', 'covers']);
const NAME_ONLY_JSON = JSON.stringify([...NAME_ONLY_EDGES]);

// The concept lane (GH 1680): test and fixture paths never anchor a concept
// step or join a derived chain. A plain fixtures/ segment is in the test
// lane; its __fixtures__ variants are added here.
export function outsideConceptLane(path: string): boolean {
  return isTestPath(path) || /(^|\/)(__fixtures(__)?|fixtures__)\//.test(path);
}

function shortName(kind: SymbolKind, qualifiedName: string): string {
  return kind === 'method' ? qualifiedName.slice(qualifiedName.lastIndexOf('.') + 1) : qualifiedName;
}

// One wm_files row as the symbol pass sees it.
export interface IndexedFile {
  path: string;
  content_md5: string;
  size_bytes: number;
  symbols_md5: string | null;
}

type StaleFile = Omit<IndexedFile, 'symbols_md5'>;

interface Parsed {
  file: StaleFile;
  extraction: Extraction | null;
}

interface PendingEdge {
  rowid: number;
  from: string;
  edge: ExtractedEdge;
}

// The names an edge's dst_name can carry for a symbol: its short name, and
// for a module row its basename and repo-relative path.
function namesOf(kind: SymbolKind, qualifiedName: string, path: string): string[] {
  return kind === 'module' ? [basename(path), path] : [shortName(kind, qualifiedName)];
}

// A repo-relative path's text, or null when it cannot be read. The scan
// passes one over the git objects of the indexed commit (GH 2584).
export type SourceReader = (relPath: string) => Promise<string | null>;

export function diskReader(repoPath: string): SourceReader {
  return async (relPath) => {
    try {
      return readFileSync(join(repoPath, relPath), 'utf8');
    } catch {
      return null;
    }
  };
}

async function sourceLanguage(
  read: SourceReader,
  relPath: string,
  sizeBytes: number,
): Promise<{ lang: SourceLanguage | null; src?: string | null }> {
  if (sizeBytes > MAX_PARSE_BYTES) return { lang: null };
  let wantsHead = false;
  const byName = languageOf(relPath, () => {
    wantsHead = true;
    return '';
  });
  if (!wantsHead) return { lang: byName };
  const src = await read(relPath);
  return { lang: languageOf(relPath, () => (src ?? '').slice(0, 120)), src };
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
  readonly inserted = new Set<string>();
  readonly removed = new Set<string>();

  constructor(
    private readonly db: TrajectoryDB,
    private readonly repo: string,
  ) {}

  deleteFile(path: string): void {
    for (const n of deleteFileSymbols(this.db, this.repo, path)) this.removed.add(n);
  }

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
      const runOrder = s.run_order ?? null;
      if (!row) {
        for (const n of namesOf(s.kind, s.qualified_name, path)) this.inserted.add(n);
        return Number(
          this.db.run(
            `INSERT INTO wm_symbols (repo, path, kind, qualified_name, signature, doc, start_line, end_line, body_hash, exported, terms, run_order)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [this.repo, path, s.kind, s.qualified_name, s.signature, s.doc, s.start_line, s.end_line, s.body_hash, s.exported, terms, runOrder],
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
        row.terms !== terms ||
        (row.run_order === null ? null : Number(row.run_order)) !== runOrder;
      if (changed) {
        this.db.run(
          `UPDATE wm_symbols SET signature = ?, doc = ?, start_line = ?, end_line = ?, body_hash = ?, exported = ?, terms = ?, run_order = ? WHERE id = ?`,
          [s.signature, s.doc, s.start_line, s.end_line, s.body_hash, s.exported, terms, runOrder, row.id],
        );
      }
      return Number(row.id);
    });
    for (const gone of existing.values()) {
      for (const n of namesOf(gone.kind, gone.qualified_name, path)) this.removed.add(n);
      this.db.run(`DELETE FROM wm_symbols WHERE id = ?`, [gone.id]);
    }
    return extraction.edges.map((edge) => ({
      rowid: Number(
        this.db.run(`INSERT INTO wm_edges (src_id, dst_name, kind, resolution, line, hint) VALUES (?, ?, ?, ?, ?, ?)`, [
          ids[edge.src],
          edge.dst_name,
          edge.kind,
          NAME_ONLY_EDGES.has(edge.kind) ? 'name' : 'unresolved',
          edge.line,
          edge.hint,
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
  qualified_name: string;
}

class Resolver {
  private readonly byName = new Map<string, Candidate[]>();
  private readonly modules = new Map<string, number>();
  private readonly byBase = new Map<string, Candidate[]>();
  private readonly fileSet = new Set<string>();
  private readonly importMap = new Map<string, Map<string, string>>();
  private readonly sourced = new Map<string, string[]>();

  constructor(db: TrajectoryDB, repo: string, pending: Array<Pick<PendingEdge, 'from' | 'edge'>>) {
    for (const s of db.all<{ id: number; path: string; kind: SymbolKind; qualified_name: string }>(
      `SELECT id, path, kind, qualified_name FROM wm_symbols WHERE repo = ?`,
      [repo],
    )) {
      const c = { id: Number(s.id), path: s.path, kind: s.kind, qualified_name: s.qualified_name };
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
    if (NAME_ONLY_EDGES.has(edge.kind)) return null;
    if (edge.kind === 'imports') {
      const target = resolveImport(from, edge.hint, this.fileSet);
      if (!target) return null;
      const hit = (this.byName.get(edge.dst_name) ?? []).find((c) => c.path === target);
      const dst = hit?.id ?? this.modules.get(target);
      return dst === undefined ? null : { dst, how: 'exact' };
    }
    if (edge.kind === 'bundles') {
      const dst = this.modules.get(edge.dst_name);
      return dst === undefined ? null : { dst, how: 'exact' };
    }
    if (edge.kind === 'runs' || edge.kind === 'sources') {
      const byPath = edge.dst_name.includes('/') ? this.modules.get(edge.dst_name) : undefined;
      if (byPath !== undefined) return { dst: byPath, how: 'exact' };
      const cands = this.byBase.get(edge.dst_name) ?? [];
      const pick =
        cands.find((c) => posix.dirname(c.path) === posix.dirname(from)) ?? (cands.length === 1 ? cands[0] : undefined);
      return pick ? { dst: pick.id, how: cands.length === 1 ? 'exact' : 'name' } : null;
    }
    if (TABLE_EDGES.has(edge.kind)) {
      const cands = (this.byName.get(edge.dst_name) ?? []).filter((c) => c.kind === 'sql_table');
      const real = cands.filter((c) => !outsideConceptLane(c.path));
      if (real.length === 1) return { dst: real[0]!.id, how: 'exact' };
      const pick =
        real.find((c) => c.path.endsWith('.sql')) ??
        real[0] ??
        cands.find((c) => c.path.endsWith('.sql') && !isTestPath(c.path)) ??
        cands.find((c) => !isTestPath(c.path)) ??
        cands[0];
      return pick ? { dst: pick.id, how: 'name' } : null;
    }
    const cands = (this.byName.get(edge.dst_name) ?? []).filter((c) => CALLABLE.has(c.kind));
    const member = edge.hint !== null && edge.hint !== 'this';
    if (member) {
      const typed = cands.filter(
        (c) => c.kind === 'method' && !isTestPath(c.path) && c.qualified_name === `${edge.hint}.${edge.dst_name}`,
      );
      return typed.length === 1 ? { dst: typed[0]!.id, how: 'name' } : null;
    }
    const same = cands.find((c) => c.path === from);
    const viaImport = this.importMap.get(from)?.get(edge.dst_name);
    const viaSource = (this.sourced.get(from) ?? []).map((p) => cands.find((c) => c.path === p)).find(Boolean);
    if (same) return { dst: same.id, how: 'exact' };
    if (viaImport) {
      const hit = cands.find((c) => c.path === viaImport);
      if (hit) return { dst: hit.id, how: 'exact' };
    } else if (viaSource) return { dst: viaSource.id, how: 'exact' };
    const unique = cands.filter((c) => !isTestPath(c.path));
    return unique.length === 1 && edge.dst_name.length >= 4 ? { dst: unique[0]!.id, how: 'name' } : null;
  }
}

function push<V>(map: Map<string, V[]>, key: string, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

// An edge whose target was deleted (ON DELETE SET NULL) no longer resolves;
// a name-only edge never had a target and keeps its resolution.
export function markOrphanedEdges(db: TrajectoryDB): void {
  db.run(
    `UPDATE wm_edges SET resolution = 'unresolved'
      WHERE dst_id IS NULL AND resolution <> 'unresolved' AND kind NOT IN (SELECT value FROM json_each(?))`,
    [NAME_ONLY_JSON],
  );
}

// The names (namesOf) of the symbols stored under `paths`.
function storedNames(db: TrajectoryDB, repo: string, paths: Iterable<string>): string[] {
  return db
    .all<{ kind: SymbolKind; qualified_name: string; path: string }>(
      `SELECT kind, qualified_name, path FROM wm_symbols WHERE repo = ? AND path IN (SELECT value FROM json_each(?))`,
      [repo, JSON.stringify([...paths])],
    )
    .flatMap((s) => namesOf(s.kind, s.qualified_name, s.path));
}

export function deleteFileSymbols(db: TrajectoryDB, repo: string, path: string): string[] {
  const names = storedNames(db, repo, [path]);
  db.run(`DELETE FROM wm_symbols WHERE repo = ? AND path = ?`, [repo, path]);
  return names;
}

// The router table is a build artifact git does not track, so a commit read
// falls back to the built copy on disk, as the bundle maps do.
async function routerTable(read: SourceReader, repoPath: string): Promise<string> {
  return (await read(ROUTER_TABLE_PATH)) ?? (await diskReader(repoPath)(ROUTER_TABLE_PATH)) ?? '';
}

interface StoredEdge {
  rowid: number;
  path: string;
  kind: EdgeKind;
  dst_name: string;
  line: number;
  hint: string | null;
  resolution: string;
  dst_id: number | null;
}

const toPending = (r: StoredEdge): Pick<PendingEdge, 'from' | 'edge'> => ({
  from: r.path,
  edge: { src: 0, kind: r.kind, dst_name: r.dst_name, line: Number(r.line), hint: r.hint },
});

// The tables a non-exact table edge names that have exactly one sql_table
// definition outside test and fixture paths.
function soleTables(db: TrajectoryDB, repo: string): string[] {
  const real = new Map<string, number>();
  for (const s of db.all<{ qualified_name: string; path: string }>(
    `SELECT qualified_name, path FROM wm_symbols
      WHERE repo = ? AND kind = 'sql_table' AND qualified_name IN (
        SELECT e.dst_name FROM wm_edges e JOIN wm_symbols src ON src.id = e.src_id
         WHERE src.repo = ? AND e.resolution <> 'exact' AND e.kind IN (SELECT value FROM json_each(?)))`,
    [repo, repo, TABLE_EDGES_JSON],
  )) {
    if (!outsideConceptLane(s.path)) real.set(s.qualified_name, (real.get(s.qualified_name) ?? 0) + 1);
  }
  return [...real].filter(([, n]) => n === 1).map(([name]) => name);
}

// Files this pass did not re-parse keep their edges, so a caller of a symbol
// that was just added, moved into another file or re-created under a new kind
// stays unresolved, and one whose name a deletion left unique stays
// unresolved too. Re-run resolution, with each caller file's stored imports
// and sources as context, over the edges naming a symbol this pass inserted
// or deleted (`names`) that are not exact or lost their target, and over every
// edge whose target this pass deleted (dst_id cleared by ON DELETE SET NULL,
// resolution not yet reset). An edge that no longer resolves gets the value
// the first pass writes for an unresolvable edge (GH 2615).
// A table edge is exact only while its table has one definition outside test
// and fixture paths, so a table edge naming an inserted symbol is revisited
// even when exact, and a non-exact one whose table is now down to one such
// definition is revisited whatever pass removed the others.
function reresolveEdges(db: TrajectoryDB, repo: string, names: Set<string>, skip: Set<number>): number {
  const candidates = db
    .all<StoredEdge>(
      `SELECT e.rowid AS rowid, s.path, e.kind, e.dst_name, e.line, e.hint, e.resolution, e.dst_id
         FROM wm_edges e JOIN wm_symbols s ON s.id = e.src_id
        WHERE s.repo = ? AND e.kind NOT IN (SELECT value FROM json_each(?))
          AND ((e.dst_id IS NULL AND e.resolution <> 'unresolved')
            OR ((e.resolution <> 'exact' OR e.dst_id IS NULL OR e.kind IN (SELECT value FROM json_each(?)))
                AND e.dst_name IN (SELECT value FROM json_each(?)))
            OR (e.kind IN (SELECT value FROM json_each(?)) AND e.resolution <> 'exact'
                AND e.dst_name IN (SELECT value FROM json_each(?))))`,
      [repo, NAME_ONLY_JSON, TABLE_EDGES_JSON, JSON.stringify([...names]), TABLE_EDGES_JSON, JSON.stringify(soleTables(db, repo))],
    )
    .filter((r) => !skip.has(Number(r.rowid)));
  if (candidates.length === 0) return 0;
  const context = db.all<StoredEdge>(
    `SELECT e.rowid AS rowid, s.path, e.kind, e.dst_name, e.line, e.hint, e.resolution, e.dst_id
       FROM wm_edges e JOIN wm_symbols s ON s.id = e.src_id
      WHERE s.repo = ? AND e.kind IN ('imports', 'sources') AND s.path IN (SELECT value FROM json_each(?))`,
    [repo, JSON.stringify([...new Set(candidates.map((c) => c.path))])],
  );
  const resolver = new Resolver(db, repo, context.map(toPending));
  let resolved = 0;
  for (const c of candidates) {
    const { from, edge } = toPending(c);
    const target = resolver.resolve(from, edge) ?? { dst: null, how: NAME_ONLY_EDGES.has(edge.kind) ? 'name' : 'unresolved' };
    if (target.how === c.resolution && target.dst === (c.dst_id === null ? null : Number(c.dst_id))) continue;
    db.run(`UPDATE wm_edges SET dst_id = ?, resolution = ? WHERE rowid = ?`, [target.dst, target.how, c.rowid]);
    resolved++;
  }
  return resolved;
}

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

// The tracked source maps whose bundle (the map's path less '.map') is a
// tracked generated .js, .mjs or .cjs file.
export function bundleMaps(files: ReadonlyArray<{ path: string; content_md5: string }>): BundleMap[] {
  const tracked = new Set(files.map((f) => f.path));
  return files
    .filter((f) => {
      const bundle = f.path.slice(0, -'.map'.length);
      return f.path.endsWith('.map') && /\.[cm]?js$/.test(bundle) && isGeneratedPath(bundle) && tracked.has(bundle);
    })
    .map((f) => ({ path: f.path, content_md5: f.content_md5 }));
}

// The git-ignored source maps a build left on disk (dist/ is built, not
// committed: GH 2054) whose generated .js, .mjs or .cjs bundle is on disk too.
// A repo git cannot list yields none.
export async function builtBundleMaps(repoPath: string): Promise<BundleMap[]> {
  let listed: string;
  try {
    listed = (
      await execFileAsync(
        'git',
        ['-C', repoPath, 'ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--', ':(glob)**/*.map', ':(exclude,glob)**/node_modules/**'],
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
      )
    ).stdout;
  } catch {
    return [];
  }
  const maps: BundleMap[] = [];
  for (const path of listed.split('\0')) {
    const bundle = path.slice(0, -'.map'.length);
    if (!path.endsWith('.map') || !/\.[cm]?js$/.test(bundle) || !isGeneratedPath(bundle) || !existsSync(join(repoPath, bundle))) continue;
    const content_md5 = fileMd5(join(repoPath, path));
    if (content_md5) maps.push({ path, content_md5 });
  }
  return maps;
}

// The repo-relative paths an ECMA-426 source map lists in `sources`, each
// resolved against the map's directory plus its sourceRoot. A source under
// node_modules, outside the repo or behind a non-file URL is skipped.
export function bundleSources(mapPath: string, mapText: string, repoPath: string): string[] {
  const map = JSON.parse(mapText) as { sources?: unknown; sourceRoot?: unknown };
  if (!Array.isArray(map.sources)) return [];
  const root = typeof map.sourceRoot === 'string' ? map.sourceRoot.replace(/^file:\/\//, '') : '';
  if (URL_SCHEME.test(root)) return [];
  const repoRoot = posix.resolve(repoPath);
  const out = new Set<string>();
  for (const source of map.sources) {
    if (typeof source !== 'string' || !source) continue;
    const s = source.replace(/^file:\/\//, '');
    if (URL_SCHEME.test(s)) continue;
    const rel = posix.relative(repoRoot, posix.resolve(repoRoot, posix.dirname(mapPath), root, s));
    if (!rel || rel === '..' || rel.startsWith('../') || posix.isAbsolute(rel) || /(^|\/)node_modules\//.test(rel)) continue;
    out.add(rel);
  }
  return [...out];
}

function bundleExtraction(bundle: string, stamp: string, sources: string[]): Extraction {
  return {
    symbols: [
      {
        kind: 'module',
        qualified_name: bundle,
        signature: bundle,
        doc: `Generated bundle of ${sources.length} in-repo source(s), read from ${bundle}.map; rebuild it after editing one.`,
        start_line: 1,
        end_line: 1,
        body_hash: stamp,
        exported: 0,
      },
    ],
    edges: sources.map((s) => ({ src: 0, kind: 'bundles', dst_name: s, line: 1, hint: null })),
  };
}

interface BundlePass {
  write: Array<{ path: string; extraction: Extraction | null }>;
  gone: string[];
  failed: FailedPath[];
}

// The bundle rows to rewrite: a bundle whose module row is stamped with
// another map md5 or extractor version is re-read, one with no in-repo
// source (or an unreadable map) loses its row, and a bundle row whose map is
// no longer listed is gone. A path in `dropped` loses its rows before the
// pass is applied, so its stamp does not count.
async function readBundles(
  db: TrajectoryDB,
  repo: string,
  repoPath: string,
  maps: BundleMap[],
  version: string,
  read: SourceReader,
  dropped: ReadonlySet<string>,
): Promise<BundlePass> {
  const fromDisk = diskReader(repoPath);
  const stamps = new Map(
    db
      .all<{ path: string; body_hash: string }>(`SELECT path, body_hash FROM wm_symbols WHERE repo = ? AND kind = 'module'`, [repo])
      .filter((r) => isGeneratedPath(r.path) && !dropped.has(r.path))
      .map((r) => [r.path, r.body_hash]),
  );
  const pass: BundlePass = { write: [], gone: [], failed: [] };
  const listed = new Set<string>();
  for (const map of maps) {
    const bundle = map.path.slice(0, -'.map'.length);
    const stamp = `${map.content_md5}:${version}`;
    listed.add(bundle);
    if (stamps.get(bundle) === stamp) continue;
    try {
      const text = (await read(map.path)) ?? (await fromDisk(map.path));
      if (text === null) throw new Error(`cannot read ${map.path}`);
      const sources = bundleSources(map.path, text, repoPath);
      pass.write.push({ path: bundle, extraction: sources.length > 0 ? bundleExtraction(bundle, stamp, sources) : null });
    } catch (e) {
      pass.failed.push({ path: map.path, error: clip(oneLine(e instanceof Error ? e.message : String(e)), FAILED_ERROR_MAX) });
      pass.write.push({ path: bundle, extraction: null });
    }
  }
  pass.gone = [...stamps.keys()].filter((p) => !listed.has(p));
  return pass;
}

// Bring one repo's symbols up to date with its wm_files rows. The grammars
// load on the first call that has a stale TS/JS or shell file to parse. With
// bundleMaps (the scan's bundleMaps of the repo's tracked files) the bundle
// rows are brought up to date too; without it they are left as they are.
// `read` supplies each file's text: the scan's reader over the indexed
// commit, else the working tree.
export async function indexRepoSymbols(
  db: TrajectoryDB,
  repo: string,
  repoPath: string,
  extractorVersion: number = EXTRACTOR_VERSION,
  maps?: BundleMap[],
  read: SourceReader = diskReader(repoPath),
): Promise<SymbolIndexStats & { failed_paths: FailedPath[] }> {
  return applyRepoSymbols(db, await planRepoSymbols(db, repo, repoPath, extractorVersion, maps, read));
}

// What indexRepoSymbols writes, read and parsed with no write: applyRepoSymbols
// writes it synchronously, so a caller can read every blob first and then
// commit in one transaction with no await inside (GH 2584). `files` are the
// repo's wm_files rows as they will be when the plan is applied, for a caller
// whose file writes have not run yet; without it they are read from wm_files.
// `dropped` holds the names of the symbols stored under the wm_files rows
// `files` leaves out, which the caller's file writes delete.
export interface SymbolPlan {
  repo: string;
  version: string;
  parsed: Parsed[];
  failed: Array<{ file: StaleFile; error: string }>;
  bundles: BundlePass;
  dropped: string[];
}

function byPath(a: { path: string }, b: { path: string }): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

export async function planRepoSymbols(
  db: TrajectoryDB,
  repo: string,
  repoPath: string,
  extractorVersion: number = EXTRACTOR_VERSION,
  maps?: BundleMap[],
  read: SourceReader = diskReader(repoPath),
  files?: ReadonlyArray<IndexedFile>,
): Promise<SymbolPlan> {
  const version = String(extractorVersion);
  const stored = db.all<IndexedFile>(`SELECT path, content_md5, size_bytes, symbols_md5 FROM wm_files WHERE repo = ? ORDER BY path`, [repo]);
  const rows = files ? [...files].sort(byPath) : stored;
  const kept = new Set(rows.map((f) => f.path));
  const dropped = new Set(stored.map((f) => f.path).filter((p) => !kept.has(p)));
  const isStale = (f: IndexedFile): boolean =>
    f.symbols_md5 !== `${f.content_md5}:${version}` && f.symbols_md5 !== `${f.content_md5}:${version}${FAILED_SUFFIX}`;
  const stale: StaleFile[] = rows
    .filter((f) => isStale(f) && inSymbolScope(f.path))
    .map(({ path, content_md5, size_bytes }) => ({ path, content_md5, size_bytes }));
  if (stale.some((f) => f.path === ROUTER_TABLE_SOURCE) && !stale.some((f) => f.path === HOOKS_PATH)) {
    const hooksFile = rows.find((f) => f.path === HOOKS_PATH);
    if (hooksFile) stale.push({ path: hooksFile.path, content_md5: hooksFile.content_md5, size_bytes: hooksFile.size_bytes });
  }
  const jobs: Array<{ file: StaleFile; lang: SourceLanguage | null; src?: string | null }> = [];
  for (const f of stale) jobs.push({ file: f, ...(await sourceLanguage(read, f.path, Number(f.size_bytes))) });
  const parsers: Parsers | null = jobs.some((j) => j.lang !== null && needsParser(j.lang)) ? await loadParsers() : null;
  let router: string | null = null;

  let known: RepoPaths | null = null;
  const knownPaths = (): RepoPaths => (known ??= repoPaths([...kept]));

  const failed: Array<{ file: StaleFile; error: string }> = [];
  const parsed: Parsed[] = [];
  for (const { file, lang, src: head } of jobs) {
    const isHooks = file.path === HOOKS_PATH;
    const env = Number(file.size_bytes) > MAX_PARSE_BYTES ? null : envReaderFor(file.path);
    if (lang === null && !isHooks && !env) {
      parsed.push({ file, extraction: null });
      continue;
    }
    try {
      const src = head ?? (await read(file.path));
      if (src === null) throw new Error(`cannot read ${file.path}`);
      if (isHooks) router ??= await routerTable(read, repoPath);
      const extraction = isHooks
        ? extractHooks(src, router ?? '')
        : env
          ? extractRunners(file.path, env.reader(file.path, src), env.ci, knownPaths())
          : extractFile(parsers, file.path, lang as SourceLanguage, src);
      parsed.push({ file, extraction });
    } catch (e) {
      failed.push({ file, error: clip(oneLine(e instanceof Error ? e.message : String(e)), FAILED_ERROR_MAX) });
    }
  }
  const bundles: BundlePass = maps
    ? await readBundles(db, repo, repoPath, maps, version, read, dropped)
    : { write: [], gone: [], failed: [] };
  return { repo, version, parsed, failed, bundles, dropped: storedNames(db, repo, dropped) };
}

export function applyRepoSymbols(db: TrajectoryDB, plan: SymbolPlan): SymbolIndexStats & { failed_paths: FailedPath[] } {
  const { repo, version, parsed, failed, bundles, dropped } = plan;
  return db.transaction(() => {
    const writer = new SymbolWriter(db, repo);
    const pending: PendingEdge[] = [];
    let symbols = 0;
    for (const { file, extraction } of parsed) {
      if (extraction) {
        pending.push(...writer.writeFile(file.path, extraction));
        symbols += extraction.symbols.length;
      } else {
        writer.deleteFile(file.path);
      }
      db.run(`UPDATE wm_files SET symbols_md5 = content_md5 || ':' || ? WHERE repo = ? AND path = ?`, [version, repo, file.path]);
    }
    for (const { file } of failed) {
      writer.deleteFile(file.path);
      db.run(`UPDATE wm_files SET symbols_md5 = content_md5 || ':' || ? || ? WHERE repo = ? AND path = ?`, [
        version,
        FAILED_SUFFIX,
        repo,
        file.path,
      ]);
    }
    for (const { path, extraction } of bundles.write) {
      if (extraction) {
        pending.push(...writer.writeFile(path, extraction));
        symbols += extraction.symbols.length;
      } else {
        writer.deleteFile(path);
      }
    }
    for (const path of bundles.gone) writer.deleteFile(path);
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
    const touched = new Set([...writer.inserted, ...writer.removed, ...dropped]);
    resolved += reresolveEdges(db, repo, touched, new Set(pending.map((p) => p.rowid)));
    markOrphanedEdges(db);
    return {
      files_parsed: parsed.filter((p) => p.extraction !== null).length,
      files_failed: failed.length + bundles.failed.length,
      symbols,
      edges: pending.length,
      edges_resolved: resolved,
      failed_paths: [...failed.map(({ file, error }) => ({ path: file.path, error })), ...bundles.failed].slice(0, FAILED_PATHS_CAP),
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
    run_order: r.run_order === null || r.run_order === undefined ? null : Number(r.run_order),
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
  return { refs: refs.slice(0, CARD_LIST_CAP), total: refs.length, truncated: refs.length > CARD_LIST_CAP };
}

// A symbol card: who calls it, what it calls and imports, the tables it reads
// and writes (for a table, who reads and writes it), the tests that reference
// it, the bundles that inline its file and the plugin_config keys it reads.
export function symbolCard(db: TrajectoryDB, symbol: SymbolRow): SymbolCard {
  const inbound = db.all<EdgeEnd>(
    `SELECT e.kind AS edge_kind, e.resolution, o.id, o.qualified_name, o.kind, o.repo, o.path, o.start_line
       FROM wm_edges e JOIN wm_symbols o ON o.id = e.src_id
      WHERE e.dst_id = ?
      ORDER BY o.path, o.start_line`,
    [symbol.id],
  );
  const outbound = db.all<EdgeEnd & { dst_name: string; line: number | null }>(
    `SELECT e.kind AS edge_kind, e.resolution, e.dst_name, e.line, o.id, o.qualified_name, o.kind, o.repo, o.path, o.start_line
       FROM wm_edges e LEFT JOIN wm_symbols o ON o.id = e.dst_id
      WHERE e.src_id = ?
      ORDER BY e.line`,
    [symbol.id],
  );
  const bundlers = db.all<EdgeEnd>(
    `SELECT e.kind AS edge_kind, e.resolution, o.id, o.qualified_name, o.kind, o.repo, o.path, o.start_line
       FROM wm_symbols m JOIN wm_edges e ON e.dst_id = m.id AND e.kind = 'bundles' JOIN wm_symbols o ON o.id = e.src_id
      WHERE m.repo = ? AND m.path = ? AND m.kind = 'module'
      ORDER BY o.path`,
    [symbol.repo, symbol.path],
  );
  const isTable = symbol.kind === 'sql_table';
  const tableSide = isTable ? inbound : outbound;
  const of = (rows: EdgeEnd[], kinds: EdgeKind[]) => rows.filter((r) => kinds.includes(r.edge_kind));
  const stale = staleFiles(db, [symbol]);
  const card: SymbolCard = {
    symbol: { ...symbol, stale: stale.has(fileRefKey(symbol)) },
    callers: refList(of(inbound, CALL_EDGES).filter((r) => r.path !== null && !isTestPath(r.path))),
    callees: refList(of(outbound, CALL_EDGES)),
    imports: refList(of(symbol.kind === 'module' ? outbound : inbound, ['imports'])),
    reads_table: refList(of(tableSide, ['reads_table'])),
    writes_table: refList(of(tableSide, ['writes_table'])),
    tests: refList(inbound.filter((r) => r.edge_kind !== 'bundles' && r.path !== null && isTestPath(r.path))),
    bundled_by: refList(bundlers),
    reads_config: configKeyList(outbound.filter((r) => r.edge_kind === 'reads_config')),
  };
  const byName = [...inbound, ...outbound].some((r) => r.resolution !== 'exact' && !NAME_ONLY_EDGES.has(r.edge_kind));
  if (byName) card.note = 'found by name; not all callers';
  return card;
}

function configKeyList(rows: Array<{ dst_name: string; line: number | null }>): ConfigKeyList {
  const unique = new Map<string, ConfigKeyRef>();
  for (const r of rows) {
    const line = Number(r.line);
    unique.set(`${r.dst_name}\u0000${line}`, { key: r.dst_name, line });
  }
  const refs = [...unique.values()];
  return { refs: refs.slice(0, CARD_LIST_CAP), total: refs.length, truncated: refs.length > CARD_LIST_CAP };
}

// The symbols holding a SELECT that reads plugin_config key `key`, in the
// given repos, one row per reading line.
export function configKeyReaders(db: TrajectoryDB, repos: string[], key: string): ConfigReader[] {
  return db
    .all<ConfigReader>(
      `SELECT DISTINCT o.qualified_name, o.kind, o.repo, o.path, e.line
         FROM wm_edges e JOIN wm_symbols o ON o.id = e.src_id
        WHERE e.kind = 'reads_config' AND e.dst_name = ? AND o.repo IN (SELECT value FROM json_each(?))
        ORDER BY o.repo, o.path, e.line, o.qualified_name`,
      [key, JSON.stringify(repos)],
    )
    .map((r) => ({ qualified_name: r.qualified_name, kind: r.kind, repo: r.repo, path: r.path, line: Number(r.line) }));
}

export interface CoveringRunner {
  runner: string;
  path: string;
  line: number;
  command: string;
}

// The runners of a repo by the directory a 'covers' edge names, keyed by the
// world-model directory path ('' for the repo root).
export function coveringRunners(db: TrajectoryDB, repo: string): Map<string, CoveringRunner[]> {
  const out = new Map<string, CoveringRunner[]>();
  for (const r of db.all<{ dst_name: string; runner: string; path: string; line: number; command: string }>(
    `SELECT DISTINCT e.dst_name, s.qualified_name AS runner, s.path, e.line, s.signature AS command
       FROM wm_edges e JOIN wm_symbols s ON s.id = e.src_id
      WHERE s.repo = ? AND e.kind = 'covers'
      ORDER BY s.path, e.line, s.qualified_name`,
    [repo],
  )) {
    push(out, r.dst_name === '.' ? '' : r.dst_name, { runner: r.runner, path: r.path, line: Number(r.line), command: r.command });
  }
  return out;
}

interface ImpactRow extends EdgeEnd {
  table_name: string | null;
}

// Transitive inbound impact, breadth-first and grouped by hop: callers over
// CALL_EDGES (via 'call'), then readers of every table a walked symbol writes
// (via 'table:<name>'). A test-path source of any non-bundles edge into a
// walked symbol lands in tests and is not walked past; a test module that
// only imports is skipped when its file is already in tests. The visited set
// ends cycles; past IMPACT_REF_CAP refs the walk stops with truncated.
export function symbolImpact(db: TrajectoryDB, symbol: SymbolRow, depth: number): SymbolImpact {
  const visited = new Set<number>([symbol.id]);
  const testPaths = new Set<string>();
  const levels: ImpactLevel[] = [];
  const tests: SymbolRef[] = [];
  let total = 0;
  let truncated = false;
  let frontier = [symbol.id];
  for (let d = 1; d <= depth && frontier.length > 0 && !truncated; d++) {
    const ids = JSON.stringify(frontier);
    const callRows = db.all<ImpactRow>(
      `SELECT DISTINCT e.kind AS edge_kind, e.resolution, o.id, o.qualified_name, o.kind, o.repo, o.path, o.start_line, NULL AS table_name
         FROM wm_edges e JOIN wm_symbols o ON o.id = e.src_id
        WHERE e.dst_id IN (SELECT value FROM json_each(?)) AND e.kind != 'bundles'
        ORDER BY e.kind NOT IN (SELECT value FROM json_each(?)), o.path, o.start_line, o.id`,
      [ids, JSON.stringify(CALL_EDGES)],
    );
    const tableRows = db.all<ImpactRow>(
      `SELECT DISTINCT r.kind AS edge_kind, r.resolution, o.id, o.qualified_name, o.kind, o.repo, o.path, o.start_line, t.qualified_name AS table_name
         FROM wm_edges w
         JOIN wm_symbols t ON t.id = w.dst_id AND t.kind = 'sql_table'
         JOIN wm_edges r ON r.dst_id = t.id AND r.kind = 'reads_table'
         JOIN wm_symbols o ON o.id = r.src_id
        WHERE w.src_id IN (SELECT value FROM json_each(?)) AND w.kind = 'writes_table'
        ORDER BY t.qualified_name, o.path, o.start_line, o.id`,
      [ids],
    );
    const refs: ImpactRef[] = [];
    const next: number[] = [];
    for (const r of [...callRows, ...tableRows]) {
      const id = Number(r.id);
      if (visited.has(id)) continue;
      const isCall = CALL_EDGES.includes(r.edge_kind);
      const test = r.path !== null && isTestPath(r.path);
      const tableName = r.table_name;
      if (!test && !isCall && tableName === null) continue;
      if (test && !isCall && testPaths.has(r.path!)) continue;
      if (total >= IMPACT_REF_CAP) {
        truncated = true;
        break;
      }
      visited.add(id);
      total++;
      const ref: SymbolRef = {
        id,
        qualified_name: r.qualified_name!,
        kind: r.kind!,
        repo: r.repo!,
        path: r.path!,
        line_start: Number(r.start_line),
      };
      if (test) {
        tests.push(ref);
        testPaths.add(ref.path);
      } else {
        refs.push({ ...ref, via: tableName === null ? 'call' : `table:${tableName}` });
        next.push(id);
      }
    }
    if (refs.length > 0) levels.push({ depth: d, refs, total: refs.length });
    frontier = next;
  }
  return { depth, levels, tests, truncated };
}

export interface ChangedFile {
  path: string;
  content: string | null;
}

export interface ChangedSymbol extends SymbolRef {
  change: 'modified' | 'removed';
}

export interface DownstreamRef extends ImpactRef {
  from: number[];
}

export interface DiffDownstream {
  changed: ChangedSymbol[];
  added: Array<{ path: string; kind: SymbolKind; qualified_name: string }>;
  downstream: DownstreamRef[];
  tests: SymbolRef[];
  unparsed: string[];
  truncated: boolean;
}

function byPathLine<T extends { path: string; line_start: number; id: number }>(a: T, b: T): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : a.line_start - b.line_start || a.id - b.id;
}

function toRef(r: SymbolRow): SymbolRef {
  return { id: r.id, qualified_name: r.qualified_name, kind: r.kind, repo: r.repo, path: r.path, line_start: r.start_line };
}

function groupByKey<T extends { kind: SymbolKind; qualified_name: string; start_line: number }>(items: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of [...items].sort((a, b) => a.start_line - b.start_line)) push(groups, `${item.kind}\0${item.qualified_name}`, item);
  return groups;
}

// What a change set can break: each file re-extracted from the supplied
// content and matched to its indexed rows by (kind, qualified_name), then the
// depth-1 impact of every modified or removed symbol merged by id. A path given
// more than once counts once, with its last entry.
export async function diffDownstream(db: TrajectoryDB, repo: string, files: ChangedFile[]): Promise<DiffDownstream> {
  const lastByPath = new Map(files.map((f) => [f.path, f]));
  const jobs = [...lastByPath.values()].map((f) => {
    const rows = db
      .all<SymbolRow>(`SELECT ${SYMBOL_COLUMNS} FROM wm_symbols s WHERE s.repo = ? AND s.path = ?`, [repo, f.path])
      .map(normalizeRow);
    const lang =
      inSymbolScope(f.path) && (f.content === null || f.content.length <= MAX_PARSE_BYTES)
        ? languageOf(f.path, () => f.content ?? '')
        : null;
    return { file: f, rows, lang };
  });
  const parsers: Parsers | null = jobs.some((j) => j.file.content !== null && j.lang !== null && needsParser(j.lang))
    ? await loadParsers()
    : null;

  const changed: ChangedSymbol[] = [];
  const added: DiffDownstream['added'] = [];
  const unparsed: string[] = [];
  for (const { file, rows, lang } of jobs) {
    if (file.content === null) {
      if (rows.length === 0 && lang === null) unparsed.push(file.path);
      for (const r of rows) changed.push({ ...toRef(r), change: 'removed' });
      continue;
    }
    if (lang === null) {
      unparsed.push(file.path);
      continue;
    }
    let extraction: Extraction;
    try {
      extraction = extractFile(parsers, file.path, lang, file.content);
    } catch {
      unparsed.push(file.path);
      continue;
    }
    const fresh = groupByKey(extraction.symbols);
    for (const [key, indexed] of groupByKey(rows)) {
      const next = fresh.get(key) ?? [];
      indexed.forEach((r, i) => {
        const s = next[i];
        if (!s) changed.push({ ...toRef(r), change: 'removed' });
        else if (s.body_hash !== r.body_hash) changed.push({ ...toRef(r), change: 'modified' });
      });
      fresh.set(key, next.slice(indexed.length));
    }
    for (const rest of fresh.values()) for (const s of rest) added.push({ path: file.path, kind: s.kind, qualified_name: s.qualified_name });
  }

  const changedIds = new Set(changed.map((c) => c.id));
  const downstream = new Map<number, DownstreamRef>();
  const tests = new Map<number, SymbolRef>();
  let truncated = false;
  for (const c of changed) {
    const impact = symbolImpact(db, symbolById(db, c.id)!, 1);
    truncated ||= impact.truncated;
    for (const ref of impact.levels[0]?.refs ?? []) {
      if (changedIds.has(ref.id)) continue;
      const seen = downstream.get(ref.id);
      if (seen) {
        if (!seen.from.includes(c.id)) seen.from.push(c.id);
      } else downstream.set(ref.id, { ...ref, from: [c.id] });
    }
    for (const t of impact.tests) if (!tests.has(t.id)) tests.set(t.id, t);
  }
  return {
    changed: changed.sort(byPathLine),
    added,
    downstream: [...downstream.values()].sort(byPathLine),
    tests: [...tests.values()].sort(byPathLine),
    unparsed,
    truncated,
  };
}

export function symbolsStamp(contentMd5: string, extractorVersion: number = EXTRACTOR_VERSION): string {
  return `${contentMd5}:${extractorVersion}`;
}

export function fileRefKey(f: { repo: string; path: string }): string {
  return `${f.repo}\u0000${f.path}`;
}

function fileMd5(absPath: string): string | null {
  try {
    return createHash('md5').update(readFileSync(absPath)).digest('hex');
  } catch {
    return null;
  }
}

// The files, keyed by fileRefKey, whose indexed symbols no longer describe
// their wm_files row: symbols_md5 is not symbolsStamp(content_md5), or the row
// is gone. A generated bundle has no wm_files row and is never stale here.
// Whether the row itself trails the reader's target commit is the freshness
// check's call (world-model/freshness.ts, GH 2584), not this one's.
export function staleFiles(db: TrajectoryDB, files: Array<{ repo: string; path: string }>): Set<string> {
  const checked = new Map<string, boolean>();
  for (const f of files) {
    const key = fileRefKey(f);
    if (checked.has(key)) continue;
    const row = db.get<{ content_md5: string; symbols_md5: string | null }>(
      `SELECT content_md5, symbols_md5 FROM wm_files WHERE repo = ? AND path = ?`,
      [f.repo, f.path],
    );
    if (!row) {
      checked.set(key, !isGeneratedPath(f.path));
      continue;
    }
    checked.set(key, row.symbols_md5 !== symbolsStamp(row.content_md5));
  }
  return new Set([...checked].filter(([, stale]) => stale).map(([key]) => key));
}
