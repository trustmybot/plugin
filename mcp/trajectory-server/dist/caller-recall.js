/**
 * Caller recall of the L1 symbol index (GH 1988): a seeded sample of one
 * repo's TS/TSX function, method and class symbols, each asked of the
 * TypeScript language service (findReferences) for its value references, and
 * those references, mapped to their innermost enclosing indexed symbol, set
 * against the symbol's world-model callers (the edge kinds and test-path
 * filter symbolCard uses for `callers`, uncapped). Each miss gets a class by
 * rule, each extra is a false_edge. Read-only: it reads the DB through `get`
 * and `all` and the repo through the language service host.
 * scripts/maintenance/wm-caller-recall.ts is its CLI. Neither the server entry
 * nor its bundle imports this module or typescript.
 */
import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { isTestPath } from './symbol-index.js';
import { projectRootFromDbPath } from './tools/containment.js';
export const MISS_CLASSES = ['unresolved', 'wrong_target', 'caller_not_indexed', 'no_edge'];
const CALL_EDGES = ['calls', 'instantiates', 'runs', 'sources'];
const SAMPLED_KINDS = ['function', 'method', 'class'];
const TS_SOURCE = /\.(ts|tsx|mts|cts)$/;
const DECLARATION_FILE = /\.d\.(ts|mts|cts)$/;
const DEFAULT_OPTIONS = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.Preserve,
    allowImportingTsExtensions: true,
    noEmit: true,
    skipLibCheck: true,
};
// mulberry32: a small seeded PRNG, so the same seed draws the same sample.
function seededRandom(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
// The candidates are the repo's non-test TS/TSX function, method and class
// rows in id order; a seeded Fisher-Yates shuffle picks `size` of them, and
// the pick is returned in id order.
export function sampleSymbols(db, repo, size, seed) {
    const rows = db
        .all(`SELECT id, qualified_name, kind, path, start_line, end_line FROM wm_symbols
        WHERE repo = ? AND kind IN (SELECT value FROM json_each(?)) ORDER BY id`, [repo, JSON.stringify(SAMPLED_KINDS)])
        .filter((r) => TS_SOURCE.test(r.path) && !DECLARATION_FILE.test(r.path) && !isTestPath(r.path))
        .map((r) => ({ ...r, id: Number(r.id), start_line: Number(r.start_line), end_line: Number(r.end_line) }));
    const random = seededRandom(seed);
    const pool = [...rows];
    const take = Math.min(Math.max(0, size), pool.length);
    for (let i = 0; i < take; i++) {
        const j = i + Math.floor(random() * (pool.length - i));
        [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return { candidates: rows.length, sample: pool.slice(0, take).sort((a, b) => a.id - b.id) };
}
// One language service per tsconfig.json: its root files are the config's own
// files plus every indexed TS file whose nearest tsconfig.json (searched from
// the file's directory up to the repo root) it is. Indexed files under no
// tsconfig share one service with DEFAULT_OPTIONS.
class Services {
    registry = ts.createDocumentRegistry();
    services = [];
    constructor(root, indexedFiles) {
        const groups = new Map();
        for (const rel of indexedFiles) {
            const abs = join(root, rel);
            if (!existsSync(abs))
                continue;
            const config = nearestTsconfig(root, dirname(abs));
            if (!groups.has(config))
                groups.set(config, new Set());
            groups.get(config).add(abs);
        }
        for (const [config, files] of [...groups].sort(([a], [b]) => String(a).localeCompare(String(b)))) {
            let options = DEFAULT_OPTIONS;
            if (config !== null) {
                const parsed = ts.getParsedCommandLineOfConfigFile(config, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => { } });
                if (parsed) {
                    options = { ...parsed.options, noEmit: true };
                    for (const f of parsed.fileNames)
                        files.add(resolve(f));
                }
            }
            this.services.push({ config, service: this.service(root, options, [...files].sort()) });
        }
    }
    service(root, options, rootFiles) {
        const host = {
            getCompilationSettings: () => options,
            getScriptFileNames: () => rootFiles,
            getScriptVersion: () => '0',
            getScriptSnapshot: (f) => {
                const text = ts.sys.readFile(f);
                return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
            },
            getCurrentDirectory: () => root,
            getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
            fileExists: ts.sys.fileExists,
            readFile: ts.sys.readFile,
            readDirectory: ts.sys.readDirectory,
            directoryExists: ts.sys.directoryExists,
            getDirectories: ts.sys.getDirectories,
            realpath: ts.sys.realpath,
        };
        return ts.createLanguageService(host, this.registry);
    }
}
function nearestTsconfig(root, dir) {
    for (let d = dir;; d = dirname(d)) {
        const candidate = join(d, 'tsconfig.json');
        if (existsSync(candidate))
            return candidate;
        if (d === root || dirname(d) === d || relative(root, d).startsWith('..'))
            return null;
    }
}
function shortName(qualifiedName) {
    return qualifiedName.slice(qualifiedName.lastIndexOf('.') + 1);
}
// The position of the declaration's name: the declaration named `name` whose
// name starts within [start_line, end_line], closest to start_line.
function declarationPosition(sf, sym) {
    const name = shortName(sym.qualified_name);
    let best = null;
    const consider = (pos) => {
        const line = sf.getLineAndCharacterOfPosition(pos).line + 1;
        if (line < sym.start_line || line > sym.end_line)
            return;
        const distance = line - sym.start_line;
        if (!best || distance < best.distance)
            best = { pos, distance };
    };
    const visit = (node) => {
        if (name === 'constructor' && ts.isConstructorDeclaration(node)) {
            consider(node.getStart(sf));
        }
        else if ((ts.isFunctionDeclaration(node) ||
            ts.isClassDeclaration(node) ||
            ts.isMethodDeclaration(node) ||
            ts.isGetAccessorDeclaration(node) ||
            ts.isSetAccessorDeclaration(node) ||
            ts.isVariableDeclaration(node)) &&
            node.name &&
            ts.isIdentifier(node.name) &&
            node.name.text === name) {
            consider(node.name.getStart(sf));
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
    return best?.pos ?? null;
}
function deepestNode(sf, pos) {
    let node = sf;
    for (;;) {
        const child = ts.forEachChild(node, (c) => (c.getStart(sf) <= pos && pos < c.getEnd() ? c : undefined));
        if (!child)
            return node;
        node = child;
    }
}
const ALIAS_DECLARATIONS = new Set([
    ts.SyntaxKind.ImportSpecifier,
    ts.SyntaxKind.ImportClause,
    ts.SyntaxKind.NamespaceImport,
    ts.SyntaxKind.ImportEqualsDeclaration,
    ts.SyntaxKind.ExportSpecifier,
]);
// A value reference: an identifier in code, not an import/export alias and not
// in a type position. `class X extends Y` is a value use of Y; `implements`
// and every other type node is not.
function isValueReference(sf, pos) {
    const node = deepestNode(sf, pos);
    if (!ts.isIdentifier(node) && !ts.isPrivateIdentifier(node) && node.kind !== ts.SyntaxKind.ConstructorKeyword)
        return false;
    for (let n = node.parent; n; n = n.parent) {
        if (ALIAS_DECLARATIONS.has(n.kind))
            return false;
        if (ts.isHeritageClause(n))
            return n.token === ts.SyntaxKind.ExtendsKeyword && ts.isClassLike(n.parent);
        if (ts.isTypeNode(n) && !ts.isExpressionWithTypeArguments(n))
            return false;
    }
    return true;
}
class CallerMap {
    db;
    repo;
    byPath = new Map();
    modules = new Map();
    constructor(db, repo) {
        this.db = db;
        this.repo = repo;
    }
    // The innermost indexed non-module symbol spanning the line (smallest span,
    // then latest start, then lowest id); else the file's module row; else an
    // unindexed ref (id null).
    enclosing(path, line) {
        if (!this.byPath.has(path)) {
            this.byPath.set(path, this.db
                .all(`SELECT id, qualified_name, kind, path, start_line, end_line FROM wm_symbols
              WHERE repo = ? AND path = ? AND kind != 'module' AND start_line IS NOT NULL AND end_line IS NOT NULL`, [this.repo, path])
                .map((r) => ({ ...r, id: Number(r.id), start_line: Number(r.start_line), end_line: Number(r.end_line) })));
        }
        let best = null;
        for (const s of this.byPath.get(path)) {
            if (s.start_line > line || s.end_line < line)
                continue;
            if (!best ||
                s.end_line - s.start_line < best.end_line - best.start_line ||
                (s.end_line - s.start_line === best.end_line - best.start_line &&
                    (s.start_line > best.start_line || (s.start_line === best.start_line && s.id < best.id)))) {
                best = s;
            }
        }
        if (best)
            return { id: best.id, qualified_name: best.qualified_name, path };
        return this.module(path) ?? { id: null, qualified_name: path, path };
    }
    module(path) {
        if (!this.modules.has(path)) {
            const row = this.db.get(`SELECT id, qualified_name FROM wm_symbols WHERE repo = ? AND path = ? AND kind = 'module'`, [this.repo, path]);
            this.modules.set(path, row ? { id: Number(row.id), qualified_name: row.qualified_name, path } : null);
        }
        return this.modules.get(path);
    }
    isModule(ref) {
        return ref.id === null || this.module(ref.path)?.id === ref.id;
    }
}
function worldModelCallers(db, id) {
    return db
        .all(`SELECT DISTINCT o.id, o.qualified_name, o.path
         FROM wm_edges e JOIN wm_symbols o ON o.id = e.src_id
        WHERE e.dst_id = ? AND e.kind IN (SELECT value FROM json_each(?))
        ORDER BY o.path, o.start_line, o.id`, [id, JSON.stringify(CALL_EDGES)])
        .map((r) => ({ ...r, id: Number(r.id) }))
        .filter((r) => !isTestPath(r.path));
}
// unresolved: the caller has a call edge to the name with no dst_id;
// wrong_target: it has one bound to a different symbol (GH 1838);
// caller_not_indexed: the reference sits in no indexed symbol but its module
// (GH 1970); no_edge: otherwise.
function classify(db, callers, target, caller) {
    if (caller.id !== null) {
        const name = shortName(target.qualified_name);
        const edges = db.all(`SELECT dst_id FROM wm_edges WHERE src_id = ? AND dst_name IN (?, ?) AND kind IN (SELECT value FROM json_each(?))`, [caller.id, name, target.qualified_name, JSON.stringify(CALL_EDGES)]);
        if (edges.some((e) => e.dst_id === null))
            return 'unresolved';
        if (edges.some((e) => e.dst_id !== null && Number(e.dst_id) !== target.id))
            return 'wrong_target';
    }
    if (callers.isModule(caller))
        return 'caller_not_indexed';
    return 'no_edge';
}
function ratio(n, d) {
    return d === 0 ? null : n / d;
}
export function callerRecall(db, opts) {
    const root = realpathSync(opts.repoPath);
    const roots = [...new Set([root, resolve(opts.repoPath)])];
    const toRepoPath = (fileName) => {
        const abs = resolve(fileName);
        for (const r of roots) {
            if (abs.startsWith(r + sep))
                return abs.slice(r.length + 1).split(sep).join('/');
        }
        return null;
    };
    const { candidates, sample } = sampleSymbols(db, opts.repo, opts.sample, opts.seed);
    const indexedFiles = db
        .all(`SELECT DISTINCT path FROM wm_symbols WHERE repo = ? ORDER BY path`, [opts.repo])
        .map((r) => r.path)
        .filter((p) => TS_SOURCE.test(p) && !DECLARATION_FILE.test(p));
    const services = new Services(root, indexedFiles);
    const callers = new CallerMap(db, opts.repo);
    const symbols = [];
    const skipped = [];
    for (const sym of sample) {
        const abs = join(root, sym.path);
        if (!existsSync(abs)) {
            skipped.push({ id: sym.id, qualified_name: sym.qualified_name, path: sym.path, reason: 'file_missing' });
            continue;
        }
        const truth = new Map();
        let located = false;
        const seen = new Set();
        for (const { service } of services.services) {
            const program = service.getProgram();
            const sf = program?.getSourceFile(abs);
            if (!program || !sf)
                continue;
            const pos = declarationPosition(sf, sym);
            if (pos === null)
                continue;
            located = true;
            for (const group of service.findReferences(abs, pos) ?? []) {
                for (const ref of group.references) {
                    const key = `${ref.fileName}\u0000${ref.textSpan.start}`;
                    if (ref.isDefinition || seen.has(key))
                        continue;
                    seen.add(key);
                    const path = toRepoPath(ref.fileName);
                    if (path === null || path.split('/').includes('node_modules') || isTestPath(path))
                        continue;
                    const refSf = program.getSourceFile(ref.fileName);
                    if (!refSf || !isValueReference(refSf, ref.textSpan.start))
                        continue;
                    const line = refSf.getLineAndCharacterOfPosition(ref.textSpan.start).line + 1;
                    const caller = callers.enclosing(path, line);
                    const callerKey = caller.id === null ? `path:${caller.path}` : String(caller.id);
                    const prior = truth.get(callerKey);
                    if (!prior || line < prior.line)
                        truth.set(callerKey, { ...caller, line });
                }
            }
        }
        if (!located) {
            skipped.push({ id: sym.id, qualified_name: sym.qualified_name, path: sym.path, reason: 'not_located' });
            continue;
        }
        const found = worldModelCallers(db, sym.id);
        const foundIds = new Set(found.map((f) => f.id));
        const missed = [...truth.values()]
            .filter((t) => t.id === null || !foundIds.has(t.id))
            .sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
            .map((t) => ({ ...t, class: classify(db, callers, sym, t) }));
        const extra = found.filter((f) => !truth.has(String(f.id))).map((f) => ({ ...f, class: 'false_edge' }));
        symbols.push({
            id: sym.id,
            qualified_name: sym.qualified_name,
            kind: sym.kind,
            path: sym.path,
            truth: truth.size,
            found: found.length,
            hit: truth.size - missed.length,
            missed,
            extra,
        });
    }
    const sum = (f) => symbols.reduce((n, s) => n + f(s), 0);
    const missesByClass = Object.fromEntries(MISS_CLASSES.map((c) => [c, 0]));
    for (const s of symbols)
        for (const m of s.missed)
            missesByClass[m.class]++;
    const hit = sum((s) => s.hit);
    return {
        repo: opts.repo,
        seed: opts.seed,
        sample_size: opts.sample,
        candidates,
        sampled_ids: sample.map((s) => s.id),
        tsconfigs: services.services.map((s) => (s.config === null ? '(none)' : (toRepoPath(s.config) ?? s.config))),
        symbols,
        skipped,
        totals: {
            measured: symbols.length,
            truth: sum((s) => s.truth),
            found: sum((s) => s.found),
            hit,
            recall: ratio(hit, sum((s) => s.truth)),
            precision: ratio(hit, sum((s) => s.found)),
            misses_by_class: missesByClass,
            false_edges: sum((s) => s.extra.length),
        },
    };
}
// The repo's on-disk path from its repos row, a relative path resolved against
// the project root the DB path implies.
export function repoPathFromDb(db, repo, dbPath) {
    const row = db.get(`SELECT path FROM repos WHERE name = ?`, [repo]);
    if (!row?.path)
        return null;
    if (isAbsolute(row.path))
        return row.path;
    const base = projectRootFromDbPath(dbPath);
    return base === null ? null : resolve(base, row.path);
}
const EXAMPLES_PER_CLASS = 5;
function pct(x) {
    return x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`;
}
export function formatCallerRecall(r) {
    const t = r.totals;
    const out = [
        `# World-model caller recall: repo \`${r.repo}\``,
        '',
        '## Method',
        '',
        `- Sample: ${r.sampled_ids.length} of ${r.candidates} non-test TS/TSX function, method and class symbols in \`wm_symbols\`, seed ${r.seed}; ${t.measured} measured, ${r.skipped.length} skipped${r.skipped.length ? ` (${r.skipped.map((s) => `${s.qualified_name}: ${s.reason}`).join(', ')})` : ''}.`,
        `- Truth: the TypeScript language service \`findReferences\` (one service per tsconfig: ${r.tsconfigs.map((c) => `\`${c}\``).join(', ')}), value references only (no declarations, import/export aliases or type positions), in non-test files, each mapped to its innermost enclosing indexed symbol (the module row at top level).`,
        '- Found: the symbol\'s world-model callers, `wm_edges` of kind calls, instantiates, runs or sources from a non-test path, uncapped.',
        '',
        '## Result',
        '',
        `- Recall: ${pct(t.recall)} (${t.hit} of ${t.truth} true callers found)`,
        `- Precision: ${pct(t.precision)} (${t.hit} of ${t.found} world-model callers true)`,
        '',
        '## Misses by class',
        '',
        '| class | count |',
        '|---|---|',
        ...MISS_CLASSES.map((c) => `| ${c} | ${t.misses_by_class[c]} |`),
        `| false_edge (extra) | ${t.false_edges} |`,
    ];
    const examples = (cls, rows) => {
        if (rows.length === 0)
            return;
        out.push('', `### ${cls}`, '');
        for (const { sym, ref } of rows.slice(0, EXAMPLES_PER_CLASS)) {
            const at = ref.line === undefined ? ref.path : `${ref.path}:${ref.line}`;
            out.push(`- \`${ref.qualified_name}\` (${at}) → \`${sym.qualified_name}\` (${sym.path})`);
        }
    };
    for (const c of MISS_CLASSES) {
        examples(c, r.symbols.flatMap((sym) => sym.missed.filter((m) => m.class === c).map((ref) => ({ sym, ref }))));
    }
    examples('false_edge', r.symbols.flatMap((sym) => sym.extra.map((ref) => ({ sym, ref }))));
    return `${out.join('\n')}\n`;
}
//# sourceMappingURL=caller-recall.js.map