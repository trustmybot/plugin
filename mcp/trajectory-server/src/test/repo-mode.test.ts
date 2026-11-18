/**
 * Per-repo mode (GH 3279): repos.mode is truest, agile, exempt or NULL (the
 * project's workflow_mode). scan_run registers a new repo exempt, a rescan
 * keeps whatever mode the row holds, repo_rename carries it and onboard_apply
 * clears exempt. isExempt is an allowlist: only a stored exempt stands the
 * git guards and the push gate down; every other deny names the repo and mode.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TrajectoryDB } from '../db.js';
import { gitGuards } from '../hooks/git-guards.js';
import { gitPushGuard } from '../hooks/git-push-guard.js';
import { isExempt, repoMode, repoModeLabel } from '../hooks/lib/repo.js';
import { WORKFLOW_MODE_KEY } from '../tools/config.js';
import { onboardTools } from '../tools/onboard.js';
import { repoTools } from '../tools/repos.js';
import { scanTools } from '../tools/scan.js';
import { pinScanEnv, tempDB } from './helpers.js';

const scanPin = pinScanEnv();
after(() => scanPin.restore());

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

function git(dir: string, ...args: string[]): string {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: GIT_ENV, timeout: 30_000 });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A checkout on main with one commit pushed to its own bare origin. */
function gitRepo(parent: string, name: string): string {
  const dir = join(parent, name);
  mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'README.md'), `${name}\n`);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
  git(parent, 'init', '-q', '--bare', '-b', 'main', `${name}.git`);
  git(dir, 'remote', 'add', 'origin', join(parent, `${name}.git`));
  git(dir, 'push', '-q', '-u', 'origin', 'main');
  return dir;
}

type RawResult = { content: Array<{ text: string }>; isError?: boolean };

async function call(handlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>>, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const r = (await handlers[name]({ agent: 'bro', ...args })) as RawResult;
  assert.ok(!r.isError, r.content[0]?.text);
  return JSON.parse(r.content[0].text) as Record<string, unknown>;
}

function payload(command: string, cwd: string): string {
  return JSON.stringify({ tool_name: 'Bash', cwd, tool_input: { command } });
}

