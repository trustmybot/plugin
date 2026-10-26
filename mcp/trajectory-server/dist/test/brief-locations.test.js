import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { briefLocations, extractSpecRefs, LOCATIONS_MAX_CHARS } from '../brief-locations.js';
import { compositeTools } from '../tools/composites.js';
import { tempDB } from './helpers.js';
const REPO = 'app';
function addFile(db, path, purpose) {
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    db.run(`INSERT INTO wm_files (repo, path, dir, purpose, updated_at) VALUES (?, ?, ?, ?, datetime('now'))`, [REPO, path, dir, purpose]);
    db.run(`INSERT INTO wm_symbols (repo, path, kind, qualified_name, start_line, end_line, body_hash) VALUES (?, ?, 'module', ?, 1, 1, 'h')`, [REPO, path, path]);
}
function addSymbol(db, path, kind, name, start, end) {
    db.run(`INSERT INTO wm_symbols (repo, path, kind, qualified_name, start_line, end_line, body_hash) VALUES (?, ?, ?, ?, ?, ?, 'h')`, [REPO, path, kind, name, start, end]);
    return db.get('SELECT last_insert_rowid() AS id').id;
}
function fixture() {
    const db = tempDB();
    addFile(db, 'mcp/server/src/tools/stats.ts', 'stats tool handlers');
    addFile(db, 'mcp/server/src/symbol-index.ts', 'the L1 symbol index');
    addFile(db, 'lib/other/stats.ts', 'another stats module');
    addFile(db, 'lib/other/helpers.ts', 'helpers');
    const statsTool = addSymbol(db, 'mcp/server/src/tools/stats.ts', 'function', 'statsTools', 10, 40);
    addSymbol(db, 'mcp/server/src/tools/stats.ts', 'function', 'formatRow', 50, 60);
    addSymbol(db, 'mcp/server/src/symbol-index.ts', 'class', 'SymbolIndex', 5, 90);
    const method = addSymbol(db, 'mcp/server/src/symbol-index.ts', 'method', 'SymbolIndex.lookup', 20, 35);
    addSymbol(db, 'mcp/server/src/symbol-index.ts', 'function', 'normalize', 100, 110);
    addSymbol(db, 'lib/other/helpers.ts', 'function', 'normalize', 3, 9);
    db.run(`INSERT INTO wm_edges (src_id, dst_id, dst_name, kind, resolution, line) VALUES (?, ?, 'SymbolIndex.lookup', 'calls', 'exact', 12)`, [
        statsTool,
        method,
    ]);
    return db;
}
const run = (db, spec, files = []) => {
    const loc = briefLocations(db, REPO, spec, files);
    assert.ok(loc, 'locations present on a seeded world model');
    return loc;
};
describe('brief locations (GH 1906)', () => {
    it('extracts path spans with line suffixes and identifier spans with ()', () => {
        const refs = extractSpecRefs('see `src/a.ts:12`, `src/b.ts:3-9`, `fn()`, `A.b` and `task_brief(section=core)`');
        assert.deepEqual(refs.paths, [
            { path: 'src/a.ts', start: 12, end: 12 },
            { path: 'src/b.ts', start: 3, end: 9 },
            { path: 'A.b' },
        ]);
        assert.deepEqual(refs.identifiers, ['fn', 'A.b']);
    });
    it('resolves an exact path with a line suffix to its purpose and non-module symbols in line order', () => {
        const db = fixture();
        const loc = run(db, 'Edit `mcp/server/src/symbol-index.ts:20`.');
        assert.deepEqual(loc.files, [
            {
                path: 'mcp/server/src/symbol-index.ts',
                purpose: 'the L1 symbol index',
                symbols: [
                    { qualified_name: 'SymbolIndex', kind: 'class', start_line: 5, end_line: 90 },
                    { qualified_name: 'SymbolIndex.lookup', kind: 'method', start_line: 20, end_line: 35 },
                    { qualified_name: 'normalize', kind: 'function', start_line: 100, end_line: 110 },
                ],
            },
        ]);
        assert.equal(loc.truncated, false);
        db.close();
    });
    it('resolves a unique suffix path and drops an ambiguous or unknown one', () => {
        const db = fixture();
        const loc = run(db, '`src/tools/stats.ts`, `stats.ts`, `nope/missing.ts`');
        assert.deepEqual(loc.files.map((f) => f.path), ['mcp/server/src/tools/stats.ts']);
        db.close();
    });
    it('resolves a Class.method identifier with its callers from wm_edges', () => {
        const db = fixture();
        const loc = run(db, 'Change `SymbolIndex.lookup`.');
        assert.deepEqual(loc.symbols, [
            {
                qualified_name: 'SymbolIndex.lookup',
                kind: 'method',
                path: 'mcp/server/src/symbol-index.ts',
                start_line: 20,
                end_line: 35,
                callers: [{ qualified_name: 'statsTools', path: 'mcp/server/src/tools/stats.ts', line_start: 10 }],
                callees: [],
            },
        ]);
        db.close();
    });
    it('resolves an fn() identifier and lists its callees', () => {
        const db = fixture();
        const loc = run(db, 'Call `statsTools()` here.');
        assert.equal(loc.symbols.length, 1);
        assert.equal(loc.symbols[0].qualified_name, 'statsTools');
        assert.deepEqual(loc.symbols[0].callees, [
            { qualified_name: 'SymbolIndex.lookup', path: 'mcp/server/src/symbol-index.ts', line_start: 20 },
        ]);
        db.close();
    });
    it('orders an ambiguous name toward the spec-named file, then files[] dirs', () => {
        const db = fixture();
        const named = run(db, 'In `lib/other/helpers.ts` fix `normalize`.');
        assert.deepEqual(named.symbols.map((s) => s.path), ['lib/other/helpers.ts', 'mcp/server/src/symbol-index.ts']);
        const scoped = run(db, 'Fix `normalize`.', ['mcp/server/src/']);
        assert.equal(scoped.symbols[0].path, 'mcp/server/src/symbol-index.ts');
        db.close();
    });
    it('drops an unknown name; nothing resolving gives empty lists', () => {
        const db = fixture();
        assert.deepEqual(run(db, 'Use `doesNotExist` and `Nope.either()`.'), { files: [], symbols: [], truncated: false });
        db.close();
    });
    it('is null with no world-model rows for the repo', () => {
        const db = tempDB();
        assert.equal(briefLocations(db, REPO, '`src/a.ts` `fn`', []), null);
        db.close();
    });
    it('caps the serialized size: per-file symbols go first, then trailing symbols, and truncated is set', () => {
        const db = fixture();
        const pad = 'x'.repeat(150);
        for (let i = 0; i < 25; i++) {
            addFile(db, `pkg/mod${i}/file${i}.ts`, 'p'.repeat(40));
            for (let j = 0; j < 12; j++)
                addSymbol(db, `pkg/mod${i}/file${i}.ts`, 'function', `fn_${i}_${j}_${pad}`, j * 10 + 1, j * 10 + 9);
        }
        const spec = Array.from({ length: 25 }, (_, i) => `\`pkg/mod${i}/file${i}.ts\` \`fn_${i}_0_${pad}\``).join(' ');
        const roomy = briefLocations(db, REPO, spec, [], 1_000_000);
        assert.equal(roomy.files.length, 10);
        assert.ok(roomy.files.every((f) => f.symbols.length === 12));
        assert.equal(roomy.symbols.length, 25);
        const symbolsOnly = JSON.stringify({ ...roomy, files: roomy.files.map((f) => ({ ...f, symbols: [] })) }).length;
        const oneList = JSON.stringify(roomy.files[0].symbols).length;
        const partial = briefLocations(db, REPO, spec, [], symbolsOnly + oneList);
        assert.equal(partial.truncated, true);
        assert.equal(partial.symbols.length, 25, 'top-level symbols kept while per-file lists can go');
        assert.equal(partial.files.at(-1).symbols.length, 0, 'per-file lists drop from the last file');
        assert.equal(partial.files[0].symbols.length, 12);
        const loc = run(db, spec);
        assert.ok(JSON.stringify(loc).length <= LOCATIONS_MAX_CHARS);
        assert.equal(loc.truncated, true);
        assert.equal(loc.files.length, 10);
        assert.ok(loc.files.every((f) => f.symbols.length === 0), 'per-file symbol lists dropped first');
        assert.ok(loc.symbols.length > 0 && loc.symbols.length < 25, 'then trailing symbols');
        assert.equal(loc.symbols[0].qualified_name, `fn_0_0_${pad}`, 'leading entries kept');
        db.close();
    });
    it('task_brief core and all carry locations end to end', async () => {
        const db = fixture();
        db.run(`INSERT INTO repos (name, path) VALUES (?, '/tmp/app')`, [REPO]);
        db.run(`INSERT INTO issues (id, objective, description, status, created_at, updated_at)
       VALUES (1, 'o', 'd', 'open', datetime('now'), datetime('now'))`);
        db.run(`INSERT INTO tasks (issue_id, branch_id, title, description, status, spec_body, files, verification, repo, created_at, updated_at)
       VALUES (1, 'perf/1-loc', 't', 'd', 'pending', ?, '[]', '[]', ?, datetime('now'), datetime('now'))`, ['## Description\nEdit `src/tools/stats.ts:12` and `SymbolIndex.lookup()`.\n', REPO]);
        const id = db.get('SELECT last_insert_rowid() AS id').id;
        const tools = compositeTools(db, '/tmp/.claude/tmb/trajectory.db', null);
        for (const section of ['core', 'all']) {
            const r = (await tools.handlers['task_brief']({ agent: 'swe', task_id: id, section }));
            const out = JSON.parse(r.content[0].text);
            assert.deepEqual(out.locations.files.map((f) => [f.path, f.purpose, f.symbols.map((s) => s.qualified_name)]), [['mcp/server/src/tools/stats.ts', 'stats tool handlers', ['statsTools', 'formatRow']]]);
            assert.deepEqual(out.locations.symbols.map((s) => [s.qualified_name, s.start_line, s.end_line, s.callers.length]), [['SymbolIndex.lookup', 20, 35, 1]]);
            if (section === 'core')
                assert.match(out.sections['core'], /locations/);
        }
        db.close();
    });
});
//# sourceMappingURL=brief-locations.test.js.map