import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tempDB } from './helpers.js';
import { resolveSoleRepo, resolveSoleRepoPath } from '../utils/repo-paths.js';
describe('resolveSoleRepoPath — single-repo fallback', () => {
    it('exactly one repos row: resolves to that row path verbatim', () => {
        const db = tempDB();
        db.run(`INSERT INTO repos (name, path) VALUES ('plugin', '/abs/path/to/plugin')`);
        assert.equal(resolveSoleRepoPath(db), '/abs/path/to/plugin');
        db.close();
    });
    it('no repos rows: returns undefined', () => {
        const db = tempDB();
        assert.equal(resolveSoleRepoPath(db), undefined);
        db.close();
    });
    it('multiple repos rows + no explicit selector: returns undefined', () => {
        const db = tempDB();
        db.run(`INSERT INTO repos (name, path) VALUES ('a', '/ws/a')`);
        db.run(`INSERT INTO repos (name, path) VALUES ('b', '/ws/b')`);
        assert.equal(resolveSoleRepoPath(db), undefined);
        db.close();
    });
    it('ignores a stale tmb_default_repo config key (read-tolerant deprecation)', () => {
        const db = tempDB();
        db.run(`INSERT INTO repos (name, path) VALUES ('a', '/ws/a')`);
        db.run(`INSERT INTO repos (name, path) VALUES ('b', '/ws/b')`);
        db.run(`INSERT INTO plugin_config (key, value_json) VALUES ('tmb_default_repo', '"a"')`);
        // The config key is no longer read; multi-repo still resolves to undefined.
        assert.equal(resolveSoleRepoPath(db), undefined);
        db.close();
    });
});
describe('resolveSoleRepo — explicit name lookup', () => {
    it('returns {name, path} from repos.path for a matching name', () => {
        const db = tempDB();
        db.run(`INSERT INTO repos (name, path) VALUES ('a', '/ws/a')`);
        db.run(`INSERT INTO repos (name, path) VALUES ('b', '/ws/b')`);
        assert.deepEqual(resolveSoleRepo(db, 'b'), { name: 'b', path: '/ws/b' });
        db.close();
    });
    it('unknown explicit name: returns undefined (no synthesis)', () => {
        const db = tempDB();
        db.run(`INSERT INTO repos (name, path) VALUES ('a', '/ws/a')`);
        assert.equal(resolveSoleRepo(db, 'missing'), undefined);
        db.close();
    });
    it('single-repo fallback returns the sole row with its name', () => {
        const db = tempDB();
        db.run(`INSERT INTO repos (name, path) VALUES ('solo', '/ws/solo')`);
        assert.deepEqual(resolveSoleRepo(db), { name: 'solo', path: '/ws/solo' });
        db.close();
    });
});
//# sourceMappingURL=utils-repo-paths.test.js.map