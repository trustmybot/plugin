import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveBackend, detectAvailable } from '../sync/backend.js';

describe('resolveBackend', () => {
  let savedEnv: string | undefined;

  before(() => {
    savedEnv = process.env.TMB_DISABLE_REMOTE_SYNC;
    delete process.env.TMB_DISABLE_REMOTE_SYNC;
  });

  after(() => {
    if (savedEnv !== undefined) {
      process.env.TMB_DISABLE_REMOTE_SYNC = savedEnv;
    } else {
      delete process.env.TMB_DISABLE_REMOTE_SYNC;
    }
  });

  it('returns off when config is off', async () => {
    const result = await resolveBackend('off');
    assert.equal(result, 'off');
  });

  it('returns gh when config is gh', async () => {
    const result = await resolveBackend('gh');
    assert.equal(result, 'gh');
  });

  it('returns glab when config is glab', async () => {
    const result = await resolveBackend('glab');
    assert.equal(result, 'glab');
  });

  it('returns both when config is both', async () => {
    const result = await resolveBackend('both');
    assert.equal(result, 'both');
  });

  it('returns null or a backend string for auto', async () => {
    const result = await resolveBackend('auto');
    assert.ok(
      result === null || result === 'gh' || result === 'glab' || result === 'both',
      `Expected null|gh|glab|both, got ${result}`,
    );
  });
});

describe('resolveBackend — hasSpawnFn bypasses TMB_DISABLE_REMOTE_SYNC', () => {
  let savedEnv: string | undefined;

  before(() => {
    savedEnv = process.env.TMB_DISABLE_REMOTE_SYNC;
    process.env.TMB_DISABLE_REMOTE_SYNC = '1';
  });

  after(() => {
    if (savedEnv !== undefined) {
      process.env.TMB_DISABLE_REMOTE_SYNC = savedEnv;
    } else {
      delete process.env.TMB_DISABLE_REMOTE_SYNC;
    }
  });

  it('returns gh (not null) when hasSpawnFn=true even with TMB_DISABLE_REMOTE_SYNC=1', async () => {
    const result = await resolveBackend('gh', null, true);
    assert.equal(result, 'gh');
  });

  it('still returns null when hasSpawnFn=false and TMB_DISABLE_REMOTE_SYNC=1', async () => {
    const result = await resolveBackend('gh', null, false);
    assert.equal(result, null);
  });
});

describe('resolveBackend — auto derives from repo_remotes, not the cwd (#1043)', () => {
  let savedEnv: string | undefined;
  const savedCwd = process.cwd();

  before(() => {
    savedEnv = process.env.TMB_DISABLE_REMOTE_SYNC;
    delete process.env.TMB_DISABLE_REMOTE_SYNC;
    // Move the process into a temp dir that is NOT a git repo, to prove the
    // decision no longer depends on a process.cwd() `git remote` probe.
    const tmp = mkdtempSync(join(tmpdir(), 'tmb-nogit-'));
    process.chdir(tmp);
  });

  after(() => {
    process.chdir(savedCwd);
    if (savedEnv !== undefined) {
      process.env.TMB_DISABLE_REMOTE_SYNC = savedEnv;
    } else {
      delete process.env.TMB_DISABLE_REMOTE_SYNC;
    }
  });

  it('a repo with a github remote resolves to gh even when cwd is not a git repo', async () => {
    const result = await resolveBackend(
      'auto',
      { github: true, gitlab: false },
      false,
      { gh: true, glab: false },
    );
    assert.equal(result, 'gh');
  });

  it('a repo with a gitlab remote resolves to glab', async () => {
    const result = await resolveBackend(
      'auto',
      { github: false, gitlab: true },
      false,
      { gh: false, glab: true },
    );
    assert.equal(result, 'glab');
  });

  it('a repo with both remotes (both CLIs available) resolves to both', async () => {
    const result = await resolveBackend(
      'auto',
      { github: true, gitlab: true },
      false,
      { gh: true, glab: true },
    );
    assert.equal(result, 'both');
  });

  it('a github remote whose CLI is not authed resolves to null (availability gate)', async () => {
    const result = await resolveBackend(
      'auto',
      { github: true, gitlab: false },
      false,
      { gh: false, glab: false },
    );
    assert.equal(result, null);
  });

  it('a repo with no remotes resolves to null', async () => {
    const result = await resolveBackend(
      'auto',
      { github: false, gitlab: false },
      false,
      { gh: true, glab: true },
    );
    assert.equal(result, null);
  });
});

describe('detectAvailable — caching (#365)', () => {
  it('injected spawnFn bypasses module-level cache and returns correct availability', async () => {
    const spawnFn = (cmd: string, args: string[]) => {
      if (cmd === 'gh' && args[0] === 'auth') return { status: 0 };
      if (cmd === 'glab' && args[0] === 'auth') return { status: 1 };
      return { status: 1 };
    };
    const first = await detectAvailable(spawnFn);
    const second = await detectAvailable(spawnFn);
    assert.equal(first.gh, true);
    assert.equal(first.glab, false);
    assert.equal(second.gh, true);
    assert.equal(second.glab, false);
  });

  it('two calls with no spawnFn use the module-level cache — results are consistent', async () => {
    const r1 = await detectAvailable();
    const r2 = await detectAvailable();
    assert.equal(typeof r1.gh, 'boolean');
    assert.equal(r1.gh, r2.gh);
    assert.equal(r1.glab, r2.glab);
  });
});
