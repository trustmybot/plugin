// A world_model_* read fetches origin/<target branch> at most once per 10
// minutes per repo before it brings the index forward (GH 2584), never for
// swe or code-reviewer; a fetch that moved the ref reindexes with trigger
// 'fetch'.
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pinScanEnv, tempDB, type ScanEnvPin } from './helpers.js';
import type { TrajectoryDB } from '../db.js';
import { GraphHolder, WorldModelGraph } from '../graph.js';
import { scanTools } from '../tools/scan.js';
import { worldModelTools } from '../tools/world_model.js';
import {
  __setTargetFetchForTests,
  fetchTargetIfDue,
  reindexIdle,
  reindexOnRefMove,
  TARGET_FETCH_TTL_MS,
  type TargetFetchRunner,
} from '../world-model/freshness.js';

type Raw = { content: Array<{ type: string; text: string }>; isError?: boolean };
type Handlers = Record<string, (args: Record<string, unknown>) => Promise<unknown>>;

const parse = (r: unknown): Record<string, unknown> => JSON.parse((r as Raw).content[0]!.text);

let pin: ScanEnvPin;
before(() => {
  pin = pinScanEnv();
});
after(() => pin.restore());
afterEach(async () => {
  __setTargetFetchForTests();
  await reindexIdle();
});

function gitIn(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, '-c', 'user.email=t@t.io', '-c', 'user.name=t', ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    .toString()
    .trim();
}

const realFetch: TargetFetchRunner = (args, opts) =>
  new Promise((resolve, reject) => {
    execFile('git', args, { cwd: opts.cwd, env: opts.env, signal: opts.signal }, (error) => (error ? reject(error) : resolve()));
  });

interface Counter {
  calls: string[][];
  runner: TargetFetchRunner;
}

function counting(inner: TargetFetchRunner = realFetch, delayMs = 0): Counter {
  const calls: string[][] = [];
  return {
    calls,
    runner: async (args, opts) => {
      calls.push(args);
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      await inner(args, opts);
    },
  };
}

interface Fx {
  root: string;
  db: TrajectoryDB;
  graph: WorldModelGraph;
  dbPath: string;
  tools: Handlers;
  push: (rel: string, body: string) => string;
  originRef: () => string;
  fetchedAt: () => string | null;
  cleanup: () => void;
}

async function fixture(opts: { origin?: boolean } = {}): Promise<Fx> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'wm-target-fetch-')));
  const ws = join(base, 'ws');
  const root = join(ws, 'app');
  const origin = join(base, 'origin.git');
  const other = join(base, 'other');
  mkdirSync(root, { recursive: true });
  gitIn(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'a.ts'), 'export function alpha(): number {\n  return 1;\n}\n');
  gitIn(root, 'add', '-A');
  gitIn(root, 'commit', '-qm', 'init');
  if (opts.origin !== false) {
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
    gitIn(root, 'remote', 'add', 'origin', origin);
    gitIn(root, 'push', '-q', '-u', 'origin', 'main');
    execFileSync('git', ['clone', '-q', origin, other]);
  }
  const dbPath = join(base, 'trajectory.db');
  const db = tempDB({ path: dbPath });
  const graph = new WorldModelGraph(db);
  const holder = GraphHolder.fixed(graph);
  const scan = scanTools(db, holder, dbPath).handlers as Handlers;
  const r = (await scan['scan_run']!({ agent: 'bro', session_dir: ws, source: 'user_manual' })) as Raw;
  assert.ok(!r.isError, JSON.stringify(r));
  await reindexIdle();
  db.run(`UPDATE repos SET target_branch = 'main' WHERE name = 'app'`);
  return {
    root,
    db,
    graph,
    dbPath,
    tools: worldModelTools(db, holder, root).handlers as Handlers,
    push: (rel, body) => {
      writeFileSync(join(other, rel), body);
      gitIn(other, 'add', '-A');
      gitIn(other, 'commit', '-qm', `add ${rel}`);
      gitIn(other, 'push', '-q', 'origin', 'main');
      return gitIn(other, 'rev-parse', 'HEAD');
    },
    originRef: () => gitIn(root, 'rev-parse', 'refs/remotes/origin/main'),
    fetchedAt: () => db.get<{ at: string | null }>(`SELECT target_fetched_at AS at FROM wm_freshness WHERE repo = 'app'`)?.at ?? null,
    cleanup: () => {
      db.close();
      rmSync(base, { recursive: true, force: true });
    },
  };
}

