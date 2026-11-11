import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { loadParsers, parserLoadCount } from '../parsing/loader.js';
import { builtBundleMaps, bundleMaps, bundleSources, EXTRACTOR_VERSION, FAILED_SUFFIX, indexRepoSymbols, markOrphanedEdges, symbolsStamp } from '../symbol-index.js';
import { DATA_CONTRACTS, IN_SYMBOL_SCOPE_SQL, isSqlContract } from '../data-contracts.js';
import { extractFile, inSymbolScope, isGeneratedPath, isBannerLine, isRuleLine, languageOf, needsParser, type SourceLanguage } from '../parsing/extract.js';
import { extractHooks } from '../parsing/hooks.js';
import { coveredDirs, repoPaths } from '../parsing/runners.js';
import { runDataContracts, trajectoryDbReader } from '../tools/trajectory-doctor.js';
import { frameUntrusted } from '../utils/untrusted.js';
import { WorldModelGraph, GraphHolder } from '../graph.js';
import { scanTools } from '../tools/scan.js';
import { resolveClaudeLogDir } from '../platform.js';
import { worldModelTools } from '../tools/world_model.js';
import type { TrajectoryDB } from '../db.js';
import { pinScanEnv, tempDB } from './helpers.js';

const scanPin = pinScanEnv();
const savedIndexTarget = process.env['TMB_WM_INDEX_TARGET'];
process.env['TMB_WM_INDEX_TARGET'] = 'HEAD';
after(() => {
  scanPin.restore();
  if (savedIndexTarget === undefined) delete process.env['TMB_WM_INDEX_TARGET'];
  else process.env['TMB_WM_INDEX_TARGET'] = savedIndexTarget;
});

const WORKTREE = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, '');

type Payload = Record<string, unknown>;

function parse<T = Payload>(r: CallToolResult): T {
  assert.ok(!r.isError, (r.content[0] as { text: string }).text);
  return JSON.parse((r.content[0] as { text: string }).text) as T;
}

interface ScanPayload {
  repos: Array<{ name: string }>;
  symbols: { files_parsed: number; files_failed: number; symbols: number; edges: number; edges_resolved: number };
}

async function scan(db: TrajectoryDB, holder: GraphHolder, sessionDir: string): Promise<ScanPayload> {
  return parse<ScanPayload>(
    (await scanTools(db, holder, ':memory:').handlers['scan_run']!({ agent: 'bro', session_dir: sessionDir })) as CallToolResult,
  );
}

function symbolRows(db: TrajectoryDB, repo: string): Payload[] {
  return db
    .all<Payload>(
      `SELECT id, path, kind, qualified_name, signature, doc, start_line, end_line, body_hash, exported
         FROM wm_symbols WHERE repo = ? ORDER BY id`,
      [repo],
    )
    .map((r) => ({ ...r }));
}

function edgeRows(db: TrajectoryDB, repo: string): Payload[] {
  return db
    .all<Payload>(
      `SELECT s.path, e.src_id, e.dst_id, e.dst_name, e.kind, e.resolution, e.line
         FROM wm_edges e JOIN wm_symbols s ON s.id = e.src_id
        WHERE s.repo = ?
        ORDER BY e.rowid`,
      [repo],
    )
    .map((r) => ({ ...r }));
}

const EVAL: Array<[string, string, string[]]> = [
  [
    'Q1',
    'where the database journal mode WAL is set when opening the trajectory DB and schema version is checked',
    ['mcp/trajectory-server/src/db.ts'],
  ],
  ['Q3', 'embeddings degraded episode recovered audit event health', ['mcp/trajectory-server/src/embeddings/health.ts']],
  ['Q5', 'cheatcode_install skill install result installed method', ['mcp/trajectory-server/src/tools/cheatcode.ts']],
  [
    'H2',
    'Python hidden-write guard: aliasing a write builtin (o = open; o(...)) is denied with the wrong "process call" message',
    ['mcp/trajectory-server/src/hooks/containment-guard.ts', 'mcp/trajectory-server/src/hooks/cmd-analysis/prog-calls.ts'],
  ],
  [
    'H4',
    'Recovery fallback broSqliteReadonly fails silently: issue_get/issue_resume/config_get query columns that no longer exist',
    ['mcp/trajectory-server/src/cli/bro-sqlite-readonly.ts'],
  ],
];

describe('L1 symbol index over this worktree (GH 1680)', () => {
  const db = tempDB();
  const holder = GraphHolder.fixed(new WorldModelGraph(db));
  let repo = '';
  let first: ScanPayload;

  before(async () => {
    assert.equal(parserLoadCount(), 0, 'no grammar loads before the first index call');
    first = await scan(db, holder, WORKTREE);
    repo = first.repos[0]!.name;
  });

  after(() => db.close());

  it('loads the grammars once, on the first index call', () => {
    assert.equal(parserLoadCount(), 1);
  });

  it('indexes symbols and resolves calls', () => {
    const count = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM wm_symbols WHERE repo = ?`, [repo])!.n;
    assert.ok(count > 0, 'wm_symbols has rows');
    assert.ok(first.symbols.files_parsed > 0 && first.symbols.edges_resolved > 0, JSON.stringify(first.symbols));
    const exactCalls = db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM wm_edges WHERE kind = 'calls' AND resolution = 'exact'`,
    )!.n;
    assert.ok(exactCalls > 0, 'calls edges resolve exactly');
    const badExact = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM wm_edges WHERE resolution = 'exact' AND dst_id IS NULL`)!.n;
    const badUnresolved = db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM wm_edges WHERE resolution = 'unresolved' AND dst_id IS NOT NULL`,
    )!.n;
    assert.equal(badExact, 0, 'an exact edge always has a dst_id');
    assert.equal(badUnresolved, 0, 'an unresolved edge never has a dst_id');
  });

  it('stamps symbols_md5 with content_md5 and EXTRACTOR_VERSION for every indexed .ts file', () => {
    const rows = db.all<{ path: string; content_md5: string; symbols_md5: string | null }>(
      `SELECT path, content_md5, symbols_md5 FROM wm_files WHERE repo = ? AND path LIKE '%.ts' AND path NOT LIKE '%dist/%'`,
      [repo],
    );
    assert.ok(rows.length > 0);
    for (const r of rows) assert.equal(r.symbols_md5, `${r.content_md5}:${EXTRACTOR_VERSION}`, r.path);
  });

  it('a rescan of an unchanged tree parses nothing and keeps every id', async () => {
    const before = symbolRows(db, repo);
    const second = await scan(db, holder, WORKTREE);
    assert.equal(second.symbols.files_parsed, 0);
    assert.deepEqual(symbolRows(db, repo), before);
  });

  it('the inline task_reopen handler in composites.ts is a tool:task_reopen symbol calling runEnvGate (GH 1970)', () => {
    const row = db.get<{ id: number; path: string; kind: string }>(
      `SELECT id, path, kind FROM wm_symbols WHERE repo = ? AND qualified_name = 'tool:task_reopen'`,
      [repo],
    );
    assert.ok(row, 'tool:task_reopen is indexed');
    assert.equal(row.path, 'mcp/trajectory-server/src/tools/composites.ts');
    assert.equal(row.kind, 'function');
    const n = db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM wm_edges WHERE src_id = ? AND kind = 'calls' AND dst_name = 'runEnvGate'`,
      [row.id],
    )!.n;
    assert.ok(n >= 1, 'tool:task_reopen calls runEnvGate');
    const caller = db.get<{ qualified_name: string }>(
      `SELECT s.qualified_name FROM wm_edges e JOIN wm_symbols s ON s.id = e.src_id
        WHERE e.dst_id = ? AND e.kind = 'calls'`,
      [row.id],
    );
    assert.equal(caller?.qualified_name, 'compositeTools');
  });

  it('world_model_search returns symbol hits with id, qualified_name, path, line_start and signature', async () => {
    const wm = worldModelTools(db, holder).handlers;
    const out = parse<{ results: Payload[] }>(
      (await wm['world_model_search']!({ agent: 'bro', repo, query: 'persistScan', mode: 'keyword', k: 10 })) as CallToolResult,
    );
    const hit = out.results.find((r) => r['kind'] === 'symbol' && r['qualified_name'] === 'persistScan');
    assert.ok(hit, JSON.stringify(out.results));
    for (const key of ['id', 'qualified_name', 'path', 'line_start', 'signature']) assert.ok(key in hit, key);
    assert.equal(hit['path'], 'mcp/trajectory-server/src/tools/scan.ts');
    assert.match(String(hit['signature']), /^<untrusted-content source="symbol-signature">/);
    for (const r of out.results) {
      assert.ok(!/(^|\/)dist\//.test(String(r['path'])) || r['kind'] === 'dir', `no dist/ file hit: ${String(r['path'])}`);
    }
  });

  it('keyword search lands the ground-truth path in the top 3 for at least 4 of 5 queries', async () => {
    const wm = worldModelTools(db, holder).handlers;
    const report: string[] = [];
    let landed = 0;
    for (const [id, query, truth] of EVAL) {
      const out = parse<{ results: Payload[] }>(
        (await wm['world_model_search']!({ agent: 'bro', repo, query, mode: 'keyword', k: 20 })) as CallToolResult,
      );
      const paths = [...new Set(out.results.filter((r) => r['kind'] !== 'dir').map((r) => String(r['path'])))].slice(0, 3);
      const hit = paths.some((p) => truth.includes(p));
      if (hit) landed++;
      report.push(`${id} ${hit ? 'hit' : 'miss'}: ${paths.join(', ')}`);
    }
    assert.ok(landed >= 4, report.join('\n'));
  });

  it('world_model_symbol on persistScan lists callers and callees', async () => {
    const wm = worldModelTools(db, holder).handlers;
    const card = parse<{
      symbol: Payload;
      callers: { refs: Payload[]; truncated: boolean };
      callees: { refs: Payload[]; truncated: boolean };
    }>((await wm['world_model_symbol']!({ agent: 'bro', repo, qualified_name: 'persistScan' })) as CallToolResult);
    assert.equal(card.symbol['qualified_name'], 'persistScan');
    assert.ok(card.callers.refs.length >= 1, 'persistScan has a caller');
    assert.ok(card.callees.refs.length >= 1, 'persistScan has a callee');
    assert.ok(card.callees.refs.some((r) => r['qualified_name'] === 'planGraph'));
    for (const key of ['id', 'qualified_name', 'kind', 'repo', 'path', 'line_start']) assert.ok(key in card.callers.refs[0]!, key);
  });

  it('world_model_symbol on a trajectory-server source inlined by the dashboard bundle lists it in bundled_by (GH 2284)', async () => {
    const wm = worldModelTools(db, holder).handlers;
    for (const [name, path] of [
      ['runMigrations', 'mcp/trajectory-server/src/db.ts'],
      ['mcp/trajectory-server/src/symbol-index.ts', 'mcp/trajectory-server/src/symbol-index.ts'],
    ]) {
      const card = parse<{ symbol: Payload; bundled_by: { refs: Payload[]; total: number } }>(
        (await wm['world_model_symbol']!({ agent: 'bro', repo, qualified_name: name, path })) as CallToolResult,
      );
      assert.equal(card.symbol['path'], path);
      const bundle = card.bundled_by.refs.find((r) => r['path'] === 'dashboard/dist/server.mjs');
      assert.ok(bundle, JSON.stringify(card.bundled_by));
      assert.equal(bundle['kind'], 'module');
    }
    const edges = db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM wm_edges e JOIN wm_symbols s ON s.id = e.src_id
        WHERE s.repo = ? AND s.path = 'dashboard/dist/server.mjs' AND e.kind = 'bundles' AND e.resolution = 'exact'`,
      [repo],
    )!.n;
    assert.ok(edges > 0, 'server.mjs has exact bundles edges');
    const outside = db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM wm_edges e JOIN wm_symbols s ON s.id = e.src_id
        WHERE s.repo = ? AND e.kind = 'bundles' AND e.dst_name LIKE '%node_modules/%'`,
      [repo],
    )!.n;
    assert.equal(outside, 0, 'no bundles edge names a node_modules source');
  });
});

describe('L1 symbol index freshness on a small repo (GH 1680)', () => {
  const ws = mkdtempSync(join(tmpdir(), 'wm-symbols-'));
  const root = join(ws, 'app');
  const db = tempDB();
  const holder = GraphHolder.fixed(new WorldModelGraph(db));

  const write = (files: Record<string, string>) => {
    for (const [p, body] of Object.entries(files)) {
      mkdirSync(join(root, p, '..'), { recursive: true });
      writeFileSync(join(root, p), body);
    }
    execFileSync('git', ['add', '-A'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'change', '--allow-empty'], { cwd: root });
  };

  const B_TS = (spareBody: string, withHelper = true) =>
    [
      '// Small helpers.',
      ...(withHelper ? ['export function helper(n: number): number {', '  return n + 1;', '}'] : []),
      'export function spare(): number {',
      `  return ${spareBody};`,
      '}',
      '',
    ].join('\n');

  before(() => {
    mkdirSync(root, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 't@t.io'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
    write({
      'src/a.ts': [
        "import { helper } from './b.js';",
        '',
        '// Entry point.',
        'export function main(db: { run(sql: string): void }): number {',
        "  db.run('INSERT INTO widgets (name) VALUES (1)');",
        '  return helper(1) + local();',
        '}',
        '',
        'function local(): number {',
        '  return 2;',
        '}',
        '',
      ].join('\n'),
      'src/b.ts': B_TS('0'),
      'src/schema.sql': 'CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT);\n',
      'scripts/lib.sh': '#!/usr/bin/env bash\nsay_hi() {\n  echo "$1"\n}\n',
      'scripts/run.sh': '#!/usr/bin/env bash\nsource ./lib.sh\ngreet() {\n  say_hi x\n}\n',
    });
  });

  after(() => {
    db.close();
    rmSync(ws, { recursive: true, force: true });
  });

  const idOf = (path: string, name: string) =>
    db.get<{ id: number }>(`SELECT id FROM wm_symbols WHERE repo = 'app' AND path = ? AND qualified_name = ?`, [path, name])
      ?.id;

  it('indexes TS, shell and SQL symbols with their edges', async () => {
    const out = await scan(db, holder, ws);
    assert.equal(out.symbols.files_parsed, 5);
    const names = symbolRows(db, 'app').map((r) => `${String(r['kind'])}:${String(r['qualified_name'])}`);
    for (const n of ['function:main', 'function:local', 'function:helper', 'function:spare', 'sql_table:widgets', 'sh_function:say_hi', 'sh_function:greet']) {
      assert.ok(names.includes(n), `${n} in ${names.join(', ')}`);
    }
    const edge = (src: string, dst: string, kind: string) =>
      db.get<{ resolution: string; dst_id: number | null }>(
        `SELECT e.resolution, e.dst_id FROM wm_edges e JOIN wm_symbols s ON s.id = e.src_id
          WHERE s.qualified_name = ? AND e.dst_name = ? AND e.kind = ?`,
        [src, dst, kind],
      );
    assert.deepEqual({ ...edge('main', 'helper', 'calls') }, { resolution: 'exact', dst_id: idOf('src/b.ts', 'helper') });
    assert.deepEqual({ ...edge('main', 'local', 'calls') }, { resolution: 'exact', dst_id: idOf('src/a.ts', 'local') });
    assert.equal(edge('main', 'widgets', 'writes_table')?.dst_id, idOf('src/schema.sql', 'widgets'));
    assert.deepEqual({ ...edge('greet', 'say_hi', 'calls') }, { resolution: 'exact', dst_id: idOf('scripts/lib.sh', 'say_hi') });

    const wm = worldModelTools(db, holder).handlers;
    const table = parse<{ writes_table: { refs: Payload[] } }>(
      (await wm['world_model_symbol']!({ agent: 'bro', repo: 'app', qualified_name: 'widgets' })) as CallToolResult,
    );
    assert.deepEqual(table.writes_table.refs.map((r) => r['qualified_name']), ['main']);
    const helper = parse<{ callers: { refs: Payload[] }; imports: { refs: Payload[] }; note?: string }>(
      (await wm['world_model_symbol']!({ agent: 'bro', id: idOf('src/b.ts', 'helper') })) as CallToolResult,
    );
    assert.deepEqual(helper.callers.refs.map((r) => r['qualified_name']), ['main']);
    assert.deepEqual(helper.imports.refs.map((r) => r['path']), ['src/a.ts']);
    assert.equal(helper.note, undefined, 'every edge of helper resolved exactly');
  });

  it('editing one file re-parses only that file and keeps the ids of its unchanged symbols', async () => {
    const beforeSymbols = symbolRows(db, 'app');
    const beforeEdges = edgeRows(db, 'app');
    const helperId = idOf('src/b.ts', 'helper');
    const spareId = idOf('src/b.ts', 'spare');
    write({ 'src/b.ts': B_TS('41 + 1') });

    const out = await scan(db, holder, ws);
    assert.equal(out.symbols.files_parsed, 1);
    const afterSymbols = symbolRows(db, 'app');
    const others = (rows: Payload[]) => rows.filter((r) => r['path'] !== 'src/b.ts');
    assert.deepEqual(others(afterSymbols), others(beforeSymbols), 'rows of other files are untouched');
    assert.deepEqual(others(edgeRows(db, 'app')), others(beforeEdges), 'edges of other files are untouched');
    assert.equal(idOf('src/b.ts', 'helper'), helperId);
    assert.equal(idOf('src/b.ts', 'spare'), spareId);
    const spareHash = (rows: Payload[]) => rows.find((r) => r['id'] === spareId)?.['body_hash'];
    assert.notEqual(spareHash(afterSymbols), spareHash(beforeSymbols), 'the edited body has a new hash');
    const md5 = db.get<{ content_md5: string; symbols_md5: string }>(
      `SELECT content_md5, symbols_md5 FROM wm_files WHERE repo = 'app' AND path = 'src/b.ts'`,
    )!;
    assert.equal(md5.symbols_md5, symbolsStamp(md5.content_md5));
  });

  it('deleting a definition leaves its callers unresolved', async () => {
    write({ 'src/b.ts': B_TS('0', false) });
    const out = await scan(db, holder, ws);
    assert.equal(out.symbols.files_parsed, 1);
    assert.equal(idOf('src/b.ts', 'helper'), undefined);
    const call = db.get<{ resolution: string; dst_id: number | null }>(
      `SELECT e.resolution, e.dst_id FROM wm_edges e JOIN wm_symbols s ON s.id = e.src_id
        WHERE s.qualified_name = 'main' AND e.dst_name = 'helper' AND e.kind = 'calls'`,
    );
    assert.deepEqual({ ...call }, { resolution: 'unresolved', dst_id: null });
  });

  it('a file removed from the tree drops its symbols', async () => {
    rmSync(join(root, 'scripts/run.sh'));
    write({});
    await scan(db, holder, ws);
    assert.equal(idOf('scripts/run.sh', 'greet'), undefined);
    const sayHi = db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM wm_edges WHERE dst_id = ?`,
      [idOf('scripts/lib.sh', 'say_hi')],
    )!.n;
    assert.equal(sayHi, 0, 'the removed caller took its edges along');
  });
});

