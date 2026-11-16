// GH 3144: a world_model_symbol name miss returns ranked near matches.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { WorldModelGraph, GraphHolder } from '../graph.js';
import { scanTools } from '../tools/scan.js';
import { worldModelTools } from '../tools/world_model.js';
import type { TrajectoryDB } from '../db.js';
import { resetEmbeddingModelForTests } from '../embeddings/model.js';
import { pinScanEnv, tempDB } from './helpers.js';

const scanPin = pinScanEnv();
after(() => scanPin.restore());
resetEmbeddingModelForTests(() => Promise.reject(new Error('no model in tests')));
after(() => resetEmbeddingModelForTests());

type Payload = Record<string, unknown>;
type Handler = (args: Payload) => Promise<CallToolResult>;
interface Near {
  id: number;
  qualified_name: string;
  kind: string;
  repo: string;
  path: string;
  line: number;
}

const text = (r: CallToolResult): string => (r.content[0] as { text: string }).text;

function parse(r: CallToolResult): Payload {
  assert.ok(!r.isError, text(r));
  return JSON.parse(text(r)) as Payload;
}

describe('world_model_symbol near matches on a name miss (GH 3144)', () => {
  let ws: string;
  let db: TrajectoryDB;
  let wm: Record<string, Handler>;
  const symbol = (args: Payload): Promise<CallToolResult> => wm['world_model_symbol']({ agent: 'bro', repo: 'app', ...args });

  before(async () => {
    ws = mkdtempSync(join(tmpdir(), 'wm-near-'));
    const repoRoot = join(ws, 'app');
    const files: Record<string, string> = {
      'README.md': '# App\n\nFixture application.\n',
      'src/path-classes.ts': [
        'export function classifyPath(p: string): string { return p; }',
        'export function classifyChange(paths: string[]): string[] { return paths.map(classifyPath); }',
        '',
      ].join('\n'),
      'src/tools/review.ts': [
        'declare function requireRoles(name: string, fn: () => Promise<number>): () => Promise<number>;',
        "export const reviewTools = { review_handoff: requireRoles('review_handoff', async () => 1) };",
        '',
      ].join('\n'),
      'src/noise.ts': [
        'export function quokkaSpin(): number { return 1; }',
        'export function unrelatedHelper(): number { return 2; }',
        'export function changeLog(): number { return 3; }',
        '',
      ].join('\n'),
    };
    for (const [p, body] of Object.entries(files)) {
      mkdirSync(join(repoRoot, p, '..'), { recursive: true });
      writeFileSync(join(repoRoot, p), body);
    }
    const git = (...a: string[]): string => execFileSync('git', ['-C', repoRoot, ...a], { encoding: 'utf8', timeout: 30_000 });
    execFileSync('git', ['init', '-q', '-b', 'main', repoRoot], { timeout: 30_000 });
    git('config', 'user.email', 't@t.io');
    git('config', 'user.name', 't');
    git('add', '.');
    git('commit', '-qm', 'init');

    db = tempDB();
    const holder = GraphHolder.fixed(new WorldModelGraph(db));
    const scan = (await scanTools(db, holder, ':memory:').handlers['scan_run']({ agent: 'bro', session_dir: ws }));
    assert.ok(!scan.isError, text(scan));
    db.run(`UPDATE repos SET target_branch = 'main' WHERE name = 'app'`);
    wm = worldModelTools(db, holder).handlers;
  });

  after(() => {
    db.close();
    rmSync(ws, { recursive: true, force: true });
  });

  it('classifyChangedPaths suggests classifyChange first, as a non-error not_found result', async () => {
    const out = parse(await symbol({ qualified_name: 'classifyChangedPaths' }));
    const hit = parse(await symbol({ qualified_name: 'classifyChange' }));
    assert.equal(out['symbol'], null);
    assert.equal(out['warning'], 'not_found');
    assert.equal(out['message'], 'symbol classifyChangedPaths not found in repo app');
    assert.equal(out['repo_source'], hit['repo_source']);
    const near = out['did_you_mean'] as Near[];
    assert.ok(near.length > 0 && near.length <= 5, JSON.stringify(near));
    assert.equal(near[0].qualified_name, 'classifyChange');
    assert.deepEqual(Object.keys(near[0]).sort(), ['id', 'kind', 'line', 'path', 'qualified_name', 'repo']);
    assert.deepEqual(
      { ...near[0], id: 0 },
      { id: 0, qualified_name: 'classifyChange', kind: 'function', repo: 'app', path: 'src/path-classes.ts', line: 2 },
    );
    assert.ok(!near.some((n) => n.qualified_name === 'quokkaSpin' || n.qualified_name === 'unrelatedHelper'));
  });

  it('reviewHandoff suggests tool:review_handoff', async () => {
    const out = parse(await symbol({ qualified_name: 'reviewHandoff' }));
    const near = out['did_you_mean'] as Near[];
    assert.ok(near.length > 0, JSON.stringify(out));
    assert.ok(near.some((n) => n.qualified_name === 'tool:review_handoff' && n.path === 'src/tools/review.ts'), JSON.stringify(near));
  });

  it('a wrong path still finds the right name elsewhere in the repo', async () => {
    const out = parse(await symbol({ qualified_name: 'classifyChange', path: 'src/noise.ts' }));
    assert.equal((out['did_you_mean'] as Near[])[0].path, 'src/path-classes.ts');
  });

  it('with no repo resolved, candidates come from every repo', async () => {
    db.run(`INSERT INTO repos (name, path) VALUES ('other', ?)`, [join(ws, 'missing-other')]);
    try {
      const out = parse(await wm['world_model_symbol']({ agent: 'bro', qualified_name: 'classifyChangedPaths' }));
      assert.equal(out['repo_source'], 'all');
      assert.equal((out['did_you_mean'] as Near[])[0].qualified_name, 'classifyChange');
      assert.equal(out['message'], 'symbol classifyChangedPaths not found in any repo');
    } finally {
      db.run(`DELETE FROM repos WHERE name = 'other'`);
    }
  });

  it('a miss with no candidate keeps the is_error result', async () => {
    const r = await symbol({ qualified_name: 'zzzNoSuchThing' });
    assert.equal(r.isError, true);
    assert.match(text(r), /symbol zzzNoSuchThing not found in repo app/);
  });
});
