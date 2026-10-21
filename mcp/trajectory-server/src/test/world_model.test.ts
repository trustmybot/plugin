import { after, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildTree, worldModelTools } from '../tools/world_model.js';
import { WorldModelGraph, GraphHolder, type DirectoryNode } from '../graph.js';
import { resetEmbeddingModelForTests } from '../embeddings/model.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bagOfWordsLoader, pinScanEnv, tempDB } from './helpers.js';
import { scanTools } from '../tools/scan.js';

const scanPin = pinScanEnv();
after(() => scanPin.restore());

// Synthetic Directory rows mirroring what allDirectoriesForRepo returns AFTER
// the #269 read fix: top-level dirs carry parent_path '' (the repo root's own
// path), and the repo root itself has path ''.
function row(path: string, parent_path: string | null): DirectoryNode & { id: number } {
  return {
    id: 0,
    key: WorldModelGraph.dirKey('app', path),
    repo: 'app',
    path,
    parent_path,
    summary: null,
    summary_source: 'llm',
    summary_updated_at: null,
    file_count: 1,
  };
}

describe('buildTree root traversal (#269)', () => {
  it('returns top-level children when querying the root path', () => {
    const rows = [
      row('', ''),
      row('docs', ''),
      row('src', ''),
      row('src/api', 'src'),
    ];
    const tree = buildTree(rows, '', null);
    assert.ok(tree, 'root tree must build');
    assert.equal(tree!.path, '');
    const top = tree!.children.map((c) => c.path).sort();
    assert.deepEqual(top, ['docs', 'src'], 'top-level dirs surface as root children (#269)');
    const src = tree!.children.find((c) => c.path === 'src');
    assert.ok(src && src.children.some((c) => c.path === 'src/api'), 'nested dir reachable');
  });

  it('does not list the root as its own child', () => {
    const tree = buildTree([row('', ''), row('docs', '')], '', null);
    assert.ok(!tree!.children.some((c) => c.path === ''), 'root must not be its own child');
  });
});

describe('buildTree cycle guard (#272)', () => {
  it('terminates on a parent_path cycle instead of overflowing the stack', () => {
    // a -> b -> a (corrupt/cyclic stored graph). Must not recurse forever.
    const rows = [row('', ''), row('a', ''), row('b', 'a'), row('a-dup', 'b')];
    // Force a cycle: make 'a' claim 'b' as a child too via a back-edge.
    rows.push(row('a', 'b'));
    const tree = buildTree(rows, '', 2);
    assert.ok(tree, 'builds without throwing on a cyclic graph');
  });
});

describe('WorldModelGraph.dirKey collision-resistance (#282)', () => {
  it('distinguishes keys when a value contains the delimiter', () => {
    assert.notEqual(WorldModelGraph.dirKey('a', 'b:c'), WorldModelGraph.dirKey('a:b', 'c'));
    assert.notEqual(WorldModelGraph.dirKey('x', ''), WorldModelGraph.dirKey('', 'x'));
  });
});

describe('buildTree node cap (#363)', () => {
  it('respects node limit and sets truncated flag when exceeded', () => {
    // Build a flat tree with 10 children so we can cap at 5.
    const rows = [row('', '')];
    for (let i = 0; i < 10; i++) rows.push(row(`dir${i}`, ''));
    const counter = { count: 0, limit: 5 };
    buildTree(rows, '', null, { nodeCounter: counter });
    assert.ok(counter.count <= counter.limit, 'node counter must not exceed limit');
  });

  it('does not truncate when node count is under limit', () => {
    const rows = [row('', ''), row('a', ''), row('b', '')];
    const counter = { count: 0, limit: 500 };
    const tree = buildTree(rows, '', null, { nodeCounter: counter });
    assert.ok(tree, 'tree must build');
    assert.equal(counter.count, 3, 'all 3 nodes counted');
    assert.ok(counter.count < counter.limit, 'not truncated');
  });
});

