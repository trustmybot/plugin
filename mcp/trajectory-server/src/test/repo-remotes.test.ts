import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tempDB } from './helpers.js';
import {
  parseLegacyRemotes,
  primaryIndex,
  primaryRemote,
  remoteProvider,
  remotesView,
  repoRemotes,
  setRemoteSync,
  syncRemotes,
  upsertRepoRemotes,
} from '../repos/remotes.js';

describe('repo_remotes accessor — pure helpers', () => {
  it('remoteProvider derives github/gitlab from the host, else other; a blank url keeps a declared github/gitlab', () => {
    assert.equal(remoteProvider('git@github.com:a/b.git'), 'github');
    assert.equal(remoteProvider('https://gitlab.example.com/a/b.git'), 'gitlab');
    assert.equal(remoteProvider('https://bitbucket.org/a/b.git', 'bitbucket'), 'other');
    assert.equal(remoteProvider('https://github.com/a/b.git', 'gitlab'), 'github', 'the host wins over a declared provider');
    assert.equal(remoteProvider('', 'gitlab'), 'gitlab');
    assert.equal(remoteProvider('', null), 'other');
  });

  it('primaryIndex picks origin, else the first; -1 for none', () => {
    assert.equal(primaryIndex([{ name: 'upstream' }, { name: 'origin' }]), 1);
    assert.equal(primaryIndex([{ name: 'a' }, { name: 'b' }]), 0);
    assert.equal(primaryIndex([]), -1);
  });

  it('parseLegacyRemotes reads both shapes and reports what it cannot', () => {
    assert.deepEqual(parseLegacyRemotes('{"origin":"u1","fork":"u2"}'), {
      ok: true,
      entries: [
        { name: 'origin', url: 'u1', provider: null },
        { name: 'fork', url: 'u2', provider: null },
      ],
      dropped: 0,
    });
    assert.deepEqual(parseLegacyRemotes('[{"provider":"github","url":"u"},{"url":"v"},{"name":"x"},{"name":"remote-1","url":"w"}]'), {
      ok: true,
      entries: [
        { name: 'origin', url: 'u', provider: 'github' },
        { name: 'remote-1', url: 'v', provider: null },
      ],
      dropped: 2,
    });
    assert.equal(parseLegacyRemotes('[').ok, false);
    assert.equal(parseLegacyRemotes('null').ok, false);
    assert.equal(parseLegacyRemotes('"s"').ok, false);
  });
});

describe('repo_remotes accessor — repoRemotes / primaryRemote / upsertRepoRemotes', () => {
  it('stores rows primary first, re-chooses the primary and drops vanished remotes on re-upsert', () => {
    const db = tempDB();
    db.run(`INSERT INTO repos (name, path) VALUES ('app', '/ws/app')`);
    assert.deepEqual(repoRemotes(db, 'app'), []);
    assert.equal(primaryRemote(db, 'app'), null);

    upsertRepoRemotes(db, 'app', [
      { name: 'upstream', url: 'https://github.com/up/app.git' },
      { name: 'origin', url: 'git@gitlab.com:me/app.git' },
      { name: 'origin', url: 'ignored-duplicate' },
    ]);
    assert.deepEqual(repoRemotes(db, 'app'), [
      { name: 'origin', provider: 'gitlab', url: 'git@gitlab.com:me/app.git', is_primary: true, sync: true },
      { name: 'upstream', provider: 'github', url: 'https://github.com/up/app.git', is_primary: false, sync: false },
    ]);
    assert.equal(primaryRemote(db, 'app')!.name, 'origin');
    const upstreamCreated = db.get<{ c: string }>(`SELECT created_at AS c FROM repo_remotes WHERE repo = 'app' AND name = 'upstream'`)!.c;

    upsertRepoRemotes(db, 'app', [
      { name: 'upstream', url: 'https://github.com/up/app2.git' },
      { name: 'bb', url: 'https://bitbucket.org/me/app.git', provider: 'bitbucket' },
    ]);
    assert.deepEqual(remotesView(repoRemotes(db, 'app')), [
      { name: 'upstream', provider: 'github', url: 'https://github.com/up/app2.git', sync: false },
      { name: 'bb', provider: 'other', url: 'https://bitbucket.org/me/app.git', sync: false },
    ]);
    assert.equal(
      db.get<{ c: string }>(`SELECT created_at AS c FROM repo_remotes WHERE repo = 'app' AND name = 'upstream'`)!.c,
      upstreamCreated,
      'an updated remote keeps its created_at',
    );

    upsertRepoRemotes(db, 'app', []);
    assert.deepEqual(repoRemotes(db, 'app'), []);
    db.close();
  });

  it('scopes every read and write to its repo', () => {
    const db = tempDB();
    db.run(`INSERT INTO repos (name, path) VALUES ('a', '/ws/a'), ('b', '/ws/b')`);
    upsertRepoRemotes(db, 'a', [{ name: 'origin', url: 'https://github.com/x/a.git' }]);
    upsertRepoRemotes(db, 'b', [{ name: 'origin', url: 'https://gitlab.com/x/b.git' }]);
    upsertRepoRemotes(db, 'a', []);
    assert.deepEqual(repoRemotes(db, 'a'), []);
    assert.equal(primaryRemote(db, 'b')!.url, 'https://gitlab.com/x/b.git');
    db.close();
  });
});

