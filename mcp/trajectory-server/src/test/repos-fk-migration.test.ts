import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tempDB } from './helpers.js';
import { TrajectoryDB } from '../db.js';
import { issueTools } from '../tools/issues.js';
import { resolveRepoForSync } from '../utils/repo-paths.js';

type RawResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

async function call(
  handlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>>,
  name: string,
  args: Record<string, unknown>,
): Promise<RawResult> {
  const handler = handlers[name];
  assert.ok(handler, `Handler not found: ${name}`);
  return handler(args) as unknown as RawResult;
}

function parse(result: RawResult) {
  return JSON.parse(result.content[0].text);
}

const VALID_LABELS = ['Bug', 'Priority: High'];

// A spawnFn that records every (cmd, args) invocation and returns a canned
// gh/glab create response so issue_create's sync path resolves an iid.
function recordingSpawnFn(url: string) {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const fn = (cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    // gh/glab `issue create` → URL on stdout; read-back `issue view` → JSON.
    if (args.includes('view')) {
      return { status: 0, stdout: JSON.stringify({ number: 42, url }), stderr: '' };
    }
    return { status: 0, stdout: url, stderr: '' };
  };
  return { fn, calls };
}

function seedRepo(
  db: TrajectoryDB,
  name: string,
  path: string,
  remotes?: Array<{ name?: string; provider: string; url: string }>,
): void {
  db.run(
    `INSERT INTO repos (name, path, file_count, remotes) VALUES (?, ?, 0, ?)`,
    [name, path, remotes ? JSON.stringify(remotes) : null],
  );
}

describe('repos-centric schema (#155) — fresh schema shape', () => {
  it('declares a repo FK on every work table', () => {
    const db = tempDB();
    for (const table of ['issues', 'tasks', 'discussions', 'audit', 'agent_runs', 'validation_attempts']) {
      const fks = db.all<{ table: string; from: string }>(`PRAGMA foreign_key_list(${table})`);
      assert.ok(
        fks.some((fk) => fk.table === 'repos' && fk.from === 'repo'),
        `${table}.repo must FK repos(name)`,
      );
    }
    db.close();
  });

  it('milestones table + composite issues.milestone FK exist', () => {
    const db = tempDB();
    const milestonesExists = db.get<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='milestones'",
    );
    assert.ok(milestonesExists, 'milestones table must exist');

    const issueFks = db.all<{ table: string; from: string; to: string }>(
      'PRAGMA foreign_key_list(issues)',
    );
    assert.ok(
      issueFks.some((fk) => fk.table === 'milestones'),
      'issues must declare a composite FK to milestones',
    );
    db.close();
  });

  it('repos.remotes column exists', () => {
    const db = tempDB();
    const cols = db.all<{ name: string }>('PRAGMA table_info(repos)').map((c) => c.name);
    assert.ok(cols.includes('remotes'), 'repos.remotes must exist');
    db.close();
  });

  it('the four repo-scoped keys live on repos, not in plugin_config (#980)', () => {
    const db = tempDB();
    const cols = db.all<{ name: string }>('PRAGMA table_info(repos)').map((c) => c.name);
    for (const col of ['target_branch', 'branching_model', 'protected_branches', 'remotes']) {
      assert.ok(cols.includes(col), `repos.${col} must exist`);
    }
    for (const key of ['pr_target', 'branching_model', 'protected_branches', 'remotes']) {
      const row = db.get<{ value_json: string }>(
        'SELECT value_json FROM plugin_config WHERE key = ?',
        [key],
      );
      assert.equal(row, undefined, `plugin_config must not seed '${key}' (#980)`);
    }
    db.close();
  });
});

