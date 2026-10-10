import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { tempDB } from './helpers.js';
import { scanTools } from '../tools/scan.js';
import { configTools } from '../tools/config.js';
import { issueTools } from '../tools/issues.js';
import { compositeTools } from '../tools/composites.js';
import { milestoneTools, nextPatchMilestone, syncRepoMilestones } from '../tools/milestones.js';

type RawResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type Call = { cmd: string; args: string[] };
type DB = ReturnType<typeof tempDB>;

const VALID_LABELS = ['Bug', 'Priority: High'];
const GH_REMOTE = 'https://github.com/acme/app.git';

function parse(r: RawResult): Record<string, unknown> {
  return JSON.parse(r.content[0].text);
}

async function call(
  handlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>>,
  name: string,
  args: Record<string, unknown>,
): Promise<RawResult> {
  const h = handlers[name];
  assert.ok(h, `handler not found: ${name}`);
  return h(args) as unknown as RawResult;
}

// Spawn-boundary mock for gh/glab `api` calls: GET returns `milestones`, every
// write succeeds. `failList` makes the GET exit non-zero.
function milestoneSpawn(
  calls: Call[],
  milestones: Array<Record<string, unknown>> = [],
  failList = false,
) {
  return (cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    const isWrite = args.includes('-X');
    if (!isWrite && failList) return { status: 1, stdout: '', stderr: 'HTTP 502' };
    if (!isWrite) return { status: 0, stdout: JSON.stringify(milestones), stderr: '' };
    return { status: 0, stdout: '{}', stderr: '' };
  };
}

function mkRepo(parent: string, name: string, files: Record<string, string>, remote?: string): string {
  const root = join(parent, name);
  mkdirSync(root, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 't@t.io'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body);
  }
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: root });
  if (remote) execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: root });
  return root;
}

function registerRepo(db: DB, path: string, remotes = [{ name: 'origin', provider: 'github', url: GH_REMOTE }]): void {
  db.run(`INSERT INTO repos (name, path, remotes) VALUES ('app', ?, ?)`, [path, JSON.stringify(remotes)]);
}

function milestoneRows(db: DB): Array<{ name: string; state: string }> {
  return db
    .all<{ name: string; state: string }>(`SELECT name, state FROM milestones WHERE repo = 'app' ORDER BY name`)
    .map((r) => ({ name: r.name, state: r.state }));
}

function auditContent(db: DB, eventType: string): Array<Record<string, unknown>> {
  return db
    .all<{ content_json: string }>(`SELECT content_json FROM audit WHERE event_type = ? ORDER BY id`, [eventType])
    .map((r) => JSON.parse(r.content_json) as Record<string, unknown>);
}

