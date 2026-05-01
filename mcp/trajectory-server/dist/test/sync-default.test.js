import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolveBackend } from '../sync/backend.js';
describe('resolveBackend env-var override', () => {
    afterEach(() => {
        delete process.env.TMB_DISABLE_REMOTE_SYNC;
    });
    it('returns null when TMB_DISABLE_REMOTE_SYNC=1 regardless of config', () => {
        process.env.TMB_DISABLE_REMOTE_SYNC = '1';
        assert.equal(resolveBackend('gh'), null);
        assert.equal(resolveBackend('glab'), null);
        assert.equal(resolveBackend('both'), null);
        assert.equal(resolveBackend('auto'), null);
        assert.equal(resolveBackend('off'), null);
    });
    it('returns null when TMB_DISABLE_REMOTE_SYNC=true regardless of config', () => {
        process.env.TMB_DISABLE_REMOTE_SYNC = 'true';
        assert.equal(resolveBackend('gh'), null);
        assert.equal(resolveBackend('glab'), null);
        assert.equal(resolveBackend('auto'), null);
    });
    it('does not override when TMB_DISABLE_REMOTE_SYNC is unset', () => {
        delete process.env.TMB_DISABLE_REMOTE_SYNC;
        assert.equal(resolveBackend('off'), 'off');
        assert.equal(resolveBackend('gh'), 'gh');
        assert.equal(resolveBackend('glab'), 'glab');
        assert.equal(resolveBackend('both'), 'both');
    });
});
//# sourceMappingURL=sync-default.test.js.map