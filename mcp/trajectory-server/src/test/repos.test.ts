import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { tempDB } from './helpers.js';
import { repoTools, renameRepo } from '../tools/repos.js';
import { WorldModelGraph, GraphHolder } from '../graph-db.js';
import type { TrajectoryDB } from '../db.js';
import { primaryRemote, upsertRepoRemotes } from '../repos/remotes.js';

type RawResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

function parse(r: RawResult): Record<string, unknown> {
  return JSON.parse(r.content[0]!.text) as Record<string, unknown>;
}

async function rename(db: TrajectoryDB, args: Record<string, unknown>, holder: GraphHolder | null = null): Promise<RawResult> {
  const h = repoTools(db, holder).handlers['repo_rename']!;
  return (await h({ agent: 'bro', reason: 'directory + GitHub repo renamed', ...args })) as unknown as RawResult;
}

const NOW = '2026-10-11T00:00:00.000Z';

// One row of every repo FK child plus a pr_review_runs host slug, all on `old`.
function seed(db: TrajectoryDB, opts: { taskStatus?: string; repoPath?: string } = {}): void {
  db.run(`INSERT INTO repos (name, path, file_count, target_branch) VALUES ('old', ?, 7, 'dev')`, [opts.repoPath ?? '/work/old']);
  upsertRepoRemotes(db, 'old', [{ name: 'origin', provider: 'github', url: 'git@github.com:acme/old.git' }]);
  db.run(`INSERT INTO milestones (name, repo) VALUES ('v1.0.0', 'old')`);
  db.run(
    `INSERT INTO issues (objective, description, status, created_at, updated_at, repo, milestone)
     VALUES ('o', 'd', 'open', ?, ?, 'old', 'v1.0.0')`,
    [NOW, NOW],
  );
  const issueId = Number(db.get<{ id: number }>(`SELECT MAX(id) AS id FROM issues`)!.id);
  db.run(
    `INSERT INTO tasks (issue_id, branch_id, description, status, repo, created_at, updated_at)
     VALUES (?, 'feat/x', 'd', ?, 'old', ?, ?)`,
    [issueId, opts.taskStatus ?? 'closed', NOW, NOW],
  );
  const taskId = Number(db.get<{ id: number }>(`SELECT MAX(id) AS id FROM tasks`)!.id);
  db.run(
    `INSERT INTO audit (issue_id, from_node, event_type, summary, repo, created_at) VALUES (?, 'bro', 'note', 's', 'old', ?)`,
    [issueId, NOW],
  );
  db.run(
    `INSERT INTO validation_attempts (task_id, attempt_n, verdict, mcp_available, repo, created_at) VALUES (?, 1, 'pass', 1, 'old', ?)`,
    [taskId, NOW],
  );
  db.run(`INSERT INTO discussions (issue_id, author, body, repo, created_at) VALUES (?, 'bro', 'b', 'old', ?)`, [issueId, NOW]);
  db.run(`INSERT INTO agent_runs (task_id, issue_id, agent_type, repo) VALUES (?, ?, 'swe', 'old')`, [taskId, issueId]);
  db.run(`INSERT INTO pr_review_runs (pr_number, repo, last_fetched_at) VALUES (5, 'github.com/acme/old', ?)`, [NOW]);
}

function countOn(db: TrajectoryDB, table: string, repo: string): number {
  const sql: Record<string, string> = {
    milestones: 'SELECT COUNT(*) AS n FROM milestones WHERE repo = ?',
    issues: 'SELECT COUNT(*) AS n FROM issues WHERE repo = ?',
    tasks: 'SELECT COUNT(*) AS n FROM tasks WHERE repo = ?',
    audit: `SELECT COUNT(*) AS n FROM audit WHERE repo = ? AND event_type <> 'repo_renamed'`,
    validation_attempts: 'SELECT COUNT(*) AS n FROM validation_attempts WHERE repo = ?',
    discussions: 'SELECT COUNT(*) AS n FROM discussions WHERE repo = ?',
    agent_runs: 'SELECT COUNT(*) AS n FROM agent_runs WHERE repo = ?',
    repo_remotes: 'SELECT COUNT(*) AS n FROM repo_remotes WHERE repo = ?',
  };
  return Number(db.get<{ n: number }>(sql[table]!, [repo])!.n);
}

const CHILDREN = ['milestones', 'repo_remotes', 'issues', 'tasks', 'audit', 'validation_attempts', 'discussions', 'agent_runs'];