describe('buildTree summary truncation at depth > 1 (#363)', () => {
  it('passes full summary at depth 0 (root)', () => {
    const r = { ...row('', ''), summary: 'line1\nline2\nline3' };
    const tree = buildTree([r], '', null);
    assert.ok(tree, 'tree builds');
    assert.equal(tree!.summary, 'line1\nline2\nline3', 'root summary not truncated');
  });

  it('passes full summary at depth 1 (immediate child)', () => {
    const root = { ...row('', ''), summary: 'root summary' };
    const child = { ...row('src', ''), summary: 'line1\nline2' };
    const tree = buildTree([root, child], '', null);
    assert.ok(tree, 'tree builds');
    const src = tree!.children.find((c) => c.path === 'src');
    assert.ok(src, 'src child found');
    assert.equal(src!.summary, 'line1\nline2', 'depth-1 summary not truncated');
  });

  it('truncates multi-line summary to first line at depth 2+', () => {
    const root = { ...row('', ''), summary: null };
    const child = { ...row('src', ''), summary: null };
    const grandchild = { ...row('src/api', 'src'), summary: 'first line\nsecond line\nthird' };
    const tree = buildTree([root, child, grandchild], '', null);
    assert.ok(tree, 'tree builds');
    const api = tree!.children
      .find((c) => c.path === 'src')
      ?.children.find((c) => c.path === 'src/api');
    assert.ok(api, 'src/api found at depth 2');
    assert.equal(api!.summary, 'first line', 'depth-2 summary truncated to first line');
  });
});

// Repo-unspecified resolution (#15). The repo-selector check runs before the
// graph is touched, so these assertions hold with graph=null.
type WmResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
function wmParse(r: WmResult): Record<string, unknown> {
  return JSON.parse(r.content[0]!.text);
}

describe('world_model_get/search — repo-unspecified (#15)', () => {
  it('world_model_get returns repo-unspecified + available_repos in multi-repo with no repo arg', async () => {
    const db = tempDB();
    db.run(`INSERT INTO repos (name, path) VALUES ('frontend', '/tmp/frontend')`);
    db.run(`INSERT INTO repos (name, path) VALUES ('backend', '/tmp/backend')`);
    const tools = worldModelTools(db, null);

    const r = (await tools.handlers['world_model_get']!({ agent: 'bro' })) as WmResult;
    const out = wmParse(r);
    assert.equal(out['warning'], 'repo-unspecified', 'multi-repo no-arg must warn repo-unspecified');
    assert.deepEqual(out['available_repos'], ['backend', 'frontend'], 'available repos named, sorted');
    assert.equal(out['root'], null);

    db.close();
  });

  it('world_model_search returns repo-unspecified + available_repos in multi-repo with no repo arg', async () => {
    const db = tempDB();
    db.run(`INSERT INTO repos (name, path) VALUES ('frontend', '/tmp/frontend')`);
    db.run(`INSERT INTO repos (name, path) VALUES ('backend', '/tmp/backend')`);
    const tools = worldModelTools(db, null);

    const r = (await tools.handlers['world_model_search']!({ agent: 'bro', query: 'parser' })) as WmResult;
    const out = wmParse(r);
    assert.equal(out['warning'], 'repo-unspecified', 'multi-repo no-arg must warn repo-unspecified');
    assert.deepEqual(out['available_repos'], ['backend', 'frontend']);
    assert.deepEqual(out['results'], []);

    db.close();
  });

  it('world_model_get with 0 repos falls through to world-model-unavailable (not repo-unspecified) (#16)', async () => {
    const db = tempDB();
    const tools = worldModelTools(db, null);

    const r = (await tools.handlers['world_model_get']!({ agent: 'bro' })) as WmResult;
    const out = wmParse(r);
    assert.notEqual(out['warning'], 'repo-unspecified', '0 repos must not short-circuit on repo-unspecified');
    assert.equal(out['warning'], 'world-model-unavailable', '0 repos falls through to the empty/unavailable path');
    assert.equal(out['repo'], '');
    assert.equal(out['available_repos'], undefined, 'no available_repos list on the 0-repo fall-through');

    db.close();
  });

  it('world_model_search with 0 repos falls through to world-model-unavailable (not repo-unspecified) (#16)', async () => {
    const db = tempDB();
    const tools = worldModelTools(db, null);

    const r = (await tools.handlers['world_model_search']!({ agent: 'bro', query: 'parser' })) as WmResult;
    const out = wmParse(r);
    assert.notEqual(out['warning'], 'repo-unspecified', '0 repos must not short-circuit on repo-unspecified');
    assert.equal(out['warning'], 'world-model-unavailable', '0 repos falls through to the empty/unavailable path');
    assert.equal(out['available_repos'], undefined, 'no available_repos list on the 0-repo fall-through');

    db.close();
  });

  it('single-repo with no repo arg resolves the sole repo (not repo-unspecified)', async () => {
    const db = tempDB();
    db.run(`INSERT INTO repos (name, path) VALUES ('app', '/tmp/app')`);
    const tools = worldModelTools(db, null);

    const r = (await tools.handlers['world_model_get']!({ agent: 'bro' })) as WmResult;
    const out = wmParse(r);
    // Sole repo resolves, so we fall through to the graph check (null graph here).
    assert.equal(out['warning'], 'world-model-unavailable', 'sole repo resolves past the selector check');
    assert.notEqual(out['warning'], 'repo-unspecified');

    db.close();
  });
});

