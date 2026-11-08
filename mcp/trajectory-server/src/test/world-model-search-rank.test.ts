import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { GraphHolder, WorldModelGraph } from '../graph.js';
import { resetEmbeddingModelForTests } from '../embeddings/model.js';
import { topKByCosine } from '../embeddings/store.js';
import { scanTools } from '../tools/scan.js';
import { worldModelTools } from '../tools/world_model.js';
import { bagOfWordsLoader, pinScanEnv, tempDB } from './helpers.js';

const scanPin = pinScanEnv();
after(() => scanPin.restore());

type Hit = Record<string, unknown>;

const FILES: Record<string, string> = {
  'README.md': '# App\n\nFixture application.\n',
  'skills/review/README.md': '# review\n\nReview findings wontfix: how the reviewer triages review findings marked wontfix.\n',
  'skills/review/SKILL.md': '# Review skill\n\nReview findings wontfix steps.\n',
  'tests/l5-l6/rows/19/README.md': '# Row 19\n\nReview findings wontfix row: replays review findings marked wontfix.\n',
  'tests/l5-l6/rows/19/run.ts': '// Replays review findings wontfix.\nexport function replayRow19(): void {}\n',
  'tests/fixtures/README.md': '# fixtures\n\nReview findings wontfix fixtures for review findings marked wontfix.\n',
  'tests/fixtures/wontfix.json': '{"review": "findings", "wontfix": true}\n',
  'changelog.d/1500-review-findings-wontfix.md': '### Fixed\n- Review findings wontfix are recorded once.\n',
  'src/validation.ts':
    "import { strict } from 'node:assert';\n\nexport const VALIDATION_MAX = 3;\n\n/** Records review findings marked wontfix. */\nexport function recordWontfix(reviewFindings: string[]): string[] {\n  strict.ok(reviewFindings.length <= VALIDATION_MAX);\n  return reviewFindings;\n}\n",
};

const isAux = (path: string) => path === 'tests' || path.startsWith('tests/') || path === 'changelog.d' || path.startsWith('changelog.d/');
const isSource = (r: Hit) => r['path'] === 'src/validation.ts';

describe('world_model_search ranks source above tests, fixtures, changelog and prose dirs (GH 1967)', () => {
  const ws = mkdtempSync(join(tmpdir(), 'wm-rank-'));
  const root = join(ws, 'app');
  const db = tempDB();
  const holder = GraphHolder.fixed(new WorldModelGraph(db));

  before(async () => {
    for (const [p, body] of Object.entries(FILES)) {
      mkdirSync(join(root, p, '..'), { recursive: true });
      writeFileSync(join(root, p), body);
    }
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 't@t.io'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
    execFileSync('git', ['add', '-A'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: root });
    const r = (await scanTools(db, holder, ':memory:').handlers['scan_run']!({ agent: 'bro', session_dir: ws })) as CallToolResult;
    assert.ok(!r.isError, (r.content[0] as { text: string }).text);
  });

  afterEach(() => resetEmbeddingModelForTests());

  after(() => {
    db.close();
    rmSync(ws, { recursive: true, force: true });
  });

  async function search(mode: string): Promise<Hit[]> {
    const r = (await worldModelTools(db, holder).handlers['world_model_search']!({
      agent: 'bro',
      repo: 'app',
      query: 'review findings wontfix',
      mode,
      k: 20,
    })) as CallToolResult;
    assert.ok(!r.isError, (r.content[0] as { text: string }).text);
    return (JSON.parse((r.content[0] as { text: string }).text) as { results: Hit[] }).results;
  }

  const show = (hits: Hit[]) => JSON.stringify(hits.map((h) => [h['kind'], h['path'], h['qualified_name'], h['score']]));

  function assertSourceLeads(hits: Hit[], top: number): void {
    const first = hits.findIndex(isSource);
    assert.ok(first >= 0 && first < top, `source in the top ${top}: ${show(hits)}`);
    const aux = hits.filter((h) => isAux(String(h['path'])));
    assert.ok(aux.some((h) => h['kind'] === 'dir'), `test and changelog dirs stay in the results: ${show(hits)}`);
    for (const p of ['tests/l5-l6/rows/19', 'tests/fixtures']) {
      assert.ok(hits.some((h) => h['kind'] === 'dir' && h['path'] === p), `${p} is not dropped: ${show(hits)}`);
    }
    for (const h of aux) assert.ok(hits.indexOf(h) > first, `${String(h['path'])} ranks below the source: ${show(hits)}`);
  }

  it('keyword: src/validation.ts or recordWontfix is in the top 3, every tests/ and changelog.d/ hit below it', async () => {
    const hits = await search('keyword');
    assertSourceLeads(hits, 3);
    assert.ok(hits.some((h) => h['kind'] === 'symbol' && h['qualified_name'] === 'recordWontfix'), show(hits));
    assert.ok(hits.some((h) => h['path'] === 'changelog.d/1500-review-findings-wontfix.md'), `the changelog fragment is not dropped: ${show(hits)}`);
  });

  it('hybrid with embeddings: the source is in the top 5, every tests/ and changelog.d/ hit below it', async () => {
    resetEmbeddingModelForTests(bagOfWordsLoader());
    const r = (await worldModelTools(db, holder).handlers['world_model_search']!({
      agent: 'bro',
      repo: 'app',
      query: 'review findings wontfix',
      k: 20,
    })) as CallToolResult;
    const out = JSON.parse((r.content[0] as { text: string }).text) as { results: Hit[]; warning?: string };
    assert.equal(out.warning, undefined, 'the embedding model answered, so RRF fusion ran');
    assertSourceLeads(out.results, 5);
  });

  it('semantic: a test dir weighs half, so it ranks below the source dir with the same words and stays in the results', async () => {
    resetEmbeddingModelForTests(bagOfWordsLoader());
    const hits = await search('semantic');
    const at = (p: string) => hits.findIndex((h) => h['kind'] === 'dir' && h['path'] === p);
    assert.ok(at('tests/fixtures') >= 0, `tests/fixtures is not dropped: ${show(hits)}`);
    assert.ok(at('skills/review') < at('tests/fixtures'), show(hits));
    const rowid = db.get<{ rowid: number }>(`SELECT id AS rowid FROM wm_directories WHERE repo = 'app' AND path = 'tests/fixtures'`)!.rowid;
    const cosine = (await topKByCosine(db, 'wm_directories', 'review findings wontfix', 100, ['app'])).find((r) => r.rowid === rowid)!;
    assert.ok(Math.abs(Number(hits[at('tests/fixtures')]!['score']) - cosine.score * 0.5) < 1e-9, show(hits));    const scores = hits.map((h) => Number(h['score']));
    assert.deepEqual(scores, [...scores].sort((a, b) => b - a), `semantic hits stay sorted by weighted score: ${show(hits)}`);
  });
});
