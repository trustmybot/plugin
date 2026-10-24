import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { parserLoadCount } from '../parsing/loader.js';
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

  it('stamps symbols_md5 with content_md5 for every indexed .ts file', () => {
    const rows = db.all<{ path: string; content_md5: string; symbols_md5: string | null }>(
      `SELECT path, content_md5, symbols_md5 FROM wm_files WHERE repo = ? AND path LIKE '%.ts' AND path NOT LIKE '%dist/%'`,
      [repo],
    );
    assert.ok(rows.length > 0);
    for (const r of rows) assert.equal(r.symbols_md5, r.content_md5, r.path);
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
    assert.equal(md5.symbols_md5, md5.content_md5);
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