describe('repos-centric schema (#155) — FK enforcement', () => {
  it('rejects an issue.repo that names no repos row', () => {
    const db = tempDB();
    assert.throws(
      () =>
        db.run(
          `INSERT INTO issues (objective, description, status, created_at, updated_at, repo)
           VALUES ('x', '', 'open', datetime('now'), datetime('now'), 'ghost')`,
        ),
      /FOREIGN KEY/,
      'a non-existent repo must be rejected by the FK',
    );
    db.close();
  });

  it('accepts an issue.repo that matches a repos row', () => {
    const db = tempDB();
    seedRepo(db, 'plugin', '/ws/plugin');
    db.run(
      `INSERT INTO issues (objective, description, status, created_at, updated_at, repo)
       VALUES ('x', '', 'open', datetime('now'), datetime('now'), 'plugin')`,
    );
    const row = db.get<{ repo: string }>(`SELECT repo FROM issues WHERE objective = 'x'`);
    assert.equal(row!.repo, 'plugin');
    db.close();
  });

  it('a null repo is FK-exempt (single-repo / ambiguous installs)', () => {
    const db = tempDB();
    db.run(
      `INSERT INTO issues (objective, description, status, created_at, updated_at, repo)
       VALUES ('x', '', 'open', datetime('now'), datetime('now'), NULL)`,
    );
    const row = db.get<{ repo: string | null }>(`SELECT repo FROM issues WHERE objective = 'x'`);
    assert.equal(row!.repo, null);
    db.close();
  });

  it('rejects an issues.milestone that names no milestones row for that repo', () => {
    const db = tempDB();
    seedRepo(db, 'plugin', '/ws/plugin');
    assert.throws(
      () =>
        db.run(
          `INSERT INTO issues (objective, description, status, created_at, updated_at, repo, milestone)
           VALUES ('x', '', 'open', datetime('now'), datetime('now'), 'plugin', 'v9.9')`,
        ),
      /FOREIGN KEY/,
      'an unknown milestone must be rejected by the composite FK',
    );
    db.close();
  });

  it('accepts a milestone present in milestones for that repo', () => {
    const db = tempDB();
    seedRepo(db, 'plugin', '/ws/plugin');
    db.run(`INSERT INTO milestones (name, repo) VALUES ('v1.0', 'plugin')`);
    db.run(
      `INSERT INTO issues (objective, description, status, created_at, updated_at, repo, milestone)
       VALUES ('x', '', 'open', datetime('now'), datetime('now'), 'plugin', 'v1.0')`,
    );
    const row = db.get<{ milestone: string }>(`SELECT milestone FROM issues WHERE objective = 'x'`);
    assert.equal(row!.milestone, 'v1.0');
    db.close();
  });

  it('restricts deleting a repos row still referenced by a work table', () => {
    const db = tempDB();
    seedRepo(db, 'plugin', '/ws/plugin');
    db.run(
      `INSERT INTO issues (objective, description, status, created_at, updated_at, repo)
       VALUES ('x', '', 'open', datetime('now'), datetime('now'), 'plugin')`,
    );
    assert.throws(
      () => db.run(`DELETE FROM repos WHERE name = 'plugin'`),
      /FOREIGN KEY/,
      'ON DELETE RESTRICT must block deleting a referenced repo',
    );
    db.close();
  });
});

