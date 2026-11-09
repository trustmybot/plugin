// needs_review on world_model_get, world_model_search and world_model_symbol
// (GH 2584): concepts a reindex flags suspect or broken, and dirs whose README
// a reindex changed, listed until bro has seen them.
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pinScanEnv, tempDB, type ScanEnvPin } from './helpers.js';
import type { TrajectoryDB } from '../db.js';
import { GraphHolder, WorldModelGraph } from '../graph.js';
import { scanTools } from '../tools/scan.js';
import { worldModelTools } from '../tools/world_model.js';
import { reindexIdle } from '../world-model/freshness.js';
import { resetEmbeddingModelForTests } from '../embeddings/model.js';

type Raw = { content: Array<{ type: string; text: string }>; isError?: boolean };
type Handlers = Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
type Row = Record<string, unknown>;
interface Review {
  concepts: Array<{ id: number; name: string; status: string; status_reason: string | null }>;
  readmes: Array<{ repo: string; path: string }>;
}

const parse = (r: unknown): Row => {
  assert.ok(!(r as Raw).isError, JSON.stringify((r as Raw).content));
  return JSON.parse((r as Raw).content[0]!.text) as Row;
};

let pin: ScanEnvPin;
before(() => {
  pin = pinScanEnv();
  resetEmbeddingModelForTests(async () => {
    throw new Error('no model in tests');
  });
});
after(() => {
  resetEmbeddingModelForTests();
  pin.restore();
});
afterEach(async () => {
  await reindexIdle();
});

interface Fx {
  db: TrajectoryDB;
  wm: Handlers;
  commit: (files: Record<string, string | null>) => string;
  scan: () => Promise<void>;
  cleanup: () => void;
}

