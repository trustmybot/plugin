import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { parserLoadCount } from '../parsing/loader.js';
import { EXTRACTOR_VERSION, FAILED_SUFFIX, indexRepoSymbols, symbolsStamp } from '../symbol-index.js';
import { DATA_CONTRACTS, IN_SYMBOL_SCOPE_SQL, isSqlContract } from '../data-contracts.js';
import { inSymbolScope } from '../parsing/extract.js';
import { runDataContracts, trajectoryDbReader } from '../tools/trajectory-doctor.js';
import { frameUntrusted } from '../utils/untrusted.js';
import { WorldModelGraph, GraphHolder } from '../graph.js';
import { scanTools } from '../tools/scan.js';
import { worldModelTools } from '../tools/world_model.js';
import type { TrajectoryDB } from '../db.js';
import { pinScanEnv, tempDB } from './helpers.js';

const scanPin = pinScanEnv();
after(() => scanPin.restore());

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
    ['scripts/hooks/containment-guard.sh', 'scripts/hooks/lib/cmd-analysis.sh'],
  ],
  [
    'H4',
    'Recovery fallback bro-sqlite-readonly.sh fails silently: issue_get/issue_resume/config_get query columns that no longer exist',
    ['skills/tmb_recovery/scripts/bro-sqlite-readonly.sh'],
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
    assert.ok(card.callees.refs.some((r) => r['qualified_name'] === 'persistFilesGraph'));
    for (const key of ['id', 'qualified_name', 'kind', 'repo', 'path', 'line_start']) assert.ok(key in card.callers.refs[0]!, key);
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
    assert.match(failed.failed_paths[0]!.error, /EISDIR/);
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

  it('source: true refuses a start_line past the end of a shrunken file and never inverts the range (GH 1851)', async () => {
    writeFileSync(join(root, 'src/shrink.ts'), 'export function shrinkHead(): number {\n  return 1;');
    try {
      const tail = await symbol({ qualified_name: 'shrinkTail', source: true });
      assert.equal(tail['source'], null);
      assert.equal(tail['source_reason'], 'range-past-eof');
      const head = await symbol({ qualified_name: 'shrinkHead', source: true });
      const source = head['source'] as { start_line: number; end_line: number };
      assert.deepEqual([source.start_line, source.end_line], [1, 2]);
      assert.ok(source.end_line >= source.start_line);
    } finally {
      writeFileSync(join(root, 'src/shrink.ts'), SHRINK_TS);
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

  it('stale flips on an edit after indexing and back after a rescan', async () => {
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
    assert.equal((await symbol({ qualified_name: 'stepA' })).symbol['stale'], true);
    assert.equal((await searchHit())['stale'], true);

    commit();
    await scan(db, holder, ws);
    assert.equal((await symbol({ qualified_name: 'stepA' })).symbol['stale'], false);
    assert.equal((await searchHit())['stale'], false);
  });
});
