// Caller recall (GH 1988): callerRecall on a fixture project whose hand-made
// world model has one miss per class, the seeded sample's determinism, the
// wm-caller-recall CLI over a read-only fixture DB, and the server bundle
// staying free of the harness.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callerRecall, sampleSymbols } from '../caller-recall.js';
import { tempDB } from './helpers.js';
const SERVER_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(SERVER_ROOT, '..', '..', 'scripts', 'maintenance', 'wm-caller-recall.ts');
const FILES = {
    'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true }, include: ['src/**/*.ts'] }),
    'src/a.ts': ['export function alpha(): number {', '  return 1;', '}', ''].join('\n'),
    'src/b.ts': [
        "import { alpha } from './a.js';",
        'export function callsAlpha(): number {',
        '  return alpha();',
        '}',
        'export function alsoCallsAlpha(): number {',
        '  return alpha() + 1;',
        '}',
        'export function unresolvedCaller(): number {',
        '  return alpha() * 2;',
        '}',
        'export function wrongCaller(): number {',
        '  return alpha() * 3;',
        '}',
        '[1].map(() => alpha());',
        '',
    ].join('\n'),
    'src/c.ts': ["export function alpha(): string {", "  return 'other';", '}', ''].join('\n'),
    'src/d.ts': ['export function stranger(): number {', '  return 0;', '}', ''].join('\n'),
    'src/e.ts': [
        "import { alpha } from './a.js';",
        'export class Box {',
        '  open(): number {',
        '    return alpha();',
        '  }',
        '}',
        'export function useBox(): number {',
        '  const b: Box = new Box();',
        '  return b.open();',
        '}',
        '',
    ].join('\n'),
    'src/test/a.test.ts': ["import { alpha } from '../a.js';", 'alpha();', ''].join('\n'),
};
function seedWorldModel(db) {
    const ids = {};
    const sym = (key, path, kind, qualifiedName, start, end) => {
        db.run(`INSERT INTO wm_symbols (repo, path, kind, qualified_name, start_line, end_line, body_hash) VALUES ('fx', ?, ?, ?, ?, ?, 'h')`, [path, kind, qualifiedName, start, end]);
        ids[key] = db.get(`SELECT last_insert_rowid() AS id`).id;
    };
    for (const path of Object.keys(FILES).filter((p) => p.endsWith('.ts')))
        sym(`mod:${path}`, path, 'module', path, 1, null);
    sym('alpha', 'src/a.ts', 'function', 'alpha', 1, 3);
    sym('callsAlpha', 'src/b.ts', 'function', 'callsAlpha', 2, 4);
    sym('alsoCallsAlpha', 'src/b.ts', 'function', 'alsoCallsAlpha', 5, 7);
    sym('unresolvedCaller', 'src/b.ts', 'function', 'unresolvedCaller', 8, 10);
    sym('wrongCaller', 'src/b.ts', 'function', 'wrongCaller', 11, 13);
    sym('otherAlpha', 'src/c.ts', 'function', 'alpha', 1, 3);
    sym('stranger', 'src/d.ts', 'function', 'stranger', 1, 3);
    sym('Box', 'src/e.ts', 'class', 'Box', 2, 6);
    sym('Box.open', 'src/e.ts', 'method', 'Box.open', 3, 5);
    sym('useBox', 'src/e.ts', 'function', 'useBox', 7, 10);
    const edge = (src, dst, name, kind, resolution) => db.run(`INSERT INTO wm_edges (src_id, dst_id, dst_name, kind, resolution) VALUES (?, ?, ?, ?, ?)`, [
        ids[src],
        dst === null ? null : ids[dst],
        name,
        kind,
        resolution,
    ]);
    edge('mod:src/b.ts', 'alpha', 'alpha', 'imports', 'exact');
    edge('callsAlpha', 'alpha', 'alpha', 'calls', 'exact');
    edge('unresolvedCaller', null, 'alpha', 'calls', 'unresolved');
    edge('wrongCaller', 'otherAlpha', 'alpha', 'calls', 'name');
    edge('stranger', 'alpha', 'alpha', 'calls', 'name');
    edge('Box.open', 'alpha', 'alpha', 'calls', 'exact');
    edge('useBox', 'Box', 'Box', 'instantiates', 'exact');
    edge('useBox', 'Box.open', 'open', 'calls', 'name');
    edge('mod:src/test/a.test.ts', 'alpha', 'alpha', 'calls', 'exact');
    return ids;
}
describe('caller recall (GH 1988)', () => {
    let repoPath;
    let dbPath;
    let db;
    let ids;
    let report;
    before(() => {
        repoPath = mkdtempSync(join(tmpdir(), 'tmb-caller-recall-'));
        for (const [rel, text] of Object.entries(FILES)) {
            mkdirSync(dirname(join(repoPath, rel)), { recursive: true });
            writeFileSync(join(repoPath, rel), text);
        }
        dbPath = join(repoPath, 'fixture.db');
        db = tempDB({ path: dbPath });
        ids = seedWorldModel(db);
        report = callerRecall(db, { repo: 'fx', repoPath, sample: 100, seed: 1988 });
    });
    after(() => {
        db.close();
        rmSync(repoPath, { recursive: true, force: true });
    });
    it('GH 1988: SC1 reports truth, found, missed and extra per symbol and recall and precision over the sample', () => {
        assert.equal(report.candidates, 10);
        assert.deepEqual(report.skipped, []);
        const alpha = report.symbols.find((s) => s.id === ids.alpha);
        assert.equal(alpha.qualified_name, 'alpha');
        assert.equal(alpha.path, 'src/a.ts');
        assert.equal(alpha.truth, 6);
        assert.equal(alpha.found, 3);
        assert.equal(alpha.hit, 2);
        assert.deepEqual(alpha.missed.map((m) => m.id).sort((x, y) => Number(x) - Number(y)), [ids['mod:src/b.ts'], ids.alsoCallsAlpha, ids.unresolvedCaller, ids.wrongCaller].sort((x, y) => Number(x) - Number(y)));
        assert.deepEqual(alpha.extra.map((e) => e.id), [ids.stranger]);
        const box = report.symbols.find((s) => s.id === ids.Box);
        assert.deepEqual([box.truth, box.found, box.hit], [1, 1, 1], 'the type annotation `b: Box` is not a caller');
        const open = report.symbols.find((s) => s.id === ids['Box.open']);
        assert.deepEqual([open.truth, open.found, open.hit], [1, 1, 1]);
        assert.deepEqual({ truth: report.totals.truth, found: report.totals.found, hit: report.totals.hit }, { truth: 8, found: 6, hit: 4 });
        assert.equal(report.totals.recall, 0.5);
        assert.equal(report.totals.precision, 4 / 6);
    });
    it('GH 1988: SC2 classes each miss by rule and totals misses by class', () => {
        const alpha = report.symbols.find((s) => s.id === ids.alpha);
        const classOf = (id) => alpha.missed.find((m) => m.id === id).class;
        assert.equal(classOf(ids.unresolvedCaller), 'unresolved');
        assert.equal(classOf(ids.wrongCaller), 'wrong_target');
        assert.equal(classOf(ids['mod:src/b.ts']), 'caller_not_indexed');
        assert.equal(classOf(ids.alsoCallsAlpha), 'no_edge');
        assert.ok(alpha.extra.every((e) => e.class === 'false_edge'));
        const other = report.symbols.find((s) => s.id === ids.otherAlpha);
        assert.deepEqual(other.extra.map((e) => [e.id, e.class]), [[ids.wrongCaller, 'false_edge']]);
        assert.deepEqual(report.totals.misses_by_class, { unresolved: 1, wrong_target: 1, caller_not_indexed: 1, no_edge: 1 });
        assert.equal(report.totals.false_edges, 2);
    });
    it('GH 1988: SC4 the same DB, seed and size draw the same symbol ids', () => {
        const first = sampleSymbols(db, 'fx', 4, 1988).sample.map((s) => s.id);
        assert.equal(first.length, 4);
        assert.deepEqual(sampleSymbols(db, 'fx', 4, 1988).sample.map((s) => s.id), first);
        assert.deepEqual(callerRecall(db, { repo: 'fx', repoPath, sample: 4, seed: 1988 }).sampled_ids, first);
        const others = [1, 2, 3, 4, 5].map((seed) => sampleSymbols(db, 'fx', 4, seed).sample.map((s) => s.id).join(','));
        assert.ok(others.some((o) => o !== first.join(',')), 'a different seed draws a different sample');
    });
    it('GH 1988: SC3 the CLI prints the markdown report and --json from a read-only DB, and exits 2 on bad usage', () => {
        const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
        const md = run('--db', dbPath, '--repo', 'fx', '--repo-path', repoPath);
        assert.equal(md.status, 0, md.stderr);
        assert.match(md.stdout, /^## Method$/m);
        assert.match(md.stdout, /^- Recall: 50\.0% \(4 of 8 true callers found\)$/m);
        assert.match(md.stdout, /^- Precision: 66\.7% \(4 of 6 world-model callers true\)$/m);
        for (const c of ['unresolved', 'wrong_target', 'caller_not_indexed', 'no_edge'])
            assert.match(md.stdout, new RegExp(`^\\| ${c} \\| 1 \\|$`, 'm'));
        assert.match(md.stdout, /^### false_edge$/m);
        const json = run('--db', dbPath, '--repo', 'fx', '--repo-path', repoPath, '--sample', '4', '--seed', '1988', '--json');
        assert.equal(json.status, 0, json.stderr);
        assert.deepEqual(JSON.parse(json.stdout).sampled_ids, sampleSymbols(db, 'fx', 4, 1988).sample.map((s) => s.id));
        assert.equal(run('--bogus').status, 2);
        assert.equal(run('--db', dbPath, '--sample', 'many', '--repo-path', repoPath).status, 2);
        assert.equal(run('--db', join(repoPath, 'missing.db'), '--repo-path', repoPath).status, 2);
    });
    it('GH 1988: the server bundle carries neither the harness nor typescript', () => {
        const bundle = readFileSync(join(SERVER_ROOT, 'dist', 'index.js'), 'utf8');
        assert.ok(!bundle.includes('callerRecall'));
        assert.ok(!bundle.includes('findReferences'));
        assert.doesNotMatch(bundle, /from ["']typescript["']/);
    });
});
//# sourceMappingURL=caller-recall.test.js.map