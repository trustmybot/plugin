// The L1 symbol index (ADR 0001, GH 1680): wm_symbols and wm_edges, written by
// scan_run and read by world_model_search and world_model_symbol. A file is
// re-parsed only when its symbols_md5 differs from content_md5 salted with
// EXTRACTOR_VERSION, so a version bump re-parses every file once. A file
// whose read or extraction throws loses its symbols, is stamped with
// FAILED_SUFFIX and is named in failed_paths; it is retried only when its
// content or the version changes (GH 1858). Calls
// resolve by import, same-file definition, sourced file or unique name;
// resolution is a hint, never a guarantee every caller was found. Resolution
// passes adapted from the GH 1680 MVP. hooks/hooks.json is indexed as 'hook'
// rows (parsing/hooks.ts), and a pass re-resolves the non-exact edges of
// unchanged files that name a symbol this pass inserted (ADR 0002).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, join, posix } from 'node:path';
import { resolveSoleRepo } from './utils/repo-paths.js';
import { loadParsers } from './parsing/loader.js';
import { extractFile, inSymbolScope, languageOf, splitWords, STOPWORDS, symbolTerms, clip, oneLine, } from './parsing/extract.js';
import { dispatchChains, extractHooks, HOOKS_PATH, REGISTRATIONS_PATH } from './parsing/hooks.js';
export const EXTRACTOR_VERSION = 2;
const MAX_PARSE_BYTES = 1_000_000;
const CARD_LIST_CAP = 50;
export const IMPACT_REF_CAP = 200;
export const IMPACT_MAX_DEPTH = 5;
const OR_FALLBACK_MIN_HITS = 3;
export const FAILED_SUFFIX = ':failed';
export const FAILED_PATHS_CAP = 20;
const FAILED_ERROR_MAX = 200;
const SYMBOL_COLUMNS = 's.id, s.repo, s.path, s.kind, s.qualified_name, s.signature, s.doc, s.start_line, s.end_line, s.body_hash, s.exported, s.run_order';
const CALLABLE = new Set(['function', 'method', 'class', 'sh_function']);
const TABLE_EDGES = new Set(['reads_table', 'writes_table', 'indexes', 'triggers_on']);
const CALL_EDGES = ['calls', 'instantiates', 'runs', 'sources'];
export function isTestPath(path) {
    return /(^|\/)(tests?|__tests__)\/|\.test\.[a-z]+$/.test(path);
}
// The concept lane (ADR 0002): test and fixture paths never anchor a concept
// step or join a derived chain.
export function outsideConceptLane(path) {
    return isTestPath(path) || /(^|\/)(__)?fixtures(__)?\//.test(path);
}
function shortName(kind, qualifiedName) {
    return kind === 'method' ? qualifiedName.slice(qualifiedName.lastIndexOf('.') + 1) : qualifiedName;
}
// The names an edge's dst_name can carry for a symbol: its short name, and
// for a module row its basename and repo-relative path.
function namesOf(kind, qualifiedName, path) {
    return kind === 'module' ? [basename(path), path] : [shortName(kind, qualifiedName)];
}
function readSource(repoPath, relPath) {
    return readFileSync(join(repoPath, relPath), 'utf8');
}
function sourceLanguage(repoPath, relPath, sizeBytes) {
    if (sizeBytes > MAX_PARSE_BYTES)
        return null;
    return languageOf(relPath, () => {
        try {
            return readSource(repoPath, relPath).slice(0, 120);
        }
        catch {
            return '';
        }
    });
}
// Resolve a relative import specifier against the importing file, trying the
// TS-on-disk forms of a '.js' specifier.
export function resolveImport(fromFile, spec, fileSet) {
    if (!spec || !spec.startsWith('.'))
        return null;
    const base = posix.normalize(posix.join(posix.dirname(fromFile), spec));
    const stem = base.replace(/\.(m?js|ts)$/, '');
    for (const c of [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.js`, `${stem}.mjs`, `${stem}/index.ts`, `${stem}/index.js`]) {
        if (fileSet.has(c))
            return c;
    }
    return null;
}
class SymbolWriter {
    db;
    repo;
    inserted = new Set();
    constructor(db, repo) {
        this.db = db;
        this.repo = repo;
    }
    // Upsert one file's symbols by (kind, qualified_name) so unchanged symbols
    // keep their ids, drop the ones that disappeared, and replace its edges.
    writeFile(path, extraction) {
        const existing = new Map(this.db
            .all(`SELECT ${SYMBOL_COLUMNS}, s.terms FROM wm_symbols s WHERE s.repo = ? AND s.path = ?`, [this.repo, path])
            .map((r) => [`${r.kind}\u0000${r.qualified_name}`, r]));
        this.db.run(`DELETE FROM wm_edges WHERE src_id IN (SELECT id FROM wm_symbols WHERE repo = ? AND path = ?)`, [this.repo, path]);
        const ids = extraction.symbols.map((s) => {
            const terms = symbolTerms(s.kind, s.qualified_name, path);
            const key = `${s.kind}\u0000${s.qualified_name}`;
            const row = existing.get(key);
            const runOrder = s.run_order ?? null;
            if (!row) {
                for (const n of namesOf(s.kind, s.qualified_name, path))
                    this.inserted.add(n);
                return Number(this.db.run(`INSERT INTO wm_symbols (repo, path, kind, qualified_name, signature, doc, start_line, end_line, body_hash, exported, terms, run_order)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [this.repo, path, s.kind, s.qualified_name, s.signature, s.doc, s.start_line, s.end_line, s.body_hash, s.exported, terms, runOrder]).lastInsertRowid);
            }
            existing.delete(key);
            const changed = row.signature !== s.signature ||
                row.doc !== s.doc ||
                Number(row.start_line) !== s.start_line ||
                Number(row.end_line) !== s.end_line ||
                row.body_hash !== s.body_hash ||
                Number(row.exported) !== s.exported ||
                row.terms !== terms ||
                (row.run_order === null ? null : Number(row.run_order)) !== runOrder;
            if (changed) {
                this.db.run(`UPDATE wm_symbols SET signature = ?, doc = ?, start_line = ?, end_line = ?, body_hash = ?, exported = ?, terms = ?, run_order = ? WHERE id = ?`, [s.signature, s.doc, s.start_line, s.end_line, s.body_hash, s.exported, terms, runOrder, row.id]);
            }
            return Number(row.id);
        });
        for (const gone of existing.values())
            this.db.run(`DELETE FROM wm_symbols WHERE id = ?`, [gone.id]);
        return extraction.edges.map((edge) => ({
            rowid: Number(this.db.run(`INSERT INTO wm_edges (src_id, dst_name, kind, resolution, line, hint) VALUES (?, ?, ?, 'unresolved', ?, ?)`, [
                ids[edge.src],
                edge.dst_name,
                edge.kind,
                edge.line,
                edge.hint,
            ]).lastInsertRowid),
            from: path,
            edge,
        }));
    }
}
class Resolver {
    byName = new Map();
    modules = new Map();
    byBase = new Map();
    fileSet = new Set();
    importMap = new Map();
    sourced = new Map();
    constructor(db, repo, pending) {
        for (const s of db.all(`SELECT id, path, kind, qualified_name FROM wm_symbols WHERE repo = ?`, [repo])) {
            const c = { id: Number(s.id), path: s.path, kind: s.kind };
            if (s.kind === 'module') {
                this.modules.set(s.path, c.id);
                this.fileSet.add(s.path);
                push(this.byBase, basename(s.path), c);
            }
            else {
                push(this.byName, shortName(s.kind, s.qualified_name), c);
            }
        }
        for (const { from, edge } of pending) {
            if (edge.kind === 'imports') {
                const target = resolveImport(from, edge.hint, this.fileSet);
                if (target) {
                    const m = this.importMap.get(from) ?? new Map();
                    m.set(edge.dst_name, target);
                    this.importMap.set(from, m);
                }
            }
            else if (edge.kind === 'sources') {
                const cands = this.byBase.get(edge.dst_name) ?? [];
                const pick = cands.find((c) => posix.dirname(c.path) === posix.dirname(from)) ?? cands[0];
                if (pick)
                    push(this.sourced, from, pick.path);
            }
        }
    }
    resolve(from, edge) {
        if (edge.kind === 'imports') {
            const target = resolveImport(from, edge.hint, this.fileSet);
            if (!target)
                return null;
            const hit = (this.byName.get(edge.dst_name) ?? []).find((c) => c.path === target);
            const dst = hit?.id ?? this.modules.get(target);
            return dst === undefined ? null : { dst, how: 'exact' };
        }
        if (edge.kind === 'runs' || edge.kind === 'sources') {
            const byPath = edge.dst_name.includes('/') ? this.modules.get(edge.dst_name) : undefined;
            if (byPath !== undefined)
                return { dst: byPath, how: 'exact' };
            const cands = this.byBase.get(edge.dst_name) ?? [];
            const pick = cands.find((c) => posix.dirname(c.path) === posix.dirname(from)) ?? (cands.length === 1 ? cands[0] : undefined);
            return pick ? { dst: pick.id, how: cands.length === 1 ? 'exact' : 'name' } : null;
        }
        if (TABLE_EDGES.has(edge.kind)) {
            const cands = (this.byName.get(edge.dst_name) ?? []).filter((c) => c.kind === 'sql_table');
            const pick = cands.find((c) => c.path.endsWith('.sql') && !isTestPath(c.path)) ??
                cands.find((c) => !isTestPath(c.path)) ??
                cands[0];
            return pick ? { dst: pick.id, how: 'name' } : null;
        }
        const cands = (this.byName.get(edge.dst_name) ?? []).filter((c) => CALLABLE.has(c.kind));
        const member = edge.hint !== null && edge.hint !== 'this';
        const same = cands.find((c) => c.path === from);
        const viaImport = this.importMap.get(from)?.get(edge.dst_name);
        const viaSource = (this.sourced.get(from) ?? []).map((p) => cands.find((c) => c.path === p)).find(Boolean);
        if (same && !member)
            return { dst: same.id, how: 'exact' };
        if (viaImport) {
            const hit = cands.find((c) => c.path === viaImport);
            if (hit)
                return { dst: hit.id, how: 'exact' };
        }
        else if (viaSource)
            return { dst: viaSource.id, how: 'exact' };
        const unique = cands.filter((c) => !isTestPath(c.path) && (!member || c.kind === 'method'));
        return unique.length === 1 && edge.dst_name.length >= 4 ? { dst: unique[0].id, how: 'name' } : null;
    }
}
function push(map, key, value) {
    const list = map.get(key);
    if (list)
        list.push(value);
    else
        map.set(key, [value]);
}
// An edge whose target was deleted (ON DELETE SET NULL) no longer resolves.
export function markOrphanedEdges(db) {
    db.run(`UPDATE wm_edges SET resolution = 'unresolved' WHERE dst_id IS NULL AND resolution <> 'unresolved'`);
}
export function deleteFileSymbols(db, repo, path) {
    db.run(`DELETE FROM wm_symbols WHERE repo = ? AND path = ?`, [repo, path]);
}
function registrationChains(repoPath) {
    try {
        return dispatchChains(readSource(repoPath, REGISTRATIONS_PATH));
    }
    catch {
        return new Map();
    }
}
const toPending = (r) => ({
    from: r.path,
    edge: { src: 0, kind: r.kind, dst_name: r.dst_name, line: Number(r.line), hint: r.hint },
});
// Files this pass did not re-parse keep their edges, so a caller of a symbol
// that was just added, moved into another file or re-created under a new kind
// stays unresolved. Re-run resolution, with each caller file's stored imports
// and sources as context, over the edges naming an inserted symbol that are
// not exact or lost their target, and over every edge whose target this pass
// deleted (dst_id cleared by ON DELETE SET NULL, resolution not yet reset).
function reresolveEdges(db, repo, names, skip) {
    const candidates = db
        .all(`SELECT e.rowid AS rowid, s.path, e.kind, e.dst_name, e.line, e.hint, e.resolution, e.dst_id
         FROM wm_edges e JOIN wm_symbols s ON s.id = e.src_id
        WHERE s.repo = ?
          AND ((e.dst_id IS NULL AND e.resolution <> 'unresolved')
            OR ((e.resolution <> 'exact' OR e.dst_id IS NULL) AND e.dst_name IN (SELECT value FROM json_each(?))))`, [repo, JSON.stringify([...names])])
        .filter((r) => !skip.has(Number(r.rowid)));
    if (candidates.length === 0)
        return 0;
    const context = db.all(`SELECT e.rowid AS rowid, s.path, e.kind, e.dst_name, e.line, e.hint, e.resolution, e.dst_id
       FROM wm_edges e JOIN wm_symbols s ON s.id = e.src_id
      WHERE s.repo = ? AND e.kind IN ('imports', 'sources') AND s.path IN (SELECT value FROM json_each(?))`, [repo, JSON.stringify([...new Set(candidates.map((c) => c.path))])]);
    const resolver = new Resolver(db, repo, context.map(toPending));
    let resolved = 0;
    for (const c of candidates) {
        const { from, edge } = toPending(c);
        const hit = resolver.resolve(from, edge);
        if (!hit || (hit.how === c.resolution && hit.dst === (c.dst_id === null ? null : Number(c.dst_id))))
            continue;
        db.run(`UPDATE wm_edges SET dst_id = ?, resolution = ? WHERE rowid = ?`, [hit.dst, hit.how, c.rowid]);
        resolved++;
    }
    return resolved;
}
// Bring one repo's symbols up to date with its wm_files rows. The grammars
// load on the first call that has a stale TS/JS or shell file to parse.
export async function indexRepoSymbols(db, repo, repoPath, extractorVersion = EXTRACTOR_VERSION) {
    const version = String(extractorVersion);
    const stale = db
        .all(`SELECT id, path, content_md5, size_bytes FROM wm_files
        WHERE repo = ? AND symbols_md5 IS NOT content_md5 || ':' || ?
          AND symbols_md5 IS NOT content_md5 || ':' || ? || ? ORDER BY path`, [repo, version, version, FAILED_SUFFIX])
        .filter((f) => inSymbolScope(f.path));
    if (stale.some((f) => f.path === REGISTRATIONS_PATH) && !stale.some((f) => f.path === HOOKS_PATH)) {
        const hooksFile = db.get(`SELECT id, path, content_md5, size_bytes FROM wm_files WHERE repo = ? AND path = ?`, [repo, HOOKS_PATH]);
        if (hooksFile)
            stale.push(hooksFile);
    }
    const jobs = stale.map((f) => ({ file: f, lang: sourceLanguage(repoPath, f.path, Number(f.size_bytes)) }));
    const parsers = jobs.some((j) => j.lang !== null && j.lang !== 'sql') ? await loadParsers() : null;
    const failed = [];
    const parsed = [];
    for (const { file, lang } of jobs) {
        const isHooks = file.path === HOOKS_PATH;
        if (lang === null && !isHooks) {
            parsed.push({ file, extraction: null });
            continue;
        }
        try {
            const src = readSource(repoPath, file.path);
            const extraction = isHooks
                ? extractHooks(src, registrationChains(repoPath))
                : extractFile(parsers, file.path, lang, src);
            parsed.push({ file, extraction });
        }
        catch (e) {
            failed.push({ file, error: clip(oneLine(e instanceof Error ? e.message : String(e)), FAILED_ERROR_MAX) });
        }
    }
    return db.transaction(() => {
        const writer = new SymbolWriter(db, repo);
        const pending = [];
        let symbols = 0;
        for (const { file, extraction } of parsed) {
            if (extraction) {
                pending.push(...writer.writeFile(file.path, extraction));
                symbols += extraction.symbols.length;
            }
            else {
                deleteFileSymbols(db, repo, file.path);
            }
            db.run(`UPDATE wm_files SET symbols_md5 = content_md5 || ':' || ? WHERE id = ?`, [version, file.id]);
        }
        for (const { file } of failed) {
            deleteFileSymbols(db, repo, file.path);
            db.run(`UPDATE wm_files SET symbols_md5 = content_md5 || ':' || ? || ? WHERE id = ?`, [version, FAILED_SUFFIX, file.id]);
        }
        let resolved = 0;
        if (pending.length > 0) {
            const resolver = new Resolver(db, repo, pending);
            for (const p of pending) {
                const hit = resolver.resolve(p.from, p.edge);
                if (!hit)
                    continue;
                db.run(`UPDATE wm_edges SET dst_id = ?, resolution = ? WHERE rowid = ?`, [hit.dst, hit.how, p.rowid]);
                resolved++;
            }
        }
        resolved += reresolveEdges(db, repo, writer.inserted, new Set(pending.map((p) => p.rowid)));
        markOrphanedEdges(db);
        return {
            files_parsed: parsed.filter((p) => p.extraction !== null).length,
            files_failed: failed.length,
            symbols,
            edges: pending.length,
            edges_resolved: resolved,
            failed_paths: failed.slice(0, FAILED_PATHS_CAP).map(({ file, error }) => ({ path: file.path, error })),
        };
    });
}
// The distinct non-stopword words of a query, each quoted for FTS5.
function queryWords(query) {
    return [...new Set(splitWords(query).split(' ').filter((w) => w.length > 1 && !STOPWORDS.has(w)))];
}
// bm25 over wm_symbols_fts with a name match weighted above a signature or
// doc match: every word first, then any word when that finds fewer than 3.
// Module rows are left to the file hits. CROSS JOIN keeps the FTS match as the
// outer loop.
export function keywordSearchSymbols(db, repo, query, limit) {
    const words = queryWords(query);
    if (words.length === 0)
        return { hits: [], match: 'all_terms' };
    const search = (op) => db.all(`SELECT ${SYMBOL_COLUMNS}, bm25(wm_symbols_fts, 10.0, 3.0, 4.0) AS rank
         FROM wm_symbols_fts CROSS JOIN wm_symbols s ON s.id = wm_symbols_fts.rowid
        WHERE wm_symbols_fts MATCH ? AND s.repo = ? AND s.kind <> 'module'
        ORDER BY rank, s.id
        LIMIT ?`, [words.map((w) => `"${w}"`).join(` ${op} `), repo, limit]);
    const all = search('AND');
    const toHit = (r) => ({ ...normalizeRow(r), score: -r.rank });
    if (all.length >= OR_FALLBACK_MIN_HITS || words.length < 2)
        return { hits: all.map(toHit), match: 'all_terms' };
    const seen = new Set(all.map((r) => r.id));
    const any = search('OR').filter((r) => !seen.has(r.id));
    return { hits: [...all, ...any].slice(0, limit).map(toHit), match: any.length > 0 ? 'any_term' : 'all_terms' };
}
function normalizeRow(r) {
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
export function symbolById(db, id) {
    const row = db.get(`SELECT ${SYMBOL_COLUMNS} FROM wm_symbols s WHERE s.id = ?`, [id]);
    return row ? normalizeRow(row) : null;
}
// Symbols named qualifiedName in repo (optionally in one file), definitions
// before the per-file module row.
export function symbolsByName(db, repo, qualifiedName, path) {
    return db
        .all(`SELECT ${SYMBOL_COLUMNS} FROM wm_symbols s
        WHERE s.repo = ? AND s.qualified_name = ? AND (? IS NULL OR s.path = ?)
        ORDER BY s.kind = 'module', s.path, s.kind`, [repo, qualifiedName, path ?? null, path ?? null])
        .map(normalizeRow);
}
function refList(rows) {
    const unique = new Map();
    for (const r of rows) {
        if (r.id === null || unique.has(Number(r.id)))
            continue;
        unique.set(Number(r.id), {
            id: Number(r.id),
            qualified_name: r.qualified_name,
            kind: r.kind,
            repo: r.repo,
            path: r.path,
            line_start: Number(r.start_line),
        });
    }
    const refs = [...unique.values()];
    return { refs: refs.slice(0, CARD_LIST_CAP), total: refs.length, truncated: refs.length > CARD_LIST_CAP };
}
// A symbol card: who calls it, what it calls and imports, the tables it reads
// and writes (for a table, who reads and writes it) and the tests that
// reference it.
export function symbolCard(db, symbol) {
    const inbound = db.all(`SELECT e.kind AS edge_kind, e.resolution, o.id, o.qualified_name, o.kind, o.repo, o.path, o.start_line
       FROM wm_edges e JOIN wm_symbols o ON o.id = e.src_id
      WHERE e.dst_id = ?
      ORDER BY o.path, o.start_line`, [symbol.id]);
    const outbound = db.all(`SELECT e.kind AS edge_kind, e.resolution, o.id, o.qualified_name, o.kind, o.repo, o.path, o.start_line
       FROM wm_edges e LEFT JOIN wm_symbols o ON o.id = e.dst_id
      WHERE e.src_id = ?
      ORDER BY e.line`, [symbol.id]);
    const isTable = symbol.kind === 'sql_table';
    const tableSide = isTable ? inbound : outbound;
    const of = (rows, kinds) => rows.filter((r) => kinds.includes(r.edge_kind));
    const stale = staleFiles(db, [symbol]);
    const card = {
        symbol: { ...symbol, stale: stale.has(fileRefKey(symbol)) },
        callers: refList(of(inbound, CALL_EDGES).filter((r) => r.path !== null && !isTestPath(r.path))),
        callees: refList(of(outbound, CALL_EDGES)),
        imports: refList(of(symbol.kind === 'module' ? outbound : inbound, ['imports'])),
        reads_table: refList(of(tableSide, ['reads_table'])),
        writes_table: refList(of(tableSide, ['writes_table'])),
        tests: refList(inbound.filter((r) => r.path !== null && isTestPath(r.path))),
    };
    if ([...inbound, ...outbound].some((r) => r.resolution !== 'exact'))
        card.note = 'found by name; not all callers';
    return card;
}
// Transitive inbound callers over CALL_EDGES, breadth-first and grouped by
// hop. A test-path caller lands in tests and is not walked past; the visited
// set ends cycles; past IMPACT_REF_CAP refs the walk stops with truncated.
export function symbolImpact(db, symbol, depth) {
    const visited = new Set([symbol.id]);
    const levels = [];
    const tests = [];
    let total = 0;
    let truncated = false;
    let frontier = [symbol.id];
    for (let d = 1; d <= depth && frontier.length > 0 && !truncated; d++) {
        const rows = db.all(`SELECT DISTINCT e.kind AS edge_kind, e.resolution, o.id, o.qualified_name, o.kind, o.repo, o.path, o.start_line
         FROM wm_edges e JOIN wm_symbols o ON o.id = e.src_id
        WHERE e.dst_id IN (SELECT value FROM json_each(?)) AND e.kind IN (SELECT value FROM json_each(?))
        ORDER BY o.path, o.start_line, o.id`, [JSON.stringify(frontier), JSON.stringify(CALL_EDGES)]);
        const refs = [];
        const next = [];
        for (const r of rows) {
            const id = Number(r.id);
            if (visited.has(id))
                continue;
            if (total >= IMPACT_REF_CAP) {
                truncated = true;
                break;
            }
            visited.add(id);
            total++;
            const ref = {
                id,
                qualified_name: r.qualified_name,
                kind: r.kind,
                repo: r.repo,
                path: r.path,
                line_start: Number(r.start_line),
            };
            if (isTestPath(ref.path)) {
                tests.push(ref);
            }
            else {
                refs.push(ref);
                next.push(id);
            }
        }
        if (refs.length > 0)
            levels.push({ depth: d, refs });
        frontier = next;
    }
    return { depth, levels, tests, truncated };
}
export function symbolsStamp(contentMd5, extractorVersion = EXTRACTOR_VERSION) {
    return `${contentMd5}:${extractorVersion}`;
}
export function fileRefKey(f) {
    return `${f.repo}\u0000${f.path}`;
}
function fileMd5(absPath) {
    try {
        return createHash('md5').update(readFileSync(absPath)).digest('hex');
    }
    catch {
        return null;
    }
}
// The files, keyed by fileRefKey, whose indexed symbols no longer describe
// the disk: the file's md5 differs from wm_files.content_md5, symbols_md5 is
// not symbolsStamp(content_md5), or the file is gone. Each file is hashed once per call; a repo
// with no resolvable root cannot be checked and counts as fresh.
export function staleFiles(db, files) {
    const roots = new Map();
    const checked = new Map();
    for (const f of files) {
        const key = fileRefKey(f);
        if (checked.has(key))
            continue;
        if (!roots.has(f.repo))
            roots.set(f.repo, resolveSoleRepo(db, f.repo)?.path ?? null);
        const root = roots.get(f.repo);
        if (root === null) {
            checked.set(key, false);
            continue;
        }
        const row = db.get(`SELECT content_md5, symbols_md5 FROM wm_files WHERE repo = ? AND path = ?`, [f.repo, f.path]);
        const disk = fileMd5(join(root, f.path));
        checked.set(key, !row || disk === null || disk !== row.content_md5 || row.symbols_md5 !== symbolsStamp(row.content_md5));
    }
    return new Set([...checked].filter(([, stale]) => stale).map(([key]) => key));
}
//# sourceMappingURL=symbol-index.js.map