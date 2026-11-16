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
import { keywordSearchSymbols } from '../symbol-index.js';
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
    assert.ok(Math.abs(Number(hits[at('tests/fixtures')]!['score']) - cosine.score * 0.5) < 1e-9, show(hits));
    const scores = hits.map((h) => Number(h['score']));
    assert.deepEqual(scores, [...scores].sort((a, b) => b - a), `semantic hits stay sorted by weighted score: ${show(hits)}`);
  });
});

describe('any_term fallback ranks rows matching more query terms first (GH 3157)', () => {
  const REPO = 'r';
  const QUERY = 'alpha bravo charlie';
  const filler = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed eiusmod tempor incididunt labore dolore magna';
  const longTwoTerm = `alpha bravo ${filler} ${filler} ${filler}`;
  // Rows matching no query term keep every term's IDF high, so a short
  // 1-term row outscores the long 2-term row on bm25 alone.
  const unrelated = (add: (i: number) => void) => {
    for (let i = 0; i < 40; i++) add(i);
  };

  function file(db: ReturnType<typeof tempDB>, path: string, purpose: string): void {
    new WorldModelGraph(db).upsertFile({
      path,
      repo: REPO,
      dir: '',
      purpose,
      purpose_source: 'test',
      content_md5: 'm',
      size_bytes: 1,
      last_commit_sha: 's',
      updated_at: 't',
    });
  }

  function dir(db: ReturnType<typeof tempDB>, path: string, summary: string): void {
    new WorldModelGraph(db).upsertDirectory({
      repo: REPO,
      path,
      parent_path: null,
      summary,
      summary_source: 'test',
      summary_updated_at: null,
      file_count: 0,
    });
  }

  function symbol(db: ReturnType<typeof tempDB>, name: string, terms: string, doc = ''): void {
    db.run(
      `INSERT INTO wm_symbols (repo, path, kind, qualified_name, body_hash, terms, doc) VALUES (?, 'src/s.ts', 'function', ?, 'h', ?, ?)`,
      [REPO, name, terms, doc],
    );
  }

  // bm25 alone, the order the searchers used before GH 3157.
  function bm25Order(db: ReturnType<typeof tempDB>, table: 'wm_files' | 'wm_directories'): string[] {
    return db
      .all<{ path: string }>(
        `SELECT t.path FROM ${table}_fts CROSS JOIN ${table} t ON t.id = ${table}_fts.rowid
          WHERE ${table}_fts MATCH '"alpha" OR "bravo" OR "charlie"' ORDER BY bm25(${table}_fts), t.path`,
      )
      .map((r) => r.path);
  }

  it('keywordSearchFiles puts a 2-term row above a 1-term row with the better bm25', () => {
    const db = tempDB();
    unrelated((i) => file(db, `docs/other${i}.md`, `zulu yankee ${i}`));
    file(db, 'src/two.ts', longTwoTerm);
    file(db, 'src/one.ts', 'charlie');
    assert.equal(bm25Order(db, 'wm_files')[0], 'src/one.ts', 'premise: bm25 alone ranks the 1-term row first');
    const { hits, match } = new WorldModelGraph(db).keywordSearchFiles(REPO, QUERY, 10);
    assert.equal(match, 'any_term');
    assert.deepEqual(hits.map((h) => WorldModelGraph.relativeFilePath(h)), ['src/two.ts', 'src/one.ts']);
    db.close();
  });

  it('keywordSearchDirectories puts a 2-term row above a 1-term row with the better bm25', () => {
    const db = tempDB();
    unrelated((i) => dir(db, `other${i}`, `zulu yankee ${i}`));
    dir(db, 'two', longTwoTerm);
    dir(db, 'one', 'charlie');
    assert.equal(bm25Order(db, 'wm_directories')[0], 'one', 'premise: bm25 alone ranks the 1-term row first');
    const { hits, match } = new WorldModelGraph(db).keywordSearchDirectories(REPO, QUERY, 10);
    assert.equal(match, 'any_term');
    assert.deepEqual(hits.map((h) => h.path), ['two', 'one']);
    db.close();
  });

  it('a 2-term row bm25 places past k still comes back within k (widened pool)', () => {
    const db = tempDB();
    unrelated((i) => file(db, `docs/other${i}.md`, `zulu yankee ${i}`));
    file(db, 'src/two.ts', longTwoTerm);
    for (let i = 0; i < 6; i++) file(db, `src/noise${i}.ts`, 'charlie');
    const k = 3;
    const before = bm25Order(db, 'wm_files');
    assert.ok(before.indexOf('src/two.ts') >= k, `premise: bm25 alone ranks it past k: ${JSON.stringify(before)}`);
    const { hits, match } = new WorldModelGraph(db).keywordSearchFiles(REPO, QUERY, k);
    assert.equal(match, 'any_term');
    assert.equal(hits.length, k);
    const paths = hits.map((h) => WorldModelGraph.relativeFilePath(h));
    assert.equal(paths[0], 'src/two.ts', JSON.stringify(paths));
    db.close();
  });

  it('keywordSearchSymbols: all-terms rows first, then OR rows by matched-term count, even past bm25 top k', () => {
    const db = tempDB();
    unrelated((i) => symbol(db, `other${i}`, `zulu yankee ${i}`));
    symbol(db, 'allThree', 'alpha bravo charlie');
    // A doc match weighs less than a name match, so bm25 sinks this row.
    symbol(db, 'twoTerms', 'two terms', longTwoTerm);
    for (let i = 0; i < 6; i++) symbol(db, `oneTerm${i}`, 'charlie');
    const k = 3;
    const bm25Only = db
      .all<{ qualified_name: string }>(
        `SELECT s.qualified_name FROM wm_symbols_fts CROSS JOIN wm_symbols s ON s.id = wm_symbols_fts.rowid
          WHERE wm_symbols_fts MATCH '"alpha" OR "bravo" OR "charlie"' ORDER BY bm25(wm_symbols_fts, 10.0, 3.0, 4.0), s.id`,
      )
      .map((r) => r.qualified_name);
    assert.ok(bm25Only.indexOf('twoTerms') >= k, `premise: bm25 alone ranks it past k: ${JSON.stringify(bm25Only)}`);
    const { hits, match } = keywordSearchSymbols(db, REPO, QUERY, k);
    assert.equal(match, 'any_term');
    const names = hits.map((h) => h.qualified_name);
    assert.deepEqual(names, ['allThree', 'twoTerms', 'oneTerm0'], JSON.stringify(names));
    db.close();
  });

  it('rows matching the same number of terms keep bm25 order', () => {
    const db = tempDB();
    file(db, 'src/long.ts', `alpha bravo ${filler}`);
    file(db, 'src/short.ts', 'alpha bravo');
    const { hits } = new WorldModelGraph(db).keywordSearchFiles(REPO, QUERY, 10);
    assert.deepEqual(hits.map((h) => WorldModelGraph.relativeFilePath(h)), ['src/short.ts', 'src/long.ts']);
    db.close();
  });
});
