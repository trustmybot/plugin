import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildTree } from '../tools/world-model.js';
import { WorldModelGraph } from '../graph-db.js';
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
//# sourceMappingURL=world-model.test.js.map