describe('a file whose extraction throws is recorded, not left unstamped (GH 1858)', () => {
  const ws = mkdtempSync(join(tmpdir(), 'wm-failed-'));
  const root = join(ws, 'app');
  const db = tempDB();
  const holder = GraphHolder.fixed(new WorldModelGraph(db));
  const contract = DATA_CONTRACTS.filter(isSqlContract).find((c) => c.id === 'wm_files_symbols_indexed')!;

  const commit = () => {
    execFileSync('git', ['add', '-A'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'change', '--allow-empty'], { cwd: root });
  };
  const row = (path: string) =>
    db.get<{ content_md5: string; symbols_md5: string | null }>(
      `SELECT content_md5, symbols_md5 FROM wm_files WHERE repo = 'app' AND path = ?`,
      [path],
    )!;
  const symbolCount = (path: string) =>
    db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM wm_symbols WHERE repo = 'app' AND path = ?`, [path])!.n;
  const unindexed = () => {
    const report = runDataContracts(trajectoryDbReader(db), [contract], { env: {} });
    assert.deepEqual(report.skipped, []);
    return report.violations.flatMap((v) => v.sample.map((s) => ({ path: s['path'], state: s['state'] })));
  };

  before(() => {
    mkdirSync(join(root, 'src'), { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 't@t.io'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
    writeFileSync(join(root, 'src/ok.ts'), 'export function fine(): number {\n  return 1;\n}\n');
    writeFileSync(join(root, 'src/bad.ts'), 'export function soon(): number {\n  return 2;\n}\n');
    commit();
  });

  after(() => {
    db.close();
    rmSync(ws, { recursive: true, force: true });
  });

  it('stamps a failed file :failed, names it in failed_paths, skips it while unchanged and re-parses it on a content change', async () => {
    const first = await scan(db, holder, ws);
    assert.equal(first.symbols.files_failed, 0);
    assert.deepEqual(unindexed(), [], 'the contract holds on a clean scan');
    assert.ok(symbolCount('src/bad.ts') > 0);

    rmSync(join(root, 'src/bad.ts'));
    mkdirSync(join(root, 'src/bad.ts'));
    db.run(`UPDATE wm_files SET content_md5 = 'edited' WHERE repo = 'app' AND path = 'src/bad.ts'`);

    const failed = await indexRepoSymbols(db, 'app', root);
    assert.equal(failed.files_failed, 1);
    assert.equal(failed.failed_paths.length, 1);
    assert.equal(failed.failed_paths[0]!.path, 'src/bad.ts');
    assert.match(failed.failed_paths[0]!.error, /cannot read src\/bad\.ts/);
    assert.ok(failed.failed_paths[0]!.error.length <= 200);
    assert.equal(row('src/bad.ts').symbols_md5, `${symbolsStamp('edited')}${FAILED_SUFFIX}`);
    assert.ok(row('src/bad.ts').symbols_md5!.endsWith(':failed'));
    assert.equal(symbolCount('src/bad.ts'), 0, 'the stale symbols of the failed file are removed');
    assert.equal(symbolCount('src/ok.ts') > 0, true);
    assert.deepEqual(unindexed(), [{ path: 'src/bad.ts', state: 'failed' }]);

    const unchanged = await indexRepoSymbols(db, 'app', root);
    assert.equal(unchanged.files_failed, 0, 'an unchanged failed file is not re-parsed');
    assert.equal(unchanged.files_parsed, 0);
    assert.deepEqual(unchanged.failed_paths, []);

    rmSync(join(root, 'src/bad.ts'), { recursive: true });
    writeFileSync(join(root, 'src/bad.ts'), 'export function back(): number {\n  return 3;\n}\n');
    commit();
    const fixed = await scan(db, holder, ws);
    assert.equal(fixed.symbols.files_failed, 0);
    assert.equal(fixed.symbols.files_parsed, 1, 'the changed content is re-parsed');
    const bad = row('src/bad.ts');
    assert.equal(bad.symbols_md5, symbolsStamp(bad.content_md5));
    assert.ok(symbolCount('src/bad.ts') > 0);
    assert.deepEqual(unindexed(), [], 'the contract holds again after a clean scan');

    db.run(`UPDATE wm_files SET symbols_md5 = NULL WHERE repo = 'app' AND path = 'src/ok.ts'`);
    assert.deepEqual(unindexed(), [{ path: 'src/ok.ts', state: 'unstamped' }]);
  });

  it('the contract scopes rows exactly as inSymbolScope does', () => {
    const paths = [
      'src/a.ts', 'dist/a.js', 'mcp/x/dist/a.js', 'src/a.js.map', 'node_modules/p/i.js', 'a/node_modules/p/i.js',
      'vendor/v.go', 'a/vendor/v.go', 'web/app.min.js', 'package-lock.json', 'a/package-lock.json', 'bun.lockb',
      'Cargo.lock', 'distro/a.ts', 'src/redist/a.ts', 'src/package-lock.json.ts', 'hooks/hooks.json', 'scripts/run',
      'build/y', 'a/build/b.js', 'src/rebuild/a.ts', 'src/build.ts',
    ];
    for (const p of paths) {
      const inScope = db.get<{ ok: number }>(`SELECT ${IN_SYMBOL_SCOPE_SQL} AS ok FROM (SELECT ? AS path)`, [p])!.ok === 1;
      assert.equal(inScope, inSymbolScope(p), p);
    }
  });

  it('caps failed_paths at 20 and counts every failure in files_failed', async () => {
    for (let i = 0; i < 22; i++) {
      mkdirSync(join(root, `src/dir${i}.ts`));
      db.run(`INSERT INTO wm_files (repo, path, dir, content_md5, updated_at) VALUES ('app', ?, 'src', ?, '2026-01-01T00:00:00.000Z')`, [
        `src/dir${i}.ts`,
        `m${i}`,
      ]);
    }
    const out = await indexRepoSymbols(db, 'app', root);
    assert.equal(out.files_failed, 22);
    assert.equal(out.failed_paths.length, 20);
  });
});

describe('world_model_symbol impact, source and stale (GH 1680)', () => {
  const ws = mkdtempSync(join(tmpdir(), 'wm-impact-'));
  const root = join(ws, 'app');
  const db = tempDB();
  const holder = GraphHolder.fixed(new WorldModelGraph(db));
  const wm = worldModelTools(db, holder).handlers;

  const CHAIN_TS = (tail = '') =>
    [
      'export function stepC(n: number): number {',
      '  return n > 0 ? stepB(n - 1) : 0;',
      '}',
      'export function stepB(n: number): number {',
      '  return stepC(n);',
      '}',
      'export function stepA(n: number): number {',
      '  return stepB(n);',
      '}',
      'export function entryPoint(): number {',
      '  return stepA(1);',
      '}',
      tail,
    ].join('\n');
  const DOTDOT_TS = 'export function dotDotFn(): number {\n  return 2;\n}\n';
  const SHRINK_TS = [
    'export function shrinkHead(): number {',
    '  return 1;',
    '}',
    'export function shrinkTail(): number {',
    '  return 2;',
    '}',
    '',
  ].join('\n');
  const HUB_CALLERS = 210;
  const LONG_BODY = 250;

  const commit = () => {
    execFileSync('git', ['add', '-A'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'change', '--allow-empty'], { cwd: root });
  };

  const symbol = async (args: Payload) =>
    parse<Payload & { symbol: Payload }>(
      (await wm['world_model_symbol']!({ agent: 'bro', repo: 'app', ...args })) as CallToolResult,
    );

  before(async () => {
    mkdirSync(join(root, 'src', 'test'), { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 't@t.io'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
    writeFileSync(join(root, 'src/chain.ts'), CHAIN_TS());
    writeFileSync(
      join(root, 'src/test/chain.test.ts'),
      ["import { stepA } from '../chain.js';", 'export function checkStepA(): number {', '  return stepA(2);', '}', ''].join('\n'),
    );
    const hub = ['export function hubTarget(): number {', '  return 1;', '}'];
    for (let i = 0; i < HUB_CALLERS; i++) hub.push(`export function hubCaller${i}(): number {`, '  return hubTarget();', '}');
    writeFileSync(join(root, 'src/hub.ts'), `${hub.join('\n')}\n`);
    const long = ['export function longBody(): number {', '  let n = 0;'];
    for (let i = 0; i < LONG_BODY; i++) long.push(`  n += ${i};`);
    long.push('  return n;', '}', '');
    writeFileSync(join(root, 'src/long.ts'), long.join('\n'));
    writeFileSync(join(root, '..foo.ts'), DOTDOT_TS);
    writeFileSync(join(root, 'src/shrink.ts'), SHRINK_TS);
    writeFileSync(join(ws, 'outside.ts'), 'export function outsideFn(): number {\n  return 1;\n}\n');
    symlinkSync(join(ws, 'outside.ts'), join(root, 'src/escape.ts'));
    commit();
    await scan(db, holder, ws);
  });

  after(() => {
    db.close();
    rmSync(ws, { recursive: true, force: true });
  });

  it('impact walks callers by depth, routes tests aside and ends a cycle', async () => {
    const card = await symbol({ qualified_name: 'stepC', impact: 3 });
    const impact = card['impact'] as {
      depth: number;
      levels: Array<{ depth: number; refs: Payload[] }>;
      tests: Payload[];
      truncated: boolean;
    };
    assert.equal(impact.depth, 3);
    assert.deepEqual(
      impact.levels.map((l) => [l.depth, l.refs.map((r) => r['qualified_name'])]),
      [
        [1, ['stepB']],
        [2, ['stepA']],
        [3, ['entryPoint']],
      ],
    );
    assert.deepEqual(impact.tests.map((r) => [r['qualified_name'], r['path']]), [['checkStepA', 'src/test/chain.test.ts']]);
    assert.equal(impact.truncated, false);
  });

  it('impact: true walks two hops and an omitted impact adds no key', async () => {
    const card = await symbol({ qualified_name: 'stepC', impact: true });
    const impact = card['impact'] as { depth: number; levels: Array<{ depth: number }>; tests: Payload[] };
    assert.equal(impact.depth, 2);
    assert.deepEqual(impact.levels.map((l) => l.depth), [1, 2]);
    assert.deepEqual(impact.tests, []);
    assert.ok(!('impact' in (await symbol({ qualified_name: 'stepC' }))));
    const bad = (await wm['world_model_symbol']!({ agent: 'bro', repo: 'app', qualified_name: 'stepC', impact: 6 })) as CallToolResult;
    assert.equal(bad.isError, true);
  });

  it('impact stops at 200 refs with truncated', async () => {
    const card = await symbol({ qualified_name: 'hubTarget', impact: 1 });
    const impact = card['impact'] as { levels: Array<{ refs: Payload[] }>; truncated: boolean };
    assert.equal(impact.levels[0]!.refs.length, 200);
    assert.equal(impact.truncated, true);
  });

  it('source: true returns the body lines from disk; omitted source leaves no key', async () => {
    const card = await symbol({ qualified_name: 'stepA', source: true });
    assert.deepEqual(card['source'], {
      start_line: 7,
      end_line: 9,
      text: frameUntrusted('symbol-source', CHAIN_TS().split('\n').slice(6, 9).join('\n')),
      truncated: false,
    });
    assert.ok(!('source' in (await symbol({ qualified_name: 'stepA' }))));
  });

  it('source over 200 lines is cut with truncated', async () => {
    const card = await symbol({ qualified_name: 'longBody', source: true });
    const source = card['source'] as { start_line: number; end_line: number; text: string; truncated: boolean };
    assert.equal(source.truncated, true);
    assert.equal(source.start_line, 1);
    assert.equal(source.end_line, 200);
    const body = source.text.split('\n').slice(1, -1);
    assert.equal(body.length, 200);
    assert.equal(body[0], 'export function longBody(): number {');
    assert.equal(source.text, frameUntrusted('symbol-source', body.join('\n')));
  });

  it('source: true reads a top-level file named ..foo.ts (GH 1851)', async () => {
    const card = await symbol({ qualified_name: 'dotDotFn', source: true });
    assert.equal(card.symbol['path'], '..foo.ts');
    assert.deepEqual(card['source'], {
      start_line: 1,
      end_line: 3,
      text: frameUntrusted('symbol-source', DOTDOT_TS.split('\n').slice(0, 3).join('\n')),
      truncated: false,
    });
  });

  it('source: true refuses a path or symlink that resolves outside the repo (GH 1851)', async () => {
    const insert = (path: string, name: string) =>
      db.run(
        `INSERT INTO wm_symbols (repo, path, kind, qualified_name, start_line, end_line, body_hash)
         VALUES ('app', ?, 'function', ?, 1, 3, 'x')`,
        [path, name],
      );
    insert('../outside.ts', 'escapeDotDot');
    insert('src/escape.ts', 'escapeSymlink');
    try {
      for (const name of ['escapeDotDot', 'escapeSymlink']) {
        const card = await symbol({ qualified_name: name, source: true });
        assert.equal(card['source'], null, name);
        assert.equal(card['source_reason'], 'outside-repo-root', name);
      }
    } finally {
      db.run(`DELETE FROM wm_symbols WHERE repo = 'app' AND qualified_name IN ('escapeDotDot', 'escapeSymlink')`);
    }
  });

  it('source: true refuses a start_line past the end of the file and never inverts the range (GH 1851)', async () => {
    const lines = SHRINK_TS.split('\n').length;
    const range = (name: string) =>
      db.get<{ start_line: number; end_line: number }>(`SELECT start_line, end_line FROM wm_symbols WHERE repo = 'app' AND qualified_name = ?`, [name])!;
    const tailRange = range('shrinkTail');
    const headRange = range('shrinkHead');
    const setRange = (name: string, start: number, end: number) =>
      db.run(`UPDATE wm_symbols SET start_line = ?, end_line = ? WHERE repo = 'app' AND qualified_name = ?`, [start, end, name]);
    setRange('shrinkTail', lines + 3, lines + 5);
    setRange('shrinkHead', 1, lines + 40);
    try {
      const tail = await symbol({ qualified_name: 'shrinkTail', source: true });
      assert.equal(tail['source'], null);
      assert.equal(tail['source_reason'], 'range-past-eof');
      const head = await symbol({ qualified_name: 'shrinkHead', source: true });
      const source = head['source'] as { start_line: number; end_line: number };
      assert.deepEqual([source.start_line, source.end_line], [1, lines]);
      assert.ok(source.end_line >= source.start_line);
    } finally {
      setRange('shrinkTail', tailRange.start_line, tailRange.end_line);
      setRange('shrinkHead', headRange.start_line, headRange.end_line);
    }
  });

  it('a bumped EXTRACTOR_VERSION re-parses every file once; the same version re-parses none', async () => {
    const same = await indexRepoSymbols(db, 'app', root);
    assert.equal(same.files_parsed, 0);
    const indexed = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM wm_files WHERE repo = 'app' AND symbols_md5 IS NOT NULL`)!.n;
    const bumped = await indexRepoSymbols(db, 'app', root, EXTRACTOR_VERSION + 1);
    assert.ok(bumped.files_parsed > 0);
    assert.equal(bumped.files_parsed, indexed);
    assert.equal((await indexRepoSymbols(db, 'app', root, EXTRACTOR_VERSION + 1)).files_parsed, 0);
    assert.equal((await indexRepoSymbols(db, 'app', root)).files_parsed, indexed);
  });

  it('a working-tree edit leaves the index and stale alone; the commit is picked up by the next read (GH 2584)', async () => {
    const searchHit = async () => {
      const out = parse<{ results: Payload[] }>(
        (await wm['world_model_search']!({ agent: 'bro', repo: 'app', query: 'stepA', mode: 'keyword', k: 10 })) as CallToolResult,
      );
      const hit = out.results.find((r) => r['kind'] === 'symbol' && r['qualified_name'] === 'stepA');
      assert.ok(hit, JSON.stringify(out.results));
      return hit;
    };
    assert.equal((await symbol({ qualified_name: 'stepA' })).symbol['stale'], false);
    assert.equal((await searchHit())['stale'], false);

    writeFileSync(join(root, 'src/chain.ts'), CHAIN_TS('// edited'));
    assert.equal((await symbol({ qualified_name: 'stepA' })).symbol['stale'], false);
    assert.equal((await searchHit())['stale'], false);
    const md5Before = db.get<{ m: string }>(`SELECT content_md5 AS m FROM wm_files WHERE repo = 'app' AND path = 'src/chain.ts'`)!.m;

    commit();
    const after = await symbol({ qualified_name: 'stepA' });
    assert.equal(after.symbol['stale'], false);
    assert.equal((await searchHit())['stale'], false);
    assert.notEqual(db.get<{ m: string }>(`SELECT content_md5 AS m FROM wm_files WHERE repo = 'app' AND path = 'src/chain.ts'`)!.m, md5Before);
  });
});

