import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { resolveDbPath } from '../db.js';
describe('resolveDbPath', () => {
    it('defaults to <cwd>/.claude/tmb/trajectory.db when no env override', () => {
        const cwd = '/some/project';
        const got = resolveDbPath({ env: {}, cwd });
        assert.equal(got, join(cwd, '.claude', 'tmb', 'trajectory.db'));
    });
    it('honors TRAJECTORY_DB_PATH env override verbatim', () => {
        const got = resolveDbPath({
            env: { TRAJECTORY_DB_PATH: '/tmp/explicit/test.db' },
            cwd: '/some/project',
        });
        assert.equal(got, '/tmp/explicit/test.db');
    });
    it('honors :memory: as a sentinel via the env override', () => {
        const got = resolveDbPath({
            env: { TRAJECTORY_DB_PATH: ':memory:' },
            cwd: '/some/project',
        });
        assert.equal(got, ':memory:');
    });
    it('treats empty TRAJECTORY_DB_PATH as unset (falls back to default)', () => {
        const cwd = '/some/project';
        const got = resolveDbPath({ env: { TRAJECTORY_DB_PATH: '' }, cwd });
        assert.equal(got, join(cwd, '.claude', 'tmb', 'trajectory.db'));
    });
    it('treats whitespace-only TRAJECTORY_DB_PATH as unset', () => {
        const cwd = '/some/project';
        const got = resolveDbPath({ env: { TRAJECTORY_DB_PATH: '   ' }, cwd });
        assert.equal(got, join(cwd, '.claude', 'tmb', 'trajectory.db'));
    });
});
//# sourceMappingURL=db-path.test.js.map