async function fixture(files: Record<string, string>): Promise<Fx> {
  const ws = mkdtempSync(join(tmpdir(), 'wm-review-'));
  const root = join(ws, 'app');
  mkdirSync(root);
  const git = (...a: string[]) => execFileSync('git', ['-C', root, ...a], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  const write = (rel: string, body: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t.io');
  git('config', 'user.name', 't');
  for (const [rel, body] of Object.entries(files)) write(rel, body);
  git('add', '-A');
  git('commit', '-qm', 'init');
  const dbDir = mkdtempSync(join(tmpdir(), 'wm-review-db-'));
  const dbPath = join(dbDir, 'trajectory.db');
  const db = tempDB({ path: dbPath });
  const holder = GraphHolder.fixed(new WorldModelGraph(db));
  const scanHandlers = scanTools(db, holder, dbPath).handlers as Handlers;
  const scan = async () => {
    parse(await scanHandlers['scan_run']!({ agent: 'bro', session_dir: ws, source: 'user_manual' }));
  };
  await scan();
  db.run(`UPDATE repos SET target_branch = 'main' WHERE name = 'app'`);
  return {
    db,
    wm: worldModelTools(db, holder).handlers as Handlers,
    commit: (changes) => {
      for (const [rel, body] of Object.entries(changes)) {
        if (body === null) git('rm', '-q', rel);
        else write(rel, body);
      }
      git('add', '-A');
      git('commit', '-qm', 'change');
      return git('rev-parse', 'HEAD');
    },
    scan,
    cleanup: () => {
      db.close();
      rmSync(ws, { recursive: true, force: true });
      rmSync(dbDir, { recursive: true, force: true });
    },
  };
}

const A = 'export function alpha(): number {\n  return 1;\n}\n';
const B = "import { alpha } from './a.js';\n\nexport function beta(): number {\n  return alpha();\n}\n";
const C = 'export function gamma(): number {\n  return 3;\n}\n';

const reads = (fx: Fx, agent: string): Array<[string, () => Promise<unknown>]> => [
  ['world_model_get', () => fx.wm['world_model_get']!({ agent, repo: 'app' })],
  ['world_model_search', () => fx.wm['world_model_search']!({ agent, repo: 'app', query: 'alpha', mode: 'keyword' })],
  ['world_model_symbol', () => fx.wm['world_model_symbol']!({ agent, repo: 'app', qualified_name: 'beta' })],
];

const reindexRows = (db: TrajectoryDB): Row[] =>
  db
    .all<{ content_json: string }>(`SELECT content_json FROM audit WHERE event_type = 'wm_reindex' ORDER BY id`)
    .map((r) => JSON.parse(r.content_json) as Row);

const pending = (db: TrajectoryDB): Record<string, number> =>
  Object.fromEntries(
    db
      .all<{ path: string; p: number }>(`SELECT path, readme_review_pending AS p FROM wm_directories WHERE repo = 'app' ORDER BY path`)
      .map((r) => [r.path, Number(r.p)]),
  );

const concept = (name: string, steps: Array<{ path: string; qualified_name: string }>) => ({
  agent: 'bro',
  repo: 'app',
  name,
  kind: 'flow',
  body: `The ${name}.`,
  steps: steps.map((s, i) => ({ ...s, kind: 'function', description: `Step ${i + 1}.`, handoff: 'calls' })),
  claims: [],
});

describe('needs_review.concepts: the GH 2584 concept flags acceptance (SC1, SC4)', () => {
  it('a changed anchor lists the concept as suspect, a deleted one as broken, a re-verify removes it', async () => {
    const fx = await fixture({ 'src/a.ts': A, 'src/b.ts': B, 'lib/c.ts': C });
    try {
      const flow = concept('alpha flow', [
        { path: 'src/b.ts', qualified_name: 'beta' },
        { path: 'src/a.ts', qualified_name: 'alpha' },
      ]);
      const gone = concept('gamma flow', [{ path: 'lib/c.ts', qualified_name: 'gamma' }]);
      const flowId = parse(await fx.wm['world_model_concept_upsert']!(flow))['id'] as number;
      const goneId = parse(await fx.wm['world_model_concept_upsert']!(gone))['id'] as number;
      for (const [tool, call] of reads(fx, 'bro')) assert.ok(!('needs_review' in parse(await call())), `${tool}: nothing to review, no key`);

      fx.commit({ 'src/a.ts': A.replace('return 1;', 'return 2;'), 'lib/c.ts': null });
      for (const agent of ['swe', 'bro']) {
        for (const [tool, call] of reads(fx, agent)) {
          const out = parse(await call());
          const review = out['needs_review'] as Review;
          assert.ok(review, `${agent} / ${tool}: needs_review present`);
          assert.deepEqual(
            review.concepts.map((c) => [c.id, c.name, c.status]),
            [
              [flowId, 'alpha flow', 'suspect'],
              [goneId, 'gamma flow', 'broken'],
            ],
            `${agent} / ${tool}: flagged concepts by id`,
          );
          assert.match(review.concepts[0]!.status_reason ?? '', /changed since verification/);
          assert.match(review.concepts[1]!.status_reason ?? '', /anchor gone/);
          assert.deepEqual(review.readmes, [], `${agent} / ${tool}: no README to review`);
          assert.ok(!('needs_review_truncated' in out));
          assert.equal((out['freshness'] as Row)['needs_review_count'], 2, `${agent} / ${tool}: count`);
        }
      }

      const incremental = reindexRows(fx.db).filter((r) => r['mode'] === 'incremental');
      assert.equal(incremental.length, 1, 'one reindex brought the index to the commit');
      assert.equal(incremental[0]!['concepts_flagged'], 2, 'concepts_flagged counts both flags');
      for (const r of reindexRows(fx.db)) assert.ok(Number.isInteger(r['concepts_flagged']), `concepts_flagged in ${JSON.stringify(r)}`);

      assert.equal(parse(await fx.wm['world_model_concept_upsert']!(flow))['status'], 'verified');
      for (const [tool, call] of reads(fx, 'bro')) {
        const review = parse(await call())['needs_review'] as Review;
        assert.deepEqual(review.concepts.map((c) => c.id), [goneId], `${tool}: the re-verified concept left the list`);
      }
    } finally {
      fx.cleanup();
    }
  });
});

describe('needs_review.readmes: a changed README waits for bro (SC2)', () => {
  it('sets the flag only for a changed README of an existing dir, lists it to every agent, clears it on a bro read', async () => {
    const fx = await fixture({
      'src/a.ts': A,
      'src/README.md': '# Src\n\nThe source code.\n',
      'docs/README.md': '# Docs\n\nThe docs.\n',
      'docs/guide.ts': C,
      'plain/x.ts': B,
    });
    try {
      const column = fx.db.all<{ name: string }>(`PRAGMA table_info(wm_directories)`).map((c) => c.name);
      assert.ok(column.includes('readme_review_pending'));
      assert.deepEqual(pending(fx.db), { '': 0, docs: 0, plain: 0, src: 0 }, 'a first index flags nothing');

      fx.commit({
        'src/README.md': '# Src\n\nThe source code, rewritten.\n',
        'docs/guide.ts': C.replace('return 3;', 'return 4;'),
        'plain/x.ts': B.replace('alpha();', 'alpha() + 1;'),
        'fresh/README.md': '# Fresh\n\nA new dir.\n',
        'fresh/y.ts': A,
      });
      const first = parse(await fx.wm['world_model_get']!({ agent: 'swe', repo: 'app' }));
      assert.deepEqual(pending(fx.db), { '': 0, docs: 0, fresh: 0, plain: 0, src: 1 }, 'only the changed README of an existing dir');
      assert.deepEqual((first['needs_review'] as Review).readmes, [{ repo: 'app', path: 'src' }]);
      assert.deepEqual((first['needs_review'] as Review).concepts, []);
      assert.equal((first['freshness'] as Row)['needs_review_count'], 1);

      await fx.scan();
      assert.equal(pending(fx.db)['src'], 1, 'the flag survives a full rebuild');

      for (const [tool, call] of reads(fx, 'swe')) {
        assert.deepEqual((parse(await call())['needs_review'] as Review).readmes, [{ repo: 'app', path: 'src' }], `swe / ${tool}`);
        assert.equal(pending(fx.db)['src'], 1, `swe / ${tool}: a swe read leaves the flag`);
      }
      for (const agent of ['code-reviewer', 'security']) {
        assert.ok(parse(await fx.wm['world_model_get']!({ agent, repo: 'app' }))['needs_review'], `a ${agent} read lists it`);
        assert.equal(pending(fx.db)['src'], 1, `a ${agent} read leaves the flag`);
      }

      const bro = parse(await fx.wm['world_model_symbol']!({ agent: 'bro', repo: 'app', qualified_name: 'alpha', path: 'src/a.ts' }));
      assert.deepEqual((bro['needs_review'] as Review).readmes, [{ repo: 'app', path: 'src' }]);
      assert.equal((bro['freshness'] as Row)['needs_review_count'], 1, 'the count matches the list it rides with');
      assert.equal(pending(fx.db)['src'], 0, 'the bro read cleared it');
      for (const [tool, call] of reads(fx, 'bro')) {
        const out = parse(await call());
        assert.ok(!('needs_review' in out), `bro / ${tool}: the next bro read omits it`);
        assert.equal((out['freshness'] as Row)['needs_review_count'], 0);
      }

      fx.commit({ 'docs/README.md': null, 'src/a.ts': A.replace('return 1;', 'return 5;') });
      await fx.wm['world_model_get']!({ agent: 'swe', repo: 'app' });
      await fx.scan();
      assert.deepEqual(
        pending(fx.db),
        { '': 0, docs: 0, fresh: 0, plain: 0, src: 0 },
        'a switch to a structural summary, an unchanged README and a README-less dir leave it at 0',
      );
    } finally {
      fx.cleanup();
    }
  });
});
