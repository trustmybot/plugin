import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { GraphHolder, WorldModelGraph } from '../graph.js';
import { scanTools } from '../tools/scan.js';
import { lookupRepoPath, worldModelTools } from '../tools/world_model.js';
import { resetEmbeddingModelForTests } from '../embeddings/model.js';
import { pinScanEnv, tempDB } from './helpers.js';

const scanPin = pinScanEnv();
after(() => scanPin.restore());
resetEmbeddingModelForTests(() => Promise.reject(new Error('no model in tests')));
after(() => resetEmbeddingModelForTests());

type Payload = Record<string, unknown>;

function text(r: CallToolResult): string {
  return (r.content[0] as { text: string }).text;
}

function parse<T = Payload>(r: CallToolResult): T {
  assert.ok(!r.isError, text(r));
  return JSON.parse(text(r)) as T;
}

// The repo is named `app` and also holds a real `app/` directory, so the
// exact-first rule is observable.
const FILES: Record<string, string> = {
  'src/billing.ts': 'export function chargeCard(amount: number): number {\n  return amount * 2;\n}\n',
  'src/checkout.ts': "import { chargeCard } from './billing.js';\n\nexport function checkout(): number {\n  return chargeCard(5);\n}\n",
  'app/billing.ts': 'export function chargeCard(amount: number): number {\n  return amount * 3;\n}\n',
};

describe('repo-name-prefixed paths (GH 3175)', () => {
  const ws = mkdtempSync(join(tmpdir(), 'wm-prefix-'));
  const root = join(ws, 'app');
  const db = tempDB();
  const holder = GraphHolder.fixed(new WorldModelGraph(db));
  const wm = worldModelTools(db, holder).handlers;
  const call = async (tool: string, args: Payload): Promise<Payload> =>
    parse(await wm[tool]({ agent: 'bro', repo: 'app', ...args }));

  before(async () => {
    for (const [p, body] of Object.entries(FILES)) {
      mkdirSync(join(root, p, '..'), { recursive: true });
      writeFileSync(join(root, p), body);
    }
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, timeout: 30_000 });
    execFileSync('git', ['config', 'user.email', 't@t.io'], { cwd: root, timeout: 30_000 });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: root, timeout: 30_000 });
    execFileSync('git', ['add', '-A'], { cwd: root, timeout: 30_000 });
    execFileSync('git', ['commit', '-qm', 'c'], { cwd: root, timeout: 30_000 });
    parse(await scanTools(db, holder, ':memory:').handlers['scan_run']({ agent: 'bro', session_dir: ws }));
  });

  after(() => {
    db.close();
    rmSync(ws, { recursive: true, force: true });
  });

  it('SC1: world_model_get on <repo>/<dir> returns the <dir> tree with path_normalized', async () => {
    const plain = await call('world_model_get', { path: 'src' });
    const prefixed = await call('world_model_get', { path: 'app/src' });
    assert.equal(prefixed['warning'], undefined);
    assert.equal(prefixed['path_normalized'], 'src');
    assert.deepEqual(prefixed['root'], plain['root']);
    assert.equal(plain['path_normalized'], undefined);
  });

  it('SC2: world_model_symbol with path <repo>/<file> finds the symbol and reports path_normalized', async () => {
    const r = await call('world_model_symbol', { qualified_name: 'checkout', path: 'app/src/checkout.ts' });
    assert.equal(r['path_normalized'], 'src/checkout.ts');
    assert.equal((r['symbol'] as { path: string }).path, 'src/checkout.ts');
  });

  it('SC2: a scope_suggest file anchor <repo>/<file> resolves and is reported as normalized', async () => {
    const r = await call('scope_suggest', { anchors: ['app/src/checkout.ts', 'app/src/missing.ts'] });
    assert.deepEqual(r['unresolved_anchors'], ['app/src/missing.ts']);
    assert.deepEqual(r['normalized_anchors'], [{ anchor: 'app/src/checkout.ts', path_normalized: 'src/checkout.ts' }]);
    const files = (r['files'] as Array<{ path: string }>).map((f) => f.path);
    assert.ok(files.includes('src/checkout.ts'), JSON.stringify(files));
  });

  it('SC3: a path that exists as given is never stripped', async () => {
    const dir = await call('world_model_get', { path: 'app' });
    assert.equal(dir['warning'], undefined);
    assert.equal(dir['path_normalized'], undefined);
    assert.equal((dir['root'] as { path: string }).path, 'app');

    const sym = await call('world_model_symbol', { qualified_name: 'chargeCard', path: 'app/billing.ts' });
    assert.equal(sym['path_normalized'], undefined);
    assert.equal((sym['symbol'] as { path: string }).path, 'app/billing.ts');

    const scope = await call('scope_suggest', { anchors: ['app/billing.ts'] });
    assert.deepEqual(scope['unresolved_anchors'], []);
    assert.equal(scope['normalized_anchors'], undefined);
  });

  it('SC3: genuine misses still return path-not-found with no path_normalized', async () => {
    for (const path of ['nope', 'app/nope', 'other/src']) {
      const r = await call('world_model_get', { path });
      assert.equal(r['warning'], 'path-not-found', path);
      assert.equal(r['path'], path);
      assert.equal(r['path_normalized'], undefined);
    }
  });

  it('lookupRepoPath strips only a segment naming a searched repo, in that repo', () => {
    const seen: Array<[readonly string[], string]> = [];
    const lookup = (repos: readonly string[], p: string): string | null => {
      seen.push([repos, p]);
      return repos.length === 1 && repos[0] === 'b' && p === 'x/y' ? 'hit' : null;
    };
    assert.deepEqual(lookupRepoPath(['a', 'b'], 'b/x/y', lookup), { value: 'hit', path_normalized: 'x/y' });
    assert.deepEqual(seen, [[['a', 'b'], 'b/x/y'], [['b'], 'x/y']]);
    assert.equal(lookupRepoPath(['a', 'b'], 'c/x/y', lookup), null);
    assert.deepEqual(lookupRepoPath(['a'], 'x', () => 'exact'), { value: 'exact' });
  });
});
