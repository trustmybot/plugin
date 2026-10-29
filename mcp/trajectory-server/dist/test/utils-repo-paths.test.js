import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { TrajectoryDB } from '../db.js';
import { tempDB } from './helpers.js';
import { repoRowPath, resolveSoleRepo, resolveSoleRepoPath } from '../utils/repo-paths.js';
describe('repoRowPath — explicit runtime project root (GH 2158)', () => {
    for (const location of ['.tmb/tmb/trajectory.db', 'state/custom.sqlite', ':memory:']) {
        it(`resolves relative paths under the explicit root with ${location}`, () => {
            const project = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-repo-paths-')));
            const dbPath = location === ':memory:' ? location : join(project, location);
            if (dbPath !== ':memory:')
                mkdirSync(dirname(dbPath), { recursive: true });
            const db = new TrajectoryDB(dbPath, {
                pluginVersion: null,
                serverLog: () => { },
                sqlLog: () => { },
                trustedProjectRoot: project,
            });
            try {
                const absoluteRepo = join(dirname(project), 'absolute-repo');
                assert.notEqual(project, process.cwd());
                assert.equal(repoRowPath(db, '.'), project);
                assert.equal(repoRowPath(db, 'packages/app'), join(project, 'packages/app'));
                assert.equal(repoRowPath(db, absoluteRepo), absoluteRepo);
                db.run(`INSERT INTO repos (name, path) VALUES ('app', 'packages/app')`);
                assert.deepEqual(resolveSoleRepo(db), { name: 'app', path: join(project, 'packages/app') });
            }
            finally {
                db.close();
                rmSync(project, { recursive: true, force: true });
            }
        });
    }
    for (const location of ['.claude/tmb/trajectory.db', 'state/custom.sqlite', ':memory:']) {
        it(`preserves the existing base without an explicit root for ${location}`, () => {
            const project = mkdtempSync(join(tmpdir(), 'tmb-repo-paths-'));
            const dbPath = location === ':memory:' ? location : join(project, location);
            if (dbPath !== ':memory:')
                mkdirSync(dirname(dbPath), { recursive: true });
            const db = new TrajectoryDB(dbPath, {
                pluginVersion: null,
                serverLog: () => { },
                sqlLog: () => { },
            });
            try {
                const absoluteRepo = join(dirname(project), 'absolute-repo');
                const base = location === ':memory:' ? process.cwd()
                    : location.startsWith('.claude/') ? project : dirname(dbPath);
                assert.equal(repoRowPath(db, '.'), resolve(base));
                assert.equal(repoRowPath(db, 'packages/app'), resolve(base, 'packages/app'));
                assert.equal(repoRowPath(db, absoluteRepo), absoluteRepo);
            }
            finally {
                db.close();
                rmSync(project, { recursive: true, force: true });
            }
        });
    }
});
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