import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { cleanupWorktree } from '../hooks/cleanup-worktree-on-task-close.js';
import { worktreeCreateRun } from '../hooks/worktree-create.js';
import { findGate } from '../hooks/registry.js';
import { HAS_PASS_SQL } from '../tools/lifecycle.js';
import { addWorktree, GIT_ENV, git, initRepo, trajectoryDb } from './hooks-worktree-lifecycle-parity.suite.js';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const T1 = '2026-10-01T10:00:00.000Z';

const closePayload = (taskId: number): string =>
  JSON.stringify({
    hook_event_name: 'PostToolUse',
    tool_name: 'mcp__plugin_tmb_trajectory-server__task_update_status',
    tool_input: { agent: 'bro', task_id: taskId, status: 'closed' },
  });

function hookEnv(db: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...GIT_ENV, TRAJECTORY_DB_PATH: db };
  for (const key of ['TMB_KEEP_CLOSED_WORKTREES', 'TMB_KEEP_HEAD_ON_CLOSE', 'TMB_TEST_RUN_ID', 'TMB_FORBID_LIVE_SYNC', 'TMB_HOOKS_SQLITE']) delete env[key];
  return env;
}

describe('cleanup-worktree-on-task-close and worktree-create (GH 1692, GH 2032)', () => {
  let base: string;
  let repo: string;
  let db: string;
  let adopted: string;
  let provisioned: string;

  before(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-worktree-lifecycle-')));
    repo = join(base, 'ws/project');
    db = join(base, 'ws/.claude/tmb/trajectory.db');
    initRepo(repo);
    adopted = addWorktree(repo, 'feat/adopted');
    provisioned = addWorktree(repo, 'feat/provisioned');
    trajectoryDb(db, (d: DatabaseSync) => {
      d.prepare('INSERT INTO repos (name, path, target_branch) VALUES (?, ?, ?)').run('project', repo, 'main');
      const task = d.prepare(
        "INSERT INTO tasks (id, issue_id, branch_id, description, status, repo, worktree_path, worktree_adopted, created_at, updated_at) VALUES (?, 1, ?, 'd', 'closed', 'project', ?, ?, ?, ?)",
      );
      task.run(1, 'feat/adopted', adopted, 1, T1, T1);
      task.run(2, 'feat/provisioned', null, 0, T1, T1);
    });
  });
  after(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('keeps a worktree the task adopted (worktree_adopted=1) and says so', () => {
    const lines: string[] = [];
    const r = cleanupWorktree(closePayload(1), hookEnv(db), (line) => lines.push(line));
    assert.deepEqual(r, { stdout: '', code: 0 });
    assert.ok(existsSync(adopted), 'the adopted worktree stays');
    assert.match(git(repo, 'worktree', 'list', '--porcelain'), /\.claude\/worktrees\/adopted/);
    assert.deepEqual(lines, [`tmb: kept adopted worktree ${adopted} after task #1 closed (GH 2032)\n`]);
  });

  it('removes a provisioned worktree (worktree_adopted=0)', () => {
    const lines: string[] = [];
    const r = cleanupWorktree(closePayload(2), hookEnv(db), (line) => lines.push(line));
    assert.deepEqual(r, { stdout: '', code: 0 });
    assert.ok(!existsSync(provisioned), 'the provisioned worktree is removed');
    assert.doesNotMatch(git(repo, 'worktree', 'list', '--porcelain'), /\.claude\/worktrees\/provisioned/);
    assert.deepEqual(lines, [`tmb: cleaned up worktree ${provisioned} after task #2 closed\n`]);
  });

  it('reads the validation_record pass with the HAS_PASS_SQL lifecycle.ts holds, equal to the .sh copy', () => {
    const sh = readFileSync(join(PLUGIN_ROOT, 'scripts/hooks/cleanup-worktree-on-task-close.sh'), 'utf8');
    const copy = /_CWC_HAS_PASS="([\s\S]*?)"\n/.exec(sh)?.[1]?.replaceAll('\\$', '$');
    assert.equal(copy, HAS_PASS_SQL);
  });

  it('worktree-create prints the bare worktree path and exits 0, a failure exits 1 with stdout empty', () => {
    const lines: string[] = [];
    const ok = worktreeCreateRun(JSON.stringify({ hook_event_name: 'WorktreeCreate', branch: 'feat/new' }), hookEnv(db), (line) => lines.push(line));
    const path = join(repo, '.claude/worktrees/new');
    assert.deepEqual(ok, { stdout: `${path}\n`, code: 0 });
    assert.ok(existsSync(join(path, '.git')));
    assert.deepEqual(lines, [`tmb worktree-create: auto-created branch feat/new in ${repo}\n`, `tmb worktree-create: created worktree ${path} for branch feat/new in repo ${repo}\n`]);
    const failed = worktreeCreateRun('{}', hookEnv(db), () => undefined);
    assert.deepEqual(failed, { stdout: '', code: 1 });
  });

  it('both gates are registered', () => {
    assert.ok(findGate('cleanup-worktree-on-task-close'));
    assert.ok(findGate('worktree-create'));
  });

  it('the bundled worktree-create passes the bare path through on stdout', () => {
    const r = spawnSync(process.execPath, [join(PLUGIN_ROOT, 'mcp/trajectory-server/dist/hooks.js'), 'worktree-create'], {
      input: JSON.stringify({ hook_event_name: 'WorktreeCreate', branch: 'feat/bundled' }),
      env: hookEnv(db),
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `${join(repo, '.claude/worktrees/bundled')}\n`);
  });
});