describe('repo_rename — transactional move', () => {
  it('moves every FK child + the pr_review_runs slug, drops the old row, audits per-table counts', async () => {
    const db = tempDB();
    seed(db);
    const r = await rename(db, { old: 'old', new: 'renamed' });
    assert.ok(!r.isError, JSON.stringify(r));
    const out = parse(r);
    assert.equal(out['graph'], 'deferred', 'no graph → deferred');

    for (const t of CHILDREN) {
      assert.equal(countOn(db, t, 'old'), 0, `${t}: nothing left on old`);
      assert.equal(countOn(db, t, 'renamed'), 1, `${t}: one row on renamed`);
    }
    const slugs = db.all<{ repo: string }>(`SELECT repo FROM pr_review_runs`).map((x) => x.repo);
    assert.deepEqual(slugs, ['github.com/acme/renamed']);

    assert.equal(db.get(`SELECT 1 AS x FROM repos WHERE name = 'old'`), undefined, 'old row gone');
    const moved = db.get<{ path: string; file_count: number; target_branch: string }>(
      `SELECT path, file_count, target_branch FROM repos WHERE name = 'renamed'`,
    );
    assert.deepEqual({ ...moved }, { path: '/work/old', file_count: 7, target_branch: 'dev' }, 'row copied');
    assert.equal(db.all('PRAGMA foreign_key_check').length, 0, 'FK check empty');
    assert.equal(Number(db.get<{ foreign_keys: number }>('PRAGMA foreign_keys')!.foreign_keys), 1, 'FKs back on');

    const audit = db.get<{ content_json: string; repo: string; issue_id: number }>(
      `SELECT content_json, repo, issue_id FROM audit WHERE event_type = 'repo_renamed'`,
    );
    assert.ok(audit, 'repo_renamed audit row');
    assert.equal(audit!.repo, 'renamed');
    assert.equal(audit!.issue_id, -1);
    const content = JSON.parse(audit!.content_json) as Record<string, unknown>;
    assert.equal(content['old'], 'old');
    assert.equal(content['new'], 'renamed');
    assert.equal(content['reason'], 'directory + GitHub repo renamed');
    assert.equal(content['graph'], 'deferred');
    assert.deepEqual(content['rows_by_table'], {
      milestones: 1,
      repo_remotes: 1,
      issues: 1,
      tasks: 1,
      audit: 1,
      validation_attempts: 1,
      discussions: 1,
      agent_runs: 1,
      pr_review_runs: 1,
    });
    db.close();
  });

  it('moves the repo_remotes rows with their provider, url, primary flag and created_at', async () => {
    const db = tempDB();
    seed(db);
    upsertRepoRemotes(db, 'old', [
      { name: 'origin', provider: 'github', url: 'git@github.com:acme/old.git' },
      { name: 'mirror', provider: 'gitlab', url: 'https://gitlab.com/acme/old.git' },
    ]);
    const before = db.all<Record<string, unknown>>(`SELECT name, provider, url, is_primary, created_at FROM repo_remotes WHERE repo = 'old' ORDER BY name`);
    const r = await rename(db, { old: 'old', new: 'renamed' });
    assert.ok(!r.isError, JSON.stringify(r));
    assert.equal((parse(r)['rows_by_table'] as Record<string, number>)['repo_remotes'], 2);
    assert.equal(countOn(db, 'repo_remotes', 'old'), 0);
    assert.deepEqual(
      db.all<Record<string, unknown>>(`SELECT name, provider, url, is_primary, created_at FROM repo_remotes WHERE repo = 'renamed' ORDER BY name`).map((x) => ({ ...x })),
      before.map((x) => ({ ...x })),
    );
    assert.equal(primaryRemote(db, 'renamed')!.name, 'origin');
    db.close();
  });

  it('rewrites the slug when the remote already names the new repo', async () => {
    const db = tempDB();
    seed(db);
    upsertRepoRemotes(db, 'old', [{ name: 'origin', provider: 'github', url: 'https://github.com/acme/renamed.git' }]);
    const r = await rename(db, { old: 'old', new: 'renamed' });
    assert.ok(!r.isError, JSON.stringify(r));
    assert.deepEqual(db.all<{ repo: string }>(`SELECT repo FROM pr_review_runs`).map((x) => x.repo), ['github.com/acme/renamed']);
    db.close();
  });

  it('rolls the whole transaction back when foreign_key_check finds a dangling reference', () => {
    const db = tempDB();
    seed(db);
    db.run('PRAGMA foreign_keys = OFF');
    db.run(
      `INSERT INTO tasks (issue_id, branch_id, description, status, repo, created_at, updated_at) VALUES (999, 'feat/dangling', 'd', 'closed', 'old', ?, ?)`,
      [NOW, NOW],
    );
    db.run('PRAGMA foreign_keys = ON');
    assert.throws(() => renameRepo(db, null, { old: 'old', new: 'renamed', reason: 'r' }), /foreign_key_check/);
    assert.ok(db.get(`SELECT 1 AS x FROM repos WHERE name = 'old'`), 'old row restored');
    assert.equal(db.get(`SELECT 1 AS x FROM repos WHERE name = 'renamed'`), undefined, 'new row rolled back');
    assert.equal(countOn(db, 'issues', 'old'), 1, 'children untouched');
    assert.equal(db.get(`SELECT 1 AS x FROM audit WHERE event_type = 'repo_renamed'`), undefined, 'no audit row');
    db.close();
  });
});

