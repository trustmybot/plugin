import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { WorldModelGraph, GraphHolder } from '../graph.js';
import { scanTools } from '../tools/scan.js';
import { checkoutLag, worldModelTools } from '../tools/world_model.js';
import { compositeTools } from '../tools/composites.js';
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

const LAG_KEYS = ['checkout_behind_upstream', 'upstream'];

function parse(r: CallToolResult): Payload {
  assert.ok(!r.isError, JSON.stringify(r.content));
  return JSON.parse((r.content[0] as { text: string }).text) as Payload;
}

describe('world-model checkout lag (GH 1966)', () => {
  let ws: string;
  let repoRoot: string;
  let db: TrajectoryDB;
  let holder: GraphHolder;
  let wm: Record<string, Handler>;
  let brief: Handler;
  let symbolId: number;
  let taskId: number;
  const git = (...a: string[]): string => execFileSync('git', ['-C', repoRoot, ...a], { encoding: 'utf8' });

  const responses = async (): Promise<Record<string, Payload>> => ({
    world_model_get: parse(await wm['world_model_get']!({ agent: 'bro', repo: 'app' })),
    'world_model_get path-not-found': parse(await wm['world_model_get']!({ agent: 'bro', repo: 'app', path: 'no/such' })),
    world_model_search: parse(await wm['world_model_search']!({ agent: 'bro', repo: 'app', query: 'quokka', mode: 'keyword' })),
    'world_model_symbol by id': parse(await wm['world_model_symbol']!({ agent: 'bro', id: symbolId })),
    'world_model_symbol by name': parse(
      await wm['world_model_symbol']!({ agent: 'bro', repo: 'app', qualified_name: 'b', path: 'src/b.ts' }),
    ),
    'task_brief scope': parse(await brief({ agent: 'bro', task_id: taskId, section: 'scope' })),
  });

  const assertNoLag = (all: Record<string, Payload>): void => {
    for (const [name, out] of Object.entries(all)) {
      for (const key of LAG_KEYS) assert.ok(!(key in out), `${name} carries no ${key}`);
    }
  };

  before(async () => {
    ws = mkdtempSync(join(tmpdir(), 'wm-lag-'));
    repoRoot = join(ws, 'app');
    const files: Record<string, string> = {
      'README.md': '# App\n\nFixture application.\n',
      'src/b.ts': 'export const b = 1;\n',
      'lib/zeta.ts': '// Quokka handshake negotiator.\n',
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

    db = tempDB();
    holder = GraphHolder.fixed(new WorldModelGraph(db));
    const scan = (await scanTools(db, holder, ':memory:').handlers['scan_run']!({ agent: 'bro', session_dir: ws })) as CallToolResult;
    assert.ok(!scan.isError, JSON.stringify(scan.content));
    db.run(`UPDATE repos SET target_branch = 'main' WHERE name = 'app'`);
    wm = worldModelTools(db, holder).handlers as Record<string, Handler>;
    brief = compositeTools(db, ':memory:', holder).handlers['task_brief'] as Handler;
    symbolId = db.get<{ id: number }>(`SELECT id FROM wm_symbols WHERE path = 'src/b.ts' AND qualified_name = 'b'`)!.id;

    db.run(
      `INSERT INTO issues (objective, description, status, created_at, updated_at)
       VALUES ('o', 'd', 'open', datetime('now'), datetime('now'))`,
    );
    db.run(
      `INSERT INTO tasks (issue_id, branch_id, title, description, status, spec_body, files, repo, created_at, updated_at)
       VALUES (last_insert_rowid(), 'fix/1966-lag', 't', 'd', 'pending', '## Description', '["src/b.ts"]', 'app', datetime('now'), datetime('now'))`,
    );
    taskId = db.get<{ id: number }>('SELECT last_insert_rowid() AS id')!.id;
  });

  after(() => {
    db.close();
    rmSync(ws, { recursive: true, force: true });
  });

  it('GH 1966: with no origin remote, no tool carries the lag fields', async () => {
    assert.equal(checkoutLag(db, 'app'), null);
    assertNoLag(await responses());
  });

  it('GH 1966: with the checkout at the upstream tip, no tool carries the lag fields', async () => {
    const origin = join(ws, 'origin.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
    git('remote', 'add', 'origin', origin);
    git('push', '-q', 'origin', 'main');
    assert.equal(checkoutLag(db, 'app'), null);
    assertNoLag(await responses());
  });

  it('GH 1966: a checkout 2 commits behind origin/main reports checkout_behind_upstream: 2 on every tool', async () => {
    git('commit', '-q', '--allow-empty', '-m', 'lane 1 merged');
    git('commit', '-q', '--allow-empty', '-m', 'lane 2 merged');
    git('push', '-q', 'origin', 'main');
    git('reset', '-q', '--hard', 'HEAD~2');

    assert.deepEqual(checkoutLag(db, 'app'), { checkout_behind_upstream: 2, upstream: 'origin/main' });
    const all = await responses();
    for (const [name, out] of Object.entries(all)) {
      assert.equal(out['checkout_behind_upstream'], 2, name);
      assert.equal(out['upstream'], 'origin/main', name);
    }
    assert.ok(all['world_model_get']!['root'], 'tree still returned');
    assert.ok((all['world_model_search']!['results'] as unknown[]).length > 0, 'search hits still returned');
    assert.equal((all['world_model_symbol by id']!['symbol'] as Payload)['qualified_name'], 'b');
    assert.ok(Array.isArray(all['task_brief scope']!['scope_world_model']));
  });

  it('GH 1966: the degraded world_model_get and world_model_search responses carry the lag fields', async () => {
    const empty = tempDB();
    try {
      empty.run(`INSERT INTO repos (name, path, target_branch) VALUES ('app', ?, 'main')`, [repoRoot]);
      const tools = worldModelTools(empty, null).handlers as Record<string, Handler>;
      const get = parse(await tools['world_model_get']!({ agent: 'bro', repo: 'app' }));
      assert.equal(get['warning'], 'world-model-unavailable');
      assert.equal(get['checkout_behind_upstream'], 2);
      const search = parse(await tools['world_model_search']!({ agent: 'bro', repo: 'app', query: 'quokka' }));
      assert.equal(search['warning'], 'world-model-unavailable');
      assert.equal(search['upstream'], 'origin/main');
      const scanned = parse(
        await worldModelTools(empty, GraphHolder.fixed(new WorldModelGraph(empty))).handlers['world_model_get']!({
          agent: 'bro',
          repo: 'app',
        }),
      );
      assert.equal(scanned['warning'], 'world-model-empty');
      assert.equal(scanned['checkout_behind_upstream'], 2);
    } finally {
      empty.close();
    }
  });

  it('GH 1966: a repo path that is not a git work tree omits the fields and leaves every response otherwise intact', async () => {
    const before = await responses();
    const nonGit = mkdtempSync(join(tmpdir(), 'wm-lag-nongit-'));
    try {
      db.run(`UPDATE repos SET path = ? WHERE name = 'app'`, [nonGit]);
      assert.equal(checkoutLag(db, 'app'), null);
      const all = await responses();
      assertNoLag(all);
      for (const [name, out] of Object.entries(all)) {
        const expected = Object.keys(before[name]!).filter((k) => !LAG_KEYS.includes(k));
        const extra = name === 'world_model_get' ? ['warning'] : [];
        assert.deepEqual(Object.keys(out).sort(), [...expected, ...extra].filter((k, i, a) => a.indexOf(k) === i).sort(), name);
      }
      assert.ok(all['world_model_get']!['root'], 'tree still returned');
      assert.ok((all['world_model_search']!['results'] as unknown[]).length > 0);
    } finally {
      db.run(`UPDATE repos SET path = ? WHERE name = 'app'`, [repoRoot]);
      rmSync(nonGit, { recursive: true, force: true });
    }
  });
});
