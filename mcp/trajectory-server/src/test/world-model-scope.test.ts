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
import { resetEmbeddingModelForTests } from '../embeddings/model.js';
import { frameUntrusted } from '../utils/untrusted.js';
import { pinScanEnv, tempDB } from './helpers.js';

const scanPin = pinScanEnv();
after(() => scanPin.restore());
resetEmbeddingModelForTests(async () => {
  throw new Error('no model in tests');
});
after(() => resetEmbeddingModelForTests());

type Payload = Record<string, unknown>;

interface ScopeFile {
  path: string;
  score: number;
  via: string[];
}

interface Scope {
  repo: string;
  files: ScopeFile[];
  tests: Array<{ path: string; via: string }>;
  runners: Array<{ runner: string; path: string; command: string; via: string }>;
  unresolved_anchors: string[];
  draft: { files: string[]; verification: string[] };
}

function text(r: CallToolResult): string {
  return (r.content[0] as { text: string }).text;
}

function parse<T = Payload>(r: CallToolResult): T {
  assert.ok(!r.isError, text(r));
  return JSON.parse(text(r)) as T;
}

const FILES: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'app', scripts: { lint: 'eslint src', test: 'node --test tests/*.test.mjs' } }, null, 2) + '\n',
  'src/billing.ts': 'export function chargeCard(amount: number): number {\n  return amount * 2;\n}\n',
  'src/checkout.ts': "import { chargeCard } from './billing.js';\n\nexport function checkout(): number {\n  return chargeCard(5);\n}\n",
  'src/report.ts': "import { chargeCard } from './billing.js';\n\nexport const charger = chargeCard;\n",
  'src/ledger.ts': '// The quokka ledger of every invoice.\nexport const quokkaLedger: number[] = [];\n',
  'src/sub/deep.ts': 'export const deep = 1;\n',
  'tests/billing.test.mjs': "import { chargeCard } from '../src/billing.js';\n\nchargeCard(1);\n",
  'tests/wombat.test.mjs': '// The wombat refund suite.\nexport const wombatRefund = 1;\n',
  'docs/guide.txt': 'guide\n',
};

