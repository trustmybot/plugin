import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildTree, worldModelTools } from '../tools/world_model.js';
import { WorldModelGraph, GraphHolder } from '../graph-db.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pinScanEnv, runGraphScript, tempDB } from './helpers.js';
const scanPin = pinScanEnv();
after(() => scanPin.restore());
// Helper to detect whether kuzu is loadable in this environment.
function kuzuAvailable() {
    try {
        const g = new WorldModelGraph(':memory:');
        g.close();
        return true;
    }
    catch {
        return false;
    }
}
// Synthetic Directory rows mirroring what allDirectoriesForRepo returns AFTER
// the #269 read fix: top-level dirs carry parent_path '' (the repo root's own
// path), and the repo root itself has path ''. No kuzu handle — the existing
// suite deliberately keeps in-process kuzu out of unit tests.
function row(path, parent_path) {
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
        assert.equal(tree.path, '');
        const top = tree.children.map((c) => c.path).sort();
        assert.deepEqual(top, ['docs', 'src'], 'top-level dirs surface as root children (#269)');
        const src = tree.children.find((c) => c.path === 'src');
        assert.ok(src && src.children.some((c) => c.path === 'src/api'), 'nested dir reachable');
    });
    it('does not list the root as its own child', () => {
        const tree = buildTree([row('', ''), row('docs', '')], '', null);
        assert.ok(!tree.children.some((c) => c.path === ''), 'root must not be its own child');
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
        for (let i = 0; i < 10; i++)
            rows.push(row(`dir${i}`, ''));
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
        assert.equal(tree.summary, 'line1\nline2\nline3', 'root summary not truncated');
    });
    it('passes full summary at depth 1 (immediate child)', () => {
        const root = { ...row('', ''), summary: 'root summary' };
        const child = { ...row('src', ''), summary: 'line1\nline2' };
        const tree = buildTree([root, child], '', null);
        assert.ok(tree, 'tree builds');
        const src = tree.children.find((c) => c.path === 'src');
        assert.ok(src, 'src child found');
        assert.equal(src.summary, 'line1\nline2', 'depth-1 summary not truncated');
    });
    it('truncates multi-line summary to first line at depth 2+', () => {
        const root = { ...row('', ''), summary: null };
        const child = { ...row('src', ''), summary: null };
        const grandchild = { ...row('src/api', 'src'), summary: 'first line\nsecond line\nthird' };
        const tree = buildTree([root, child, grandchild], '', null);
        assert.ok(tree, 'tree builds');
        const api = tree.children
            .find((c) => c.path === 'src')
            ?.children.find((c) => c.path === 'src/api');
        assert.ok(api, 'src/api found at depth 2');
        assert.equal(api.summary, 'first line', 'depth-2 summary truncated to first line');
    });
});
function wmParse(r) {
    return JSON.parse(r.content[0].text);
}
describe('world_model_get/search — repo-unspecified (#15)', () => {
    it('world_model_get returns repo-unspecified + available_repos in multi-repo with no repo arg', async () => {
        const db = tempDB();
        db.run(`INSERT INTO repos (name, path) VALUES ('frontend', '/tmp/frontend')`);
        db.run(`INSERT INTO repos (name, path) VALUES ('backend', '/tmp/backend')`);
        const tools = worldModelTools(db, null);
        const r = (await tools.handlers['world_model_get']({ agent: 'bro' }));
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
        const r = (await tools.handlers['world_model_search']({ agent: 'bro', query: 'parser' }));
        const out = wmParse(r);
        assert.equal(out['warning'], 'repo-unspecified', 'multi-repo no-arg must warn repo-unspecified');
        assert.deepEqual(out['available_repos'], ['backend', 'frontend']);
        assert.deepEqual(out['results'], []);
        db.close();
    });
    it('world_model_get with 0 repos falls through to world-model-unavailable (not repo-unspecified) (#16)', async () => {
        const db = tempDB();
        const tools = worldModelTools(db, null);
        const r = (await tools.handlers['world_model_get']({ agent: 'bro' }));
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
        const r = (await tools.handlers['world_model_search']({ agent: 'bro', query: 'parser' }));
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
        const r = (await tools.handlers['world_model_get']({ agent: 'bro' }));
        const out = wmParse(r);
        // Sole repo resolves, so we fall through to the graph check (null graph here).
        assert.equal(out['warning'], 'world-model-unavailable', 'sole repo resolves past the selector check');
        assert.notEqual(out['warning'], 'repo-unspecified');
        db.close();
    });
});
// unmerged_work — closed-task branches not yet merged into the target (#1059).
// A stub graph (no kuzu) returns a single root dir so the handler reaches the
// success path; the git work happens against a real temp repo.
describe('world_model_get — unmerged_work (#1059)', () => {
    function stubGraph() {
        return {
            allDirectoriesForRepo: () => [row('', '')],
            fileCoverage: () => ({ files: 0, with_purpose: 0, by_source: {} }),
        };
    }
    function gitRepo() {
        const ws = mkdtempSync(join(tmpdir(), 'wm-unmerged-'));
        const repoRoot = join(ws, 'app');
        mkdirSync(repoRoot, { recursive: true });
        const git = (...a) => execFileSync('git', ['-C', repoRoot, ...a], { encoding: 'utf8' });
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
    function seed(db, repoPath) {
        db.run(`INSERT INTO repos (name, path, target_branch) VALUES ('app', ?, 'dev')`, [repoPath]);
        db.run(`INSERT INTO issues (objective, description, status, created_at, updated_at)
       VALUES ('o', 'd', 'open', datetime('now'), datetime('now'))`);
    }
    function addTask(db, branchId, parent, commitSha, status) {
        db.run(`INSERT INTO tasks (issue_id, branch_id, parent_branch_id, description, status, commit_sha, repo, created_at, updated_at)
       VALUES (1, ?, ?, 'd', ?, ?, 'app', datetime('now'), datetime('now'))`, [branchId, parent, status, commitSha]);
    }
    it('surfaces a closed-task branch whose tip is not merged into the target', async () => {
        const repo = gitRepo();
        const db = tempDB();
        try {
            seed(db, repo.repoRoot);
            addTask(db, 'fix/unmerged', 'dev', repo.unmergedTip, 'closed');
            const tools = worldModelTools(db, GraphHolder.fixed(stubGraph()));
            const out = wmParse((await tools.handlers['world_model_get']({ agent: 'bro' })));
            const work = out['unmerged_work'];
            assert.equal(work.length, 1, 'un-merged branch surfaces');
            assert.equal(work[0]['branch_id'], 'fix/unmerged');
            assert.equal(work[0]['parent_branch_id'], 'dev');
            assert.equal(work[0]['tip'], repo.unmergedTip, 'newest commit_sha is the tip');
            assert.equal(work[0]['closed_tasks'], 1);
            assert.equal(work[0]['merged_into_target'], false);
            assert.equal(out['warning'], undefined, 'no warning on the success path');
        }
        finally {
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
            const out = wmParse((await tools.handlers['world_model_get']({ agent: 'bro' })));
            assert.deepEqual(out['unmerged_work'], [], 'deleted ref → skipped despite un-ancestor tip');
            assert.equal(out['warning'], undefined, 'no warning: a deleted ref is expected');
        }
        finally {
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
            const r = (await tools.handlers['world_model_get']({ agent: 'bro' }));
            const out = wmParse(r);
            assert.notEqual(r.isError, true, 'never an is_error');
            assert.deepEqual(out['unmerged_work'], [], 'dangling tip → skipped');
            assert.equal(out['warning'], undefined, 'exit-128 is not the spawn .error fail-soft path');
        }
        finally {
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
            const out = wmParse((await tools.handlers['world_model_get']({ agent: 'bro' })));
            assert.deepEqual(out['unmerged_work'], [], 'merged branch omitted → empty list');
        }
        finally {
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
            const out = wmParse((await tools.handlers['world_model_get']({ agent: 'bro' })));
            assert.deepEqual(out['unmerged_work'], [], 'no qualifying tasks → empty list');
        }
        finally {
            db.close();
            repo.cleanup();
        }
    });
    it('fail-soft on a non-git repos.path: empty list + unmerged-work-unavailable, no error', async () => {
        const ws = mkdtempSync(join(tmpdir(), 'wm-nongit-'));
        const db = tempDB();
        try {
            db.run(`INSERT INTO repos (name, path, target_branch) VALUES ('app', ?, 'dev')`, [ws]);
            db.run(`INSERT INTO issues (objective, description, status, created_at, updated_at)
         VALUES ('o', 'd', 'open', datetime('now'), datetime('now'))`);
            addTask(db, 'fix/orphan', 'dev', 'a'.repeat(40), 'closed');
            const tools = worldModelTools(db, GraphHolder.fixed(stubGraph()));
            const r = (await tools.handlers['world_model_get']({ agent: 'bro' }));
            const out = wmParse(r);
            assert.notEqual(r.isError, true, 'never an is_error');
            assert.deepEqual(out['unmerged_work'], []);
            assert.equal(out['warning'], 'unmerged-work-unavailable');
        }
        finally {
            db.close();
            rmSync(ws, { recursive: true, force: true });
        }
    });
});
// Rename-prune regression test (#342). kuzu is instantiated in a child
// process so that kuzu's native destructor crash on exit (kuzu v0.11 /
// Node 24 / macOS known issue) does not propagate to this test file's
// exit code. All assertions are reported via stdout JSON.
describe('pruneDirectories + rename regression (#342)', () => {
    it('old node + CONTAINS edge gone after dir rename, new path visible (#342)', async () => {
        if (!kuzuAvailable()) {
            console.log('  SKIP: kuzu not available in this environment');
            return;
        }
        const ws = mkdtempSync(join(tmpdir(), 'wm-rename-'));
        try {
            // Prepare the repo fixture in-process (no kuzu needed here).
            const repoRoot = join(ws, 'app');
            mkdirSync(join(repoRoot, 'old-dir'), { recursive: true });
            writeFileSync(join(repoRoot, 'old-dir', 'file.txt'), 'content\n');
            execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
            execFileSync('git', ['config', 'user.email', 't@t.io'], { cwd: repoRoot });
            execFileSync('git', ['config', 'user.name', 't'], { cwd: repoRoot });
            execFileSync('git', ['add', '.'], { cwd: repoRoot });
            execFileSync('git', ['commit', '-qm', 'init'], { cwd: repoRoot });
            // Delegate the kuzu-heavy portion to a child process.
            // import.meta.url is dist/test/world_model.test.js; dist/ is one level up.
            const distRoot = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
            const script = `
import { TrajectoryDB } from '${distRoot}/db.js';
import { WorldModelGraph, GraphHolder } from '${distRoot}/graph-db.js';
import { scanTools } from '${distRoot}/tools/scan.js';

const ws = ${JSON.stringify(ws)};
const repoRoot = ${JSON.stringify(repoRoot)};
const db = new TrajectoryDB(':memory:');
const graph = new WorldModelGraph(ws + '/world-model.kuzu');
const tools = scanTools(db, GraphHolder.fixed(graph), ':memory:');

// First scan.
const r1 = await tools.handlers.scan_run({ agent: 'bro', session_dir: ws });
if (r1.isError) { console.log(JSON.stringify({ok:false,msg:'first scan failed: '+r1.content[0].text})); process.exit(1); }

const nodesBefore = graph.allDirectoriesForRepo('app');
const hadOldDir = nodesBefore.some(n => n.path === 'old-dir');

// Rename.
import { renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
renameSync(repoRoot + '/old-dir', repoRoot + '/new-dir');
execFileSync('git', ['add', '-A'], { cwd: repoRoot });
execFileSync('git', ['commit', '-qm', 'rename dir'], { cwd: repoRoot });

// Second scan.
const r2 = await tools.handlers.scan_run({ agent: 'bro', session_dir: ws });
if (r2.isError) { console.log(JSON.stringify({ok:false,msg:'second scan failed: '+r2.content[0].text})); process.exit(1); }

const nodesAfter = graph.allDirectoriesForRepo('app');
const hasOldDir = nodesAfter.some(n => n.path === 'old-dir');
const hasNewDir = nodesAfter.some(n => n.path === 'new-dir');

graph.close();
db.close();

console.log(JSON.stringify({ ok: true, hadOldDir, hasOldDir, hasNewDir }));
`;
            let stdout = '';
            try {
                stdout = execFileSync(process.execPath, ['--experimental-sqlite', '--input-type=module'], { input: script, encoding: 'utf8', timeout: 30000 });
            }
            catch (e) {
                const se = e;
                // Exit 139 (SIGSEGV) from kuzu native cleanup is expected — check stdout.
                const out = se.stdout ?? '';
                if (out.trim())
                    stdout = out;
                else
                    throw new Error(`child process failed (exit ${se.status}): ${se.stderr?.slice(0, 500) ?? ''}`);
            }
            const result = JSON.parse(stdout.trim().split('\n').find((l) => l.startsWith('{')) ?? '{}');
            assert.ok(result.ok !== false, `child assertion: ${result.msg ?? 'unknown'}`);
            assert.ok(result.hadOldDir, 'old-dir node present after first scan');
            assert.ok(!result.hasOldDir, 'old-dir node must be gone after rename + rescan (#342)');
            assert.ok(result.hasNewDir, 'new-dir node must be visible after rescan');
        }
        finally {
            rmSync(ws, { recursive: true, force: true });
        }
    });
});
describe('world_model_get/search — File nodes', () => {
    it('zoom-in lists files with purposes, root carries coverage, depth-2 children carry no files, search returns kind:file', () => {
        const ws = mkdtempSync(join(tmpdir(), 'wm-files-'));
        try {
            const repoRoot = join(ws, 'app');
            const files = {
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
            const out = runGraphScript(`
import { tempDB } from '$DIST/test/helpers.js';
import { WorldModelGraph, GraphHolder } from '$DIST/graph-db.js';
import { scanTools } from '$DIST/tools/scan.js';
import { worldModelTools } from '$DIST/tools/world_model.js';

const ws = ${JSON.stringify(ws)};
const db = tempDB();
const graph = new WorldModelGraph(ws + '/world-model.kuzu');
const holder = GraphHolder.fixed(graph);
const scan = await scanTools(db, holder, ':memory:').handlers.scan_run({ agent: 'bro', session_dir: ws });
if (scan.isError) { console.log(JSON.stringify({ error: scan.content[0].text })); process.exit(0); }
const wm = worldModelTools(db, holder).handlers;
const parse = (r) => JSON.parse(r.content[0].text);
const zoom = parse(await wm.world_model_get({ agent: 'bro', repo: 'app', path: 'src', depth: 1 }));
const root = parse(await wm.world_model_get({ agent: 'bro', repo: 'app' }));
const search = parse(await wm.world_model_search({ agent: 'bro', repo: 'app', query: 'quokka', mode: 'keyword' }));
const hybrid = parse(await wm.world_model_search({ agent: 'bro', repo: 'app', query: 'lib' }));
const all = graph.allFilesForRepo('app');
const stored = Object.fromEntries(all.map((f) => [f.path, f.purpose]));
const graphCounts = {
  files: all.length,
  with_purpose: all.filter((f) => f.purpose !== '').length,
  by_source: all.reduce((acc, f) => ({ ...acc, [f.purpose_source]: (acc[f.purpose_source] ?? 0) + 1 }), {}),
};
graph.close();
db.close();
console.log(JSON.stringify({ zoom, root, search, hybrid, graphCounts, stored }));
`);
            assert.equal(out['error'], undefined, `scan failed: ${String(out['error'])}`);
            const zoom = out['zoom'];
            assert.equal(zoom.root.path, 'src');
            assert.deepEqual(zoom.root.files, [
                {
                    path: 'src/a.ts',
                    purpose: '<untrusted-content source="file-purpose">\nParses inbound webhook payloads.\n</untrusted-content>',
                    purpose_source: 'comment',
                    content_md5: zoom.root.files[0]['content_md5'],
                },
                { path: 'src/b.ts', purpose: '', purpose_source: 'none', content_md5: zoom.root.files[1]['content_md5'] },
            ]);
            assert.match(String(zoom.root.files[0]['content_md5']), /^[0-9a-f]{32}$/);
            const root = out['root'];
            const graphCounts = out['graphCounts'];
            assert.deepEqual(root.coverage, graphCounts, 'coverage matches the graph');
            assert.deepEqual(graphCounts.by_source, { comment: 2, heading: 2, none: 1 });
            assert.equal(root.root['files'], undefined, 'the default root call carries no file array');
            assert.ok(root.root.children.length > 0);
            for (const c of root.root.children)
                assert.equal(c['files'], undefined, `child ${String(c['path'])} carries no files`);
            const search = out['search'];
            assert.equal(search.mode, 'keyword');
            assert.deepEqual(search.results.map((r) => [r['kind'], r['path']]), [['file', 'lib/zeta.ts']]);
            assert.equal(search.results[0]['purpose'], '<untrusted-content source="file-purpose">\nQuokka handshake negotiator.\n</untrusted-content>', 'file hit purposes leave the server framed');
            const stored = out['stored'];
            assert.equal(stored['app/src/a.ts'], 'Parses inbound webhook payloads.', 'the graph keeps the raw purpose');
            assert.equal(stored['app/lib/zeta.ts'], 'Quokka handshake negotiator.');
            const hybrid = out['hybrid'];
            assert.equal(hybrid.warning, 'semantic_unavailable');
            assert.deepEqual(hybrid.results.map((r) => [r['kind'], r['path']]), [['dir', 'lib'], ['file', 'lib/README.md'], ['file', 'lib/zeta.ts']], 'directories first, then files, each tagged with kind');
        }
        finally {
            rmSync(ws, { recursive: true, force: true });
        }
    });
});
//# sourceMappingURL=world_model.test.js.map