const BETA = 'export function beta(): number {\n  return 2;\n}\n';

async function read(fx: Fx, agent: string, tool = 'world_model_symbol'): Promise<Record<string, unknown>> {
  const args: Record<string, unknown> =
    tool === 'world_model_symbol' ? { agent, repo: 'app', qualified_name: 'alpha' } : tool === 'world_model_search' ? { agent, repo: 'app', query: 'alpha', mode: 'keyword' } : { agent, repo: 'app' };
  const r = (await fx.tools[tool]!(args)) as Raw;
  assert.ok(!r.isError, JSON.stringify(r));
  return parse(r);
}

function newestReindex(db: TrajectoryDB): Record<string, unknown> | null {
  const row = db.get<{ c: string }>(`SELECT content_json AS c FROM audit WHERE event_type = 'wm_reindex' AND repo = 'app' ORDER BY id DESC LIMIT 1`);
  return row ? (JSON.parse(row.c) as Record<string, unknown>) : null;
}

describe('world_model_* reads fetch origin/<target> (GH 2584)', () => {
  it('SC1: a bro read fetches a commit pushed from another clone and reindexes with trigger fetch', async () => {
    const fx = await fixture();
    try {
      const pushed = fx.push('b.ts', BETA);
      const r = (await fx.tools['world_model_symbol']!({ agent: 'bro', repo: 'app', qualified_name: 'beta' })) as Raw;
      assert.ok(!r.isError, JSON.stringify(r));
      const out = parse(r);
      assert.equal(fx.originRef(), pushed, 'origin/main moved to the pushed commit');
      const fresh = out['freshness'] as { target_commit: string; stale: boolean; reindex: { trigger: string } };
      assert.equal(fresh.target_commit, pushed);
      assert.equal(fresh.stale, false);
      assert.equal(fresh.reindex.trigger, 'fetch');
      const audit = newestReindex(fx.db)!;
      assert.equal(audit['trigger'], 'fetch');
      assert.equal(audit['to_commit'], pushed);
      assert.ok(fx.fetchedAt(), 'target_fetched_at stamped');
    } finally {
      fx.cleanup();
    }
  });

  it('a fetch that leaves origin/<target> where it was reindexes nothing and records no fetch trigger', async () => {
    const fx = await fixture();
    try {
      const before = newestReindex(fx.db);
      await read(fx, 'bro', 'world_model_get');
      assert.deepEqual(newestReindex(fx.db), before);
      assert.ok(fx.fetchedAt());
    } finally {
      fx.cleanup();
    }
  });

  it('SC2: a second read inside the window runs no fetch; past the window it fetches again', async () => {
    const fx = await fixture();
    try {
      const c = counting();
      __setTargetFetchForTests({ runner: c.runner });
      await read(fx, 'bro');
      assert.equal(c.calls.length, 1);
      assert.deepEqual(c.calls[0]!.slice(-4), ['fetch', '-q', 'origin', 'main']);
      assert.ok(c.calls[0]!.includes('http.lowSpeedLimit=1000'));
      await read(fx, 'bro', 'world_model_search');
      await read(fx, 'bro', 'world_model_get');
      assert.equal(c.calls.length, 1, 'no fetch inside the window');

      const stamped = Date.parse(fx.fetchedAt()!);
      assert.equal(await fetchTargetIfDue(fx.db, 'app', { agent: 'bro', now: stamped + TARGET_FETCH_TTL_MS - 1000 }), 'skipped');
      assert.equal(c.calls.length, 1);
      const later = stamped + TARGET_FETCH_TTL_MS + 60_000;
      assert.equal(await fetchTargetIfDue(fx.db, 'app', { agent: 'bro', now: later }), 'unchanged');
      assert.equal(c.calls.length, 2, 'now past 10 minutes fetches again');
      assert.equal(fx.fetchedAt(), new Date(later).toISOString());

      fx.db.run(`UPDATE wm_freshness SET target_fetched_at = ? WHERE repo = 'app'`, [new Date(Date.now() - TARGET_FETCH_TTL_MS - 1000).toISOString()]);
      await read(fx, 'consultant-x');
      assert.equal(c.calls.length, 3, 'a read past the window fetches again');
    } finally {
      fx.cleanup();
    }
  });

  it('SC2: swe and code-reviewer reads never fetch and never write target_fetched_at', async () => {
    const fx = await fixture();
    try {
      const c = counting();
      __setTargetFetchForTests({ runner: c.runner });
      fx.push('b.ts', BETA);
      for (const agent of ['swe', 'code-reviewer', 'tmb:swe', 'CODE-REVIEWER']) {
        for (const tool of ['world_model_get', 'world_model_search', 'world_model_symbol']) await read(fx, agent, tool);
        assert.equal(await fetchTargetIfDue(fx.db, 'app', { agent }), 'skipped');
      }
      assert.equal(c.calls.length, 0);
      assert.equal(fx.fetchedAt(), null);
    } finally {
      fx.cleanup();
    }
  });

  it('SC3: an unreachable remote answers from the current index, stamps the attempt and is not retried in the window', async () => {
    const fx = await fixture();
    try {
      const head = fx.originRef();
      gitIn(fx.root, 'remote', 'set-url', 'origin', join(fx.root, 'no-such-remote.git'));
      const c = counting();
      __setTargetFetchForTests({ runner: c.runner });
      const out = await read(fx, 'bro');
      assert.equal(c.calls.length, 1);
      assert.equal((out['freshness'] as { target_commit: string }).target_commit, head);
      assert.ok(fx.fetchedAt(), 'a failed attempt is stamped');
      await read(fx, 'bro');
      assert.equal(c.calls.length, 1, 'no retry inside the window');
    } finally {
      fx.cleanup();
    }
  });

  it('SC3: a fetch past the cap is cut off, the read answers and the attempt is stamped', async () => {
    const fx = await fixture();
    try {
      let aborted = false;
      const c = counting((_args, opts) => {
        opts.signal.addEventListener('abort', () => {
          aborted = true;
        });
        return new Promise<void>(() => undefined);
      });
      __setTargetFetchForTests({ runner: c.runner, timeoutMs: 50 });
      const started = Date.now();
      const out = await read(fx, 'bro');
      assert.ok(Date.now() - started < 4000, 'the read did not wait for the hung fetch');
      assert.ok(aborted, 'the hung fetch was signalled to stop');
      assert.ok(out['freshness']);
      assert.ok(fx.fetchedAt());
      await read(fx, 'bro');
      assert.equal(c.calls.length, 1);
    } finally {
      fx.cleanup();
    }
  });

  it('SC3: a repo with no origin remote fetches nothing and writes nothing', async () => {
    const fx = await fixture({ origin: false });
    try {
      const c = counting();
      __setTargetFetchForTests({ runner: c.runner });
      await read(fx, 'bro');
      assert.equal(await fetchTargetIfDue(fx.db, 'app', { agent: 'bro' }), 'skipped');
      assert.equal(c.calls.length, 0);
      assert.equal(fx.fetchedAt(), null);
    } finally {
      fx.cleanup();
    }
  });

  it('SC4: two concurrent reads of one repo start one fetch', async () => {
    const fx = await fixture();
    try {
      const pushed = fx.push('b.ts', BETA);
      const c = counting(realFetch, 100);
      __setTargetFetchForTests({ runner: c.runner });
      const [a, b] = await Promise.all([read(fx, 'bro'), read(fx, 'bro', 'world_model_search')]);
      assert.equal(c.calls.length, 1);
      for (const out of [a, b]) assert.equal((out['freshness'] as { target_commit: string }).target_commit, pushed);
      assert.equal(newestReindex(fx.db)!['trigger'], 'fetch');
    } finally {
      fx.cleanup();
    }
  });

  it('SC4: reindexOnRefMove with fetch:true stamps target_fetched_at', async () => {
    const fx = await fixture();
    try {
      const pushed = fx.push('b.ts', BETA);
      assert.equal(fx.fetchedAt(), null);
      await reindexOnRefMove(fx.db, fx.graph, 'app', { dbPath: fx.dbPath, fetch: true });
      assert.ok(fx.fetchedAt());
      assert.equal(fx.originRef(), pushed);
    } finally {
      fx.cleanup();
    }
  });
});