describe('repo_rename — refusals', () => {
  it('repo_same when old == new', async () => {
    const db = tempDB();
    seed(db);
    const r = await rename(db, { old: 'old', new: 'old' });
    assert.equal(r.isError, true);
    assert.equal(parse(r)['error'], 'repo_same');
    db.close();
  });

  it('repo_not_found when old is missing', async () => {
    const db = tempDB();
    const r = await rename(db, { old: 'ghost', new: 'renamed' });
    assert.equal(r.isError, true);
    assert.equal(parse(r)['error'], 'repo_not_found');
    db.close();
  });

  it('repo_exists when new already exists', async () => {
    const db = tempDB();
    seed(db);
    db.run(`INSERT INTO repos (name, path) VALUES ('renamed', '/work/renamed')`);
    const r = await rename(db, { old: 'old', new: 'renamed' });
    assert.equal(r.isError, true);
    assert.equal(parse(r)['error'], 'repo_exists');
    assert.equal(countOn(db, 'issues', 'old'), 1, 'nothing moved');
    db.close();
  });

  it('rename_in_progress while a live task worktree sits under the old name; force overrides', async () => {
    const db = tempDB();
    seed(db, { taskStatus: 'running' });
    const r = await rename(db, { old: 'old', new: 'renamed' });
    assert.equal(r.isError, true);
    const out = parse(r);
    assert.equal(out['error'], 'rename_in_progress');
    const blocking = out['blocking_tasks'] as Array<{ worktree: string }>;
    assert.equal(blocking.length, 1);
    assert.equal(blocking[0]!.worktree, '/work/old/.claude/worktrees/x');
    assert.equal(countOn(db, 'tasks', 'old'), 1, 'nothing moved');

    const forced = await rename(db, { old: 'old', new: 'renamed', force: true });
    assert.ok(!forced.isError, JSON.stringify(forced));
    assert.equal(countOn(db, 'tasks', 'renamed'), 1);
    db.close();
  });

  it('a live task whose worktree does not sit under the old name does not block', async () => {
    const db = tempDB();
    seed(db, { taskStatus: 'running', repoPath: '/work/elsewhere' });
    const r = await rename(db, { old: 'old', new: 'renamed' });
    assert.ok(!r.isError, JSON.stringify(r));
    db.close();
  });

  it('is bro-only', async () => {
    const db = tempDB();
    seed(db);
    const h = repoTools(db).handlers['repo_rename']!;
    const r = (await h({ agent: 'swe', old: 'old', new: 'renamed', reason: 'r' })) as unknown as RawResult;
    assert.equal(r.isError, true);
    assert.equal(parse(r)['error'], 'forbidden');
    db.close();
  });
});