describe('scope_suggest and world_model_get fields (GH 2327)', () => {
  const ws = mkdtempSync(join(tmpdir(), 'wm-scope-'));
  const root = join(ws, 'app');
  const db = tempDB();
  const holder = GraphHolder.fixed(new WorldModelGraph(db));
  const wm = worldModelTools(db, holder).handlers;
  const suggest = async (args: Payload): Promise<CallToolResult> => wm['scope_suggest']!({ agent: 'bro', repo: 'app', ...args });

  before(async () => {
    for (const [p, body] of Object.entries(FILES)) {
      mkdirSync(join(root, p, '..'), { recursive: true });
      writeFileSync(join(root, p), body);
    }
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 't@t.io'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
    execFileSync('git', ['add', '-A'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'c'], { cwd: root });
    parse((await scanTools(db, holder, ':memory:').handlers['scan_run']!({ agent: 'bro', session_dir: ws })) as CallToolResult);
  });

  after(() => {
    db.close();
    rmSync(ws, { recursive: true, force: true });
  });

  it('SC1: files are ranked by score, each via naming search, anchor, caller:<name> or import:<name>', async () => {
    const scope = parse<Scope>(await suggest({ objective: 'quokka ledger', anchors: ['chargeCard'] }));
    const byPath = new Map(scope.files.map((f) => [f.path, f]));
    assert.deepEqual(byPath.get('src/billing.ts')?.via, ['anchor']);
    assert.deepEqual(byPath.get('src/checkout.ts')?.via.sort(), ['caller:chargeCard', 'import:chargeCard']);
    assert.deepEqual(byPath.get('src/report.ts')?.via, ['import:chargeCard']);
    assert.ok(byPath.get('src/ledger.ts')?.via.includes('search'), JSON.stringify(scope.files));
    const scores = scope.files.map((f) => f.score);
    assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
    assert.ok(byPath.get('src/billing.ts')!.score > byPath.get('src/report.ts')!.score);
    assert.ok(byPath.get('src/report.ts')!.score > byPath.get('src/ledger.ts')!.score);
    for (const f of scope.files) {
      assert.deepEqual(Object.keys(f).sort(), ['path', 'score', 'via']);
      for (const via of f.via) assert.match(via, /^(search|anchor|caller:.+|import:.+)$/);
    }
  });

  it('SC2: tests, runners and the draft come back; an unknown anchor is listed, not fatal', async () => {
    const scope = parse<Scope>(await suggest({ objective: '', anchors: ['chargeCard', 'noSuchSymbol', 'src/ledger.ts'] }));
    assert.deepEqual(scope.tests, [{ path: 'tests/billing.test.mjs', via: 'test_of:chargeCard' }]);
    assert.deepEqual(scope.unresolved_anchors, ['noSuchSymbol']);
    assert.deepEqual(scope.files.find((f) => f.path === 'src/ledger.ts')?.via, ['anchor']);
    assert.ok(scope.files.every((f) => !f.via.includes('search')));
    assert.deepEqual(
      scope.runners.map(({ runner, path, via }) => ({ runner, path, via })),
      [
        { runner: 'lint', path: 'package.json', via: 'covers:src' },
        { runner: 'test', path: 'package.json', via: 'covers:tests' },
      ],
    );
    assert.equal(scope.runners[0]!.command, frameUntrusted('runner-command', 'eslint src'));
    assert.deepEqual(scope.draft.files, scope.files.map((f) => f.path));
    assert.deepEqual(scope.draft.verification, [
      frameUntrusted('runner-command', 'eslint src'),
      frameUntrusted('runner-command', 'node --test tests/*.test.mjs'),
    ]);
  });

  it('SC2: with nothing qualifying, tests, runners and unresolved_anchors are empty arrays', async () => {
    const scope = parse<Scope>(await suggest({ objective: 'zzzqqq nothingmatches' }));
    assert.deepEqual(scope.files, []);
    assert.deepEqual(scope.tests, []);
    assert.deepEqual(scope.runners, []);
    assert.deepEqual(scope.unresolved_anchors, []);
    assert.deepEqual(scope.draft, { files: [], verification: [] });
  });

  it('SC2: a missing or blank objective with no anchors is an error, and swe may not call it', async () => {
    for (const args of [{}, { objective: '' }, { objective: '   ', anchors: [] }]) {
      const r = await suggest(args);
      assert.equal(r.isError, true, JSON.stringify(args));
      assert.match(text(r), /objective is required/);
    }
    assert.equal((await suggest({ objective: 'x', anchors: 'chargeCard' })).isError, true);
    const denied = await wm['scope_suggest']!({ agent: 'swe', repo: 'app', objective: 'quokka' });
    assert.equal(denied.isError, true);
  });

  it('GH 2529: a test file found by search goes to tests[] with via search, not files[] or draft.files', async () => {
    const scope = parse<Scope>(await suggest({ objective: 'wombat refund' }));
    assert.deepEqual(scope.tests.find((t) => t.path === 'tests/wombat.test.mjs'), { path: 'tests/wombat.test.mjs', via: 'search' });
    assert.ok(!scope.files.some((f) => f.path === 'tests/wombat.test.mjs'), JSON.stringify(scope.files));
    assert.ok(!scope.draft.files.includes('tests/wombat.test.mjs'));
    assert.ok(scope.runners.some((r) => r.via === 'covers:tests'), JSON.stringify(scope.runners));
  });

  it('GH 2529: the schema requires only agent; anchors without an objective succeed, neither errors', async () => {
    const def = worldModelTools(db, holder).definitions.find((d) => d.name === 'scope_suggest');
    assert.deepEqual(def?.inputSchema.required, ['agent']);
    const scope = parse<Scope>(await suggest({ anchors: ['chargeCard'] }));
    assert.ok(scope.files.some((f) => f.path === 'src/billing.ts'));
    const r = await suggest({});
    assert.equal(r.isError, true);
    assert.match(text(r), /objective is required/);
  });

  it('SC1: k caps the search seeds', async () => {
    const scope = parse<Scope>(await suggest({ objective: 'chargeCard quokka ledger checkout', k: 1 }));
    assert.equal(scope.files.filter((f) => f.via.includes('search')).length, 1);
  });

  it("SC3: fields ['path','purpose'] keeps path and children on nodes and path and purpose on files[]", async () => {
    const out = parse<{ root: Payload }>(await wm['world_model_get']!({ agent: 'bro', repo: 'app', path: 'src', fields: ['path', 'purpose'] }));
    const node = out.root;
    assert.deepEqual(Object.keys(node).sort(), ['children', 'files', 'path']);
    const children = node['children'] as Payload[];
    assert.deepEqual(children.map((c) => c['path']), ['src/sub']);
    assert.deepEqual(Object.keys(children[0]!).sort(), ['children', 'path']);
    const files = node['files'] as Payload[];
    assert.ok(files.length > 0);
    for (const f of files) assert.deepEqual(Object.keys(f).sort(), ['path', 'purpose']);
  });

  it('SC3: without fields the output is unchanged, and naming every field reproduces it byte for byte', async () => {
    const plain = text(await wm['world_model_get']!({ agent: 'bro', repo: 'app', path: 'src' }));
    const root = (JSON.parse(plain) as { root: Payload }).root;
    assert.deepEqual(Object.keys(root), [
      'path', 'summary', 'summary_source', 'summary_updated_at', 'file_count', 'summary_sha', 'commits_behind',
      'dead_refs', 'trust', 'covered_by', 'children', 'files',
    ]);
    assert.deepEqual(Object.keys((root['files'] as Payload[])[0]!), ['path', 'purpose', 'purpose_source', 'content_md5']);
    const every = [
      'path', 'summary', 'summary_source', 'summary_updated_at', 'file_count', 'summary_sha', 'commits_behind',
      'dead_refs', 'trust', 'covered_by', 'covered_by_truncated', 'children', 'files', 'purpose', 'purpose_source', 'content_md5',
    ];
    assert.equal(text(await wm['world_model_get']!({ agent: 'bro', repo: 'app', path: 'src', fields: every })), plain);
  });

  it("SC3: an unknown field such as 'nope' is rejected with the valid fields named", async () => {
    const r = await wm['world_model_get']!({ agent: 'bro', repo: 'app', path: 'src', fields: ['path', 'nope'] });
    assert.equal(r.isError, true);
    assert.match(text(r), /unknown field\(s\) nope; valid fields: path, summary, .*purpose, purpose_source, content_md5/);
  });
});
