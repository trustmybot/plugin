/**
 * branch-up-to-date-with-remote under workflow_mode agile (GH 2225): an agile
 * task's branch is measured against its parent feature branch (origin/<parent>,
 * else the local parent), not repos.target_branch; a truest task, and an agile
 * task whose parent does not resolve, keep origin/<target_branch>.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { branchUpToDateWithRemote } from '../hooks/branch-up-to-date-with-remote.js';
import { ALLOW, type GateResult } from '../hooks/gate.js';

const SCHEMA = readFileSync(join(resolve(dirname(fileURLToPath(import.meta.url)), '../..'), 'src/schema.sql'), 'utf8');
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.com',
};
const FEATURE = 'feat/milestone';
const LOCAL_FEATURE = 'feat/local-milestone';

function git(dir: string, ...args: string[]): string {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, ...GIT_ENV }, timeout: 30_000 });
  assert.equal(r.status, 0, `git ${args.join(' ')} in ${dir}: ${r.stderr}`);
  return r.stdout.trim();
}

function commit(dir: string, name: string): string {
  writeFileSync(join(dir, name), `${name}\n`);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', `add ${name}`);
  return git(dir, 'rev-parse', 'HEAD');
}

function denyReason(r: GateResult): string {
  const out = JSON.parse(r.stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  return out.hookSpecificOutput.permissionDecisionReason;
}

describe('branch-up-to-date-with-remote measures an agile task against its parent feature branch (GH 2225)', () => {
  let root: string;
  let work: string;
  let db: string;
  let env: NodeJS.ProcessEnv;

  /**
   * origin/main is one commit past the point FEATURE was cut from it; origin/FEATURE is one
   * commit past the local tip feat/at-feature sits on; LOCAL_FEATURE exists only locally.
   */
  before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-agile-fresh-')));
    work = join(root, 'work');
    mkdirSync(work);
    git(work, 'init', '-q', '-b', 'main');
    commit(work, 'README.md');
    git(root, 'init', '-q', '--bare', 'origin.git');
    git(work, 'remote', 'add', 'origin', join(root, 'origin.git'));
    git(work, 'push', '-qu', 'origin', 'main');

    git(work, 'checkout', '-q', '-b', FEATURE);
    const featureTip = commit(work, 'milestone.txt');
    git(work, 'push', '-q', 'origin', FEATURE);
    git(work, 'branch', 'feat/at-feature', featureTip);
    git(work, 'branch', 'feat/behind-local', featureTip);
    git(work, 'checkout', '-q', '-b', LOCAL_FEATURE);
    commit(work, 'local-milestone.txt');

    git(root, 'clone', '-q', join(root, 'origin.git'), 'other');
    const other = join(root, 'other');
    git(other, 'checkout', '-q', 'main');
    commit(other, 'dev-moves.txt');
    git(other, 'checkout', '-q', FEATURE);
    commit(other, 'milestone-moves.txt');
    git(other, 'push', '-q', 'origin', 'main', FEATURE);
    git(work, 'checkout', '-q', 'main');

    db = join(root, 'trajectory.db');
    const d = new DatabaseSync(db);
    d.exec(SCHEMA);
    d.prepare("INSERT INTO repos (name, path, target_branch) VALUES ('work', ?, 'main')").run(work);
    d.exec("INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (1, 'o', 'open', datetime('now'), datetime('now'))");
    const task = d.prepare("INSERT INTO tasks (id, issue_id, branch_id, parent_branch_id, description, status, repo, created_at, updated_at) VALUES (?, 1, ?, ?, 'd', 'pending', 'work', datetime('now'), datetime('now'))");
    task.run(1, 'feat/at-feature', FEATURE);
    task.run(2, 'feat/behind-local', LOCAL_FEATURE);
    task.run(3, 'feat/gone-parent', 'feat/gone');
    d.close();
    git(work, 'branch', 'feat/gone-parent', featureTip);
    env = { PATH: process.env.PATH, HOME: join(root, 'home'), CLAUDE_PROJECT_DIR: root, TRAJECTORY_DB_PATH: db, LC_ALL: 'C', ...GIT_ENV };
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  const setMode = (mode: 'agile' | 'truest' | null): void => {
    const d = new DatabaseSync(db);
    d.exec("DELETE FROM plugin_config WHERE key = 'workflow_mode'");
    if (mode !== null) d.prepare("INSERT INTO plugin_config (key, value_json) VALUES ('workflow_mode', ?)").run(JSON.stringify(mode));
    d.close();
  };
  const attach = async (branch: string): Promise<GateResult> =>
    await branchUpToDateWithRemote(JSON.stringify({ tool_name: 'Bash', tool_input: { command: `git worktree add ../wt ${branch}` }, cwd: work }), env);

  it('agile: denies a branch behind origin/<feature branch>, naming it, after fetching it', async () => {
    setMode('agile');
    const reason = denyReason(await attach('feat/at-feature'));
    assert.ok(reason.startsWith(`BLOCKED: branch 'feat/at-feature' is behind origin/${FEATURE} by 1 commit(s).`), reason);
    assert.ok(reason.includes(`git fetch origin ${FEATURE} && git branch feat/at-feature origin/${FEATURE}`), reason);
  });

  it('agile: measures against the local feature branch when origin has none', async () => {
    setMode('agile');
    const reason = denyReason(await attach('feat/behind-local'));
    assert.ok(reason.startsWith(`BLOCKED: branch 'feat/behind-local' is behind ${LOCAL_FEATURE} by 1 commit(s).`), reason);
    assert.ok(reason.includes(`git branch -D feat/behind-local && git branch feat/behind-local ${LOCAL_FEATURE}, then`), reason);
  });

  it('agile: allows a branch at its feature branch tip, though main has moved past it', async () => {
    setMode('agile');
    git(work, 'fetch', '-q', 'origin', FEATURE);
    git(work, 'branch', '-f', 'feat/at-feature', `origin/${FEATURE}`);
    try {
      assert.deepEqual(await attach('feat/at-feature'), ALLOW);
    } finally {
      git(work, 'branch', '-f', 'feat/at-feature', `origin/${FEATURE}~1`);
    }
  });

  it('agile with a parent that does not resolve: measures against origin/main as before', async () => {
    setMode('agile');
    assert.ok(denyReason(await attach('feat/gone-parent')).startsWith("BLOCKED: branch 'feat/gone-parent' is behind origin/main by 1 commit(s)."));
  });

  for (const mode of ['truest', null] as const) {
    it(`${mode ?? 'unset'} mode: measures a stacked task against origin/main as before`, async () => {
      setMode(mode);
      assert.ok(denyReason(await attach('feat/at-feature')).startsWith("BLOCKED: branch 'feat/at-feature' is behind origin/main by 1 commit(s)."));
      git(work, 'fetch', '-q', 'origin', FEATURE);
      git(work, 'branch', '-f', 'feat/behind-local', `origin/${FEATURE}`);
      try {
        assert.ok(denyReason(await attach('feat/behind-local')).startsWith("BLOCKED: branch 'feat/behind-local' is behind origin/main by 1 commit(s)."));
      } finally {
        git(work, 'branch', '-f', 'feat/behind-local', `origin/${FEATURE}~1`);
      }
    });
  }
});
