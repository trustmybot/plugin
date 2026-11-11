// Differential test for the world model (GH 2584): a DB brought forward by the
// git-range incremental reindex (ensureFresh) holds the same wm_files,
// wm_symbols and wm_edges rows as a DB built from scratch by a full scan at
// the same commit. The clean rebuild is the oracle.
import { after, before, describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { pinScanEnv, tempDB, type ScanEnvPin } from './helpers.js';
import type { TrajectoryDB } from '../db.js';
import { GraphHolder, WorldModelGraph } from '../graph.js';
import { scanTools } from '../tools/scan.js';
import { compare, describeMismatch, multisetMinus, snapshot, WM_TABLES } from '../world-model/equivalence.js';
import { ensureFresh, reindexIdle } from '../world-model/freshness.js';

type Raw = { content: Array<{ type: string; text: string }>; isError?: boolean };
type Handlers = Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
const REPLAY_COMMITS = 5;
const PIN_TARGET = 'TMB_WM_INDEX_TARGET';

const git = (cwd: string, ...a: string[]) =>
  execFileSync('git', ['-C', cwd, ...a], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).toString().trim();

const datedGit =
  (cwd: string) =>
  (date: string, ...a: string[]) =>
    execFileSync('git', ['-C', cwd, ...a], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    })
      .toString()
      .trim();

function assertEquivalent(a: TrajectoryDB, b: TrajectoryDB, repo: string, label: string): void {
  const sa = snapshot(a, repo);
  const sb = snapshot(b, repo);
  for (const table of WM_TABLES) {
    assert.ok(sa[table].length > 0, `${label}: A has no ${table} rows`);
    assert.ok(sb[table].length > 0, `${label}: B has no ${table} rows`);
  }
  const mismatches = compare(sa, sb);
  assert.equal(mismatches.length, 0, mismatches.length ? describeMismatch(label, mismatches) : '');
}

interface Indexed {
  db: TrajectoryDB;
  graph: WorldModelGraph;
  dbPath: string;
  close: () => void;
}