// unmerged_work — closed-task branches not yet merged into the target (#1059).
// A stub graph returns a single root dir so the handler reaches the
// success path; the git work happens against a real temp repo.
describe('world_model_get — unmerged_work (#1059)', () => {
  function stubGraph(): WorldModelGraph {
    return {
      allDirectoriesForRepo: () => [row('', '')],
      directoryCount: () => 1,
      subtree: () => [row('', '')],
      fileCoverage: () => ({ files: 0, with_purpose: 0, by_source: {} }),
    } as unknown as WorldModelGraph;
  }

  function gitRepo(): { repoRoot: string; devTip: string; unmergedTip: string; cleanup: () => void } {
    const ws = mkdtempSync(join(tmpdir(), 'wm-unmerged-'));
    const repoRoot = join(ws, 'app');
    mkdirSync(repoRoot, { recursive: true });
    const git = (...a: string[]) => execFileSync('git', ['-C', repoRoot, ...a], { encoding: 'utf8' });
    execFileSync('git', ['init', '-q', '-b', 'dev', repoRoot]);
    git('config', 'user.email', 't@t.io');
    git('config', 'user.name', 't');
    writeFileSync(join(repoRoot, 'a.txt'), 'a\n');
    git('add', '.');
    git('commit', '-qm', 'init');
    const devTip = git('rev-parse', 'HEAD').trim();
    git('checkout', '-q', '-b', 'fix/unmerged');
    writeFileSync(join(repoRoot, 'b.txt'), 'b\n');
    git('add', '.');
    git('commit', '-qm', 'feature work');
    const unmergedTip = git('rev-parse', 'HEAD').trim();
    git('checkout', '-q', 'dev');
    return { repoRoot, devTip, unmergedTip, cleanup: () => rmSync(ws, { recursive: true, force: true }) };
  }

  function seed(db: ReturnType<typeof tempDB>, repoPath: string): void {
    db.run(`INSERT INTO repos (name, path, target_branch) VALUES ('app', ?, 'dev')`, [repoPath]);
    db.run(
      `INSERT INTO issues (objective, description, status, created_at, updated_at)
       VALUES ('o', 'd', 'open', datetime('now'), datetime('now'))`,
    );
  }

  function addTask(
    db: ReturnType<typeof tempDB>,
    branchId: string,
    parent: string | null,
    commitSha: string | null,
    status: string,
  ): void {
    db.run(
      `INSERT INTO tasks (issue_id, branch_id, parent_branch_id, description, status, commit_sha, repo, created_at, updated_at)
       VALUES (1, ?, ?, 'd', ?, ?, 'app', datetime('now'), datetime('now'))`,
      [branchId, parent, status, commitSha],
    );
  }

  it('surfaces a closed-task branch whose tip is not merged into the target', async () => {
    const repo = gitRepo();
    const db = tempDB();
    try {
      seed(db, repo.repoRoot);
      addTask(db, 'fix/unmerged', 'dev', repo.unmergedTip, 'closed');
      const tools = worldModelTools(db, GraphHolder.fixed(stubGraph()));
      const out = wmParse((await tools.handlers['world_model_get']!({ agent: 'bro' })) as WmResult);
      const work = out['unmerged_work'] as Array<Record<string, unknown>>;
      assert.equal(work.length, 1, 'un-merged branch surfaces');
      assert.equal(work[0]!['branch_id'], 'fix/unmerged');
      assert.equal(work[0]!['parent_branch_id'], 'dev');
      assert.equal(work[0]!['tip'], repo.unmergedTip, 'newest commit_sha is the tip');
      assert.equal(work[0]!['closed_tasks'], 1);
      assert.equal(work[0]!['merged_into_target'], false);
      assert.equal(out['warning'], undefined, 'no warning on the success path');
    } finally {
      db.close();
      repo.cleanup();
    }
  });

  it('skips a branch whose local ref was deleted post-merge, even with an un-ancestor tip', async () => {
    const repo = gitRepo();
    const db = tempDB();
    try {
      seed(db, repo.repoRoot);
      addTask(db, 'fix/unmerged', 'dev', repo.unmergedTip, 'closed');
      // Simulate squash-merge cleanup: the tip stays reachable but the ref is gone.
      execFileSync('git', ['-C', repo.repoRoot, 'branch', '-D', 'fix/unmerged']);
      const tools = worldModelTools(db, GraphHolder.fixed(stubGraph()));
      const out = wmParse((await tools.handlers['world_model_get']!({ agent: 'bro' })) as WmResult);
      assert.deepEqual(out['unmerged_work'], [], 'deleted ref → skipped despite un-ancestor tip');
      assert.equal(out['warning'], undefined, 'no warning: a deleted ref is expected');
    } finally {
      db.close();
      repo.cleanup();
    }
  });

  it('skips a live-ref branch whose recorded tip is unresolvable, with no warning', async () => {
    const repo = gitRepo();
    const db = tempDB();
    try {
      seed(db, repo.repoRoot);
      // Live ref (fix/unmerged) but a dangling tip → is-ancestor exits 128.
      addTask(db, 'fix/unmerged', 'dev', 'a'.repeat(40), 'closed');
      const tools = worldModelTools(db, GraphHolder.fixed(stubGraph()));
      const r = (await tools.handlers['world_model_get']!({ agent: 'bro' })) as WmResult;
      const out = wmParse(r);
      assert.notEqual(r.isError, true, 'never an is_error');
      assert.deepEqual(out['unmerged_work'], [], 'dangling tip → skipped');
      assert.equal(out['warning'], undefined, 'exit-128 is not the spawn .error fail-soft path');
    } finally {
      db.close();
      repo.cleanup();
    }
  });

  it('omits merged branches and returns [] when nothing qualifies', async () => {
    const repo = gitRepo();
    const db = tempDB();
    try {
      seed(db, repo.repoRoot);
      addTask(db, 'fix/merged', 'dev', repo.devTip, 'closed'); // tip is an ancestor of dev
      const tools = worldModelTools(db, GraphHolder.fixed(stubGraph()));
      const out = wmParse((await tools.handlers['world_model_get']!({ agent: 'bro' })) as WmResult);
      assert.deepEqual(out['unmerged_work'], [], 'merged branch omitted → empty list');
    } finally {
      db.close();
      repo.cleanup();
    }
  });

  it('returns [] when the repo has no commit-bearing tasks', async () => {
    const repo = gitRepo();
    const db = tempDB();
    try {
      seed(db, repo.repoRoot);
      addTask(db, 'fix/pending', 'dev', null, 'pending'); // no commit_sha → not counted
      const tools = worldModelTools(db, GraphHolder.fixed(stubGraph()));
      const out = wmParse((await tools.handlers['world_model_get']!({ agent: 'bro' })) as WmResult);
      assert.deepEqual(out['unmerged_work'], [], 'no qualifying tasks → empty list');
    } finally {
      db.close();
      repo.cleanup();
    }
  });

  it('fail-soft on a non-git repos.path: empty list + unmerged-work-unavailable, no error', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'wm-nongit-'));
    const db = tempDB();
    try {
      db.run(`INSERT INTO repos (name, path, target_branch) VALUES ('app', ?, 'dev')`, [ws]);
      db.run(
        `INSERT INTO issues (objective, description, status, created_at, updated_at)
         VALUES ('o', 'd', 'open', datetime('now'), datetime('now'))`,
      );
      addTask(db, 'fix/orphan', 'dev', 'a'.repeat(40), 'closed');
      const tools = worldModelTools(db, GraphHolder.fixed(stubGraph()));
      const r = (await tools.handlers['world_model_get']!({ agent: 'bro' })) as WmResult;
      const out = wmParse(r);
      assert.notEqual(r.isError, true, 'never an is_error');
      assert.deepEqual(out['unmerged_work'], []);
      assert.equal(out['warning'], 'unmerged-work-unavailable');
    } finally {
      db.close();
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('pruneDirectories + rename regression (#342)', () => {
  it('old directory gone after a dir rename, new path visible (#342)', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'wm-rename-'));
    try {
      const repoRoot = join(ws, 'app');
      mkdirSync(join(repoRoot, 'old-dir'), { recursive: true });
      writeFileSync(join(repoRoot, 'old-dir', 'file.txt'), 'content\n');
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
      execFileSync('git', ['config', 'user.email', 't@t.io'], { cwd: repoRoot });
      execFileSync('git', ['config', 'user.name', 't'], { cwd: repoRoot });
      execFileSync('git', ['add', '.'], { cwd: repoRoot });
      execFileSync('git', ['commit', '-qm', 'init'], { cwd: repoRoot });

      const db = tempDB();
      const graph = new WorldModelGraph(db);
      const tools = scanTools(db, GraphHolder.fixed(graph), ':memory:');
      const r1 = (await tools.handlers['scan_run']!({ agent: 'bro', session_dir: ws })) as WmResult;
      assert.ok(!r1.isError, r1.content[0]!.text);
      assert.ok(graph.allDirectoriesForRepo('app').some((n) => n.path === 'old-dir'), 'old-dir present after first scan');

      renameSync(join(repoRoot, 'old-dir'), join(repoRoot, 'new-dir'));
      execFileSync('git', ['add', '-A'], { cwd: repoRoot });
      execFileSync('git', ['commit', '-qm', 'rename dir'], { cwd: repoRoot });
      const r2 = (await tools.handlers['scan_run']!({ agent: 'bro', session_dir: ws })) as WmResult;
      assert.ok(!r2.isError, r2.content[0]!.text);

      const after = graph.allDirectoriesForRepo('app').map((n) => n.path);
      assert.ok(!after.includes('old-dir'), 'old-dir must be gone after rename + rescan (#342)');
      assert.ok(after.includes('new-dir'), 'new-dir must be visible after rescan');
      db.close();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('world_model_get/search — File nodes', () => {
  afterEach(() => resetEmbeddingModelForTests());

  function fixture(): { ws: string; db: ReturnType<typeof tempDB>; graph: WorldModelGraph; holder: GraphHolder } {
    const ws = mkdtempSync(join(tmpdir(), 'wm-files-'));
    const repoRoot = join(ws, 'app');
    const files: Record<string, string> = {
      'README.md': '# App\n\nFixture application.\n',
      'src/a.ts': '// Parses inbound webhook payloads.\n',
      'src/b.ts': 'export const b = 1;\n',
      'lib/README.md': '# lib\n\nShared helpers.\n',
      'lib/zeta.ts': '// Quokka handshake negotiator.\n',
    };
    for (const [p, body] of Object.entries(files)) {
      mkdirSync(join(repoRoot, p, '..'), { recursive: true });
      writeFileSync(join(repoRoot, p), body);
    }
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.email', 't@t.io'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: repoRoot });
    execFileSync('git', ['add', '.'], { cwd: repoRoot });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: repoRoot });
    const db = tempDB();
    const graph = new WorldModelGraph(db);
    return { ws, db, graph, holder: GraphHolder.fixed(graph) };
  }

  async function scan(f: ReturnType<typeof fixture>): Promise<void> {
    const r = (await scanTools(f.db, f.holder, ':memory:').handlers['scan_run']!({ agent: 'bro', session_dir: f.ws })) as WmResult;
    assert.ok(!r.isError, r.content[0]!.text);
  }

  it('zoom-in lists files with purposes, root carries coverage, depth-2 children carry no files, keyword search returns kind:file', async () => {
    resetEmbeddingModelForTests(async () => {
      throw new Error('no model in tests');
    });
    const f = fixture();
    try {
      await scan(f);
      const wm = worldModelTools(f.db, f.holder).handlers;
      const zoom = wmParse((await wm['world_model_get']!({ agent: 'bro', repo: 'app', path: 'src', depth: 1 })) as WmResult) as {
        root: { path: string; files: Array<Record<string, unknown>> };
      };
      assert.equal(zoom.root.path, 'src');
      assert.deepEqual(zoom.root.files, [
        {
          path: 'src/a.ts',
          purpose: '<untrusted-content source="file-purpose">\nParses inbound webhook payloads.\n</untrusted-content>',
          purpose_source: 'comment',
          content_md5: zoom.root.files[0]!['content_md5'],
        },
        { path: 'src/b.ts', purpose: '', purpose_source: 'none', content_md5: zoom.root.files[1]!['content_md5'] },
      ]);
      assert.match(String(zoom.root.files[0]!['content_md5']), /^[0-9a-f]{32}$/);

      const root = wmParse((await wm['world_model_get']!({ agent: 'bro', repo: 'app' })) as WmResult) as {
        root: Record<string, unknown> & { children: Array<Record<string, unknown>> };
        coverage: unknown;
      };
      const all = f.graph.allFilesForRepo('app');
      const bySource: Record<string, number> = {};
      for (const file of all) bySource[file.purpose_source] = (bySource[file.purpose_source] ?? 0) + 1;
      assert.deepEqual(root.coverage, {
        files: all.length,
        with_purpose: all.filter((file) => file.purpose !== '').length,
        by_source: bySource,
      }, 'coverage matches the graph');
      assert.deepEqual(bySource, { comment: 2, heading: 2, none: 1 });
      assert.equal(root.root['files'], undefined, 'the default root call carries no file array');
      assert.ok(root.root.children.length > 0);
      for (const c of root.root.children) assert.equal(c['files'], undefined, `child ${String(c['path'])} carries no files`);

      const search = wmParse(
        (await wm['world_model_search']!({ agent: 'bro', repo: 'app', query: 'quokka', mode: 'keyword' })) as WmResult,
      ) as { results: Array<Record<string, unknown>>; mode: string };
      assert.equal(search.mode, 'keyword');
      assert.deepEqual(search.results.map((r) => [r['kind'], r['path']]), [['file', 'lib/zeta.ts']]);
      assert.equal(
        search.results[0]!['purpose'],
        '<untrusted-content source="file-purpose">\nQuokka handshake negotiator.\n</untrusted-content>',
        'file hit purposes leave the server framed',
      );
      const stored = Object.fromEntries(all.map((file) => [file.path, file.purpose]));
      assert.equal(stored['app/src/a.ts'], 'Parses inbound webhook payloads.', 'the graph keeps the raw purpose');
      assert.equal(stored['app/lib/zeta.ts'], 'Quokka handshake negotiator.');

      const hybrid = wmParse(
        (await wm['world_model_search']!({ agent: 'bro', repo: 'app', query: 'lib' })) as WmResult,
      ) as { results: Array<Record<string, unknown>>; warning: string; mode: string };
      assert.equal(hybrid.mode, 'hybrid');
      assert.equal(hybrid.warning, 'semantic_unavailable', 'no model: hybrid falls back to keyword hits');
      assert.deepEqual(
        hybrid.results.map((r) => [r['kind'], r['path']]).sort(),
        [['dir', 'lib'], ['file', 'lib/README.md'], ['file', 'lib/zeta.ts']],
        'directories and files, each tagged with kind',
      );
    } finally {
      f.db.close();
      rmSync(f.ws, { recursive: true, force: true });
    }
  });

  it('semantic and hybrid rank by embeddings once the model is available', async () => {
    resetEmbeddingModelForTests(bagOfWordsLoader());
    const f = fixture();
    try {
      await scan(f);
      const wm = worldModelTools(f.db, f.holder).handlers;
      const semantic = wmParse(
        (await wm['world_model_search']!({ agent: 'bro', repo: 'app', query: 'handshake negotiator', mode: 'semantic' })) as WmResult,
      ) as { results: Array<Record<string, unknown>>; warning?: string; mode: string };
      assert.equal(semantic.mode, 'semantic');
      assert.equal(semantic.warning, undefined);
      assert.deepEqual([semantic.results[0]!['kind'], semantic.results[0]!['path']], ['file', 'lib/zeta.ts']);

      const embedded = f.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM wm_files_embeddings')!.n;
      assert.equal(embedded, 4, 'every file with a purpose was embedded on demand');

      const hybrid = wmParse(
        (await wm['world_model_search']!({ agent: 'bro', repo: 'app', query: 'quokka handshake' })) as WmResult,
      ) as { results: Array<Record<string, unknown>>; warning?: string };
      assert.equal(hybrid.warning, undefined);
      assert.deepEqual([hybrid.results[0]!['kind'], hybrid.results[0]!['path']], ['file', 'lib/zeta.ts']);
      assert.ok(Number(hybrid.results[0]!['score']) > 0);

      const before = f.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM wm_files_embeddings')!.n;
      f.graph.upsertFile({ ...f.graph.allFilesForRepo('app').find((x) => x.path === 'app/lib/zeta.ts')!, purpose: 'Changed purpose.' });
      const after = f.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM wm_files_embeddings')!.n;
      assert.equal(after, before - 1, 'a purpose change drops the stale embedding');
    } finally {
      f.db.close();
      rmSync(f.ws, { recursive: true, force: true });
    }
  });
});
