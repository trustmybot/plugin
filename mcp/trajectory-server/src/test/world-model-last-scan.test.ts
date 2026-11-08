import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { WorldModelGraph, GraphHolder } from '../graph.js';
import { recordScanError, SCAN_ERROR_MESSAGE_MAX, SCAN_ERRORS_MAX, scanTools, type ScanError } from '../tools/scan.js';
import { worldModelTools } from '../tools/world_model.js';
import type { TrajectoryDB } from '../db.js';
import { resetEmbeddingModelForTests } from '../embeddings/model.js';
import { pinScanEnv, tempDB } from './helpers.js';

const scanPin = pinScanEnv();
after(() => scanPin.restore());
resetEmbeddingModelForTests(async () => {
  throw new Error('no model in tests');
});
after(() => resetEmbeddingModelForTests());

type Payload = Record<string, unknown>;
type Handler = (args: Payload) => Promise<CallToolResult>;

interface LastScan {
  at: string;
  source: string | null;
  ok: boolean;
  errors: ScanError[];
}

function parse(r: CallToolResult): Payload {
  assert.ok(!r.isError, JSON.stringify(r.content));
  return JSON.parse((r.content[0] as { text: string }).text) as Payload;
}

describe('world-model last_scan and index_error (GH 1972)', () => {
  let ws: string;
  let repoRoot: string;
  let db: TrajectoryDB;
  let holder: GraphHolder;
  let wm: Record<string, Handler>;
  const git = (...a: string[]): string => execFileSync('git', ['-C', repoRoot, ...a], { encoding: 'utf8' });

  const scan = async (): Promise<Payload> =>
    parse((await scanTools(db, holder, ':memory:').handlers['scan_run']!({ agent: 'bro', session_dir: ws })) as CallToolResult);

  const auditErrors = (): unknown =>
    (JSON.parse(
      db.get<{ content_json: string }>(
        `SELECT content_json FROM audit WHERE event_type = 'deep_scan_completed' ORDER BY id DESC LIMIT 1`,
      )!.content_json,
    ) as Payload)['errors'];

  const lastScanOf = async (args: Payload): Promise<LastScan | null> =>
    parse(await wm['world_model_get']!({ agent: 'bro', ...args }))['last_scan'] as LastScan | null;

  const symbolCard = async (): Promise<Payload> =>
    parse(await wm['world_model_symbol']!({ agent: 'bro', repo: 'app', qualified_name: 'b', path: 'src/b.ts' }));

  before(() => {
    ws = mkdtempSync(join(tmpdir(), 'wm-last-scan-'));
    repoRoot = join(ws, 'app');
    const files: Record<string, string> = {
      'README.md': '# App\n\nFixture application.\n',
      'src/b.ts': 'export const b = 1;\n',
    };
    for (const [p, body] of Object.entries(files)) {
      mkdirSync(join(repoRoot, p, '..'), { recursive: true });
      writeFileSync(join(repoRoot, p), body);
    }
    execFileSync('git', ['init', '-q', '-b', 'main', repoRoot]);
    git('config', 'user.email', 't@t.io');
    git('config', 'user.name', 't');
    git('add', '.');
    git('commit', '-qm', 'init');

    db = tempDB({ seedScan: false });
    holder = GraphHolder.fixed(new WorldModelGraph(db));
    wm = worldModelTools(db, holder).handlers as Record<string, Handler>;
  });

  after(() => {
    db.close();
    rmSync(ws, { recursive: true, force: true });
  });

  it('last_scan is null before any scan', async () => {
    assert.equal(await lastScanOf({ repo: 'app' }), null);
  });

  it('a clean scan records errors [] and world_model_get reports ok', async () => {
    const out = await scan();
    assert.deepEqual(out['errors'], []);
    assert.deepEqual(auditErrors(), []);
    const last = await lastScanOf({ repo: 'app' });
    assert.ok(last);
    assert.equal(last.ok, true);
    assert.deepEqual(last.errors, []);
    assert.equal(last.source, 'bro_auto_initial');
    assert.equal(typeof last.at, 'string');
    assert.ok(!('index_error' in (await symbolCard())));
  });

  it('a failing symbol index lands in scan_run, the audit row, world_model_get and world_model_symbol', async () => {
    for (const op of ['INSERT', 'UPDATE', 'DELETE']) {
      db.run(`CREATE TRIGGER inject_${op.toLowerCase()} BEFORE ${op} ON wm_symbols BEGIN SELECT RAISE(ABORT, 'injected index failure'); END`);
    }
    writeFileSync(join(repoRoot, 'src/b.ts'), 'export const b = 2;\nexport function c(): number { return b; }\n');
    git('commit', '-qam', 'change');
    try {
      const out = await scan();
      const errors = out['errors'] as ScanError[];
      const indexErrors = errors.filter((e) => e.stage === 'symbol_index');
      assert.equal(indexErrors.length, 1, JSON.stringify(errors));
      assert.equal(indexErrors[0]!.repo, 'app');
      assert.match(indexErrors[0]!.error, /injected index failure/);
      assert.deepEqual(auditErrors(), errors);

      for (const args of [{ repo: 'app' }, { repo: 'app', path: 'no/such' }, { repo: 'ghost' }]) {
        const last = await lastScanOf(args);
        assert.ok(last, JSON.stringify(args));
        assert.equal(last.ok, false);
        assert.deepEqual(last.errors, errors);
      }
      const warned = parse(await wm['world_model_get']!({ agent: 'bro', repo: 'ghost' }));
      assert.equal(warned['warning'], 'world-model-empty');

      const card = await symbolCard();
      assert.match(String(card['index_error']), /injected index failure/);
    } finally {
      for (const op of ['insert', 'update', 'delete']) db.run(`DROP TRIGGER inject_${op}`);
    }
  });

  it('a clean rescan clears last_scan and index_error', async () => {
    writeFileSync(join(repoRoot, 'src/b.ts'), 'export const b = 3;\n');
    git('commit', '-qam', 'again');
    const out = await scan();
    assert.deepEqual(out['errors'], []);
    const last = await lastScanOf({ repo: 'app' });
    assert.equal(last?.ok, true);
    assert.ok(!('index_error' in (await symbolCard())));
  });

  it('a deep_scan_completed row with no errors key reads as []', async () => {
    db.run(
      `INSERT INTO audit (issue_id, from_node, event_type, summary, content_json, created_at)
       VALUES (-1, 'bro', 'deep_scan_completed', 'legacy', '{"source":"user_manual"}', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
    );
    const last = await lastScanOf({ repo: 'app' });
    assert.deepEqual(last && { ok: last.ok, errors: last.errors, source: last.source }, { ok: true, errors: [], source: 'user_manual' });
  });

  it(`errors cap at ${SCAN_ERRORS_MAX} entries and ${SCAN_ERROR_MESSAGE_MAX} chars each`, () => {
    const errors: ScanError[] = [];
    for (let i = 0; i < SCAN_ERRORS_MAX + 5; i++) recordScanError(errors, 'milestone_sync', `r${i}`, new Error('x'.repeat(2000)));
    assert.equal(errors.length, SCAN_ERRORS_MAX);
    assert.equal(errors[0]!.error.length, SCAN_ERROR_MESSAGE_MAX);
    assert.equal(errors[SCAN_ERRORS_MAX - 1]!.repo, `r${SCAN_ERRORS_MAX - 1}`);
  });
});