// A fresh DB with session_dir scanned by scan_run: the clean full rebuild.
async function cleanScan(sessionDir: string): Promise<Indexed> {
  const dir = mkdtempSync(join(tmpdir(), 'wm-equiv-db-'));
  const dbPath = join(dir, 'trajectory.db');
  const db = tempDB({ path: dbPath });
  const graph = new WorldModelGraph(db);
  const handlers = scanTools(db, GraphHolder.fixed(graph), dbPath).handlers as Handlers;
  const r = (await handlers['scan_run']!({ agent: 'bro', session_dir: sessionDir, source: 'user_manual' })) as Raw;
  assert.ok(!r.isError, JSON.stringify(r));
  return {
    db,
    graph,
    dbPath,
    close: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function stepIncremental(a: Indexed, repo: string, expect: string): Promise<void> {
  const f = await ensureFresh(a.db, a.graph, repo, { dbPath: a.dbPath, trigger: 'read' });
  assert.equal(f.mode, 'incremental', `the step to ${expect} ran the incremental path`);
  assert.equal(f.indexed_commit, expect);
}

let pin: ScanEnvPin;
let pinnedTarget: string | undefined;
before(() => {
  pin = pinScanEnv();
  pinnedTarget = process.env[PIN_TARGET];
  delete process.env[PIN_TARGET];
});
after(async () => {
  await reindexIdle();
  if (pinnedTarget === undefined) delete process.env[PIN_TARGET];
  else process.env[PIN_TARGET] = pinnedTarget;
  pin.restore();
});

interface Fx {
  root: string;
  a: Indexed;
  commit: (changes: Record<string, string | null>) => string;
  mv: (from: string, to: string) => string;
  check: (label: string) => Promise<void>;
  cleanup: () => void;
}

async function fixture(files: Record<string, string>): Promise<Fx> {
  const ws = mkdtempSync(join(tmpdir(), 'wm-equiv-'));
  const root = join(ws, 'app');
  mkdirSync(root);
  const g = (...a: string[]) => git(root, ...a);
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t.io');
  g('config', 'user.name', 't');
  const write = (rel: string, body: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  };
  const commit = (changes: Record<string, string | null>) => {
    for (const [rel, body] of Object.entries(changes)) {
      if (body === null) g('rm', '-q', rel);
      else write(rel, body);
    }
    g('add', '-A');
    g('commit', '-qm', 'change');
    return g('rev-parse', 'HEAD');
  };
  for (const [rel, body] of Object.entries(files)) write(rel, body);
  g('add', '-A');
  g('commit', '-qm', 'init');
  const a = await cleanScan(ws);
  a.db.run(`UPDATE repos SET target_branch = 'main' WHERE name = 'app'`);
  return {
    root,
    a,
    commit,
    mv: (from, to) => {
      mkdirSync(dirname(join(root, to)), { recursive: true });
      g('mv', from, to);
      g('commit', '-qm', `mv ${from} ${to}`);
      return g('rev-parse', 'HEAD');
    },
    check: async (label) => {
      const b = await cleanScan(ws);
      try {
        assertEquivalent(a.db, b.db, 'app', label);
      } finally {
        b.close();
      }
    },
    cleanup: () => {
      a.close();
      rmSync(ws, { recursive: true, force: true });
    },
  };
}

const ALPHA = 'export function alpha(): number {\n  return 1;\n}\n';
const BETA = "import { alpha } from './a.js';\n\nexport function beta(): number {\n  return alpha();\n}\n";
const GAMMA = "import { alpha } from './a.js';\nimport { shared } from './s1.js';\n\nexport function gamma(): number {\n  return alpha() + shared();\n}\n";
const SHARED = (n: number) => `export function shared(): number {\n  return ${n};\n}\n`;
const HELPER = (n: number) => `function helper(): number {\n  return ${n};\n}\n`;
const CALLER = 'export function caller(): number {\n  return helper();\n}\n';
const BASE = { 'src/a.ts': ALPHA, 'src/b.ts': BETA, 'src/g.ts': GAMMA, 'src/s1.ts': SHARED(1), 'lib/util.ts': 'export const util = 1;\n' };

describe('fixture steps: incremental reindex equals a clean rebuild (SC1)', () => {
  it('a file rename with unchanged content (git mv)', async () => {
    const fx = await fixture(BASE);
    try {
      await fx.check('initial');
      const head = fx.mv('src/a.ts', 'src/alpha.ts');
      await stepIncremental(fx.a, 'app', head);
      await fx.check('after git mv src/a.ts src/alpha.ts');
    } finally {
      fx.cleanup();
    }
  });

  it('a move into another directory', async () => {
    const fx = await fixture(BASE);
    try {
      const head = fx.mv('src/a.ts', 'core/deep/a.ts');
      await stepIncremental(fx.a, 'app', head);
      await fx.check('after moving src/a.ts to core/deep/a.ts');
    } finally {
      fx.cleanup();
    }
  });

  it('a delete', async () => {
    const fx = await fixture(BASE);
    try {
      const head = fx.commit({ 'src/a.ts': null });
      await stepIncremental(fx.a, 'app', head);
      await fx.check('after deleting src/a.ts');
    } finally {
      fx.cleanup();
    }
  });

  it('an exported function signature change', async () => {
    const fx = await fixture(BASE);
    try {
      const head = fx.commit({ 'src/a.ts': 'export function alpha(n: number = 0, label?: string): number {\n  return n + (label ? 1 : 0);\n}\n' });
      await stepIncremental(fx.a, 'app', head);
      await fx.check('after changing the alpha signature');
    } finally {
      fx.cleanup();
    }
  });

  it('two files defining the same symbol name, then one removed', async () => {
    const fx = await fixture(BASE);
    try {
      const both = fx.commit({ 'src/s2.ts': SHARED(2), 'lib/s3.ts': SHARED(3) });
      await stepIncremental(fx.a, 'app', both);
      await fx.check('with shared defined in src/s1.ts, src/s2.ts and lib/s3.ts');
      const one = fx.commit({ 'src/s1.ts': null });
      await stepIncremental(fx.a, 'app', one);
      await fx.check('after removing src/s1.ts');
    } finally {
      fx.cleanup();
    }
  });

  it('a call resolved by name alone, then a second definition of that name, then one removed', async () => {
    const fx = await fixture({ ...BASE, 'src/h1.ts': HELPER(1), 'src/caller.ts': CALLER });
    try {
      await fx.check('with helper defined once');
      const both = fx.commit({ 'lib/h2.ts': `export ${HELPER(2)}` });
      await stepIncremental(fx.a, 'app', both);
      await fx.check('with helper defined in src/h1.ts and lib/h2.ts');
      const one = fx.commit({ 'lib/h2.ts': null });
      await stepIncremental(fx.a, 'app', one);
      await fx.check('after removing lib/h2.ts');
    } finally {
      fx.cleanup();
    }
  });

  it('a merge whose side branch adds a file byte-identical to one main already has (GH 2636)', async () => {
    const fx = await fixture(BASE);
    const at = datedGit(fx.root);
    const addDup = (date: string) => {
      writeFileSync(join(fx.root, 'lib/dup.ts'), SHARED(9));
      at(date, 'add', '-A');
      at(date, 'commit', '-qm', 'add lib/dup.ts');
      return at(date, 'rev-parse', 'HEAD');
    };
    try {
      at('2030-01-01T00:00:00Z', 'branch', 'side');
      const onMain = addDup('2030-01-02T00:00:00Z');
      await stepIncremental(fx.a, 'app', onMain);
      at('2030-01-03T00:00:00Z', 'checkout', '-q', 'side');
      const onSide = addDup('2030-01-03T00:00:00Z');
      at('2030-01-04T00:00:00Z', 'checkout', '-q', 'main');
      at('2030-01-04T00:00:00Z', 'merge', '-q', '--no-ff', '-m', 'merge side', 'side');
      const merged = at('2030-01-04T00:00:00Z', 'rev-parse', 'HEAD');
      assert.equal(at('2030-01-04T00:00:00Z', 'diff', '--name-only', onMain, merged), '', 'the merge changes no content');
      await stepIncremental(fx.a, 'app', merged);
      const dup = fx.a.graph.allFilesForRepo('app').find((f) => WorldModelGraph.relativeFilePath(f) === 'lib/dup.ts');
      assert.equal(dup?.last_commit_sha, onSide, 'lib/dup.ts carries the side commit, the newest to touch it');
      await fx.check('after merging a side branch that adds an identical lib/dup.ts');
    } finally {
      fx.cleanup();
    }
  });

  it('the same merge with the side commit older-dated than main (GH 2636 older side)', async () => {
    const fx = await fixture(BASE);
    const at = datedGit(fx.root);
    const addDup = (date: string) => {
      writeFileSync(join(fx.root, 'lib/dup.ts'), SHARED(9));
      at(date, 'add', '-A');
      at(date, 'commit', '-qm', 'add lib/dup.ts');
      return at(date, 'rev-parse', 'HEAD');
    };
    try {
      at('2030-01-01T00:00:00Z', 'branch', 'side');
      const onMain = addDup('2030-01-02T00:00:00Z');
      await stepIncremental(fx.a, 'app', onMain);
      at('2030-01-03T00:00:00Z', 'checkout', '-q', 'side');
      addDup('2030-01-01T12:00:00Z');
      at('2030-01-04T00:00:00Z', 'checkout', '-q', 'main');
      at('2030-01-04T00:00:00Z', 'merge', '-q', '--no-ff', '-m', 'merge side', 'side');
      const merged = at('2030-01-04T00:00:00Z', 'rev-parse', 'HEAD');
      await stepIncremental(fx.a, 'app', merged);
      const dup = fx.a.graph.allFilesForRepo('app').find((f) => WorldModelGraph.relativeFilePath(f) === 'lib/dup.ts');
      assert.equal(dup?.last_commit_sha, onMain, "lib/dup.ts keeps main's commit, the newer by date");
      await fx.check('after merging an older-dated side branch that adds an identical lib/dup.ts');
    } finally {
      fx.cleanup();
    }
  });

  it('a merge taking an older-dated side change over a newer main change (GH 2636 re-read)', async () => {
    const fx = await fixture(BASE);
    const at = datedGit(fx.root);
    const setUtil = (date: string, n: number) => {
      writeFileSync(join(fx.root, 'lib/util.ts'), `export const util = ${n};\n`);
      at(date, 'commit', '-qam', `util ${n}`);
      return at(date, 'rev-parse', 'HEAD');
    };
    try {
      at('2030-01-01T00:00:00Z', 'branch', 'side');
      const onMain = setUtil('2030-01-02T00:00:00Z', 2);
      await stepIncremental(fx.a, 'app', onMain);
      at('2030-01-03T00:00:00Z', 'checkout', '-q', 'side');
      setUtil('2030-01-01T12:00:00Z', 3);
      at('2030-01-04T00:00:00Z', 'checkout', '-q', 'main');
      at('2030-01-04T00:00:00Z', 'merge', '-q', '--no-ff', '-X', 'theirs', '-m', 'merge side', 'side');
      const merged = at('2030-01-04T00:00:00Z', 'rev-parse', 'HEAD');
      assert.equal(at('2030-01-04T00:00:00Z', 'diff', '--name-only', onMain, merged), 'lib/util.ts', 'the merge changes lib/util.ts');
      await stepIncremental(fx.a, 'app', merged);
      const util = fx.a.graph.allFilesForRepo('app').find((f) => WorldModelGraph.relativeFilePath(f) === 'lib/util.ts');
      assert.equal(util?.last_commit_sha, onMain, "lib/util.ts carries main's commit, the newer by date");
      await fx.check('after merging an older-dated side change to lib/util.ts');
    } finally {
      fx.cleanup();
    }
  });

  it('a file that fails to parse, fixed in a later commit', async () => {
    const fx = await fixture(BASE);
    try {
      const broken = fx.commit({
        'src/b.ts': "import { alpha } from './a.js';\n\nexport function beta(: number {\n  return alpha(;\n}}}\nclass {\n",
        'package.json': '{ "name": "app", "scripts": { "build": ',
      });
      await stepIncremental(fx.a, 'app', broken);
      await fx.check('with src/b.ts and package.json unparseable');
      const fixed = fx.commit({ 'src/b.ts': BETA, 'package.json': '{ "name": "app", "scripts": { "build": "tsc" } }\n' });
      await stepIncremental(fx.a, 'app', fixed);
      await fx.check('after fixing src/b.ts and package.json');
    } finally {
      fx.cleanup();
    }
  });
});

describe('the comparator bites (SC3)', () => {
  it('one wm_edges row deleted from A is reported, by name, as only in B', async () => {
    const fx = await fixture(BASE);
    const b = await cleanScan(dirname(fx.root));
    try {
      assertEquivalent(fx.a.db, b.db, 'app', 'before the corruption');
      const victim = fx.a.db.get<{ rowid: number }>(
        `SELECT e.rowid AS rowid FROM wm_edges e JOIN wm_symbols s ON s.id = e.src_id
          WHERE s.repo = 'app' AND s.qualified_name = 'beta' AND e.kind = 'calls' AND e.dst_name = 'alpha'`,
      );
      assert.ok(victim, 'the beta -> alpha call edge exists');
      const before = snapshot(fx.a.db, 'app').wm_edges;
      fx.a.db.run(`DELETE FROM wm_edges WHERE rowid = ?`, [victim.rowid]);
      const removed = multisetMinus(before, snapshot(fx.a.db, 'app').wm_edges);
      assert.equal(removed.length, 1);
      const row = removed[0]!;
      assert.match(row, /"src_name":"beta"/);

      const mismatches = compare(snapshot(fx.a.db, 'app'), snapshot(b.db, 'app'));
      assert.deepEqual(mismatches, [{ table: 'wm_edges', onlyA: [], onlyB: [row] }]);
      assert.throws(() => assertEquivalent(fx.a.db, b.db, 'app', 'after the corruption'), (e: Error) => {
        assert.ok(e.message.includes('wm_edges: 0 only in A (incremental), 1 only in B (clean rebuild)'), e.message);
        assert.ok(e.message.includes(row), e.message);
        return true;
      });
    } finally {
      b.close();
      fx.cleanup();
    }
  });
});

// The checkout this test runs from: dist/test/ sits under mcp/trajectory-server.
function pluginCheckout(): string | null {
  try {
    return git(dirname(fileURLToPath(import.meta.url)), 'rev-parse', '--show-toplevel');
  } catch {
    return null;
  }
}

function missingHistory(root: string | null): string | null {
  if (!root) return 'the test does not run from a git checkout';
  if (git(root, 'rev-parse', '--is-shallow-repository') === 'true') return `${root} is a shallow clone`;
  const count = Number(git(root, 'rev-list', '--first-parent', '--count', 'HEAD'));
  if (count < REPLAY_COMMITS + 1) return `${root} has ${count} first-parent commits, the replay needs ${REPLAY_COMMITS + 1}`;
  return null;
}

// Each replay step runs against the A the previous step left behind, so once
// one fails the rest would compare against a diverged A.
let replayStepFailed = false;

// One test per replayed commit so each hang guard covers a single incremental
// step plus one clean rebuild, not the whole replay (GH 2810).
describe('real-history replay over the plugin checkout (SC2)', () => {
  const root = pluginCheckout();
  const missing = missingHistory(root);
  if (missing) {
    it(`steps A through the last ${REPLAY_COMMITS} first-parent commits, equal to a clean rebuild after each`, (t: TestContext) => {
      if (process.env['CI'] === 'true') assert.fail(`real-history replay needs full history under CI: ${missing} (checkout with fetch-depth: 0)`);
      t.diagnostic(`skipped: ${missing}`);
      t.skip(missing);
    });
    return;
  }
  const checkout = root!;
  const commits = git(checkout, 'rev-list', '--first-parent', '-n', String(REPLAY_COMMITS + 1), 'HEAD').split('\n').reverse();
  let ws: string | null = null;
  let a: Indexed | null = null;

  before(
    async () => {
      ws = mkdtempSync(join(tmpdir(), 'wm-equiv-replay-'));
      git(ws, 'clone', '-q', '--no-checkout', '--shared', checkout, join(ws, 'plugin'));
      process.env[PIN_TARGET] = commits[0]!;
      a = await cleanScan(ws);
    },
    { timeout: 240_000 },
  );
  after(() => {
    delete process.env[PIN_TARGET];
    a?.close();
    if (ws) rmSync(ws, { recursive: true, force: true });
  });

  for (const sha of commits.slice(1)) {
    const label = `at ${sha.slice(0, 12)} (${git(checkout, 'show', '-s', '--format=%s', sha)})`;
    it(label, { timeout: 240_000 }, async (t: TestContext) => {
      if (replayStepFailed) {
        t.skip('an earlier replay step failed');
        return;
      }
      // Set before the work and cleared only on success, so a throw or a
      // timeout both leave it set for the steps after this one.
      replayStepFailed = true;
      process.env[PIN_TARGET] = sha;
      await stepIncremental(a!, 'plugin', sha);
      const b = await cleanScan(ws!);
      try {
        assertEquivalent(a!.db, b.db, 'plugin', label);
      } finally {
        b.close();
      }
      replayStepFailed = false;
    });
  }
});
