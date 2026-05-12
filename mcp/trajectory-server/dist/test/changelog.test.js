import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderChangelog } from '../renderers/changelog.js';
const OPTS_WITH_SINCE = {
    generatedAt: '2026-04-21',
    sinceSha: 'abc1234def',
    sinceDate: '2026-04-01',
};
const OPTS_NO_SINCE = {
    generatedAt: '2026-04-21',
    sinceSha: null,
    sinceDate: null,
};
function makeCommit(overrides = {}) {
    return {
        sha: 'aabbccdd1234567',
        author: 'Test Author',
        date: '2026-04-21T10:00:00Z',
        subject: 'feat(mcp): something',
        body: '',
        files_changed: [],
        ...overrides,
    };
}
describe('renderChangelog', () => {
    it('empty commits array produces valid doc with "0 commits."', () => {
        const out = renderChangelog([], OPTS_WITH_SINCE);
        assert.ok(out.includes('0 commits,'), `Expected "0 commits," in output:\n${out}`);
        assert.ok(!out.includes('##'), 'Expected no date sections for empty input');
        assert.ok(out.includes('# Changelog'), 'Expected heading');
    });
    it('empty commits with no since → "All history."', () => {
        const out = renderChangelog([], OPTS_NO_SINCE);
        assert.ok(out.includes('All history.'), `Expected "All history." in:\n${out}`);
    });
    it('sinceSha and sinceDate appear in header', () => {
        const out = renderChangelog([], OPTS_WITH_SINCE);
        assert.ok(out.includes('`abc1234`'), `Expected abbrev sha in header:\n${out}`);
        assert.ok(out.includes('(2026-04-01)'), `Expected date in header:\n${out}`);
    });
    it('single commit produces one date section', () => {
        const c = makeCommit({ sha: 'd34fa890000', date: '2026-04-21T09:00:00Z', subject: 'feat(mcp): module-graph renderer', author: 'Test Author', files_changed: ['src/renderers/module-graph.ts'] });
        const out = renderChangelog([c], OPTS_WITH_SINCE);
        assert.ok(out.includes('## 2026-04-21'), `Expected date section:\n${out}`);
        assert.ok(out.includes('`d34fa89`'), `Expected sha:\n${out}`);
        assert.ok(out.includes('feat(mcp): module-graph renderer'), `Expected subject:\n${out}`);
        assert.ok(out.includes('Test Author'), `Expected author:\n${out}`);
        assert.ok(out.includes('`src/renderers/module-graph.ts`'), `Expected file:\n${out}`);
        const sections = out.match(/^## /gm);
        assert.equal(sections?.length ?? 0, 1, 'Expected exactly one date section');
    });
    it('multi-commit multi-day input grouped by date descending', () => {
        const c1 = makeCommit({ sha: 'aaaaaaa0001', date: '2026-04-21T10:00:00Z', subject: 'feat(mcp): newer', author: 'Test Author' });
        const c2 = makeCommit({ sha: 'bbbbbbb0002', date: '2026-04-20T10:00:00Z', subject: 'fix(db): older', author: 'Test Author' });
        const out = renderChangelog([c1, c2], OPTS_WITH_SINCE);
        const idx21 = out.indexOf('2026-04-21');
        const idx20 = out.indexOf('2026-04-20');
        assert.ok(idx21 < idx20, 'Newer date should appear before older date');
        assert.ok(out.includes('2 commits,'), `Expected "2 commits," in:\n${out}`);
    });
    it('commits on same day grouped by conventional scope', () => {
        const c1 = makeCommit({ sha: 'ccccccc0001', date: '2026-04-21T10:00:00Z', subject: 'feat(mcp): renderer A', author: 'Test Author' });
        const c2 = makeCommit({ sha: 'ddddddd0002', date: '2026-04-21T11:00:00Z', subject: 'feat(mcp): renderer B', author: 'Test Author' });
        const c3 = makeCommit({ sha: 'eeeeeee0003', date: '2026-04-21T12:00:00Z', subject: 'fix(db): unrelated fix', author: 'Test Author' });
        const out = renderChangelog([c1, c2, c3], OPTS_WITH_SINCE);
        const mcpSection = out.includes('— mcp (2 commits)') || out.includes('— mcp (2 commit');
        assert.ok(mcpSection, `Expected mcp group with 2 commits in:\n${out}`);
        const dbSection = out.includes('— db (1 commit)');
        assert.ok(dbSection, `Expected db group with 1 commit in:\n${out}`);
    });
    it('non-conventional subject falls back to author grouping', () => {
        const c1 = makeCommit({ sha: 'fffffff0001', date: '2026-04-21T10:00:00Z', subject: 'Some arbitrary commit message', author: 'Alice' });
        const c2 = makeCommit({ sha: '1111111', date: '2026-04-21T11:00:00Z', subject: 'Another arbitrary message', author: 'Alice' });
        const out = renderChangelog([c1, c2], OPTS_WITH_SINCE);
        assert.ok(out.includes('— Alice (2 commit'), `Expected Alice group in:\n${out}`);
    });
    it('files_changed rendered as comma-separated backtick list', () => {
        const c = makeCommit({ files_changed: ['src/a.ts', 'src/b.ts'] });
        const out = renderChangelog([c], OPTS_WITH_SINCE);
        assert.ok(out.includes('`src/a.ts`, `src/b.ts`'), `Expected formatted files in:\n${out}`);
    });
    it('sha is truncated to 7 chars', () => {
        const c = makeCommit({ sha: 'abcdefg1234567890' });
        const out = renderChangelog([c], OPTS_WITH_SINCE);
        assert.ok(out.includes('`abcdefg`'), `Expected 7-char abbrev in:\n${out}`);
        assert.ok(!out.includes('`abcdefg1`'), 'Should not have 8-char sha');
    });
    it('output includes generation comment header', () => {
        const out = renderChangelog([], OPTS_WITH_SINCE);
        assert.ok(out.startsWith('<!-- Auto-rendered 2026-04-21.'), `Expected HTML comment header:\n${out}`);
    });
    it('unique file count across all commits', () => {
        const c1 = makeCommit({ files_changed: ['a.ts', 'b.ts'] });
        const c2 = makeCommit({ files_changed: ['b.ts', 'c.ts'] });
        const out = renderChangelog([c1, c2], OPTS_WITH_SINCE);
        assert.ok(out.includes('3 files touched'), `Expected 3 unique files in:\n${out}`);
    });
    it('sinceSha only (no sinceDate) produces partial since line', () => {
        const out = renderChangelog([], { generatedAt: '2026-04-21', sinceSha: 'deadbeef', sinceDate: null });
        assert.ok(out.includes('`deadbee`'), `Expected sha in:\n${out}`);
        assert.ok(!out.includes('(null)'), 'Should not render null date');
    });
    it('sinceDate only (no sinceSha) produces partial since line', () => {
        const out = renderChangelog([], { generatedAt: '2026-04-21', sinceSha: null, sinceDate: '2026-03-15T00:00:00Z' });
        assert.ok(out.includes('(2026-03-15)'), `Expected date in:\n${out}`);
        assert.ok(!out.includes('null'), 'Should not render null sha');
    });
    it('deterministic ordering: same input always same output', () => {
        const commits = [
            makeCommit({ sha: 'aaa0001', date: '2026-04-21T10:00:00Z', subject: 'feat(mcp): A' }),
            makeCommit({ sha: 'bbb0002', date: '2026-04-20T10:00:00Z', subject: 'fix(db): B' }),
            makeCommit({ sha: 'ccc0003', date: '2026-04-21T11:00:00Z', subject: 'feat(mcp): C' }),
        ];
        const out1 = renderChangelog(commits, OPTS_WITH_SINCE);
        const out2 = renderChangelog(commits, OPTS_WITH_SINCE);
        assert.equal(out1, out2, 'Output should be deterministic');
    });
});
//# sourceMappingURL=changelog.test.js.map