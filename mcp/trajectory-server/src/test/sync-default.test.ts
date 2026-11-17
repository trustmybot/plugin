import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolveBackend } from '../sync/backend.js';

describe('resolveBackend env-var override', () => {
  afterEach(() => {
    delete process.env.TMB_DISABLE_REMOTE_SYNC;
  });

  it('returns null when TMB_DISABLE_REMOTE_SYNC=1 regardless of config', async () => {
    process.env.TMB_DISABLE_REMOTE_SYNC = '1';
    assert.equal(await resolveBackend('gh'), null);
    assert.equal(await resolveBackend('glab'), null);
    assert.equal(await resolveBackend('both'), null);
    assert.equal(await resolveBackend('auto'), null);
    assert.equal(await resolveBackend('off'), null);
  });

  it('returns null when TMB_DISABLE_REMOTE_SYNC=true regardless of config', async () => {
    process.env.TMB_DISABLE_REMOTE_SYNC = 'true';
    assert.equal(await resolveBackend('gh'), null);
    assert.equal(await resolveBackend('glab'), null);
    assert.equal(await resolveBackend('auto'), null);
  });

  it('does not override when TMB_DISABLE_REMOTE_SYNC is unset', async () => {
    delete process.env.TMB_DISABLE_REMOTE_SYNC;
    assert.equal(await resolveBackend('off'), 'off');
    assert.equal(await resolveBackend('gh'), 'gh');
    assert.equal(await resolveBackend('glab'), 'glab');
    assert.equal(await resolveBackend('both'), 'both');
  });
});