describe('repo_remotes.sync — the onboard Remote choice (GH 1590)', () => {
  const syncOf = (db: ReturnType<typeof tempDB>, repo = 'app'): Array<[string, boolean]> =>
    repoRemotes(db, repo).map((r) => [r.name, r.sync]);

  function appWith(remotes: Array<{ name: string; url: string }>): ReturnType<typeof tempDB> {
    const db = tempDB();
    db.run(`INSERT INTO repos (name, path) VALUES ('app', '/ws/app'), ('lib', '/ws/lib')`);
    upsertRepoRemotes(db, 'app', remotes);
    return db;
  }

  it('a new row starts at sync = is_primary; a re-upsert keeps every recorded sync', () => {
    const db = appWith([
      { name: 'origin', url: 'https://github.com/me/app.git' },
      { name: 'mirror', url: 'git@gitlab.com:me/app.git' },
    ]);
    assert.deepEqual(syncOf(db), [['origin', true], ['mirror', false]]);

    setRemoteSync(db, 'app', ['gitlab']);
    upsertRepoRemotes(db, 'app', [
      { name: 'origin', url: 'https://github.com/me/app2.git' },
      { name: 'mirror', url: 'git@gitlab.com:me/app2.git' },
      { name: 'fork', url: 'https://github.com/fork/app.git' },
    ]);
    assert.deepEqual(syncOf(db), [['origin', false], ['mirror', true], ['fork', false]]);
    db.close();
  });

  it('syncRemotes returns only the sync rows, primary first', () => {
    const db = appWith([
      { name: 'mirror', url: 'git@gitlab.com:me/app.git' },
      { name: 'origin', url: 'https://github.com/me/app.git' },
    ]);
    assert.deepEqual(syncRemotes(db, 'app').map((r) => r.name), ['origin']);
    setRemoteSync(db, 'app', ['gitlab', 'github']);
    assert.deepEqual(syncRemotes(db, 'app').map((r) => r.name), ['origin', 'mirror']);
    assert.deepEqual(syncRemotes(db, 'lib'), []);
    db.close();
  });

  it('setRemoteSync marks one row per chosen provider (the primary when it has it), clears the rest, and returns the missing providers', () => {
    const db = appWith([
      { name: 'origin', url: 'https://github.com/me/app.git' },
      { name: 'upstream', url: 'https://github.com/up/app.git' },
      { name: 'lab-a', url: 'git@gitlab.com:me/app.git' },
      { name: 'lab-b', url: 'git@gitlab.com:other/app.git' },
    ]);
    upsertRepoRemotes(db, 'lib', [{ name: 'origin', url: 'https://github.com/me/lib.git' }]);

    assert.deepEqual(setRemoteSync(db, 'app', ['github', 'gitlab']), []);
    assert.deepEqual(syncOf(db), [['origin', true], ['upstream', false], ['lab-a', true], ['lab-b', false]]);

    assert.deepEqual(setRemoteSync(db, 'app', ['gitlab']), []);
    assert.deepEqual(syncOf(db), [['origin', false], ['upstream', false], ['lab-a', true], ['lab-b', false]]);

    assert.deepEqual(setRemoteSync(db, 'lib', ['gitlab', 'github']), ['gitlab']);
    assert.deepEqual(syncOf(db, 'lib'), [['origin', true]]);
    assert.deepEqual(syncOf(db), [['origin', false], ['upstream', false], ['lab-a', true], ['lab-b', false]], 'another repo is untouched');

    assert.deepEqual(setRemoteSync(db, 'app', []), []);
    assert.deepEqual(syncRemotes(db, 'app'), []);
    db.close();
  });
});