describe('generated output stays out of the world model (GH 1835)', () => {
  it('isGeneratedPath flags build output, dependencies, maps and minified bundles, and inSymbolScope adds lockfiles', () => {
    for (const p of ['dist/x.js', 'a/dist/b.js', 'x.js.map', 'build/y', 'node_modules/z/i.js', 'vendor/v.go', 'app.min.js']) {
      assert.equal(isGeneratedPath(p), true, p);
      assert.equal(inSymbolScope(p), false, p);
    }
    assert.equal(isGeneratedPath('src/dist-utils.ts'), false);
    assert.equal(inSymbolScope('src/dist-utils.ts'), true);
    for (const p of ['package-lock.json', 'bun.lockb', 'yarn.lock']) {
      assert.equal(isGeneratedPath(p), false, p);
      assert.equal(inSymbolScope(p), false, p);
    }
  });

  const ws = mkdtempSync(join(tmpdir(), 'wm-generated-'));
  const root = join(ws, 'app');
  const db = tempDB();
  const graph = new WorldModelGraph(db);
  const holder = GraphHolder.fixed(graph);
  const SOURCE = '// Quokka relay: forwards widget frames.\nexport function quokkaRelay(n: number): number {\n  return n + 1;\n}\n';
  const distRows = () => ({
    files: db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM wm_files WHERE repo = 'app' AND path LIKE 'dist/%'`)!.n,
    dirs: db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM wm_directories WHERE repo = 'app' AND (path = 'dist' OR path LIKE 'dist/%')`,
    )!.n,
  });

  before(async () => {
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'src/a.ts'), SOURCE);
    writeFileSync(join(root, 'dist/a.js'), SOURCE.replace('(n: number): number', '(n)'));
    writeFileSync(join(root, 'dist/a.js.map'), '{"version":3}\n');
    writeFileSync(join(root, 'package-lock.json'), '{"lockfileVersion":3}\n');
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 't@t.io'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
    execFileSync('git', ['add', '-A'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: root });
    await scan(db, holder, ws);
  });

  after(() => {
    db.close();
    rmSync(ws, { recursive: true, force: true });
  });

  it('indexes src/ and the lockfile but no committed dist/ file or directory', () => {
    assert.deepEqual(distRows(), { files: 0, dirs: 0 });
    const paths = db.all<{ path: string }>(`SELECT path FROM wm_files WHERE repo = 'app' ORDER BY path`).map((r) => r.path);
    assert.deepEqual(paths, ['package-lock.json', 'src/a.ts']);
    const repoRoot = graph.allDirectoriesForRepo('app').find((d) => d.path === '')!;
    assert.ok(!String(repoRoot.summary).includes('dist'), String(repoRoot.summary));
  });

  it('world_model_search returns no dist/ hit for a term in both src/a.ts and dist/a.js', async () => {
    const wm = worldModelTools(db, holder).handlers;
    const out = parse<{ results: Payload[] }>(
      (await wm['world_model_search']!({ agent: 'bro', repo: 'app', query: 'quokka relay', mode: 'keyword', k: 20 })) as CallToolResult,
    );
    assert.ok(out.results.some((r) => r['path'] === 'src/a.ts'), JSON.stringify(out.results));
    for (const r of out.results) {
      const path = String(r['path']);
      assert.ok(!path.includes('dist/') && path !== 'dist', JSON.stringify(r));
    }
  });

  it('a rescan deletes dist rows an earlier scan stored', async () => {
    const now = new Date().toISOString();
    for (const path of ['dist', 'dist/sub']) {
      graph.upsertDirectory({
        repo: 'app',
        path,
        parent_path: path === 'dist' ? '' : 'dist',
        summary: 'dist/ — stale',
        summary_source: 'structural',
        summary_updated_at: now,
        file_count: 1,
      });
    }
    for (const [path, dir] of [
      ['dist/a.js', 'dist'],
      ['dist/sub/b.js', 'dist/sub'],
    ] as const) {
      graph.upsertFile({
        repo: 'app',
        path,
        dir,
        purpose: 'Quokka relay.',
        purpose_source: 'comment',
        content_md5: 'x',
        size_bytes: 1,
        last_commit_sha: 'x',
        updated_at: now,
      });
    }
    assert.deepEqual(distRows(), { files: 2, dirs: 2 });
    await scan(db, holder, ws);
    assert.deepEqual(distRows(), { files: 0, dirs: 0 });
  });
});

