import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tempDB } from './helpers.js';
import { resolveDefaultRepoPath } from '../utils/repo-paths.js';
describe('resolveDefaultRepoPath', () => {
    it('workspace pattern: resolves dbPath to project root via tmb_default_repo', () => {
        const db = tempDB();
        db.run(`INSERT INTO plugin_config (key, value_json, updated_at) VALUES ('tmb_default_repo', '"plugin"', datetime('now'))`);
        const result = resolveDefaultRepoPath(db, '/foo/bar/baz/.claude/tmb/trajectory.db');
        assert.equal(result, '/foo/bar/baz/plugin');
        db.close();
    });
    it('single-repo fallback: no tmb_default_repo config returns undefined', () => {
        const db = tempDB();
        const result = resolveDefaultRepoPath(db, '/foo/bar/baz/.claude/tmb/trajectory.db');
        assert.equal(result, undefined);
        db.close();
    });
    it('empty dbPath returns undefined', () => {
        const db = tempDB();
        db.run(`INSERT INTO plugin_config (key, value_json, updated_at) VALUES ('tmb_default_repo', '"plugin"', datetime('now'))`);
        const result = resolveDefaultRepoPath(db, '');
        assert.equal(result, undefined);
        db.close();
    });
    it('malformed value_json returns undefined (catches JSON parse error)', () => {
        const db = tempDB();
        db.run(`INSERT INTO plugin_config (key, value_json, updated_at) VALUES ('tmb_default_repo', 'plugin', datetime('now'))`);
        const result = resolveDefaultRepoPath(db, '/foo/bar/baz/.claude/tmb/trajectory.db');
        assert.equal(result, undefined);
        db.close();
    });
});
//# sourceMappingURL=utils-repo-paths.test.js.map