import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildTree, worldModelTools } from '../tools/world_model.js';
import { WorldModelGraph } from '../graph-db.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { tempDB } from './helpers.js';
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
import { WorldModelGraph } from '${distRoot}/graph-db.js';
import { scanTools } from '${distRoot}/tools/scan.js';

const ws = ${JSON.stringify(ws)};
const repoRoot = ${JSON.stringify(repoRoot)};
const db = new TrajectoryDB(':memory:');
const graph = new WorldModelGraph(ws + '/world-model.kuzu');
const tools = scanTools(db, graph, ':memory:');

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
//# sourceMappingURL=world_model.test.js.map