function reason(stdout: string): string {
  if (stdout === '') return '';
  const out = JSON.parse(stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  return out.hookSpecificOutput.permissionDecisionReason;
}

/** The repo-and-mode suffix, sitting right before the deny's fix ending. */
function suffixed(repo: string, mode: string): RegExp {
  return new RegExp(`\\(repo ${repo}, mode ${mode}\\)( Allowed form: | This is policy: stop and report\\.$)`);
}

describe('repo mode — the hooks/lib/repo.ts readers', () => {
  let dir: string;
  let dbPath: string;
  let roots: Record<string, string>;
  let env: NodeJS.ProcessEnv;
  before(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-repo-mode-')));
    roots = {};
    for (const name of ['held', 'free', 'strict', 'loose', 'stray']) {
      roots[name] = join(dir, name);
      mkdirSync(roots[name]);
    }
    dbPath = join(dir, 'trajectory.db');
    const db = new TrajectoryDB(dbPath);
    const insert = (name: string, mode: string | null): void => {
      db.run(`INSERT INTO repos (name, path, mode) VALUES (?, ?, ?)`, [name, roots[name], mode]);
    };
    insert('held', null);
    insert('free', 'exempt');
    insert('strict', 'truest');
    insert('loose', 'agile');
    db.close();
    env = { ...process.env, CLAUDE_PROJECT_DIR: dir, TRAJECTORY_DB_PATH: dbPath };
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  const setProjectMode = (value: string | null): void => {
    const db = new TrajectoryDB(dbPath);
    if (value === null) db.run(`DELETE FROM plugin_config WHERE key = ?`, [WORKFLOW_MODE_KEY]);
    else db.run(`INSERT INTO plugin_config (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`, [WORKFLOW_MODE_KEY, JSON.stringify(value)]);
    db.close();
  };

  it('isExempt is true only for a stored exempt', () => {
    assert.equal(isExempt(dbPath, roots['free'], env), true);
    for (const name of ['held', 'strict', 'loose', 'stray']) assert.equal(isExempt(dbPath, roots[name], env), false, name);
    assert.equal(isExempt(dbPath, '', env), false, 'no root');
  });

  it('isExempt is false when the DB is missing or does not read', () => {
    assert.equal(isExempt('', roots['free'], env), false, 'no DB path');
    assert.equal(isExempt(join(dir, 'missing.db'), roots['free'], env), false, 'missing DB');
    const junk = join(dir, 'junk.db');
    writeFileSync(junk, 'this is not a sqlite database\n'.repeat(64));
    assert.equal(isExempt(junk, roots['free'], env), false, 'unreadable DB');
  });

  it('repoMode reads the stored mode, else the project workflow_mode (unset reads as truest)', () => {
    setProjectMode(null);
    assert.equal(repoMode(dbPath, roots['held'], env), 'truest');
    assert.equal(repoMode(dbPath, roots['stray'], env), 'truest', 'unregistered');
    setProjectMode('agile');
    assert.equal(repoMode(dbPath, roots['held'], env), 'agile');
    assert.equal(repoMode(dbPath, roots['strict'], env), 'truest');
    assert.equal(repoMode(dbPath, roots['loose'], env), 'agile');
    assert.equal(repoMode(dbPath, roots['free'], env), 'exempt');
    setProjectMode(null);
    assert.equal(repoMode(join(dir, 'missing.db'), roots['loose'], env), 'truest', 'unreadable DB');
  });

  it('repoModeLabel names the registered repo, else the root dir', () => {
    assert.equal(repoModeLabel(dbPath, roots['loose'], env), '(repo loose, mode agile)');
    assert.equal(repoModeLabel(dbPath, roots['stray'], env), '(repo stray, mode truest)');
  });
});

describe('repo mode — git-guards', () => {
  let dir: string;
  let app: string;
  let dbPath: string;
  let env: NodeJS.ProcessEnv;
  before(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-repo-mode-gg-')));
    app = gitRepo(dir, 'app');
    dbPath = join(dir, 'trajectory.db');
    const db = new TrajectoryDB(dbPath);
    db.run(`INSERT INTO repos (name, path, target_branch, branching_model, protected_branches) VALUES ('app', ?, 'main', 'github-flow', '["main"]')`, [app]);
    db.close();
    env = { ...GIT_ENV, CLAUDE_PROJECT_DIR: dir, TRAJECTORY_DB_PATH: dbPath };
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  const setMode = (mode: string | null, project: string | null = null): void => {
    const db = new TrajectoryDB(dbPath);
    db.run(`UPDATE repos SET mode = ? WHERE name = 'app'`, [mode]);
    db.run(`DELETE FROM plugin_config WHERE key = ?`, [WORKFLOW_MODE_KEY]);
    if (project !== null) db.run(`INSERT INTO plugin_config (key, value_json) VALUES (?, ?)`, [WORKFLOW_MODE_KEY, JSON.stringify(project)]);
    db.close();
  };

  const commitOnMain = async (): Promise<string> => reason((await gitGuards(payload(`git -C ${app} commit -m x`, dir), env)).stdout);
  const newBranchOffFeature = async (): Promise<string> =>
    reason((await gitGuards(payload(`git -C ${app} switch -c feat/y`, dir), env)).stdout);

  it('an exempt repo stands every rule down', async () => {
    setMode('exempt');
    assert.equal(await commitOnMain(), '');
    assert.deepEqual(await gitGuards(payload(`gh pr create --base dev --head feat/x`, app), env), { stdout: '', code: 0 });
    assert.deepEqual(await gitGuards(payload(`git -C ${app} push --force origin main`, dir), env), { stdout: '', code: 0 });
  });

  it('NULL, truest and agile keep the rules on, each deny naming the repo and mode', async () => {
    for (const [mode, project, label] of [
      [null, null, 'truest'],
      [null, 'agile', 'agile'],
      ['truest', 'agile', 'truest'],
      ['agile', null, 'agile'],
    ] as const) {
      setMode(mode, project);
      const r = await commitOnMain();
      assert.match(r, /^BLOCKED: main is a shared workflow base/, `${mode}/${project}`);
      assert.match(r, suffixed('app', label), `${mode}/${project}`);
    }
    setMode(null);
    assert.match(reason((await gitGuards(payload(`gh pr create --base dev --head feat/x`, app), env)).stdout), suffixed('app', 'truest'));
    assert.match(reason((await gitGuards(payload(`git -C ${app} push --force origin main`, dir), env)).stdout), suffixed('app', 'truest'));
    git(app, 'switch', '-q', '-c', 'feat/x');
    try {
      assert.match(await newBranchOffFeature(), suffixed('app', 'truest'));
    } finally {
      git(app, 'switch', '-q', 'main');
    }
  });
});

describe('repo mode — git-push-guard', () => {
  let dir: string;
  let app: string;
  let dbPath: string;
  let env: NodeJS.ProcessEnv;
  before(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-repo-mode-pg-')));
    app = gitRepo(dir, 'app');
    git(app, 'switch', '-q', '-c', 'feat/x');
    writeFileSync(join(app, 'a.txt'), 'work\n');
    git(app, 'add', '-A');
    git(app, 'commit', '-qm', 'feat: work');
    const sha = git(app, 'rev-parse', 'HEAD');
    dbPath = join(dir, 'trajectory.db');
    const db = new TrajectoryDB(dbPath);
    db.run(`INSERT INTO repos (name, path, target_branch) VALUES ('app', ?, 'main')`, [app]);
    db.run(`INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (1, 'o', 'open', datetime('now'), datetime('now'))`);
    db.run(
      `INSERT INTO tasks (id, issue_id, branch_id, title, description, status, commit_sha, created_at, updated_at)
       VALUES (1, 1, 'feat/x', 'work', 'd', 'closed', ?, datetime('now'), datetime('now'))`,
      [sha],
    );
    db.close();
    env = { ...GIT_ENV, CLAUDE_PROJECT_DIR: dir, TRAJECTORY_DB_PATH: dbPath };
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  const setMode = (mode: string | null): void => {
    const db = new TrajectoryDB(dbPath);
    db.run(`UPDATE repos SET mode = ? WHERE name = 'app'`, [mode]);
    db.close();
  };
  const push = async (from: string): Promise<string> => reason((await gitPushGuard(payload(`git -C ${from} push origin feat/x`, dir), env)).stdout);

  it('an exempt repo pushes an unreviewed commit, from its checkout or a worktree under it', async () => {
    setMode('exempt');
    assert.equal(await push(app), '');
    assert.equal(await push(join(app, '.claude/worktrees/t')), '');
  });

  it('NULL, truest and agile keep the gate on, each deny naming the repo and mode', async () => {
    for (const mode of [null, 'truest', 'agile'] as const) {
      setMode(mode);
      const label = mode ?? 'truest';
      const unsigned = await push(app);
      assert.match(unsigned, /^BLOCKED: pushing 1 unsigned commit\(s\)/, String(mode));
      assert.match(unsigned, suffixed('app', label), String(mode));
      const worktree = await push(join(app, '.claude/worktrees/t'));
      assert.match(worktree, /^BLOCKED: push from \.claude\/worktrees\/ is forbidden/, String(mode));
      assert.match(worktree, suffixed('app', label), String(mode));
    }
  });

  it('a swe push stays denied in an exempt repo: the role boundary is not a repo rule', async () => {
    setMode('exempt');
    const r = await gitPushGuard(JSON.stringify({ tool_name: 'Bash', cwd: dir, agent_type: 'swe', tool_input: { command: `git -C ${app} push origin feat/x` } }), env);
    assert.match(reason(r.stdout), /^BLOCKED/);
  });
});

describe('repo mode — scan_run, repos_list, repo_rename and onboard_apply', () => {
  let ws: string;
  before(() => {
    ws = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-repo-mode-scan-')));
    for (const name of ['alpha', 'beta']) gitRepo(ws, name);
  });
  after(() => rmSync(ws, { recursive: true, force: true }));

  const modes = (db: TrajectoryDB): Record<string, string | null> =>
    Object.fromEntries(db.all<{ name: string; mode: string | null }>(`SELECT name, mode FROM repos ORDER BY name`).map((r) => [r.name, r.mode]));

  it('scan_run registers a new repo exempt and a rescan keeps the stored mode', async () => {
    const db = tempDB();
    const tools = scanTools(db, null);
    await call(tools.handlers, 'scan_run', { session_dir: ws });
    assert.deepEqual(modes(db), { alpha: 'exempt', beta: 'exempt' });
    db.run(`UPDATE repos SET mode = 'truest' WHERE name = 'alpha'`);
    db.run(`UPDATE repos SET mode = NULL WHERE name = 'beta'`);
    await call(tools.handlers, 'scan_run', { session_dir: ws });
    assert.deepEqual(modes(db), { alpha: 'truest', beta: null });
    db.close();
  });

  it('repos_list returns the stored mode and the effective one', async () => {
    const db = tempDB();
    const tools = scanTools(db, null);
    await call(tools.handlers, 'scan_run', { session_dir: ws });
    db.run(`UPDATE repos SET mode = NULL WHERE name = 'beta'`);
    const list = async (): Promise<Array<Record<string, unknown>>> =>
      ((await call(tools.handlers, 'repos_list')).repos as Array<Record<string, unknown>>).map(({ name, mode, effective_mode }) => ({ name, mode, effective_mode }));
    assert.deepEqual(await list(), [
      { name: 'alpha', mode: 'exempt', effective_mode: 'exempt' },
      { name: 'beta', mode: null, effective_mode: 'truest' },
    ]);
    db.run(`INSERT INTO plugin_config (key, value_json) VALUES (?, '"agile"')`, [WORKFLOW_MODE_KEY]);
    assert.deepEqual((await list())[1], { name: 'beta', mode: null, effective_mode: 'agile' });
    db.close();
  });

  it('repo_rename carries the mode to the renamed row', async () => {
    const db = tempDB();
    db.run(`INSERT INTO repos (name, path, mode) VALUES ('old', '/work/old', 'agile')`);
    await call(repoTools(db, null).handlers, 'repo_rename', { old: 'old', new: 'renamed', reason: 'directory renamed' });
    assert.deepEqual(modes(db), { renamed: 'agile' });
    db.close();
  });

  it('a per-repo onboard_apply clears exempt and leaves truest and agile', async () => {
    const db = tempDB();
    db.run(`INSERT INTO repos (name, path, mode) VALUES ('a', '/repo/a', 'exempt'), ('b', '/repo/b', 'agile'), ('c', '/repo/c', 'exempt')`);
    const tools = onboardTools(db);
    for (const repo of ['a', 'b']) {
      const out = await call(tools.handlers, 'onboard_apply', { shape: 'local', repo, branching_model: 'github-flow', pr_target: 'main' });
      assert.equal(out.ok, true, JSON.stringify(out));
    }
    assert.deepEqual(modes(db), { a: null, b: 'agile', c: 'exempt' });
    db.close();
  });

  it('a workspace onboard_apply clears exempt on every repo whose policy it seeds', async () => {
    const db = tempDB();
    db.run(`INSERT INTO repos (name, path, mode) VALUES ('a', '/repo/a', 'exempt'), ('b', '/repo/b', 'truest')`);
    const out = await call(onboardTools(db).handlers, 'onboard_apply', { shape: 'local', branching_model: 'gitflow' });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.deepEqual(modes(db), { a: null, b: 'truest' });
    db.close();
  });
});