describe('repos-centric schema (#155) — issue-scoped sync', () => {
  it('resolveRepoForSync returns the sole repo with decoded remotes', () => {
    const db = tempDB();
    seedRepo(db, 'plugin', '/ws/plugin', [
      { name: 'origin', provider: 'github', url: 'https://github.com/acme/plugin.git' },
    ]);
    const resolved = resolveRepoForSync(db, null);
    assert.ok(resolved);
    assert.equal(resolved!.name, 'plugin');
    assert.equal(resolved!.path, '/ws/plugin');
    assert.equal(resolved!.remotes[0]!.url, 'https://github.com/acme/plugin.git');
    db.close();
  });

  it('resolveRepoForSync returns null for an ambiguous multi-repo install', () => {
    const db = tempDB();
    seedRepo(db, 'a', '/ws/a');
    seedRepo(db, 'b', '/ws/b');
    assert.equal(resolveRepoForSync(db, null), null);
    db.close();
  });

  it('issue_create syncs against the explicit gh --repo of the issue repo', async () => {
    const db = tempDB();
    seedRepo(db, 'plugin', '/ws/plugin', [
      { name: 'origin', provider: 'github', url: 'https://github.com/acme/plugin.git' },
    ]);
    db.run(`INSERT INTO plugin_config (key, value_json) VALUES ('issue_sync', '"gh"')
             ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`);

    const spawn = recordingSpawnFn('https://github.com/acme/plugin/issues/42');
    const tools = issueTools(db);
    const result = await call(tools.handlers, 'issue_create', {
      agent: 'bro',
      objective: 'scoped sync issue',
      labels: VALID_LABELS,
      description: 'body',
      _spawnFn: spawn.fn,
    });
    const created = parse(result);
    assert.ok(!result.isError, `expected success, got ${JSON.stringify(created)}`);
    assert.equal(created.repo, 'plugin', 'issue must adopt the sole repo');
    assert.equal(created.gh_iid, 42, 'gh_iid persisted from the explicit-repo sync');

    const createCall = spawn.calls.find((c) => c.args.includes('create'));
    assert.ok(createCall, 'a gh issue create call must have fired');
    const repoFlagIdx = createCall!.args.indexOf('--repo');
    assert.ok(repoFlagIdx >= 0, 'gh create must carry an explicit --repo flag');
    assert.equal(
      createCall!.args[repoFlagIdx + 1],
      'github.com/acme/plugin',
      'gh --repo must target the issue repo, not process.cwd()',
    );
    db.close();
  });

  it('issue_create on an unresolvable multi-repo install surfaces a named error', async () => {
    const db = tempDB();
    seedRepo(db, 'a', '/ws/a', [
      { provider: 'github', url: 'https://github.com/acme/a.git' },
    ]);
    seedRepo(db, 'b', '/ws/b', [
      { provider: 'github', url: 'https://github.com/acme/b.git' },
    ]);
    db.run(`INSERT INTO plugin_config (key, value_json) VALUES ('issue_sync', '"gh"')
             ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`);

    const spawn = recordingSpawnFn('https://github.com/acme/a/issues/1');
    const tools = issueTools(db);
    const result = await call(tools.handlers, 'issue_create', {
      agent: 'bro',
      objective: 'ambiguous repo issue',
      labels: VALID_LABELS,
      description: 'body',
      _spawnFn: spawn.fn,
    });
    const created = parse(result);
    assert.ok(created._sync, 'a sync diagnostic must be present');
    assert.equal(created._sync.reason, 'unresolvable_repo');
    assert.equal(
      spawn.calls.length,
      0,
      'no gh command must fire when the repo is unresolvable',
    );
    db.close();
  });

  it('issue_create targets the named repo when repo= is passed explicitly', async () => {
    const db = tempDB();
    seedRepo(db, 'a', '/ws/a', [
      { provider: 'github', url: 'https://github.com/acme/a.git' },
    ]);
    seedRepo(db, 'b', '/ws/b', [
      { provider: 'github', url: 'https://github.com/acme/b.git' },
    ]);
    db.run(`INSERT INTO plugin_config (key, value_json) VALUES ('issue_sync', '"gh"')
             ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`);

    const spawn = recordingSpawnFn('https://github.com/acme/b/issues/7');
    const tools = issueTools(db);
    const result = await call(tools.handlers, 'issue_create', {
      agent: 'bro',
      objective: 'explicit repo issue',
      labels: VALID_LABELS,
      description: 'body',
      repo: 'b',
      _spawnFn: spawn.fn,
    });
    const created = parse(result);
    assert.ok(!result.isError, `expected success, got ${JSON.stringify(created)}`);
    assert.equal(created.repo, 'b');
    const createCall = spawn.calls.find((c) => c.args.includes('create'));
    const repoFlagIdx = createCall!.args.indexOf('--repo');
    assert.equal(createCall!.args[repoFlagIdx + 1], 'github.com/acme/b');
    db.close();
  });
});

describe('repos-centric schema (#155) — migration backfill', () => {
  // The migration backfills repo from the parent on every table for single-repo
  // installs. We exercise the end-state contract a migrated single-repo DB must
  // satisfy: a sole repos row, and parent→child repo inheritance writable under
  // the FK. (The version-stepped upgrade path is covered in schema-upgrade.test.)
  it('single-repo backfill: child rows inherit the sole repo under the FK', () => {
    const db = tempDB();
    seedRepo(db, 'plugin', '/ws/plugin');

    db.run(
      `INSERT INTO issues (objective, description, status, created_at, updated_at, repo)
       VALUES ('parent', '', 'open', datetime('now'), datetime('now'), 'plugin')`,
    );
    const issueId = db.get<{ id: number }>(`SELECT id FROM issues WHERE objective = 'parent'`)!.id;

    db.run(
      `INSERT INTO discussions (issue_id, author, kind, body, repo, created_at)
       VALUES (?, 'bro', 'note', 'hi', 'plugin', datetime('now'))`,
      [issueId],
    );
    db.run(
      `INSERT INTO audit (issue_id, from_node, event_type, summary, content_json, repo, created_at)
       VALUES (?, 'bro', 'evt', 's', '{}', 'plugin', datetime('now'))`,
      [issueId],
    );

    const disc = db.get<{ repo: string }>(`SELECT repo FROM discussions WHERE issue_id = ?`, [issueId]);
    const aud = db.get<{ repo: string }>(`SELECT repo FROM audit WHERE issue_id = ?`, [issueId]);
    assert.equal(disc!.repo, 'plugin');
    assert.equal(aud!.repo, 'plugin');
    db.close();
  });
});