describe('a comment banner or a comment set off by a blank line is never a symbol doc (GH 1834)', () => {
  // Mirrors the banner comments of the former skills/tmb_recovery bro-sqlite-readonly shell fallback, now cli.js bro-sqlite-readonly (GH 1692).
  const BANNER_SH = [
    '#!/usr/bin/env bash',
    '# ---------------------------------------------------------------------------',
    '# JSON output helpers',
    '# ---------------------------------------------------------------------------',
    'error_json() {',
    '  printf "%s" "$1"',
    '}',
    '',
    '# ---------------------------------------------------------------------------',
    '# Tool implementations — each prints JSON matching the MCP response shape',
    '# ---------------------------------------------------------------------------',
    '',
    'tool_issue_resume() {',
    '  :',
    '}',
    '',
    '# Says hi.',
    'say_hi() {',
    '  :',
    '}',
    '',
    '# Set off by a blank line.',
    '',
    'loose() {',
    '  :',
    '}',
    '',
  ].join('\n');

  const BANNER_TS = [
    '// ====================================================================',
    '// Section',
    '// ====================================================================',
    'export function banner(): number {',
    '  return 1;',
    '}',
    '',
    '/* ---------- */',
    '',
    'export function bannerGap(): number {',
    '  return 2;',
    '}',
    '',
    '// Adds one.',
    'export function plain(): number {',
    '  return 3;',
    '}',
    '',
    '/**',
    ' * JSDoc kept.',
    ' */',
    'function jsdoc(): number {',
    '  return 4;',
    '}',
    '',
    '// Set off by a blank line.',
    '',
    'export function loose(): number {',
    '  return 5;',
    '}',
    '',
  ].join('\n');

  const docs = async (path: string, lang: SourceLanguage, src: string) => {
    const out = extractFile(await loadParsers(), path, lang, src);
    return Object.fromEntries(out.symbols.filter((s) => s.kind !== 'module').map((s) => [s.qualified_name, s.doc]));
  };

  it('bash comment rows end on their own row, so adjacency is the row right above', async () => {
    const tree = (await loadParsers()).bash.parse('# a\n# b\nf() { :; }\n')!;
    const rows = tree.rootNode.namedChildren.map((c) => [c!.type, c!.startPosition.row, c!.endPosition.row]);
    assert.deepEqual(rows, [
      ['comment', 0, 0],
      ['comment', 1, 1],
      ['function_definition', 2, 2],
    ]);
  });

  it('bash: a banner above or a blank row away gives an empty doc; an adjacent comment is kept', async () => {
    assert.deepEqual(await docs('scripts/banner.sh', 'bash', BANNER_SH), {
      error_json: '',
      tool_issue_resume: '',
      say_hi: 'Says hi.',
      loose: '',
    });
  });

  it('TS: a banner above or a blank row away gives an empty doc; an adjacent // or JSDoc comment is kept', async () => {
    assert.deepEqual(await docs('src/banner.ts', 'typescript', BANNER_TS), {
      banner: '',
      bannerGap: '',
      plain: 'Adds one.',
      jsdoc: 'JSDoc kept.',
      loose: '',
    });
  });

  it('a rule line is three or more of -=#*_~/ after the marker', () => {
    for (const l of ['# ---', '// ====', '#####', '/* ~~~ */', ' * ___', '# - - -', '//////']) assert.ok(isRuleLine(l), l);
    for (const l of ['# --', '/**', ' */', ' *', '# --- Section ---', '// Adds one.', '#']) assert.ok(!isRuleLine(l), l);
  });

  it('a file stored at extractor version 1 with a banner doc is re-parsed on an unchanged rescan', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'wm-banner-'));
    const root = join(ws, 'app');
    const db = tempDB();
    const holder = GraphHolder.fixed(new WorldModelGraph(db));
    try {
      mkdirSync(join(root, 'scripts'), { recursive: true });
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
      execFileSync('git', ['config', 'user.email', 't@t.io'], { cwd: root });
      execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
      writeFileSync(join(root, 'scripts/banner.sh'), BANNER_SH);
      execFileSync('git', ['add', '-A'], { cwd: root });
      execFileSync('git', ['commit', '-qm', 'init'], { cwd: root });
      await scan(db, holder, ws);
      assert.equal(EXTRACTOR_VERSION, 16);
      db.run(`UPDATE wm_files SET symbols_md5 = content_md5 || ':1' WHERE repo = 'app' AND path = 'scripts/banner.sh'`);
      db.run(`UPDATE wm_symbols SET doc = 'JSON output helpers' WHERE repo = 'app' AND qualified_name = 'error_json'`);
      const out = await scan(db, holder, ws);
      assert.equal(out.symbols.files_parsed, 1);
      const doc = db.get<{ doc: string }>(`SELECT doc FROM wm_symbols WHERE repo = 'app' AND qualified_name = 'error_json'`)!.doc;
      assert.equal(doc, '');
    } finally {
      db.close();
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('a symbol doc starts after the last banner line of its comment block (GH 1954)', () => {
  const docs = async (path: string, lang: SourceLanguage, src: string) => {
    const out = extractFile(lang === 'perl' ? null : await loadParsers(), path, lang, src);
    return Object.fromEntries(out.symbols.filter((s) => s.kind !== 'module').map((s) => [s.qualified_name, s.doc]));
  };

  it('a banner line is a rule line or a title framed by three or more of one - or =', () => {
    for (const l of ['# ---', '# --- Section ---', '// ==== Section ====', '=== title ===', '# ---- --dry-run is a pure preview (GH 1675) ----'])
      assert.ok(isBannerLine(l), l);
    for (const l of ['# --self-test: exercise run-dir resolution', '// --candidate (a JSON object)', '# --- open', '# -- x --', '# --- x ===', '// real doc'])
      assert.ok(!isBannerLine(l), l);
  });

  it('bash: a lone framed banner gives an empty doc; a glued real doc after it is kept', async () => {
    const src = [
      '# --- Install-scope notice, once per session ----',
      'notice() {',
      '  :',
      '}',
      '',
      '# ---- Rule (h): Edit/Write inside the worktree is allowed ----',
      '# bypass_check — the allow path of an Edit/Write inside the worktree.',
      'bypass_check() {',
      '  :',
      '}',
      '',
      '# ---- --dry-run is a pure preview (GH 1675) ----',
      'dry_run() {',
      '  :',
      '}',
      '',
      '# --self-test: exercise run-dir resolution against a temp dir.',
      'self_test() {',
      '  :',
      '}',
      '',
    ].join('\n');
    const got = await docs('scripts/hooks.sh', 'bash', src);
    assert.equal(got.notice, '');
    assert.equal(got.bypass_check, 'bypass_check — the allow path of an Edit/Write inside the worktree.');
    assert.equal(got.dry_run, '');
    assert.equal(got.self_test, '--self-test: exercise run-dir resolution against a temp dir.');
  });

  it('TS: a framed = banner gives way to the doc glued under it; a doc starting with -- is kept', async () => {
    const src = [
      '// ==== Section ====',
      '// real doc',
      'export function glued(): number {',
      '  return 1;',
      '}',
      '',
      '// === title ===',
      'export function titled(): number {',
      '  return 2;',
      '}',
      '',
      '// --candidate (a JSON object with the proposed fields).',
      'export function candidate(): number {',
      '  return 3;',
      '}',
      '',
    ].join('\n');
    assert.deepEqual(await docs('src/banner.ts', 'typescript', src), {
      glued: 'real doc',
      titled: '',
      candidate: '--candidate (a JSON object with the proposed fields).',
    });
  });

  it('Perl: a framed banner gives way to the doc glued under it', async () => {
    const src = ['#!/usr/bin/env perl', 'use strict;', '', '# --- Section ---', '# real perl doc', 'sub glued {', '  return 1;', '}', ''].join('\n');
    assert.equal((await docs('x.pl', 'perl', src)).glued, 'real perl doc');
  });
});

describe('world model hook symbols: router entries (GH 2185, F287-5)', () => {
  const PLUGIN_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
  const read = (path: string): string => readFileSync(join(PLUGIN_ROOT, path), 'utf8');

  it('the shipped Write group has one runs edge per routed gate, in run order, named by its first gate', () => {
    const table = read('mcp/trajectory-server/dist/hooks-router.txt');
    const x = extractHooks(read('hooks/hooks.json'), table);
    const at = x.symbols.findIndex((s) => s.qualified_name.startsWith('PreToolUse#') && s.doc.includes('Write|Edit'));
    assert.ok(at >= 0);
    assert.equal(x.symbols[at]!.qualified_name, 'PreToolUse#1:containment-guard');
    assert.ok(x.symbols[at]!.start_line > 0, 'the symbol sits on its command line');
    const gates = table.split('\n').map((l) => l.split(' ')).filter((f) => f[3] === 'PreToolUse' && f[4] === 'Write|Edit|MultiEdit|NotebookEdit' && f[6] === undefined).map((f) => f[0]!);
    assert.ok(gates.includes('swe-boundary'));
    assert.match(x.symbols[at]!.doc, new RegExp(`runs router gates ${gates.join(', ')}$`));
    const edges = x.edges.filter((e) => e.src === at && e.kind === 'runs');
    assert.deepEqual(edges.map((e) => e.dst_name), gates.map((g) => `mcp/trajectory-server/src/hooks/${g}.ts`));
    assert.deepEqual(edges.map((e) => e.line), gates.map((_, i) => i + 1));
  });

  it('each part of a shipped event is its own hook symbol with only that part\'s gates', () => {
    const table = read('mcp/trajectory-server/dist/hooks-router.txt');
    const x = extractHooks(read('hooks/hooks.json'), table);
    const names = x.symbols.filter((s) => s.kind === 'hook').map((s) => s.qualified_name);
    assert.deepEqual(names.filter((n) => n.startsWith('SessionStart#')), ['SessionStart#1:ensure-gitignore', 'SessionStart#2:session-start-persona', 'SessionStart#3:session-start-prescan']);
    assert.deepEqual(names.filter((n) => n.startsWith('UserPromptSubmit#')), ['UserPromptSubmit#1:activation-routine', 'UserPromptSubmit#2:user-prompt-persona', 'UserPromptSubmit#3:roundtable-slash-detect']);
    assert.deepEqual(names.filter((n) => n.startsWith('WorktreeCreate#')), ['WorktreeCreate#1:worktree-create']);
    assert.deepEqual(names.filter((n) => n.startsWith('SubagentStart#')), ['SubagentStart#1:reviewer-downstream-context']);
    assert.deepEqual(names.filter((n) => n.endsWith(':swe-downstream-context')), ['PreToolUse#2:swe-downstream-context']);
    const persona = x.symbols.findIndex((s) => s.qualified_name === 'SessionStart#2:session-start-persona');
    assert.deepEqual(x.edges.filter((e) => e.src === persona && e.kind === 'runs').map((e) => e.dst_name), ['mcp/trajectory-server/src/hooks/session-start-persona.ts']);
  });

  it('every runs edge of the shipped hooks.json names a gate\'s TypeScript module, never a bash script (GH 1692)', () => {
    const x = extractHooks(read('hooks/hooks.json'), read('mcp/trajectory-server/dist/hooks-router.txt'));
    const runs = x.edges.filter((e) => e.kind === 'runs').map((e) => e.dst_name);
    assert.ok(runs.length > 0);
    for (const dst of runs) {
      assert.match(dst, /^mcp\/trajectory-server\/src\/hooks\/[a-z0-9-]+\.ts$/);
      assert.ok(existsSync(join(PLUGIN_ROOT, dst)), dst);
    }
  });

  it('every PreToolUse entry of the shipped hooks.json is named by a gate, not by its position', () => {
    const x = extractHooks(read('hooks/hooks.json'), read('mcp/trajectory-server/dist/hooks-router.txt'));
    for (const s of x.symbols.filter((y) => y.qualified_name.startsWith('PreToolUse#'))) {
      assert.doesNotMatch(s.qualified_name, /:hook\d+$/);
    }
  });

  it('with no table a router entry stays a bare hook with no runs edge', () => {
    const x = extractHooks(read('hooks/hooks.json'));
    const at = x.symbols.findIndex((s) => s.qualified_name.startsWith('PreToolUse#'));
    assert.equal(x.symbols[at]!.qualified_name, 'PreToolUse#1:hook1');
    assert.equal(x.edges.filter((e) => e.src === at).length, 0);
  });

  it('the shipped single-gate Stop entry is named by its gate, on its command line, with one runs edge', () => {
    const src = read('hooks/hooks.json');
    const x = extractHooks(src, read('mcp/trajectory-server/dist/hooks-router.txt'));
    const at = x.symbols.findIndex((s) => s.qualified_name === 'Stop#2:liveness-sentinel');
    assert.ok(at >= 0, x.symbols.map((s) => s.qualified_name).join(' '));
    const line = src.split('\n').findIndex((l) => l.includes('dist/hooks.js\\" liveness-sentinel')) + 1;
    assert.ok(line > 0);
    assert.equal(x.symbols[at]!.start_line, line);
    assert.match(x.symbols[at]!.doc, /runs gate liveness-sentinel$/);
    assert.deepEqual(x.edges.filter((e) => e.src === at && e.kind === 'runs').map((e) => e.dst_name), ['mcp/trajectory-server/src/hooks/liveness-sentinel.ts']);
  });

  it('a dist/hooks.js entry whose argument is not its event runs that gate, table or not', () => {
    const hooks = JSON.stringify(
      { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/mcp/trajectory-server/dist/hooks.js" some-gate' }] }] } },
      null,
      2,
    );
    for (const table of ['', 'a 1 enforcement PreToolUse Bash *\n']) {
      const x = extractHooks(hooks, table);
      assert.deepEqual(x.symbols.map((s) => s.qualified_name), ['PreToolUse#1:some-gate']);
      assert.ok(x.symbols[0]!.start_line > 0);
      assert.deepEqual(x.edges.filter((e) => e.kind === 'runs').map((e) => e.dst_name), ['mcp/trajectory-server/src/hooks/some-gate.ts']);
    }
  });

  it('a scan indexes the table, and a registry.ts change refreshes hooks.json with no change of its own', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'wm-router-hooks-'));
    const root = join(ws, 'app');
    const db = tempDB();
    const holder = GraphHolder.fixed(new WorldModelGraph(db));
    const hooks = JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/mcp/trajectory-server/dist/hooks.js" PreToolUse' }] }] } }, null, 2);
    const commit = (): void => {
      execFileSync('git', ['add', '-A'], { cwd: root });
      execFileSync('git', ['commit', '-qm', 'c'], { cwd: root });
    };
    const runs = (): string[] =>
      db.all<{ dst_name: string }>(
        `SELECT e.dst_name FROM wm_edges e JOIN wm_symbols s ON s.id = e.src_id WHERE s.repo = 'app' AND s.kind = 'hook' AND e.kind = 'runs' ORDER BY e.line`,
      ).map((r) => r.dst_name);
    try {
      mkdirSync(join(root, 'hooks'), { recursive: true });
      mkdirSync(join(root, 'mcp/trajectory-server/dist'), { recursive: true });
      mkdirSync(join(root, 'mcp/trajectory-server/src/hooks'), { recursive: true });
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
      execFileSync('git', ['config', 'user.email', 't@t.io'], { cwd: root });
      execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
      writeFileSync(join(root, 'hooks/hooks.json'), hooks);
      writeFileSync(join(root, 'mcp/trajectory-server/src/hooks/registry.ts'), 'export const A = 1;\n');
      writeFileSync(join(root, 'mcp/trajectory-server/dist/hooks-router.txt'), 'a 1 enforcement PreToolUse Bash *\n');
      commit();
      await scan(db, holder, ws);
      assert.deepEqual(runs(), ['mcp/trajectory-server/src/hooks/a.ts']);
      writeFileSync(join(root, 'mcp/trajectory-server/src/hooks/registry.ts'), 'export const A = 2;\n');
      writeFileSync(join(root, 'mcp/trajectory-server/dist/hooks-router.txt'), 'a 1 enforcement PreToolUse Bash *\nb 1 advisory PreToolUse Bash *\n');
      commit();
      await scan(db, holder, ws);
      assert.deepEqual(runs(), ['mcp/trajectory-server/src/hooks/a.ts', 'mcp/trajectory-server/src/hooks/b.ts']);
    } finally {
      db.close();
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('Perl subs and constants (GH 2284)', () => {
  const PERL = [
    '#!/usr/bin/env perl',
    'use strict;',
    '',
    '# Seconds to wait.',
    'use constant TIMEOUT => 30;',
    'use constant LIMITS => (',
    '  1, 2,',
    ');',
    '# Exit codes.',
    'use constant {',
    "  OK    => 0, # plain",
    "  'FAIL' => [1, 2],",
    '  _HIDDEN => { a => 1 },',
    '};',
    '',
    '# Reads one file.',
    'sub slurp {',
    '  my $f = shift;',
    '  return 1;',
    '}',
    'sub one { return 1; }',
    'sub Pkg::_inner($) {',
    '  my $h = sub {',
    '    1;',
    '  };',
    '}',
    'sub later($); # declared only',
    '=pod',
    'sub not_code {',
    '=cut',
    '__END__',
    'sub after_end { 1 }',
    '',
  ].join('\n');

  const rows = () =>
    extractFile(null, 'x.pl', 'perl', PERL)
      .symbols.filter((s) => s.kind !== 'module')
      .map((s) => ({ kind: s.kind, name: s.qualified_name, start: s.start_line, end: s.end_line, doc: s.doc, exported: s.exported }));

  it('indexes subs as function and both use constant forms as const, with line numbers, and skips forward declarations, POD and __END__', () => {
    assert.deepEqual(rows(), [
      { kind: 'const', name: 'TIMEOUT', start: 5, end: 5, doc: 'Seconds to wait.', exported: 1 },
      { kind: 'const', name: 'LIMITS', start: 6, end: 8, doc: '', exported: 1 },
      { kind: 'const', name: 'OK', start: 11, end: 11, doc: 'Exit codes.', exported: 1 },
      { kind: 'const', name: 'FAIL', start: 12, end: 12, doc: 'Exit codes.', exported: 1 },
      { kind: 'const', name: '_HIDDEN', start: 13, end: 13, doc: 'Exit codes.', exported: 0 },
      { kind: 'function', name: 'slurp', start: 17, end: 20, doc: 'Reads one file.', exported: 1 },
      { kind: 'function', name: 'one', start: 21, end: 21, doc: '', exported: 1 },
      { kind: 'function', name: 'Pkg::_inner', start: 22, end: 26, doc: '', exported: 0 },
    ]);
    const sigs = extractFile(null, 'x.pl', 'perl', PERL).symbols.map((s) => s.signature);
    assert.ok(sigs.includes('TIMEOUT => 30'), sigs.join(' | '));
    assert.ok(sigs.includes('sub Pkg::_inner($)'), sigs.join(' | '));
  });

  it('maps .pl, .pm and a perl shebang to perl, which needs no grammar', () => {
    assert.equal(languageOf('a/b.pl', () => ''), 'perl');
    assert.equal(languageOf('a/B.pm', () => ''), 'perl');
    assert.equal(languageOf('bin/tool', () => '#!/usr/bin/env perl -w\n'), 'perl');
    assert.equal(languageOf('bin/tool', () => '#!/bin/bash\n'), 'bash');
    assert.equal(needsParser('perl'), false);
  });

  it('indexing the fixture copy of enums-stable-extract.pl yields its named subs', () => {
    const src = readFileSync(join(WORKTREE, 'mcp/trajectory-server/src/test/fixtures/perl/enums-stable-extract.pl'), 'utf8');
    const subs = extractFile(null, 'mcp/trajectory-server/src/test/fixtures/perl/enums-stable-extract.pl', 'perl', src).symbols.filter((s) => s.kind === 'function');
    assert.deepEqual(subs.map((s) => s.qualified_name), ['slurp', 'lits', 'strip_js_comments', 'const_value', 'emit']);
    const line = (n: string) => subs.find((s) => s.qualified_name === n)!;
    const at = (n: string) => src.split('\n').findIndex((l) => l.startsWith(`sub ${n} `)) + 1;
    for (const s of subs) assert.equal(s.start_line, at(s.qualified_name), s.qualified_name);
    assert.equal(line('lits').end_line, line('lits').start_line);
    assert.ok(line('strip_js_comments').end_line > line('strip_js_comments').start_line);
  });
});

describe('a Perl sub ends on the line of its own closing brace (GH 2302)', () => {
  const spans = (lines: string[]) =>
    extractFile(null, 'x.pl', 'perl', lines.join('\n'))
      .symbols.filter((s) => s.kind === 'function')
      .map((s) => [s.qualified_name, s.start_line, s.end_line]);

  it('a closing brace after code on its line ends the sub there', () => {
    assert.deepEqual(spans(['sub first {', '  my $x = 1;', '  return $x; }', '', 'sub second {', '  return 2;', '}']), [
      ['first', 1, 3],
      ['second', 5, 7],
    ]);
  });

  it('a nested block closes before the sub does', () => {
    assert.deepEqual(spans(['sub n {', '  if ($a) { return 1 }', '  return 0;', '}']), [['n', 1, 4]]);
  });

  it('a brace in a quoted string, a comment or after a backslash does not end the sub', () => {
    assert.deepEqual(
      spans([
        'sub quoted {',
        "  my $s = '}';",
        '  my $t = "x}y";',
        '  # } not code',
        '  my $r = qr/\\}/;',
        '  return $#{$s}; }',
        'sub after { 1 }',
      ]),
      [
        ['quoted', 1, 6],
        ['after', 7, 7],
      ],
    );
  });

  it('a sub whose { opens on the next line ends at its closing brace', () => {
    assert.deepEqual(spans(['sub x', '{', '  return 1;', '}', 'sub y { 2 }']), [
      ['x', 1, 4],
      ['y', 5, 5],
    ]);
  });

  it('a brace inside a same-line [...] such as a regex class [^}] does not end the sub', () => {
    assert.deepEqual(spans(['sub cls {', '  while ($c =~ /\\{([^}]*)\\}/g) {', '    1;', '  }', '}']), [['cls', 1, 5]]);
    const src = readFileSync(join(WORKTREE, 'mcp/trajectory-server/src/test/fixtures/perl/enums-stable-extract.pl'), 'utf8');
    const at = (n: string) => src.split('\n').findIndex((l) => l.startsWith(`sub ${n} `)) + 1;
    const close = (n: string) => src.split('\n').findIndex((l, i) => i >= at(n) && l === '}') + 1;
    const real = extractFile(null, 'mcp/trajectory-server/src/test/fixtures/perl/enums-stable-extract.pl', 'perl', src).symbols.filter((s) => s.kind === 'function');
    for (const n of ['slurp', 'strip_js_comments', 'const_value']) {
      assert.equal(real.find((s) => s.qualified_name === n)!.end_line, close(n), n);
    }
  });

  it('a sub whose braces never balance falls back to the first } at its indent', () => {
    assert.deepEqual(spans(['sub broken {', '  if (1) {', '    return 1;', '}', '', 'sub tail {']), [
      ['broken', 1, 4],
      ['tail', 6, 6],
    ]);
  });
});

describe("'bundles' edges from a bundle's source map (GH 2284)", () => {
  const ws = mkdtempSync(join(tmpdir(), 'wm-bundles-'));
  const root = join(ws, 'app');
  const db = tempDB();
  const holder = GraphHolder.fixed(new WorldModelGraph(db));
  const MAP = (sources: string[]) => JSON.stringify({ version: 3, file: 'bundle.js', sources, names: [], mappings: '' });

  const commit = (files: Record<string, string>) => {
    for (const [p, body] of Object.entries(files)) {
      mkdirSync(join(root, p, '..'), { recursive: true });
      writeFileSync(join(root, p), body);
    }
    execFileSync('git', ['add', '-A'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'change'], { cwd: root });
  };
  const bundleEdges = () =>
    edgeRows(db, 'app')
      .filter((e) => e['kind'] === 'bundles')
      .map((e) => ({ src: e['path'], dst: e['dst_name'], resolution: e['resolution'] }));

  before(async () => {
    mkdirSync(root, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 't@t.io'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
    commit({
      'src/a.ts': 'export function alpha(): number {\n  return 1;\n}\n',
      'src/b.ts': "import { alpha } from './a.js';\nexport const beta = alpha();\n",
      'dist/bundle.js': 'function alpha(){return 1}\nexport const beta=alpha();\n//# sourceMappingURL=bundle.js.map\n',
      'dist/bundle.js.map': MAP(['../src/a.ts', '../src/b.ts', '../node_modules/x/i.js', '../../outside.ts']),
    });
    await scan(db, holder, ws);
  });

  after(() => {
    db.close();
    rmSync(ws, { recursive: true, force: true });
  });

  it('gives one exact edge per in-repo source and none for node_modules or outside the repo', () => {
    const edges = bundleEdges();
    assert.ok(edges.length > 0);
    assert.deepEqual(edges, [
      { src: 'dist/bundle.js', dst: 'src/a.ts', resolution: 'exact' },
      { src: 'dist/bundle.js', dst: 'src/b.ts', resolution: 'exact' },
    ]);
    const bundle = symbolRows(db, 'app').filter((r) => r['path'] === 'dist/bundle.js');
    assert.deepEqual(bundle.map((r) => r['kind']), ['module']);
    const files = db.all<{ path: string }>(`SELECT path FROM wm_files WHERE repo = 'app' AND path LIKE 'dist/%'`);
    assert.equal(files.length, 0, 'the bundle stays out of wm_files');
  });

  it('world_model_symbol on a source lists the bundle in bundled_by, not in tests', async () => {
    const wm = worldModelTools(db, holder).handlers;
    const card = parse<{ bundled_by: { refs: Payload[] }; tests: { refs: Payload[] }; symbol: Payload }>(
      (await wm['world_model_symbol']!({ agent: 'bro', repo: 'app', qualified_name: 'alpha' })) as CallToolResult,
    );
    assert.deepEqual(card.bundled_by.refs.map((r) => r['path']), ['dist/bundle.js']);
    assert.equal(card.tests.refs.length, 0);
    assert.equal(card.symbol['stale'], false);
  });

  it('bundleSources resolves sourceRoot and file URLs and skips URLs, node_modules and paths outside the repo', () => {
    const map = (o: object) => JSON.stringify({ version: 3, mappings: '', ...o });
    assert.deepEqual(bundleSources('pkg/dist/x.mjs.map', map({ sourceRoot: '../src/', sources: ['a.ts', 'sub/b.ts', 'a.ts'] }), '/repo'), [
      'pkg/src/a.ts',
      'pkg/src/sub/b.ts',
    ]);
    assert.deepEqual(
      bundleSources('d/x.js.map', map({ sources: ['file:///repo/lib/c.ts', 'webpack://app/./e.ts', '/elsewhere/f.ts', '../node_modules/.bun/y/z.js', '../../up.ts'] }), '/repo'),
      ['lib/c.ts'],
    );
    assert.deepEqual(bundleSources('d/x.js.map', map({}), '/repo'), []);
    assert.deepEqual(
      bundleMaps([
        { path: 'dist/a.js', content_md5: '1' },
        { path: 'dist/a.js.map', content_md5: '2' },
        { path: 'dist/gone.js.map', content_md5: '3' },
        { path: 'src/x.js', content_md5: '4' },
        { path: 'src/x.js.map', content_md5: '5' },
      ]),
      [{ path: 'dist/a.js.map', content_md5: '2' }],
    );
  });

  it('builtBundleMaps lists an ignored built map whose bundle is on disk, and skips node_modules, non-generated and orphan maps (GH 2054)', async (t) => {
    const repo = mkdtempSync(join(tmpdir(), 'wm-built-'));
    t.after(() => rmSync(repo, { recursive: true, force: true }));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const files: Record<string, string> = {
      '.gitignore': 'dist/\nout/\nnode_modules/\n',
      'dist/b.mjs': 'export {};\n',
      'dist/b.mjs.map': MAP(['../src/b.ts']),
      'dist/orphan.js.map': MAP(['../src/b.ts']),
      'out/c.js': '',
      'out/c.js.map': MAP(['../src/b.ts']),
      'node_modules/p/dist/i.js': '',
      'node_modules/p/dist/i.js.map': MAP([]),
    };
    for (const [p, body] of Object.entries(files)) {
      mkdirSync(join(repo, p, '..'), { recursive: true });
      writeFileSync(join(repo, p), body);
    }
    const maps = await builtBundleMaps(repo);
    assert.deepEqual(maps.map((m) => m.path), ['dist/b.mjs.map']);
    assert.match(maps[0]!.content_md5, /^[0-9a-f]{32}$/);
    assert.deepEqual(await builtBundleMaps(join(repo, 'no-such-dir')), []);
  });

  it('an unchanged map is not re-read, a changed one rewrites the edges, and a removed map drops the bundle row', async () => {
    const id = () => db.get<{ id: number }>(`SELECT id FROM wm_symbols WHERE repo = 'app' AND path = 'dist/bundle.js'`)?.id;
    const before = id();
    await scan(db, holder, ws);
    assert.equal(id(), before);
    commit({ 'dist/bundle.js.map': MAP(['../src/a.ts']) });
    await scan(db, holder, ws);
    assert.deepEqual(bundleEdges(), [{ src: 'dist/bundle.js', dst: 'src/a.ts', resolution: 'exact' }]);
    rmSync(join(root, 'dist/bundle.js.map'));
    execFileSync('git', ['add', '-A'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'rm map'], { cwd: root });
    await scan(db, holder, ws);
    assert.equal(id(), undefined);
    assert.deepEqual(bundleEdges(), []);
  });
});

describe('an l3 hook test links to the TS gate it runs (GH 1839)', () => {
  const TEST = 'mcp/trajectory-server/src/test/x-l3.test.ts';
  const gate = (n: string) => `mcp/trajectory-server/src/hooks/${n}.ts`;
  const runs = async (path: string, src: string) =>
    extractFile(await loadParsers(), path, 'typescript', src)
      .edges.filter((e) => e.kind === 'runs')
      .map((e) => ({ dst: e.dst_name, line: e.line }));

  const LITERAL = "import { runGate } from './hook-sandbox.js';\nrunGate('containment-guard', opts);\nrunGate(\"containment-guard\", opts);\n";
  const CONST = "const GATE = 'a-gate';\nrunGate(GATE, opts);\nrunGate(GATE, opts);\n";
  const COMMENT = '// Runs the gate as `node dist/hooks.js git-push-guard` (see dist/hooks.js git-push-guard).\nexport const x = 1;\n';

  it('a runGate literal, a const GATE and a dist/hooks.js mention each give one runs edge on the first mention', async () => {
    assert.deepEqual(await runs(TEST, LITERAL), [{ dst: gate('containment-guard'), line: 2 }]);
    assert.deepEqual(await runs(TEST, CONST), [{ dst: gate('a-gate'), line: 1 }]);
    assert.deepEqual(await runs(TEST, COMMENT), [{ dst: gate('git-push-guard'), line: 1 }]);
  });

  it('every const GATE in a file gets its edge, and names that are not gate names are skipped', async () => {
    const src = [
      "describe('a', () => { const GATE = 'gate-one'; });",
      "describe('b', () => { const GATE = 'gate-two'; });",
      '// `dist/hooks.js <gate>` and `dist/hooks.js PreToolUse`',
      "runGate('PreToolUse', opts);",
      'runGate(name, opts);',
      "runGate('gate-two', opts);",
    ].join('\n');
    assert.deepEqual(await runs(TEST, src), [
      { dst: gate('gate-one'), line: 1 },
      { dst: gate('gate-two'), line: 2 },
    ]);
  });

  it('the same sources at a non-test path give no runs edge', async () => {
    for (const src of [LITERAL, CONST, COMMENT]) assert.deepEqual(await runs('mcp/trajectory-server/src/foo.ts', src), []);
  });

  it('world_model_symbol lists a test that only runs a gate under the gate module\'s tests', async (t) => {
    const ws = mkdtempSync(join(tmpdir(), 'wm-test-gate-'));
    const root = join(ws, 'app');
    const db = tempDB();
    t.after(() => {
      db.close();
      rmSync(ws, { recursive: true, force: true });
    });
    const holder = GraphHolder.fixed(new WorldModelGraph(db));
    const files: Record<string, string> = {
      'mcp/trajectory-server/src/hooks/g1.ts': 'export function g1(): number {\n  return 1;\n}\n',
      'mcp/trajectory-server/src/test/g1-l3.test.ts': "import { runGate } from './hook-sandbox.js';\nrunGate('g1', { cwd: '.', env: {} });\n",
    };
    for (const [p, body] of Object.entries(files)) {
      mkdirSync(join(root, p, '..'), { recursive: true });
      writeFileSync(join(root, p), body);
    }
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 't@t.io'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
    execFileSync('git', ['add', '-A'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'c'], { cwd: root });
    await scan(db, holder, ws);
    const card = parse<{ tests: { refs: Payload[] } }>(
      (await worldModelTools(db, holder).handlers['world_model_symbol']!({
        agent: 'bro',
        repo: 'app',
        qualified_name: 'mcp/trajectory-server/src/hooks/g1.ts',
        path: 'mcp/trajectory-server/src/hooks/g1.ts',
      })) as CallToolResult,
    );
    assert.deepEqual(card.tests.refs.map((r) => r['path']), ['mcp/trajectory-server/src/test/g1-l3.test.ts']);
  });
});

describe('world_model_symbol impact reaches import-linked tests and table readers (GH 2333)', () => {
  const ws = mkdtempSync(join(tmpdir(), 'wm-impact-2333-'));
  const root = join(ws, 'app');
  const db = tempDB();
  const holder = GraphHolder.fixed(new WorldModelGraph(db));
  const wm = worldModelTools(db, holder).handlers;

  interface Impact {
    levels: Array<{ depth: number; refs: Payload[]; total: number }>;
    tests: Payload[];
    truncated: boolean;
  }
  const impactOf = async (qualified_name: string, impact: number) =>
    parse<{ impact: Impact }>(
      (await wm['world_model_symbol']!({ agent: 'bro', repo: 'app', qualified_name, impact })) as CallToolResult,
    ).impact;
  const names = (refs: Payload[]) => refs.map((r) => r['qualified_name']);

  before(async () => {
    const files: Record<string, string> = {
      'src/core.ts': 'export function coreFn(): number {\n  return 1;\n}\n',
      'src/caller.ts': "import { coreFn } from './core.js';\nexport function callerFn(): number {\n  return coreFn();\n}\n",
      'src/test/caller.test.ts': "import { callerFn } from '../caller.js';\nexport const subject = callerFn;\n",
      'src/test/core.test.ts': "import { coreFn } from '../core.js';\nexport const subject = coreFn;\n",
      'schema.sql': 'CREATE TABLE items (id INTEGER PRIMARY KEY);\n',
      'src/writer.ts':
        "export function writeItem(db: { run(sql: string): void }): void {\n  db.run('INSERT INTO items (id) VALUES (1)');\n}\n",
      'src/reader.ts': [
        'export function readItems(db: { all(sql: string): unknown[] }): unknown[] {',
        "  return db.all('SELECT id FROM items');",
        '}',
        'export function readerCaller(db: { all(sql: string): unknown[] }): number {',
        '  return readItems(db).length;',
        '}',
        '',
      ].join('\n'),
    };
    for (const [p, body] of Object.entries(files)) {
      mkdirSync(join(root, p, '..'), { recursive: true });
      writeFileSync(join(root, p), body);
    }
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 't@t.io'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
    execFileSync('git', ['add', '-A'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'c'], { cwd: root });
    await scan(db, holder, ws);
  });

  after(() => {
    db.close();
    rmSync(ws, { recursive: true, force: true });
  });

  it('a test module importing a caller lands in tests at depth 2, one importing the symbol at depth 1, neither in levels', async () => {
    const one = await impactOf('coreFn', 1);
    assert.deepEqual(one.tests.map((r) => r['path']), ['src/test/core.test.ts']);
    assert.deepEqual(one.levels.map((l) => [l.depth, names(l.refs)]), [[1, ['callerFn']]]);
    assert.equal(one.levels[0]!.refs[0]!['via'], 'call');
    assert.ok(one.levels[0]!.total > 0);

    const two = await impactOf('coreFn', 2);
    assert.deepEqual(two.tests.map((r) => r['path']).sort(), ['src/test/caller.test.ts', 'src/test/core.test.ts']);
    const levelPaths = two.levels.flatMap((l) => l.refs.map((r) => r['path']));
    assert.ok(!levelPaths.some((p) => String(p).startsWith('src/test/')), JSON.stringify(levelPaths));
  });

  it('a writer reaches the readers of the table it writes with via table:<name>, and their callers by call', async () => {
    const one = await impactOf('writeItem', 1);
    assert.deepEqual(one.levels.map((l) => [l.depth, l.refs.map((r) => [r['qualified_name'], r['via']])]), [
      [1, [['readItems', 'table:items']]],
    ]);
    assert.ok(one.levels[0]!.total > 0);

    const two = await impactOf('writeItem', 2);
    assert.deepEqual(two.levels.map((l) => [l.depth, l.refs.map((r) => [r['qualified_name'], r['via']])]), [
      [1, [['readItems', 'table:items']]],
      [2, [['readerCaller', 'call']]],
    ]);
    for (const level of two.levels) {
      assert.equal(level.total, level.refs.length);
      for (const ref of level.refs) assert.ok(typeof ref['via'] === 'string', JSON.stringify(ref));
    }
  });
});

describe('member calls bind only by receiver type (GH 1838)', () => {
  const ws = mkdtempSync(join(tmpdir(), 'wm-member-1838-'));
  const root = join(ws, 'app');
  const db = tempDB();
  const holder = GraphHolder.fixed(new WorldModelGraph(db));

  const callees = (src: string): Array<[string, string | null]> =>
    db
      .all<{ dst_name: string; dst: string | null }>(
        `SELECT e.dst_name, d.qualified_name AS dst
           FROM wm_edges e JOIN wm_symbols s ON s.id = e.src_id LEFT JOIN wm_symbols d ON d.id = e.dst_id
          WHERE s.repo = 'app' AND s.qualified_name = ? AND e.kind = 'calls'
          ORDER BY e.rowid`,
        [src],
      )
      .map((r) => [r.dst_name, r.dst]);

  before(async () => {
    const files: Record<string, string> = {
      'src/write-paths.ts': 'export class WritePaths {\n  join(): string {\n    return "";\n  }\n}\n',
      'src/locale-grep.ts': 'export class LocaleGrep {\n  test(s: string): boolean {\n    return s.length > 0;\n  }\n}\n',
      'src/caller.ts': [
        "import { WritePaths } from './write-paths.js';",
        'export function untyped(s: string): boolean {',
        "  const segments = ['a', 'b'];",
        "  segments.join('/');",
        '  return /x/.test(s);',
        '}',
        'export function viaNew(): string {',
        '  const w = new WritePaths();',
        '  return w.join();',
        '}',
        'export function viaParam(wp: WritePaths): string {',
        '  return wp.join();',
        '}',
        'export function viaStatic(): string {',
        '  return WritePaths.join();',
        '}',
        'export class Holder {',
        '  private held: WritePaths = new WritePaths();',
        '  run(): string {',
        '    return this.held.join();',
        '  }',
        '}',
        'export class Owner {',
        '  constructor(private readonly owned: WritePaths) {}',
        '  run(): string {',
        '    return this.owned.join();',
        '  }',
        '}',
        '',
      ].join('\n'),
      'src/clash.ts': [
        "import { WritePaths } from './write-paths.js';",
        "import { LocaleGrep } from './locale-grep.js';",
        'export function first(): string {',
        '  const r = new WritePaths();',
        '  return r.join();',
        '}',
        'export function second(): boolean {',
        '  const r = new LocaleGrep();',
        "  return r.test('s');",
        '}',
        'export class Self {',
        '  helper(): number {',
        '    return 1;',
        '  }',
        '  run(): number {',
        '    return this.helper();',
        '  }',
        '}',
        '',
      ].join('\n'),
      'src/chain.ts': [
        'export function join(): string {',
        "  return '';",
        '}',
        'export function chained(lines: string[]): string {',
        "  return lines.map((line) => line.trim()).filter(Boolean).join('/');",
        '}',
        'export class Deep {',
        '  private alpha = { beta: { gamma: { delta: [] as string[] } } };',
        '  run(): string {',
        "    return this.alpha.beta.gamma.delta.slice(0, 10).join('/');",
        '  }',
        '}',
        '',
      ].join('\n'),
    };
    for (const [p, body] of Object.entries(files)) {
      mkdirSync(join(root, p, '..'), { recursive: true });
      writeFileSync(join(root, p), body);
    }
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 't@t.io'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
    execFileSync('git', ['add', '-A'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'c'], { cwd: root });
    await scan(db, holder, ws);
  });

  after(() => {
    db.close();
    rmSync(ws, { recursive: true, force: true });
  });

  it('a call on an untyped local or a regex literal stays unresolved', () => {
    assert.deepEqual(callees('untyped'), [
      ['join', null],
      ['test', null],
    ]);
  });

  it('new, a parameter annotation, a class field, a parameter property and a static receiver each bind to WritePaths.join', () => {
    for (const src of ['viaNew', 'viaParam', 'Holder.run', 'Owner.run']) {
      assert.deepEqual(callees(src), [['join', 'WritePaths.join']], src);
    }
    assert.deepEqual(callees('viaStatic'), [
      ['WritePaths', 'WritePaths'],
      ['join', 'WritePaths.join'],
    ]);
  });

  it('a receiver typed two ways in one file binds neither; this.m() still binds to the same-file method', () => {
    assert.deepEqual(callees('first'), [['join', null]]);
    assert.deepEqual(callees('second'), [['test', null]]);
    assert.deepEqual(callees('Self.run'), [['helper', 'Self.helper']]);
  });

  it('a member call on a receiver of 40+ characters stays a member call, bound neither by bare name nor to a same-file function', () => {
    const joins = (src: string) => callees(src).filter(([name]) => name === 'join');
    assert.deepEqual(joins('chained'), [['join', null]]);
    assert.deepEqual(joins('Deep.run'), [['join', null]]);
  });

  it('extraction keeps a non-null hint on a member call with a long chained receiver', async () => {
    const parsers = await loadParsers();
    const src = 'export function f(lines: string[]): string {\n  return lines.map((line) => line.trim()).filter(Boolean).join("/");\n}\n';
    const edge = extractFile(parsers, 'src/a.ts', 'typescript', src).edges.find((e) => e.kind === 'calls' && e.dst_name === 'join');
    assert.ok(edge);
    assert.notEqual(edge.hint, null);
    assert.equal(edge.hint!.endsWith('…'), true);
  });
});

describe('member calls skip named-import and sourced-file binding (GH 2472)', () => {
  const ws = mkdtempSync(join(tmpdir(), 'wm-member-2472-'));
  const root = join(ws, 'app');
  const db = tempDB();
  const holder = GraphHolder.fixed(new WorldModelGraph(db));

  const callees = (src: string): Array<[string, string | null]> =>
    db
      .all<{ dst_name: string; dst: string | null }>(
        `SELECT e.dst_name, d.path || ':' || d.qualified_name AS dst
           FROM wm_edges e JOIN wm_symbols s ON s.id = e.src_id LEFT JOIN wm_symbols d ON d.id = e.dst_id
          WHERE s.repo = 'app' AND s.qualified_name = ? AND e.kind = 'calls'
          ORDER BY e.rowid`,
        [src],
      )
      .map((r) => [r.dst_name, r.dst]);

  before(async () => {
    const files: Record<string, string> = {
      'src/paths.ts': "export function join(s: string): string {\n  return s;\n}\n",
      'src/write-paths.ts': 'export class WritePaths {\n  join(): string {\n    return "";\n  }\n}\n',
      'src/caller.ts': [
        "import { join } from './paths.js';",
        "import { WritePaths } from './write-paths.js';",
        'export function bareAndUntyped(): string {',
        "  const segments = ['a', 'b'];",
        "  join('a');",
        "  return segments.join('/');",
        '}',
        'export function typed(): string {',
        '  const w = new WritePaths();',
        '  return w.join();',
        '}',
        '',
      ].join('\n'),
    };
    for (const [p, body] of Object.entries(files)) {
      mkdirSync(join(root, p, '..'), { recursive: true });
      writeFileSync(join(root, p), body);
    }
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 't@t.io'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
    execFileSync('git', ['add', '-A'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'c'], { cwd: root });
    await scan(db, holder, ws);
  });

  after(() => {
    db.close();
    rmSync(ws, { recursive: true, force: true });
  });

  it('a bare call binds to the named import; a member call on an untyped local stays unresolved', () => {
    assert.deepEqual(callees('bareAndUntyped'), [
      ['join', 'src/paths.ts:join'],
      ['join', null],
    ]);
  });

  it('a member call on a typed receiver binds by receiver type, not to the same-named import', () => {
    assert.deepEqual(callees('typed'), [['join', 'src/write-paths.ts:WritePaths.join']]);
  });

  it('the extractor version is 16', () => {
    assert.equal(EXTRACTOR_VERSION, 16);
  });
});

describe('reads_config edges name the plugin_config keys a symbol reads (GH 2325)', () => {
  const ws = mkdtempSync(join(tmpdir(), 'wm-config-'));
  const root = join(ws, 'app');
  const db = tempDB();
  const holder = GraphHolder.fixed(new WorldModelGraph(db));
  const wm = worldModelTools(db, holder).handlers;

  const CONFIG_TS = [
    "const MODE_KEY = 'review_mode';",
    'interface Db {',
    '  get(sql: string, params?: unknown[]): unknown;',
    '  run(sql: string, params?: unknown[]): void;',
    '}',
    'export function literalSql(): string {',
    "  return \"SELECT value FROM plugin_config WHERE key = 'pr_target'\";",
    '}',
    'export function boundRead(db: Db): unknown {',
    "  return db.get('SELECT value FROM plugin_config WHERE key = ?', [MODE_KEY]);",
    '}',
    'export function listRead(db: Db): unknown {',
    "  return db.get(\"SELECT key, value FROM plugin_config WHERE key IN ('alpha_key', 'beta_key')\");",
    '}',
    'export function boundListRead(db: Db): unknown {',
    "  return db.get('SELECT key, value FROM plugin_config WHERE key IN (?, ?)', [MODE_KEY, 'gamma_key']);",
    '}',
    'export function templateConstRead(db: Db): unknown {',
    "  return db.get(`SELECT value FROM plugin_config WHERE key = '${MODE_KEY}'`);",
    '}',
    'export function dynamicRead(db: Db, key: string): unknown {',
    "  return db.get(`SELECT value FROM plugin_config WHERE key = '${key}'`);",
    '}',
    'export function dynamicBound(db: Db, key: string): unknown {',
    "  return db.get('SELECT value FROM plugin_config WHERE key = ?', [key]);",
    '}',
    'export function deleteRow(db: Db): void {',
    "  db.run(\"DELETE FROM plugin_config WHERE key = 'gone_key'\");",
    '}',
    'export function otherTable(db: Db): unknown {',
    "  return db.get(\"SELECT value FROM settings WHERE key = 'not_config'\");",
    '}',
    '',
  ].join('\n');
  const CONFIG_SH = [
    '#!/usr/bin/env bash',
    'read_cfg() {',
    '  sqlite3 "$DB" "SELECT value FROM plugin_config WHERE key = \'sh_key\'"',
    '}',
    'read_var() {',
    '  sqlite3 "$DB" "SELECT value FROM plugin_config WHERE key = \'$1\'"',
    '}',
    '',
  ].join('\n');
  const lineOf = (body: string, needle: string): number => body.split('\n').findIndex((l) => l.includes(needle)) + 1;

  const configEdges = () =>
    db
      .all<{ qualified_name: string; dst_name: string; dst_id: number | null; resolution: string; line: number }>(
        `SELECT s.qualified_name, e.dst_name, e.dst_id, e.resolution, e.line
           FROM wm_edges e JOIN wm_symbols s ON s.id = e.src_id
          WHERE s.repo = 'app' AND e.kind = 'reads_config'
          ORDER BY s.qualified_name, e.dst_name`,
      )
      .map((r) => ({ ...r }));
  const keysBySymbol = () => {
    const out: Record<string, string[]> = {};
    for (const e of configEdges()) (out[e.qualified_name] ??= []).push(e.dst_name);
    return out;
  };
  const EXPECTED = {
    boundListRead: ['gamma_key', 'review_mode'],
    boundRead: ['review_mode'],
    listRead: ['alpha_key', 'beta_key'],
    literalSql: ['pr_target'],
    read_cfg: ['sh_key'],
    templateConstRead: ['review_mode'],
  };

  before(async () => {
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(join(root, 'src/config.ts'), CONFIG_TS);
    writeFileSync(join(root, 'scripts/config.sh'), CONFIG_SH);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 't@t.io'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
    execFileSync('git', ['add', '-A'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'c'], { cwd: root });
    await scan(db, holder, ws);
  });

  after(() => {
    db.close();
    rmSync(ws, { recursive: true, force: true });
  });

  it('a literal, a const-bound ?, an IN list and a ${CONST} read each yield edges; a dynamic key, a DELETE and another table yield none', () => {
    assert.deepEqual(keysBySymbol(), EXPECTED);
    for (const e of configEdges()) {
      assert.equal(e.resolution, 'name');
      assert.equal(e.dst_id, null);
    }
    assert.equal(
      configEdges().find((e) => e.qualified_name === 'boundRead')?.line,
      lineOf(CONFIG_TS, "WHERE key = ?', [MODE_KEY]"),
    );
  });

  it('indexRepoSymbols re-parsing every file and markOrphanedEdges leave the edges name-resolved', async () => {
    const before = configEdges();
    const out = await indexRepoSymbols(db, 'app', root, EXTRACTOR_VERSION + 1);
    assert.equal(out.files_parsed, 2);
    markOrphanedEdges(db);
    assert.deepEqual(configEdges(), before);
  });

  it('the card lists the keys read and its reads_config edges add no by-name note; config_key lists the readers', async () => {
    const outboundKinds = () =>
      db
        .all<{ kind: string; resolution: string }>(
          `SELECT e.kind, e.resolution FROM wm_edges e JOIN wm_symbols s ON s.id = e.src_id
            WHERE s.repo = 'app' AND s.qualified_name = 'literalSql' ORDER BY e.kind`,
        )
        .map((r) => `${r.kind}:${r.resolution}`);
    assert.deepEqual(outboundKinds(), ['reads_config:name', 'reads_table:unresolved']);
    db.run(
      `DELETE FROM wm_edges WHERE kind = 'reads_table'
         AND src_id = (SELECT id FROM wm_symbols WHERE repo = 'app' AND qualified_name = 'literalSql')`,
    );
    const card = parse<{ reads_config: { refs: Payload[]; total: number; truncated: boolean }; note?: string }>(
      (await wm['world_model_symbol']!({ agent: 'bro', repo: 'app', qualified_name: 'literalSql' })) as CallToolResult,
    );
    assert.deepEqual(card.reads_config, {
      refs: [{ key: 'pr_target', line: lineOf(CONFIG_TS, "'pr_target'") }],
      total: 1,
      truncated: false,
    });
    assert.equal(card.note, undefined);

    const readers = parse<{ config_key: string; readers: Payload[] }>(
      (await wm['world_model_symbol']!({ agent: 'bro', repo: 'app', config_key: 'review_mode' })) as CallToolResult,
    );
    assert.equal(readers.config_key, 'review_mode');
    assert.deepEqual(
      readers.readers.map((r) => ({ ...r })),
      ['boundRead', 'boundListRead', 'templateConstRead'].map((qualified_name) => ({
        qualified_name,
        kind: 'function',
        repo: 'app',
        path: 'src/config.ts',
        line: lineOf(CONFIG_TS, `function ${qualified_name}(`) + 1,
      })),
    );
    const none = parse<{ readers: Payload[] }>(
      (await wm['world_model_symbol']!({ agent: 'bro', repo: 'app', config_key: 'gone_key' })) as CallToolResult,
    );
    assert.deepEqual(none.readers, []);
    const bad = (await wm['world_model_symbol']!({ agent: 'bro', repo: 'app', config_key: '' })) as CallToolResult;
    assert.ok(bad.isError);
  });
});

describe('covers edges from lint and test runners to the directories they check (GH 2326)', () => {
  const ws = mkdtempSync(join(tmpdir(), 'wm-covers-'));
  const root = join(ws, 'app');
  const db = tempDB();
  const holder = GraphHolder.fixed(new WorldModelGraph(db));

  const packageJson = (lint: string) =>
    JSON.stringify(
      {
        name: 'app',
        scripts: {
          test: 'node --test tests/unit/*.test.mjs',
          lint,
          typecheck: 'tsc --noEmit',
          ghost: 'eslint missing/dir gone',
        },
      },
      null,
      2,
    ) + '\n';
  const WORKFLOW = ['name: ci', 'on: push', 'jobs:', '  test:', '    runs-on: ubuntu-latest', '    steps:', '      - run: cd pkg && npm test', ''].join('\n');
  const lineOf = (body: string, needle: string): number => body.split('\n').findIndex((l) => l.includes(needle)) + 1;

  const commit = (files: Record<string, string>) => {
    for (const [p, body] of Object.entries(files)) {
      mkdirSync(join(root, p, '..'), { recursive: true });
      writeFileSync(join(root, p), body);
    }
    execFileSync('git', ['add', '-A'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'c', '--allow-empty'], { cwd: root });
  };
  const coversEdges = () =>
    db
      .all<{ runner: string; path: string; dst_name: string; dst_id: number | null; resolution: string; line: number }>(
        `SELECT s.qualified_name AS runner, s.path, e.dst_name, e.dst_id, e.resolution, e.line
           FROM wm_edges e JOIN wm_symbols s ON s.id = e.src_id
          WHERE s.repo = 'app' AND e.kind = 'covers'
          ORDER BY s.path, s.qualified_name, e.dst_name`,
      )
      .map((r) => ({ ...r }));
  const dirsByRunner = () => {
    const out: Record<string, string[]> = {};
    for (const e of coversEdges()) (out[`${e.path}#${e.runner}`] ??= []).push(e.dst_name);
    return out;
  };

  before(async () => {
    mkdirSync(root, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 't@t.io'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
    commit({
      'package.json': packageJson('eslint src lib'),
      '.github/workflows/ci.yml': WORKFLOW,
      'src/a.ts': 'export const a = 1;\n',
      'lib/b.ts': 'export const b = 2;\n',
      'tests/unit/a.test.mjs': 'export const t = 1;\n',
      'tests/unit/sub/b.test.mjs': 'export const u = 1;\n',
      'pkg/index.js': 'export const p = 1;\n',
      'docs/guide.txt': 'guide\n',
    });
    await scan(db, holder, ws);
  });

  after(() => {
    db.close();
    rmSync(ws, { recursive: true, force: true });
  });

  it('indexes runner symbols with covers edges for a glob, path arguments and a cd step, and none for tsc --noEmit or a missing directory', () => {
    const runners = db
      .all<{ path: string; qualified_name: string; signature: string; start_line: number; end_line: number }>(
        `SELECT path, qualified_name, signature, start_line, end_line FROM wm_symbols WHERE repo = 'app' AND kind = 'runner' ORDER BY path, qualified_name`,
      )
      .map((r) => ({ ...r }));
    const ciLine = lineOf(WORKFLOW, 'cd pkg');
    assert.deepEqual(
      runners.map((r) => `${r.path}#${r.qualified_name}`),
      [`.github/workflows/ci.yml#ci:${ciLine}`, 'package.json#ghost', 'package.json#lint', 'package.json#test', 'package.json#typecheck'],
    );
    const test = runners.find((r) => r.qualified_name === 'test')!;
    assert.equal(test.signature, 'node --test tests/unit/*.test.mjs');
    assert.equal(test.start_line, lineOf(packageJson('eslint src lib'), '"test"'));
    assert.equal(test.end_line, test.start_line);
    assert.deepEqual(dirsByRunner(), {
      [`.github/workflows/ci.yml#ci:${ciLine}`]: ['pkg'],
      'package.json#lint': ['lib', 'src'],
      'package.json#test': ['tests/unit'],
    });
    for (const e of coversEdges()) {
      assert.equal(e.resolution, 'name');
      assert.equal(e.dst_id, null);
    }
    assert.equal(coversEdges().find((e) => e.runner === 'test')?.line, test.start_line);
  });

  it('a re-parse at EXTRACTOR_VERSION + 1 and markOrphanedEdges keep covers name-resolved; a dropped path argument drops its edge', async () => {
    const before = coversEdges();
    const out = await indexRepoSymbols(db, 'app', root, EXTRACTOR_VERSION + 1);
    assert.ok(out.files_parsed >= 2);
    markOrphanedEdges(db);
    assert.deepEqual(coversEdges(), before);

    commit({ 'package.json': packageJson('eslint src') });
    await scan(db, holder, ws);
    assert.deepEqual(dirsByRunner()['package.json#lint'], ['src']);
    for (const e of coversEdges()) assert.deepEqual([e.resolution, e.dst_id], ['name', null]);
  });
});

describe('coveredDirs reads the directories a runner command names (GH 2326)', () => {
  const known = repoPaths(['src/a.ts', 'src/deep/b.ts', 'lib/c.ts', 'pkg/sub/d.ts', 'scripts/run.mjs', 'README.md']);
  const cases: Array<[string, string, string[]]> = [
    ['node --test tests/none/*.test.mjs', '.', []],
    ['eslint src lib', '.', ['src', 'lib']],
    ['eslint "src/**/*.ts" --max-warnings=0', '.', ['src']],
    ['prettier --check src/ --config=lib/x.json', '.', ['src']],
    ['cd pkg && npm test', '.', ['pkg']],
    ['cd pkg; vitest run sub', '.', ['pkg/sub']],
    ['cd pkg && cd sub && make', '.', ['pkg/sub']],
    ['cd "$DIR" && eslint src', '.', []],
    ['tsc --noEmit', '.', []],
    ['node scripts/run.mjs', '.', ['scripts']],
    ['eslint ../outside /abs/src ~/src', '.', []],
    ['eslint deep', 'src', ['src/deep']],
    ['eslint .', 'pkg', ['pkg']],
    ['grep -E \'^[a-z]+$\' README.md > src/out.txt 2>&1', '.', []],
    ['NODE_ENV=test eslint $SRC src # lib', '.', ['src']],
    ['eslint src \\\n  lib', '.', ['src', 'lib']],
    ['eslint src src/ ./src', '.', ['src']],
    ['eslint *.ts', 'src', []],
    ['eslint ./*.ts', 'src', ['src']],
    ["git tag -l 'v[0-9]*'", '.', []],
    ['if [ "$X" = 1 ]; then { echo hi; }; fi', '.', []],
  ];
  for (const [command, base, dirs] of cases) {
    it(`${JSON.stringify(command)} from ${base} covers ${JSON.stringify(dirs)}`, () => {
      assert.deepEqual(coveredDirs(command, base, known), dirs);
    });
  }
});

describe('coveredDirs skips script names, echo text and make targets (GH 2521)', () => {
  const known = repoPaths(['src/a.ts', 'src/schema.json', 'docs/guide.md', 'tests/a.test.mjs']);
  const cases: Array<[string, string[]]> = [
    ['npm run docs', []],
    ['pnpm run docs', []],
    ['yarn run-script docs', []],
    ['bun run docs', []],
    ['./node_modules/.bin/npm run --silent docs', []],
    ['echo src', []],
    ['printf src', []],
    ['make docs', []],
    ['just docs', []],
    ['task docs', []],
    ['make -C docs/ docs', ['docs']],
    ['npm run lint -- src', ['src']],
    ['node --test tests', ['tests']],
    ['npm test src', ['src']],
    ['make schema > src/schema.json', []],
    ['just gen > src/schema.json', []],
    ['task gen >> src/schema.json', []],
    ['make docs < src/a.ts', []],
    ['make gen 2> src/schema.json', []],
    ['echo x > src/a.txt', []],
    ['npm run docs > src/a.txt', []],
  ];
  for (const [command, dirs] of cases) {
    it(`${JSON.stringify(command)} covers ${JSON.stringify(dirs)}`, () => {
      assert.deepEqual(coveredDirs(command, '.', known), dirs);
    });
  }
});

describe('scan_run records no covers edge for a script name or echo text (GH 2521)', () => {
  const ws = mkdtempSync(join(tmpdir(), 'wm-covers-names-'));
  const root = join(ws, 'app');
  const db = tempDB();
  const holder = GraphHolder.fixed(new WorldModelGraph(db));

  before(async () => {
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'docs'), { recursive: true });
    mkdirSync(join(root, 'tests'), { recursive: true });
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'app', scripts: { 'build:docs': 'npm run docs', show: 'echo src', test: 'node --test tests' } }, null, 2) + '\n',
    );
    writeFileSync(join(root, 'src/a.ts'), 'export const a = 1;\n');
    writeFileSync(join(root, 'docs/guide.txt'), 'guide\n');
    writeFileSync(join(root, 'tests/a.test.mjs'), 'export const t = 1;\n');
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 't@t.io'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
    execFileSync('git', ['add', '-A'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'c'], { cwd: root });
    await scan(db, holder, ws);
  });

  after(() => {
    db.close();
    rmSync(ws, { recursive: true, force: true });
  });

  it('only test covers tests', () => {
    const edges = db
      .all<{ runner: string; dst_name: string }>(
        `SELECT s.qualified_name AS runner, e.dst_name
           FROM wm_edges e JOIN wm_symbols s ON s.id = e.src_id
          WHERE s.repo = 'app' AND e.kind = 'covers'`,
      )
      .map((r) => ({ ...r }));
    assert.deepEqual(edges, [{ runner: 'test', dst_name: 'tests' }]);
  });
});

describe('table edges resolve exact when one non-test definition exists (GH 2523)', () => {
  const ws = mkdtempSync(join(tmpdir(), 'wm-table-exact-'));
  const root = join(ws, 'app');
  const db = tempDB();
  const holder = GraphHolder.fixed(new WorldModelGraph(db));
  const wm = worldModelTools(db, holder).handlers;

  const write = (files: Record<string, string>) => {
    for (const [p, body] of Object.entries(files)) {
      mkdirSync(join(root, p, '..'), { recursive: true });
      writeFileSync(join(root, p), body);
    }
    execFileSync('git', ['add', '-A'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'change', '--allow-empty'], { cwd: root });
  };
  const reader = (name: string, table: string) =>
    `export function ${name}(): string {\n  return 'SELECT id FROM ${table}';\n}\n`;
  const tableEdge = (reader: string) =>
    db.get<{ path: string | null; resolution: string }>(
      `SELECT d.path, e.resolution FROM wm_edges e JOIN wm_symbols s ON s.id = e.src_id
         LEFT JOIN wm_symbols d ON d.id = e.dst_id
        WHERE s.repo = 'app' AND s.qualified_name = ? AND e.kind = 'reads_table'`,
      [reader],
    );
  const noteOf = async (qualified_name: string) =>
    parse<{ note?: string }>(
      (await wm['world_model_symbol']!({ agent: 'bro', repo: 'app', qualified_name })) as CallToolResult,
    ).note;

  before(async () => {
    mkdirSync(root, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 't@t.io'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
    write({
      'src/schema.sql': 'CREATE TABLE items (id INTEGER PRIMARY KEY);\nCREATE TABLE pairs (id INTEGER PRIMARY KEY);\n',
      'src/other.sql': 'CREATE TABLE pairs (id INTEGER PRIMARY KEY);\n',
      'src/test/schema.sql': 'CREATE TABLE items (id INTEGER PRIMARY KEY);\nCREATE TABLE lonely (id INTEGER PRIMARY KEY);\n',
      'fixtures/items.sql': 'CREATE TABLE items (id INTEGER PRIMARY KEY);\n',
      'fixtures/schema.sql': 'CREATE TABLE dups (id INTEGER PRIMARY KEY);\n',
      'src/a/schema.sql': 'CREATE TABLE dups (id INTEGER PRIMARY KEY);\n',
      'src/b/schema.sql': 'CREATE TABLE dups (id INTEGER PRIMARY KEY);\n',
      'src/dups.ts': reader('readDups', 'dups'),
      'src/items.ts': reader('readItems', 'items'),
      'src/pairs.ts': reader('readPairs', 'pairs'),
      'src/lonely.ts': reader('readLonely', 'lonely'),
    });
    await scan(db, holder, ws);
  });

  after(() => {
    db.close();
    rmSync(ws, { recursive: true, force: true });
  });

  it('one definition outside test and fixture paths resolves exact, despite test and fixture copies', () => {
    assert.deepEqual({ ...tableEdge('readItems') }, { path: 'src/schema.sql', resolution: 'exact' });
  });

  it('no-guess: two non-test definitions stay unlinked, a lone test definition links', () => {
    assert.deepEqual({ ...tableEdge('readPairs') }, { path: null, resolution: 'unresolved' });
    assert.deepEqual({ ...tableEdge('readLonely') }, { path: 'src/test/schema.sql', resolution: 'exact' });
  });

  it('no-guess: two real definitions plus a fixtures copy stay unlinked (GH 2527)', () => {
    assert.deepEqual({ ...tableEdge('readDups') }, { path: null, resolution: 'unresolved' });
  });

  it('a card whose only table edge resolves exact carries no found-by-name note', async () => {
    assert.equal(await noteOf('readItems'), undefined);
    assert.equal(await noteOf('readPairs'), 'found by name; not all callers');
  });

  it('a second non-test definition unlinks the edge, and removing it links it back exact', async () => {
    write({ 'src/more.sql': 'CREATE TABLE items (id INTEGER PRIMARY KEY);\n' });
    await scan(db, holder, ws);
    assert.deepEqual({ ...tableEdge('readItems') }, { path: null, resolution: 'unresolved' });
    assert.equal(await noteOf('readItems'), 'found by name; not all callers');

    write({ 'src/more.sql': 'CREATE TABLE extra (id INTEGER PRIMARY KEY);\n' });
    await scan(db, holder, ws);
    assert.deepEqual({ ...tableEdge('readItems') }, { path: 'src/schema.sql', resolution: 'exact' });

    write({ 'src/more.sql': 'CREATE TABLE items (id INTEGER PRIMARY KEY);\n' });
    await scan(db, holder, ws);
    assert.equal(tableEdge('readItems')!.resolution, 'unresolved');

    rmSync(join(root, 'src/more.sql'));
    write({});
    await scan(db, holder, ws);
    assert.deepEqual({ ...tableEdge('readItems') }, { path: 'src/schema.sql', resolution: 'exact' });
    assert.equal(await noteOf('readItems'), undefined);
  });
});

describe('inline self-naming tool handlers are tool:<name> symbols (GH 1970)', () => {
  const ws = mkdtempSync(join(tmpdir(), 'wm-tools-'));
  const root = join(ws, 'app');
  const db = tempDB();
  const holder = GraphHolder.fixed(new WorldModelGraph(db));
  const TOOLS_TS = [
    'function helper(): void {}',
    'function go(): void {}',
    'function x(): void {}',
    'export function tools() {',
    '  return {',
    '    foo_bar: requireRoles(',
    "      'foo_bar',",
    "      ['bro'],",
    '      wrap(async () => {',
    '        helper();',
    '      }),',
    '    ),',
    "    task_reopen: wrap('task_reopen', () => go()),",
    '    onClick: debounce(() => go()),',
    "    a: wrap('b', () => x()),",
    '  };',
    '}',
    '',
  ].join('\n');

  before(async () => {
    mkdirSync(join(root, 'src/test'), { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 't@t.io'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
    writeFileSync(join(root, 'src/tools.ts'), TOOLS_TS);
    writeFileSync(join(root, 'src/test/tools.test.ts'), "import { tools } from '../tools.js';\nit('x', () => { tools(); });\n");
    execFileSync('git', ['add', '-A'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: root });
    await scan(db, holder, ws);
  });

  after(() => {
    db.close();
    rmSync(ws, { recursive: true, force: true });
  });

  const row = (name: string) =>
    db.get<{ id: number; kind: string; start_line: number; end_line: number; signature: string }>(
      `SELECT id, kind, start_line, end_line, signature FROM wm_symbols WHERE repo = 'app' AND qualified_name = ?`,
      [name],
    );

  it('a pair whose call chain names its key and holds a closure is a function symbol spanning the pair, calling helper', () => {
    const sym = row('tool:foo_bar');
    assert.ok(sym, 'tool:foo_bar is indexed');
    assert.deepEqual({ kind: sym.kind, start_line: sym.start_line, end_line: sym.end_line, signature: sym.signature }, {
      kind: 'function',
      start_line: 6,
      end_line: 12,
      signature: 'foo_bar: requireRoles(',
    });
    const edge = db.get<{ dst_id: number | null; resolution: string }>(
      `SELECT dst_id, resolution FROM wm_edges WHERE src_id = ? AND kind = 'calls' AND dst_name = 'helper'`,
      [sym.id],
    );
    assert.deepEqual({ ...edge }, { dst_id: row('helper')!.id, resolution: 'exact' });
  });

  it('the enclosing function calls the tool: symbol, so a handler-only helper keeps its transitive callers and tests', async () => {
    const edge = db.get<{ dst_id: number | null; resolution: string }>(
      `SELECT dst_id, resolution FROM wm_edges WHERE src_id = ? AND kind = 'calls' AND dst_name = 'tool:foo_bar'`,
      [row('tools')!.id],
    );
    assert.deepEqual({ ...edge }, { dst_id: row('tool:foo_bar')!.id, resolution: 'exact' });
    const wm = worldModelTools(db, holder).handlers;
    const card = parse<{ impact: { levels: Array<{ refs: Payload[] }>; tests: Payload[] } }>(
      (await wm['world_model_symbol']!({ agent: 'bro', repo: 'app', qualified_name: 'helper', impact: 3 })) as CallToolResult,
    );
    const levels = card.impact.levels.map((l) => l.refs.map((r) => r['qualified_name']));
    assert.deepEqual(levels.slice(0, 2), [['tool:foo_bar'], ['tools']]);
    assert.ok(
      card.impact.tests.some((t) => t['path'] === 'src/test/tools.test.ts'),
      JSON.stringify(card.impact.tests),
    );
  });

  it('a pair with no string literal, or a literal other than its key, is no tool: symbol', () => {
    const tools = db
      .all<{ qualified_name: string }>(`SELECT qualified_name FROM wm_symbols WHERE repo = 'app' AND qualified_name LIKE 'tool:%' ORDER BY qualified_name`)
      .map((r) => r.qualified_name);
    assert.deepEqual(tools, ['tool:foo_bar', 'tool:task_reopen']);
  });

  it('a keyword search for the tool name returns the tool: symbol', async () => {
    const wm = worldModelTools(db, holder).handlers;
    const out = parse<{ results: Payload[] }>(
      (await wm['world_model_search']!({ agent: 'bro', repo: 'app', query: 'task_reopen', mode: 'keyword', k: 10 })) as CallToolResult,
    );
    assert.ok(
      out.results.some((r) => r['kind'] === 'symbol' && r['qualified_name'] === 'tool:task_reopen'),
      JSON.stringify(out.results),
    );
  });
});

describe('references link only on proof (GH 3032)', () => {
  const ws = mkdtempSync(join(tmpdir(), 'wm-no-guess-'));
  const root = join(ws, 'app');
  const db = tempDB();
  const holder = GraphHolder.fixed(new WorldModelGraph(db));

  before(async () => {
    const files: Record<string, string> = {
      'src/lonely.ts': 'export function uniquelyNamedHelper(): number {\n  return 1;\n}\n',
      'src/caller.ts': 'export function callsWithoutImport(): number {\n  return uniquelyNamedHelper();\n}\n',
    };
    for (const [p, body] of Object.entries(files)) {
      mkdirSync(join(root, p, '..'), { recursive: true });
      writeFileSync(join(root, p), body);
    }
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 't@t.io'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
    execFileSync('git', ['add', '-A'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: root });
    await scan(db, holder, ws);
  });

  after(() => {
    db.close();
    rmSync(ws, { recursive: true, force: true });
  });

  it('no-guess: a TS call to a uniquely named function in a non-imported file stays unlinked', () => {
    const edge = db.get<{ dst_id: number | null; resolution: string }>(
      `SELECT e.dst_id, e.resolution FROM wm_edges e JOIN wm_symbols s ON s.id = e.src_id
        WHERE s.repo = 'app' AND s.qualified_name = 'callsWithoutImport' AND e.kind = 'calls' AND e.dst_name = 'uniquelyNamedHelper'`,
    );
    assert.deepEqual({ ...edge }, { dst_id: null, resolution: 'unresolved' });
  });
});
