import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveBackend } from '../sync/backend.js';
describe('resolveBackend', () => {
    it('returns off when config is off', () => {
        const result = resolveBackend('off');
        assert.equal(result, 'off');
    });
    it('returns gh when config is gh', () => {
        const result = resolveBackend('gh');
        assert.equal(result, 'gh');
    });
    it('returns glab when config is glab', () => {
        const result = resolveBackend('glab');
        assert.equal(result, 'glab');
    });
    it('returns both when config is both', () => {
        const result = resolveBackend('both');
        assert.equal(result, 'both');
    });
    it('returns null or a backend string for auto', () => {
        const result = resolveBackend('auto');
        assert.ok(result === null || result === 'gh' || result === 'glab' || result === 'both', `Expected null|gh|glab|both, got ${result}`);
    });
});
//# sourceMappingURL=sync-backend.test.js.map