describe('repo_rename — graph', () => {
  it('a graph that fails to re-key leaves the SQL side committed with graph deferred', async () => {
    const db = tempDB();
    seed(db);
    const failing = {
      renameRepo: () => {
        throw new Error('kuzu exploded');
      },
    } as unknown as WorldModelGraph;
    const r = await rename(db, { old: 'old', new: 'renamed' }, GraphHolder.fixed(failing));
    assert.ok(!r.isError, JSON.stringify(r));
    const out = parse(r);
    assert.equal(out['graph'], 'deferred');
    assert.equal(out['graph_error'], 'kuzu exploded');
    assert.equal(countOn(db, 'issues', 'renamed'), 1);
    const audit = db.get<{ content_json: string }>(`SELECT content_json FROM audit WHERE event_type = 'repo_renamed'`);
    assert.equal((JSON.parse(audit!.content_json) as Record<string, unknown>)['graph'], 'deferred');
    db.close();
  });

  // kuzu runs in a child process so its native destructor crash on exit
  // (kuzu v0.11 / Node 24 / macOS) cannot fail this file; see world_model.test.ts.
  it('re-keys Directory nodes: world_model_get(new) returns the tree, old is empty', () => {
    try {
      new WorldModelGraph(':memory:').close();
    } catch {
      console.log('  SKIP: kuzu not available in this environment');
      return;
    }
    const ws = mkdtempSync(join(tmpdir(), 'repo-rename-graph-'));
    try {
      const repoRoot = join(ws, 'app');
      mkdirSync(join(repoRoot, 'src', 'api'), { recursive: true });
      writeFileSync(join(repoRoot, 'README.md'), 'app\n');
      writeFileSync(join(repoRoot, 'src', 'api', 'h.ts'), 'export {};\n');
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
      execFileSync('git', ['config', 'user.email', 't@t.io'], { cwd: repoRoot });
      execFileSync('git', ['config', 'user.name', 't'], { cwd: repoRoot });
      execFileSync('git', ['add', '.'], { cwd: repoRoot });
      execFileSync('git', ['commit', '-qm', 'init'], { cwd: repoRoot });

      const distRoot = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
      const script = `
import { TrajectoryDB } from '${distRoot}/db.js';
import { WorldModelGraph, GraphHolder } from '${distRoot}/graph-db.js';
import { scanTools } from '${distRoot}/tools/scan.js';
import { repoTools } from '${distRoot}/tools/repos.js';
import { worldModelTools } from '${distRoot}/tools/world_model.js';

const ws = ${JSON.stringify(ws)};
const db = new TrajectoryDB(':memory:');
const graph = new WorldModelGraph(ws + '/world-model.kuzu');
const holder = GraphHolder.fixed(graph);
const s = await scanTools(db, holder, ':memory:').handlers.scan_run({ agent: 'bro', session_dir: ws });
if (s.isError) { console.log(JSON.stringify({ ok: false, msg: s.content[0].text })); process.exit(1); }
const before = graph.allDirectoriesForRepo('app').length;
const r = await repoTools(db, holder).handlers.repo_rename({ agent: 'bro', old: 'app', new: 'app2', reason: 'test' });
const out = JSON.parse(r.content[0].text);
const wm = worldModelTools(db, holder).handlers.world_model_get;
const gNew = JSON.parse((await wm({ agent: 'bro', repo: 'app2', depth: null })).content[0].text);
const gOld = JSON.parse((await wm({ agent: 'bro', repo: 'app', depth: null })).content[0].text);
const keys = graph.allDirectoriesForRepo('app2').map((n) => n.key);
const api = gNew.root?.children?.find((c) => c.path === 'src')?.children?.some((c) => c.path === 'src/api') ?? false;
graph.close();
db.close();
console.log(JSON.stringify({ ok: true, before, renameError: r.isError ?? false, out, newRoot: gNew.root !== null, api, oldWarning: gOld.warning, oldRoot: gOld.root, keys }));
`;
      let stdout = '';
      try {
        stdout = execFileSync(process.execPath, ['--experimental-sqlite', '--input-type=module'], {
          input: script,
          encoding: 'utf8',
          timeout: 30000,
        });
      } catch (e: unknown) {
        const se = e as { stdout?: string; stderr?: string; status?: number };
        if (se.stdout?.trim()) stdout = se.stdout;
        else throw new Error(`child process failed (exit ${se.status}): ${se.stderr?.slice(0, 500) ?? ''}`);
      }
      const res = JSON.parse(stdout.trim().split('\n').find((l) => l.startsWith('{')) ?? '{}') as {
        ok?: boolean; msg?: string; before?: number; renameError?: boolean;
        out?: Record<string, unknown>; newRoot?: boolean; api?: boolean; oldWarning?: string; oldRoot?: unknown; keys?: string[];
      };
      assert.ok(res.ok !== false, `child: ${res.msg ?? 'unknown'}`);
      assert.ok((res.before ?? 0) >= 3, 'scan populated app nodes');
      assert.equal(res.renameError, false, JSON.stringify(res.out));
      assert.equal(res.out!['graph'], 'rekeyed');
      assert.equal(res.out!['graph_nodes'], res.before);
      assert.ok(res.newRoot, 'world_model_get(app2) returns the tree');
      assert.ok(res.api, 'CONTAINS edges re-linked under the new repo');
      assert.equal(res.oldWarning, 'world-model-empty', 'world_model_get(app) is empty');
      assert.equal(res.oldRoot, null);
      assert.ok(res.keys!.every((k) => k === WorldModelGraph.dirKey('app2', JSON.parse(k)[1] as string)), 'keys recomputed with dirKey');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