describe('scan_run — milestone reconcile', () => {
  it('upserts the remote milestones with their states and audits the reconcile', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'ms-reconcile-'));
    try {
      mkRepo(ws, 'app', { 'README.md': 'app\n', 'package.json': '{"version":"1.4.2"}' }, GH_REMOTE);
      const db = tempDB();
      await call(configTools(db).handlers, 'config_set', { agent: 'bro', key: 'issue_sync', value: 'gh' });
      const calls: Call[] = [];
      const _spawnFn = milestoneSpawn(calls, [
        { number: 1, title: 'v1.0.0', state: 'closed' },
        { number: 2, title: 'v1.1.0', state: 'open' },
      ]);

      const r = await call(scanTools(db, null).handlers, 'scan_run', { agent: 'bro', session_dir: ws, _spawnFn });
      assert.ok(!r.isError, `scan_run failed: ${JSON.stringify(r)}`);

      assert.deepEqual(milestoneRows(db), [
        { name: 'v1.0.0', state: 'closed' },
        { name: 'v1.1.0', state: 'open' },
      ]);
      const list = calls.find((c) => c.cmd === 'gh' && c.args[0] === 'api');
      assert.ok(list, 'gh api must be called');
      assert.ok(list.args.includes('repos/acme/app/milestones?state=all&per_page=100'), `list args: ${list.args.join(' ')}`);
      assert.deepEqual(auditContent(db, 'milestones_reconciled'), [{ imported: 2, closed: 1, repo: 'app' }]);
      assert.equal(auditContent(db, 'milestone_seeded').length, 0, 'remote rows exist, so nothing is seeded');
      db.close();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('closes a local row the remote has since closed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ms-reclose-'));
    try {
      const db = tempDB();
      registerRepo(db, dir);
      db.run(`INSERT INTO milestones (name, repo, state) VALUES ('v2.0.0', 'app', 'open')`);
      await call(configTools(db).handlers, 'config_set', { agent: 'bro', key: 'issue_sync', value: 'gh' });
      const calls: Call[] = [];
      const _spawnFn = milestoneSpawn(calls, [{ number: 4, title: 'v2.0.0', state: 'closed' }]);
      syncRepoMilestones(db, 'app', dir, _spawnFn);
      assert.deepEqual(milestoneRows(db), [{ name: 'v2.0.0', state: 'closed' }]);
      assert.deepEqual(auditContent(db, 'milestones_reconciled'), [{ imported: 0, closed: 1, repo: 'app' }]);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('maps GitLab active→open through glab api', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ms-glab-'));
    try {
      const db = tempDB();
      registerRepo(db, dir, [{ name: 'origin', provider: 'gitlab', url: 'https://gitlab.com/grp/app.git' }]);
      await call(configTools(db).handlers, 'config_set', { agent: 'bro', key: 'issue_sync', value: 'glab' });
      const calls: Call[] = [];
      const _spawnFn = milestoneSpawn(calls, [
        { id: 11, title: 'v3.0.0', state: 'active' },
        { id: 12, title: 'v2.9.0', state: 'closed' },
      ]);
      syncRepoMilestones(db, 'app', dir, _spawnFn);
      assert.deepEqual(milestoneRows(db), [
        { name: 'v2.9.0', state: 'closed' },
        { name: 'v3.0.0', state: 'open' },
      ]);
      assert.equal(calls[0]!.cmd, 'glab');
      assert.ok(calls[0]!.args.includes('projects/grp%2Fapp/milestones?per_page=100'));
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a remote failure never fails the scan and writes milestone_reconcile_failed', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'ms-fail-'));
    try {
      mkRepo(ws, 'app', { 'README.md': 'app\n', 'package.json': '{"version":"1.4.2"}' }, GH_REMOTE);
      const db = tempDB();
      await call(configTools(db).handlers, 'config_set', { agent: 'bro', key: 'issue_sync', value: 'gh' });
      const calls: Call[] = [];
      const _spawnFn = milestoneSpawn(calls, [], true);

      const r = await call(scanTools(db, null).handlers, 'scan_run', { agent: 'bro', session_dir: ws, _spawnFn });
      assert.ok(!r.isError, `scan_run must succeed on a remote error: ${JSON.stringify(r)}`);
      const failed = auditContent(db, 'milestone_reconcile_failed');
      assert.equal(failed.length, 1);
      assert.equal(failed[0]!['repo'], 'app');
      assert.equal(failed[0]!['reason'], 'non_zero_exit');
      assert.deepEqual(milestoneRows(db), [], 'no seed shadows an unread remote');
      assert.equal(auditContent(db, 'milestone_seed_skipped')[0]!['reason'], 'reconcile_failed');
      db.close();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('sync off → no spawn at all (seed stays local)', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'ms-off-'));
    try {
      mkRepo(ws, 'app', { 'README.md': 'app\n', 'package.json': '{"version":"1.4.2"}' }, GH_REMOTE);
      const db = tempDB();
      const calls: Call[] = [];
      const _spawnFn = milestoneSpawn(calls);

      const r = await call(scanTools(db, null).handlers, 'scan_run', { agent: 'bro', session_dir: ws, _spawnFn });
      assert.ok(!r.isError, `scan_run failed: ${JSON.stringify(r)}`);
      assert.equal(calls.length, 0, 'issue_sync off must not touch the remote');
      assert.deepEqual(milestoneRows(db), [{ name: 'v1.4.3', state: 'open' }]);
      assert.equal(auditContent(db, 'milestones_reconciled').length, 0);
      db.close();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('scan_run — milestone seed', () => {
  it('nextPatchMilestone strips a pre-release suffix before bumping', () => {
    assert.equal(nextPatchMilestone('1.4.2'), 'v1.4.3');
    assert.equal(nextPatchMilestone('1.5.0-rc.2'), 'v1.5.1');
    assert.equal(nextPatchMilestone('v2.0.9'), 'v2.0.10');
    assert.equal(nextPatchMilestone('not-a-version'), null);
  });

  it('package.json 1.4.2 seeds an open v1.4.3; sync off → remote_created=false, no spawn', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ms-seed-'));
    try {
      writeFileSync(join(dir, 'package.json'), '{"version":"1.4.2"}');
      const db = tempDB();
      registerRepo(db, dir);
      const calls: Call[] = [];
      syncRepoMilestones(db, 'app', dir, milestoneSpawn(calls));
      assert.deepEqual(milestoneRows(db), [{ name: 'v1.4.3', state: 'open' }]);
      assert.equal(calls.length, 0);
      assert.deepEqual(auditContent(db, 'milestone_seeded'), [
        { name: 'v1.4.3', repo: 'app', source: 'package.json', remote_created: false },
      ]);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('1.5.0-rc.2 seeds v1.5.1', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ms-seed-rc-'));
    try {
      mkdirSync(join(dir, '.claude-plugin'));
      writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), '{"version":"1.5.0-rc.2"}');
      const db = tempDB();
      registerRepo(db, dir);
      syncRepoMilestones(db, 'app', dir, milestoneSpawn([]));
      assert.deepEqual(milestoneRows(db), [{ name: 'v1.5.1', state: 'open' }]);
      assert.equal(auditContent(db, 'milestone_seeded')[0]!['source'], '.claude-plugin/plugin.json');
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads pyproject.toml [project] and Cargo.toml [package] versions', () => {
    const py = mkdtempSync(join(tmpdir(), 'ms-seed-py-'));
    const rs = mkdtempSync(join(tmpdir(), 'ms-seed-rs-'));
    try {
      writeFileSync(join(py, 'pyproject.toml'), '[tool.x]\nversion = "9.9.9"\n[project]\nname = "p"\nversion = "0.3.1"\n');
      writeFileSync(join(rs, 'Cargo.toml'), '[package]\nname = "c"\nversion = "2.1.0"\n');
      const dbPy = tempDB();
      registerRepo(dbPy, py);
      syncRepoMilestones(dbPy, 'app', py, milestoneSpawn([]));
      assert.deepEqual(milestoneRows(dbPy), [{ name: 'v0.3.2', state: 'open' }]);
      dbPy.close();
      const dbRs = tempDB();
      registerRepo(dbRs, rs);
      syncRepoMilestones(dbRs, 'app', rs, milestoneSpawn([]));
      assert.deepEqual(milestoneRows(dbRs), [{ name: 'v2.1.1', state: 'open' }]);
      dbRs.close();
    } finally {
      rmSync(py, { recursive: true, force: true });
      rmSync(rs, { recursive: true, force: true });
    }
  });

  it('falls back to the highest vX.Y.Z git tag', () => {
    const ws = mkdtempSync(join(tmpdir(), 'ms-seed-tag-'));
    try {
      const root = mkRepo(ws, 'app', { 'README.md': 'app\n' });
      for (const tag of ['v0.9.0', 'v0.10.2', 'v0.10.1']) execFileSync('git', ['tag', tag], { cwd: root });
      const db = tempDB();
      registerRepo(db, root);
      syncRepoMilestones(db, 'app', root, milestoneSpawn([]));
      assert.deepEqual(milestoneRows(db), [{ name: 'v0.10.3', state: 'open' }]);
      assert.equal(auditContent(db, 'milestone_seeded')[0]!['source'], 'git_tag');
      db.close();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('sync on → the seed is POSTed to the remote and remote_created=true', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ms-seed-on-'));
    try {
      writeFileSync(join(dir, 'package.json'), '{"version":"1.4.2"}');
      const db = tempDB();
      registerRepo(db, dir);
      await call(configTools(db).handlers, 'config_set', { agent: 'bro', key: 'issue_sync', value: 'gh' });
      const calls: Call[] = [];
      const _spawnFn = milestoneSpawn(calls, []);
      syncRepoMilestones(db, 'app', dir, _spawnFn);
      const post = calls.find((c) => c.args.includes('POST'));
      assert.ok(post, 'seed must POST the milestone');
      assert.equal(post.cmd, 'gh');
      assert.ok(post.args.includes('repos/acme/app/milestones'));
      assert.ok(post.args.includes('title=v1.4.3'));
      assert.equal(auditContent(db, 'milestone_seeded')[0]!['remote_created'], true);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('no version source and no tags → skipped + audit', () => {
    const ws = mkdtempSync(join(tmpdir(), 'ms-seed-none-'));
    try {
      const root = mkRepo(ws, 'app', { 'README.md': 'app\n' });
      const db = tempDB();
      registerRepo(db, root);
      syncRepoMilestones(db, 'app', root, milestoneSpawn([]));
      assert.deepEqual(milestoneRows(db), []);
      assert.deepEqual(auditContent(db, 'milestone_seed_skipped'), [{ repo: 'app', reason: 'no_version_source' }]);
      db.close();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('a repo that already has a milestone row is not seeded', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ms-seed-has-'));
    try {
      writeFileSync(join(dir, 'package.json'), '{"version":"1.4.2"}');
      const db = tempDB();
      registerRepo(db, dir);
      db.run(`INSERT INTO milestones (name, repo, state) VALUES ('v1.0.0', 'app', 'closed')`);
      syncRepoMilestones(db, 'app', dir, milestoneSpawn([]));
      assert.deepEqual(milestoneRows(db), [{ name: 'v1.0.0', state: 'closed' }]);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a seeded-only repo still retires when it disappears from the workspace', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'ms-retire-'));
    try {
      const root = mkRepo(ws, 'app', { 'README.md': 'app\n', 'package.json': '{"version":"1.0.0"}' });
      const db = tempDB();
      const tools = scanTools(db, null);
      await call(tools.handlers, 'scan_run', { agent: 'bro', session_dir: ws });
      assert.deepEqual(milestoneRows(db), [{ name: 'v1.0.1', state: 'open' }]);
      rmSync(root, { recursive: true, force: true });
      const r = await call(tools.handlers, 'scan_run', { agent: 'bro', session_dir: ws });
      assert.equal(parse(r)['repos_retired'], 1);
      assert.deepEqual(milestoneRows(db), []);
      db.close();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('milestone_close', () => {
  function setup(): { db: DB; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), 'ms-close-'));
    const db = tempDB();
    registerRepo(db, dir);
    db.run(`INSERT INTO milestones (name, repo, state) VALUES ('v1.4.3', 'app', 'open')`);
    return { db, dir };
  }

  it('closes locally, audits, and makes no remote call when sync is off', async () => {
    const { db, dir } = setup();
    try {
      const calls: Call[] = [];
      const r = await call(milestoneTools(db).handlers, 'milestone_close', {
        agent: 'bro',
        name: 'v1.4.3',
        _spawnFn: milestoneSpawn(calls),
      });
      assert.ok(!r.isError, JSON.stringify(parse(r)));
      assert.deepEqual(milestoneRows(db), [{ name: 'v1.4.3', state: 'closed' }]);
      assert.equal(calls.length, 0);
      assert.deepEqual(auditContent(db, 'milestone_closed'), [
        { name: 'v1.4.3', repo: 'app', forced: false, open_issues: 0, remote_closed: false },
      ]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('closes on the remote under the sync gate (PATCH state=closed)', async () => {
    const { db, dir } = setup();
    try {
      await call(configTools(db).handlers, 'config_set', { agent: 'bro', key: 'issue_sync', value: 'gh' });
      const calls: Call[] = [];
      const _spawnFn = milestoneSpawn(calls, [{ number: 7, title: 'v1.4.3', state: 'open' }]);
      const r = await call(milestoneTools(db).handlers, 'milestone_close', { agent: 'bro', name: 'v1.4.3', _spawnFn });
      assert.ok(!r.isError, JSON.stringify(parse(r)));
      assert.equal(parse(r)['remote_closed'], true);
      const patch = calls.find((c) => c.args.includes('PATCH'));
      assert.ok(patch, 'remote close must PATCH');
      assert.ok(patch.args.includes('repos/acme/app/milestones/7'));
      assert.ok(patch.args.includes('state=closed'));
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses while open issues reference the milestone; force overrides', async () => {
    const { db, dir } = setup();
    try {
      const issues = issueTools(db);
      const created = await call(issues.handlers, 'issue_create', { agent: 'bro', objective: 'pending work', labels: VALID_LABELS, milestone: 'v1.4.3' });
      assert.ok(!created.isError);
      const tools = milestoneTools(db);

      const refused = await call(tools.handlers, 'milestone_close', { agent: 'bro', name: 'v1.4.3' });
      assert.ok(refused.isError);
      assert.match(String(parse(refused)['error']), /^milestone_has_open_issues/);
      assert.deepEqual(milestoneRows(db), [{ name: 'v1.4.3', state: 'open' }]);

      const forced = await call(tools.handlers, 'milestone_close', { agent: 'bro', name: 'v1.4.3', force: true });
      assert.ok(!forced.isError, JSON.stringify(parse(forced)));
      assert.deepEqual(milestoneRows(db), [{ name: 'v1.4.3', state: 'closed' }]);
      assert.equal(auditContent(db, 'milestone_closed')[0]!['forced'], true);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a non-bro caller and an unknown milestone', async () => {
    const { db, dir } = setup();
    try {
      const tools = milestoneTools(db);
      const forbidden = await call(tools.handlers, 'milestone_close', { agent: 'swe', name: 'v1.4.3' });
      assert.ok(forbidden.isError);
      assert.equal(parse(forbidden)['error'], 'forbidden');
      const missing = await call(tools.handlers, 'milestone_close', { agent: 'bro', name: 'v9.9.9' });
      assert.ok(missing.isError);
      assert.match(String(parse(missing)['error']), /^milestone_not_found/);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('milestone_default payload + issue_list milestone filter', () => {
  function repoDb(openMilestones: string[]): DB {
    const db = tempDB();
    db.run(`INSERT INTO repos (name, path) VALUES ('app', '/tmp/app')`);
    for (const m of openMilestones) db.run(`INSERT INTO milestones (name, repo, state) VALUES (?, 'app', 'open')`, [m]);
    return db;
  }

  async function createIssue(db: DB, objective: string, milestone?: string): Promise<Record<string, unknown>> {
    const args: Record<string, unknown> = { agent: 'bro', objective, labels: VALID_LABELS };
    if (milestone) args['milestone'] = milestone;
    const r = await call(issueTools(db).handlers, 'issue_create', args);
    assert.ok(!r.isError, JSON.stringify(parse(r)));
    return parse(r);
  }

  async function startIntent(db: DB, branch: string): Promise<Record<string, unknown>> {
    const r = await call(compositeTools(db, '/tmp/.claude/tmb/trajectory.db').handlers, 'intent_start', {
      agent: 'bro',
      objective: `intent ${branch}`,
      intent_verbatim: 'do it',
      branch_id: branch,
    });
    assert.ok(!r.isError, JSON.stringify(parse(r)));
    return parse(r);
  }

  it('issue_create reports applied / explicit / none_open / multiple_open', async () => {
    const one = repoDb(['v1.0.0']);
    const applied = await createIssue(one, 'applied default');
    assert.equal(applied['milestone_default'], 'applied');
    assert.equal(applied['milestone'], 'v1.0.0');
    const explicit = await createIssue(one, 'explicit choice wins', 'v2.0.0');
    assert.equal(explicit['milestone_default'], 'explicit');
    one.close();

    const none = repoDb([]);
    const noneOpen = await createIssue(none, 'nothing open');
    assert.equal(noneOpen['milestone_default'], 'none_open');
    assert.equal(noneOpen['open_milestones'], undefined);
    none.close();

    const many = repoDb(['v1.1.0', 'v1.0.0']);
    const multiple = await createIssue(many, 'ambiguous default');
    assert.equal(multiple['milestone_default'], 'multiple_open');
    assert.deepEqual(multiple['open_milestones'], ['v1.0.0', 'v1.1.0']);
    assert.equal(multiple['milestone'], null);
    many.close();
  });

  it('intent_start reports applied / none_open / multiple_open', async () => {
    const one = repoDb(['v1.0.0']);
    assert.equal((await startIntent(one, 'feat/ms-applied'))['milestone_default'], 'applied');
    one.close();
    const none = repoDb([]);
    assert.equal((await startIntent(none, 'feat/ms-none'))['milestone_default'], 'none_open');
    none.close();
    const many = repoDb(['v1.0.0', 'v1.1.0']);
    const multiple = await startIntent(many, 'feat/ms-multi');
    assert.equal(multiple['milestone_default'], 'multiple_open');
    assert.deepEqual(multiple['open_milestones'], ['v1.0.0', 'v1.1.0']);
    many.close();
  });

  it("issue_list filters by milestone name and by 'none'", async () => {
    const db = repoDb(['v1.0.0', 'v1.1.0']);
    const tagged = await createIssue(db, 'bound to one zero', 'v1.0.0');
    const untagged = await createIssue(db, 'left untriaged entirely');
    const handlers = issueTools(db).handlers;

    const byName = parse(await call(handlers, 'issue_list', { agent: 'bro', milestone: 'v1.0.0' })) as unknown as Array<{ id: number }>;
    assert.deepEqual(byName.map((r) => r.id), [tagged['id']]);
    const none = parse(await call(handlers, 'issue_list', { agent: 'bro', milestone: 'none' })) as unknown as Array<{ id: number }>;
    assert.deepEqual(none.map((r) => r.id).filter((id) => id > 0), [untagged['id']]);
    const noneClosed = parse(await call(handlers, 'issue_list', { agent: 'bro', milestone: 'none', status: 'closed' })) as unknown as Array<{ id: number }>;
    assert.deepEqual(noneClosed.filter((r) => r.id > 0), []);
    db.close();
  });
});
