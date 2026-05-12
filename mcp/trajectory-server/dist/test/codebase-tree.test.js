import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderCodebaseTree } from '../renderers/codebase-tree.js';
const OPTS = { generatedAt: '2026-04-21' };
function makeRow(overrides) {
    return {
        language: null,
        size_bytes: null,
        last_commit_sha: null,
        last_change_type: null,
        last_change_at: null,
        imports: [],
        exports: [],
        metadata: {},
        ...overrides,
    };
}
describe('renderCodebaseTree', () => {
    it('empty input produces valid doc with "0 files indexed."', () => {
        const out = renderCodebaseTree([], OPTS);
        assert.ok(out.startsWith('<!-- Auto-rendered 2026-04-21. Do not edit. -->'), `Expected header:\n${out}`);
        assert.ok(out.includes('0 files indexed.'), `Expected "0 files indexed." in:\n${out}`);
        assert.ok(out.includes('# Codebase Tree'), `Expected heading in:\n${out}`);
    });
    it('empty input has empty tree block', () => {
        const out = renderCodebaseTree([], OPTS);
        assert.ok(out.includes('```\n```'), `Expected empty code block in:\n${out}`);
    });
    it('output starts with generated-header line exactly', () => {
        const out = renderCodebaseTree([], OPTS);
        assert.ok(out.startsWith('<!-- Auto-rendered 2026-04-21.'));
    });
    it('single file renders one leaf with correct annotation', () => {
        const rows = [makeRow({ path: 'src/index.ts', type: 'source', language: 'ts' })];
        const out = renderCodebaseTree(rows, OPTS);
        assert.ok(out.includes('1 files indexed.'), `Expected "1 files indexed." in:\n${out}`);
        assert.ok(out.includes('index.ts'), `Expected filename in:\n${out}`);
        assert.ok(out.includes('(source, ts)'), `Expected annotation in:\n${out}`);
    });
    it('annotation without language omits language part', () => {
        const rows = [makeRow({ path: 'README.md', type: 'doc' })];
        const out = renderCodebaseTree(rows, OPTS);
        assert.ok(out.includes('(doc)'), `Expected "(doc)" annotation in:\n${out}`);
        assert.ok(!out.includes('(doc,'), `Should not include language in:\n${out}`);
    });
    it('deleted files are omitted from tree and count', () => {
        const rows = [
            makeRow({ path: 'src/active.ts', type: 'source', language: 'ts' }),
            makeRow({ path: 'src/gone.ts', type: 'source', language: 'ts', last_change_type: 'deleted' }),
        ];
        const out = renderCodebaseTree(rows, OPTS);
        assert.ok(out.includes('1 files indexed.'), `Expected 1 file indexed (deleted omitted) in:\n${out}`);
        assert.ok(!out.includes('gone.ts'), `Deleted file should not appear in:\n${out}`);
        assert.ok(out.includes('active.ts'), `Active file should appear in:\n${out}`);
    });
    it('multi-directory input renders proper tree lines', () => {
        const rows = [
            makeRow({ path: 'src/agents/bro.md', type: 'doc' }),
            makeRow({ path: 'src/agents/architect.md', type: 'doc' }),
            makeRow({ path: 'README.md', type: 'doc' }),
        ];
        const out = renderCodebaseTree(rows, OPTS);
        assert.ok(out.includes('src/'), `Expected "src/" dir in:\n${out}`);
        assert.ok(out.includes('bro.md'), `Expected bro.md in:\n${out}`);
        assert.ok(out.includes('architect.md'), `Expected architect.md in:\n${out}`);
        assert.ok(out.includes('README.md'), `Expected README.md in:\n${out}`);
        assert.ok(out.includes('├──') || out.includes('└──'), `Expected tree chars in:\n${out}`);
    });
    it('non-last items use ├── and last item uses └──', () => {
        const rows = [
            makeRow({ path: 'a.ts', type: 'source' }),
            makeRow({ path: 'b.ts', type: 'source' }),
        ];
        const out = renderCodebaseTree(rows, OPTS);
        assert.ok(out.includes('├──'), `Expected ├── for non-last in:\n${out}`);
        assert.ok(out.includes('└──'), `Expected └── for last in:\n${out}`);
    });
    it('directory with single child dir is collapsed', () => {
        const rows = [
            makeRow({ path: 'mcp/trajectory-server/src/db.ts', type: 'source', language: 'ts' }),
        ];
        const out = renderCodebaseTree(rows, OPTS);
        assert.ok(out.includes('mcp/trajectory-server/src/'), `Expected collapsed dir path in:\n${out}`);
    });
    it('summary table counts match non-deleted rows by type', () => {
        const rows = [
            makeRow({ path: 'src/a.ts', type: 'source' }),
            makeRow({ path: 'src/b.ts', type: 'source' }),
            makeRow({ path: 'src/a.test.ts', type: 'test' }),
            makeRow({ path: 'README.md', type: 'doc' }),
            makeRow({ path: 'src/gone.ts', type: 'source', last_change_type: 'deleted' }),
        ];
        const out = renderCodebaseTree(rows, OPTS);
        assert.ok(out.includes('## Summary by type'), `Expected summary section in:\n${out}`);
        assert.ok(out.includes('| source |'), `Expected source row in summary:\n${out}`);
        assert.ok(out.includes('| test   |'), `Expected test row in summary:\n${out}`);
        assert.ok(out.includes('| doc    |'), `Expected doc row in summary:\n${out}`);
        const sourceMatch = out.match(/\| source \|[^|]+(\d+)\s*\|/);
        assert.ok(sourceMatch, 'Expected source count row');
        assert.equal(sourceMatch[1].trim(), '2', `Expected source count 2 (deleted excluded), got ${sourceMatch[1]}`);
    });
    it('paths sorted alphabetically at each level', () => {
        const rows = [
            makeRow({ path: 'z.ts', type: 'source' }),
            makeRow({ path: 'a.ts', type: 'source' }),
            makeRow({ path: 'm.ts', type: 'source' }),
        ];
        const out = renderCodebaseTree(rows, OPTS);
        const aIdx = out.indexOf('a.ts');
        const mIdx = out.indexOf('m.ts');
        const zIdx = out.indexOf('z.ts');
        assert.ok(aIdx < mIdx && mIdx < zIdx, `Expected alphabetical order in:\n${out}`);
    });
    it('deterministic: same input produces identical output', () => {
        const rows = [
            makeRow({ path: 'src/db.ts', type: 'source', language: 'ts' }),
            makeRow({ path: 'src/index.ts', type: 'source', language: 'ts' }),
            makeRow({ path: 'README.md', type: 'doc' }),
            makeRow({ path: 'schema.sql', type: 'config', language: 'sql' }),
        ];
        const out1 = renderCodebaseTree(rows, OPTS);
        const out2 = renderCodebaseTree(rows, OPTS);
        assert.equal(out1, out2, 'Output should be deterministic');
    });
    it('continuation lines use │   for non-last dirs and spaces for last', () => {
        const rows = [
            makeRow({ path: 'src/tools/a.ts', type: 'source' }),
            makeRow({ path: 'lib/b.ts', type: 'source' }),
        ];
        const out = renderCodebaseTree(rows, OPTS);
        assert.ok(out.includes('│'), `Expected │ continuation in:\n${out}`);
    });
    it('summary table has correct header', () => {
        const rows = [makeRow({ path: 'src/x.ts', type: 'source' })];
        const out = renderCodebaseTree(rows, OPTS);
        assert.ok(out.includes('| Type   | Count |'), `Expected table header in:\n${out}`);
        assert.ok(out.includes('|--------|-------|'), `Expected table separator in:\n${out}`);
    });
    it('all-deleted input produces 0 files indexed and empty tree', () => {
        const rows = [
            makeRow({ path: 'src/old.ts', type: 'source', last_change_type: 'deleted' }),
        ];
        const out = renderCodebaseTree(rows, OPTS);
        assert.ok(out.includes('0 files indexed.'), `Expected 0 files when all deleted:\n${out}`);
        assert.ok(!out.includes('old.ts'), `Deleted file should not appear:\n${out}`);
    });
});
//# sourceMappingURL=codebase-tree.test.js.map