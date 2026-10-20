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
      { name: 'origin', provider: 'gitlab', url: 'git@gitlab.com:me/app.git', is_primary: true },
      { name: 'upstream', provider: 'github', url: 'https://github.com/up/app.git', is_primary: false },
    ]);
    assert.equal(primaryRemote(db, 'app')!.name, 'origin');
    const upstreamCreated = db.get<{ c: string }>(`SELECT created_at AS c FROM repo_remotes WHERE repo = 'app' AND name = 'upstream'`)!.c;

    upsertRepoRemotes(db, 'app', [
      { name: 'upstream', url: 'https://github.com/up/app2.git' },
      { name: 'bb', url: 'https://bitbucket.org/me/app.git', provider: 'bitbucket' },
    ]);
    assert.deepEqual(remotesView(repoRemotes(db, 'app')), [
      { name: 'upstream', provider: 'github', url: 'https://github.com/up/app2.git' },
      { name: 'bb', provider: 'other', url: 'https://bitbucket.org/me/app.git' },
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
