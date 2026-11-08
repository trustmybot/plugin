import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { GraphHolder, WorldModelGraph } from '../graph.js';
import { scanTools } from '../tools/scan.js';
import { worldModelTools } from '../tools/world_model.js';
import { frameUntrusted } from '../utils/untrusted.js';
import { pinScanEnv, tempDB } from './helpers.js';

const scanPin = pinScanEnv();
after(() => scanPin.restore());

interface Node {
  path: string;
  covered_by?: Array<{ runner: string; path: string; line: number; command: string }>;
  covered_by_truncated?: true;
  children: Node[];
}

function text(r: CallToolResult): string {
  assert.ok(!r.isError, (r.content[0] as { text: string }).text);
  return (r.content[0] as { text: string }).text;
}

describe('world_model_get lists the runners covering each directory (GH 2326)', () => {
  const ws = mkdtempSync(join(tmpdir(), 'wm-covered-by-'));
  const root = join(ws, 'app');
  const db = tempDB();
  const holder = GraphHolder.fixed(new WorldModelGraph(db));
  const wm = worldModelTools(db, holder).handlers;
  const scripts: Record<string, string> = { test: 'node --test tests/unit/*.test.mjs', lint: 'eslint src' };
  for (let i = 0; i < 11; i++) scripts[`lint${i}`] = 'eslint lib';
  const PACKAGE_JSON = JSON.stringify({ name: 'app', scripts }, null, 2) + '\n';

  const tree = async (): Promise<Map<string, Node>> => {
    const payload = JSON.parse(
      text((await wm['world_model_get']!({ agent: 'bro', repo: 'app', depth: null })) as CallToolResult),
    ) as { root: Node };
    const nodes = new Map<string, Node>();
    const visit = (n: Node): void => {
      nodes.set(n.path, n);
      n.children.forEach(visit);
    };
    visit(payload.root);
    return nodes;
  };

  before(async () => {
    const files: Record<string, string> = {
      'package.json': PACKAGE_JSON,
      'src/a.ts': 'export const a = 1;\n',
      'lib/b.ts': 'export const b = 2;\n',
      'lib/inner/c.ts': 'export const c = 3;\n',
      'tests/unit/a.test.mjs': 'export const t = 1;\n',
      'tests/unit/sub/b.test.mjs': 'export const u = 1;\n',
      'docs/guide.txt': 'guide\n',
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
    text((await scanTools(db, holder, ':memory:').handlers['scan_run']!({ agent: 'bro', session_dir: ws })) as CallToolResult);
  });

  after(() => {
    db.close();
    rmSync(ws, { recursive: true, force: true });
  });

  it('a glob runner sits under the directory it covers and under its subdirectory; an uncovered directory has no covered_by', async () => {
    const nodes = await tree();
    const expected = {
      runner: 'test',
      path: 'package.json',
      line: PACKAGE_JSON.split('\n').findIndex((l) => l.includes('"test"')) + 1,
      command: frameUntrusted('runner-command', 'node --test tests/unit/*.test.mjs'),
    };
    assert.deepEqual(nodes.get('tests/unit')?.covered_by, [expected]);
    assert.deepEqual(nodes.get('tests/unit/sub')?.covered_by, [expected]);
    assert.deepEqual(nodes.get('src')?.covered_by?.map((r) => r.runner), ['lint']);
    for (const p of ['', 'docs', 'tests']) {
      assert.ok(nodes.has(p), `${p} in the tree`);
      assert.equal('covered_by' in nodes.get(p)!, false, `${p} carries no covered_by`);
      assert.equal('covered_by_truncated' in nodes.get(p)!, false);
    }
  });

  it('more than 10 covering runners are cut to 10 with covered_by_truncated, the inherited list too', async () => {
    const nodes = await tree();
    for (const p of ['lib', 'lib/inner']) {
      const node = nodes.get(p)!;
      assert.equal(node.covered_by?.length, 10, p);
      assert.equal(node.covered_by_truncated, true, p);
      assert.deepEqual(node.covered_by?.map((r) => r.runner), Array.from({ length: 10 }, (_, i) => `lint${i}`));
    }
    assert.equal('covered_by_truncated' in nodes.get('src')!, false);
  });
});
