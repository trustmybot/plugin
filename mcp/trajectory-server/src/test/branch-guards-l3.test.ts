/**
 * The branch guards end to end (GH 1692), the l3 bash suites' cases in
 * node:test. stay-on-base-guard denies a checkout or switch of an open task's
 * branch from the main checkout; branch-up-to-date-with-remote denies attaching
 * a worktree to a branch behind origin/<pr_target>; no-worktree-branch-create
 * denies `git worktree add -b/-B/--create-branch/--detach`;
 * require-feature-branch-active denies a swe spawn whose task branch does not
 * exist. Each case runs `node dist/hooks.js <gate>` with CLAUDE_PROJECT_DIR
 * pinned to the sandbox and PWD set.
 */
import assert from 'node:assert/strict';
import { mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { makeSandbox, runGate, without, type Sandbox } from './hook-sandbox.js';
import { commit, DENY, gateEnv, git, has, hasNot, insertRepo, newDb, NO_DB, sql } from './git-push-guard-l3.js';

interface GateRun {
  cwd: string;
  db?: string;
  env?: NodeJS.ProcessEnv;
}

/** The gate's stdout and stderr for <payload> (a `2>&1`). */
function gate(sb: Sandbox, name: string, payload: unknown, opts: GateRun): string {
  const r = runGate(name, {
    cwd: opts.cwd,
    input: JSON.stringify(payload),
    env: { ...gateEnv(sb, opts.cwd), TRAJECTORY_DB_PATH: opts.db ?? NO_DB, ...opts.env },
  });
  return r.stdout + r.stderr;
}

const bash = (command: string) => ({ tool_name: 'Bash', tool_input: { command } });
/** The `$(...)` capture is empty: only trailing newlines, if anything. */
const silent = (out: string, msg: string) => assert.equal(out.replace(/\n+$/, ''), '', `${msg}\n--- output ---\n${out}`);
const heredoc = (...body: string[]) => ["cat > notes.md <<'EOF'", ...body, 'EOF'].join('\n');

let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox('branch-guards');
});
afterEach(() => sb.remove());

describe('stay-on-base-guard l3', () => {
  let db: string;
  beforeEach(() => {
    db = join(sb.dir, 'trajectory.db');
    sql(db, 'CREATE TABLE repos (name TEXT PRIMARY KEY, path TEXT)');
    sql(
      db,
      `CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, issue_id INTEGER NOT NULL, branch_id TEXT NOT NULL,
         parent_branch_id TEXT, title TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
         status TEXT NOT NULL DEFAULT 'pending', spec_body TEXT NOT NULL DEFAULT '', repo TEXT,
         prompt_bearing INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')),
         updated_at TEXT NOT NULL DEFAULT (datetime('now')), completed_at TEXT)`,
    );
    sql(
      db,
      `CREATE TABLE issues (id INTEGER PRIMARY KEY AUTOINCREMENT, objective TEXT NOT NULL DEFAULT '',
         description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'open',
         created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    );
    sql(db, "INSERT INTO repos (name, path) VALUES ('plugin', ?)", join(sb.dir, 'registered'));
    sql(db, "INSERT INTO issues (objective) VALUES ('test')");
    for (const [branch, status] of [
      ['feat/open-task', 'pending'],
      ['feat/running-task', 'running'],
      ['feat/closed-task', 'closed'],
    ])
      sql(db, 'INSERT INTO tasks (issue_id, branch_id, status, description) VALUES (1, ?, ?, ?)', branch, status, `${status} task`);
  });

  const run = (cmd: string, cwd = sb.dir, dbPath = db) => gate(sb, 'stay-on-base-guard', bash(cmd), { cwd, db: dbPath });
  const fromWorktree = (cmd: string) => {
    const wt = join(sb.dir, '.claude/worktrees/my-task');
    mkdirSync(wt, { recursive: true });
    return run(cmd, wt);
  };

  it('non-Bash tool: silent pass', () =>
    silent(gate(sb, 'stay-on-base-guard', { tool_name: 'Edit', tool_input: { file_path: 'foo.ts' } }, { cwd: sb.dir, db }), 'non-Bash ignored'));

  it('non-checkout Bash command: silent pass', () => silent(run('ls -la'), 'ls passes through'));
  it('git status: silent pass', () => silent(run('git status'), 'git status not a branch switch'));

  it('DENY: git checkout <open-task-branch> from main checkout', () => {
    const out = run('git checkout feat/open-task');
    has(out, DENY, 'deny checkout of open task branch');
    has(out, 'main checkout stays on the base', 'error message teaches recovery');
    has(out, 'feat/open-task', 'branch name in message');
    has(out, `cd ${sb.dir}/registered/.claude/worktrees/open-task`, 'absolute <repos.path>/.claude/worktrees/<slug>, not cwd-relative');
  });

  it('DENY: git switch <running-task-branch> from main checkout', () =>
    has(run('git switch feat/running-task'), DENY, 'deny switch of running task branch'));

  it('ALLOW: git checkout <closed-task-branch>: closed tasks are not open', () =>
    silent(run('git checkout feat/closed-task'), 'closed task branch is not blocked'));

  it('ALLOW: git checkout dev: not a task branch', () => silent(run('git checkout dev'), 'base branch checkout not blocked'));
  it('ALLOW: git checkout -b feat/new-branch: new branch creation', () => silent(run('git checkout -b feat/new-branch'), 'new-branch creation allowed'));
  it('ALLOW: git switch -c feat/new-branch: new branch creation', () => silent(run('git switch -c feat/new-branch'), 'switch -c allowed'));

  it('ALLOW: git checkout -- path/to/file.ts: file restore, not a branch switch', () =>
    silent(run('git checkout -- path/to/file.ts'), 'file restore not a branch switch'));

  it('ALLOW: command run from inside a worktree (pwd signal)', () =>
    silent(fromWorktree('git checkout feat/open-task'), 'worktree CWD is excluded from guard'));

  it('ALLOW: command with cd worktree prefix', () =>
    silent(run(`cd ${sb.dir}/.claude/worktrees/my-task && git checkout feat/open-task`), 'cd into worktree prefix excluded'));

  it('ALLOW: no DB (not a TMB project)', () =>
    silent(run('git checkout feat/open-task', sb.dir, '/nonexistent-path/trajectory.db'), 'no DB = not TMB = allow'));

  it('GH 1196: ALLOW: heredoc mentioning git checkout <open-task-branch>', () =>
    silent(run(heredoc('git checkout feat/open-task')), 'heredoc content is not a switch'));

  describe('with linked worktrees', () => {
    let repo: string;
    beforeEach(() => {
      repo = join(sb.dir, 'repo');
      mkdirSync(repo);
      git(sb.env, repo, 'init', '-q', '-b', 'dev');
      git(sb.env, repo, 'commit', '-q', '--allow-empty', '-m', 'init');
      git(sb.env, repo, 'branch', 'feat/running-task');
      git(sb.env, repo, 'branch', 'feat/open-task');
      git(sb.env, repo, 'worktree', 'add', '-q', join(repo, '.claude/worktrees/running-task'), 'feat/running-task');
    });

    it('DENY ambiguous_git_target: bare switch to an open-task branch while worktrees exist', () => {
      const out = run('git checkout feat/open-task', repo);
      has(out, 'ambiguous_git_target', 'no dir and several checkouts: the real reason');
      has(out, 'Allowed form: git -C <path> checkout feat/open-task', 'the deny carries the remedy');
    });

    it("DENY: 'git -C <main> checkout <open-task-branch>' while worktrees exist", () =>
      has(run(`git -C ${repo} checkout feat/open-task`, join(repo, '.claude/worktrees/running-task')), 'belongs to open task', 'an explicit main dir decides, not the cwd'));

    it("DENY without a repos row: the worktree path is absolute under the statement's main checkout", () => {
      sql(db, 'DELETE FROM repos');
      has(run(`git -C ${repo} checkout feat/open-task`, '/'), `cd ${repo}/.claude/worktrees/open-task`, 'falls back to the main checkout of the statement dir');
    });
  });
});

describe('branch-up-to-date-with-remote l3', () => {
  const GATE = 'branch-up-to-date-with-remote';

  /** A main-only clone of a bare origin, pushed, with one commit. */
  function clone(dir: string): string {
    const origin = `${dir}-origin.git`;
    mkdirSync(dir, { recursive: true });
    git(sb.env, sb.dir, 'init', '-q', '--bare', origin);
    git(sb.env, dir, 'init', '-q', '-b', 'main');
    git(sb.env, dir, 'remote', 'add', 'origin', origin);
    commit(sb.env, dir, 'init', { 'README.md': 'init\n' });
    git(sb.env, dir, 'push', '-q', '-u', 'origin', 'main');
    return dir;
  }

  /** <branch> at HEAD, then main advanced and pushed past it. */
  function staleBranch(repo: string, branch: string): void {
    git(sb.env, repo, 'branch', branch, 'HEAD');
    commit(sb.env, repo, 'advance', { 'a.txt': 'x\n' });
    git(sb.env, repo, 'push', '-q', 'origin', 'main');
  }

  let work: string;
  let db: string;
  beforeEach(() => {
    work = clone(join(sb.dir, 'work'));
    db = newDb(work);
    insertRepo(db, 'fixture', work, 'main');
  });

  const run = (cmd: string, env?: NodeJS.ProcessEnv) => gate(sb, GATE, bash(cmd), { cwd: work, db, env });

  /** A second registered repo whose sib-stale branch is behind its own origin/main. */
  function sibling(): string {
    const sib = clone(join(sb.dir, 'sib'));
    staleBranch(sib, 'sib-stale');
    insertRepo(db, 'sib', sib, 'main');
    return sib;
  }

  it('non-worktree-add command: silent pass', () => silent(run('ls -la'), 'non-worktree ignored'));

  it('worktree-add with -B (branch-create form): pass through (sibling hook handles)', () =>
    silent(run('git worktree add -B foo .claude/worktrees/x HEAD'), 'branch-create variant skipped'));

  it('branch up-to-date with origin/main: pass', () => {
    git(sb.env, work, 'branch', 'fresh-branch', 'HEAD');
    silent(run('git worktree add .claude/worktrees/x fresh-branch'), 'up-to-date branch allowed');
  });

  it('branch behind origin/main: BLOCK', () => {
    staleBranch(work, 'stale-branch');
    const out = run('git worktree add .claude/worktrees/y stale-branch');
    has(out, DENY, 'deny on stale branch');
    has(out, 'behind origin/main', 'reason cites the gap');
  });

  it('TMB_ALLOW_STALE_BRANCH=1 bypass: pass even on stale branch', () => {
    staleBranch(work, 'stale-branch');
    silent(run('git worktree add .claude/worktrees/y stale-branch', { TMB_ALLOW_STALE_BRANCH: '1' }), 'env bypass works');
  });

  it('no DB (not a TMB project): pass', () => {
    staleBranch(work, 'stale-branch');
    renameSync(db, `${db}.bak`);
    const r = runGate(GATE, {
      cwd: work,
      input: JSON.stringify(bash('git worktree add .claude/worktrees/y stale-branch')),
      env: { ...without(gateEnv(sb, work), 'TRAJECTORY_DB_PATH'), CLAUDE_PROJECT_DIR: work },
    });
    renameSync(`${db}.bak`, db);
    silent(r.stdout + r.stderr, 'no DB allow');
  });

  it("branch doesn't exist locally: pass (let git's own error fire)", () =>
    silent(run('git worktree add .claude/worktrees/y nonexistent-branch-xyz'), 'missing branch passes through'));

  it('origin remote missing: pass (offline-friendly)', () => {
    staleBranch(work, 'stale-branch');
    git(sb.env, work, 'remote', 'remove', 'origin');
    silent(run('git worktree add .claude/worktrees/y stale-branch'), 'no origin = no check');
  });

  it("multi-repo: 'cd <sibling> && git worktree add <stale>' resolves the SIBLING and blocks", () => {
    const sib = sibling();
    const out = run(`cd ${sib} && git worktree add .claude/worktrees/z sib-stale`);
    has(out, DENY, "deny on the sibling's stale branch via cd target");
    has(out, 'behind origin/main', "reason cites the sibling's gap");
  });

  it('multi-repo: a fresh branch in the sibling passes (resolution is correct, not blanket-deny)', () => {
    const sib = sibling();
    git(sb.env, sib, 'branch', 'sib-fresh', 'origin/main');
    silent(run(`cd ${sib} && git worktree add .claude/worktrees/z2 sib-fresh`), 'up-to-date sibling branch allowed');
  });

  it('GH 1196: heredoc mentioning a worktree add of a stale branch: silent pass', () => {
    const sib = sibling();
    silent(run(heredoc(`cd ${sib} && git worktree add .claude/worktrees/z sib-stale`)), 'heredoc content is not a worktree add');
  });

  it("GH 1196: 'git -C <sibling> worktree add <stale>' resolves the sibling and blocks", () => {
    const sib = sibling();
    has(run(`git -C ${sib} worktree add .claude/worktrees/z3 sib-stale`), 'behind origin/main', 'the -C target decides the repo');
  });
});

describe('no-worktree-branch-create l3', () => {
  let db: string;
  beforeEach(() => {
    db = join(sb.dir, 'trajectory.db');
    sql(db, 'CREATE TABLE meta (k TEXT)');
  });

  const run = (tool: string, cmd: string, env?: NodeJS.ProcessEnv) =>
    gate(sb, 'no-worktree-branch-create', { tool_name: tool, tool_input: { command: cmd } }, { cwd: sb.dir, db, env });

  it('non-Bash tool: silent pass', () => silent(run('Edit', 'whatever'), 'non-Bash ignored'));
  it('Bash, non-worktree command: silent pass', () => silent(run('Bash', 'ls -la'), 'non-worktree command ignored'));

  it('git worktree add WITHOUT -b/-B (attach existing branch): silent pass', () =>
    silent(run('Bash', 'git worktree add .claude/worktrees/mywork fix/foo-bar'), 'attach-existing allowed'));

  it('git worktree add -b NAME path: BLOCK', () => {
    const out = run('Bash', 'git worktree add -b new/branch .claude/worktrees/x main');
    has(out, DENY, 'deny on -b');
    has(out, 'Branch authority belongs to bro', 'reason cites doctrine');
  });

  it('git worktree add -B NAME path: BLOCK', () => has(run('Bash', 'git worktree add -B fix/typo-foo .claude/worktrees/y HEAD'), DENY, 'deny on -B'));

  it('git worktree add --create-branch NAME path: BLOCK', () =>
    has(run('Bash', 'git worktree add --create-branch new .claude/worktrees/z HEAD'), DENY, 'deny on --create-branch'));

  it('TMB_ALLOW_WORKTREE_BRANCH_CREATE bypass: pass even on -B', () =>
    silent(run('Bash', 'git worktree add -B foo .claude/worktrees/x HEAD', { TMB_ALLOW_WORKTREE_BRANCH_CREATE: '1' }), 'env bypass works'));

  it('#2869: git worktree add --detach path branch: BLOCK', () => {
    const out = run('Bash', 'git worktree add --detach .claude/worktrees/x fix/foo');
    has(out, DENY, 'deny on --detach');
    has(out, 'strands SWE', 'reason cites #2869 doctrine');
  });

  it('#2869: git worktree add (no --detach): silent pass', () => silent(run('Bash', 'git worktree add .claude/worktrees/y fix/bar'), 'plain worktree add allowed'));

  it('#2869: TMB_ALLOW_WORKTREE_DETACH bypass: pass even with --detach', () =>
    silent(run('Bash', 'git worktree add --detach .claude/worktrees/x fix/foo', { TMB_ALLOW_WORKTREE_DETACH: '1' }), 'detach bypass works'));

  it('GH 1196: heredoc mentioning git worktree add -b: silent pass', () =>
    silent(run('Bash', heredoc('git worktree add -b foo .claude/worktrees/x')), 'heredoc content is not a worktree add'));

  it('GH 1196: git -C <repo> worktree add -b NAME path: BLOCK', () =>
    has(run('Bash', 'git -C /repo worktree add -b foo .claude/worktrees/x'), DENY, 'a -C-scoped branch-create still blocks'));

  it('no DB (not a TMB project): pass even on -B', () => {
    rmSync(db);
    silent(run('Bash', 'git worktree add -B foo .claude/worktrees/x HEAD'), 'no DB = not TMB = allow');
  });

  it('no DB (not a TMB project): pass even on --detach', () => {
    rmSync(db);
    silent(run('Bash', 'git worktree add --detach .claude/worktrees/x fix/foo'), 'no DB = not TMB = allow detach too');
  });
});

describe('require-feature-branch-active l3', () => {
  const GATE = 'require-feature-branch-active';

  /** A repo at <dir> on <branch> with one commit. */
  function repoAt(dir: string, branch: string): string {
    mkdirSync(dir, { recursive: true });
    git(sb.env, dir, 'init', '-q', '-b', branch);
    commit(sb.env, dir, 'init', { 'README.md': 'init\n' });
    return dir;
  }

  function insertTask(db: string, id: number, branch: string, opts: { parent?: string; spec?: string } = {}): void {
    sql(
      db,
      `INSERT INTO tasks (id, issue_id, branch_id, parent_branch_id, title, description, status, spec_body, repo, created_at, updated_at)
         VALUES (?, 1, ?, ?, ?, 'd', 'pending', ?, NULL, datetime('now'), datetime('now'))`,
      id,
      branch,
      opts.parent ?? null,
      `task ${id}`,
      opts.spec ?? '## body',
    );
  }

  const spawn = (agent: string, prompt: string) => ({ tool_input: { subagent_type: agent, prompt } });
  const run = (cwd: string, payload: unknown, db?: string, env?: NodeJS.ProcessEnv) => gate(sb, GATE, payload, { cwd, db, env });
  const deny = (out: string, msg: string) => has(out, DENY, msg);
  const allow = (out: string, msg: string) => hasNot(out, DENY, msg);

  describe('a dev repo with task 1 on fix/1-foo', () => {
    let repo: string;
    let db: string;
    beforeEach(() => {
      repo = repoAt(join(sb.dir, 'repo'), 'dev');
      db = newDb(repo);
    });

    it('happy path: branch exists, main on base: no block', () => {
      git(sb.env, repo, 'branch', 'fix/1-foo');
      insertTask(db, 1, 'fix/1-foo');
      allow(run(repo, spawn('swe', 'task_id=1 You are SWE.'), db), 'branch exists (main stays on base) must not be blocked');
    });

    it('branch missing blocks: task expects fix/1-foo but it was never created', () => {
      insertTask(db, 1, 'fix/1-foo');
      const out = run(repo, spawn('swe', 'task_id=1 You are SWE.'), db);
      deny(out, 'missing branch must produce deny decision');
      has(out, 'fix/1-foo', 'block message must name the expected branch');
      has(out, 'exist', 'block message must say the branch must exist');
    });

    it('remoteless repo: missing-branch remedy prescribes the plain local base, no origin/', () => {
      insertTask(db, 1, 'fix/1-foo', { parent: 'dev' });
      const out = run(repo, spawn('swe', 'task_id=1 You are SWE.'), db);
      deny(out, 'missing branch must produce deny decision');
      has(out, 'branch fix/1-foo dev', 'remoteless remedy must prescribe the plain local base (parent branch)');
      hasNot(out, 'origin/', 'remoteless remedy must NOT reference origin/');
    });

    it('with-remote repo: missing-branch remedy keeps the origin/<base> form', () => {
      git(sb.env, repo, 'remote', 'add', 'origin', 'https://example.com/foo.git');
      insertTask(db, 1, 'fix/1-foo', { parent: 'dev' });
      const out = run(repo, spawn('swe', 'task_id=1 You are SWE.'), db);
      deny(out, 'missing branch must produce deny decision');
      has(out, 'branch fix/1-foo origin/dev', 'with-remote remedy must keep the origin/<base> form');
    });

    it('non-swe agent passes: architect bypasses the hook', () => {
      insertTask(db, 1, 'fix/1-foo');
      allow(run(repo, spawn('architect', 'task_id=1 You are architect.'), db), 'non-swe agent must not be blocked');
    });

    it('no task_id in prompt passes: require-task-spec handles it', () => {
      insertTask(db, 1, 'fix/1-foo');
      allow(run(repo, spawn('swe', 'You are SWE but no task_id here.'), db), 'missing task_id must not be blocked by this hook');
    });

    it('missing DB passes: not a TMB project', () =>
      allow(run(repo, spawn('swe', 'task_id=1 You are SWE.'), '/nonexistent/trajectory.db'), 'missing DB must not block'));

    it('bypass env var passes: TMB_ALLOW_BRANCH_MISMATCH=1 overrides block', () => {
      insertTask(db, 1, 'fix/1-foo');
      allow(run(repo, spawn('swe', 'task_id=1 You are SWE.'), db, { TMB_ALLOW_BRANCH_MISMATCH: '1' }), 'bypass env var must suppress block even on mismatch');
    });
  });

  describe('TMB workspace shape: tasks.repo=null', () => {
    let ws: string;
    let wsDb: string;
    let inner: string;
    beforeEach(() => {
      ws = join(sb.dir, 'workspace');
      inner = repoAt(join(ws, 'plugin'), 'fix/1-foo');
      wsDb = newDb(ws);
      insertRepo(wsDb, 'plugin', inner, null);
    });

    it('single-repo fallback (one registered repo) + branch exists: passes', () => {
      insertTask(wsDb, 10, 'fix/1-foo', { spec: '' });
      allow(run(inner, spawn('swe', 'task_id=10 You are SWE.'), wsDb), 'single-repo fallback + branch exists must not block');
    });

    it('no single-repo fallback (two repos) + no .git at workspace root: blocks with clear error', () => {
      const sibling = repoAt(join(ws, 'sibling'), 'main');
      insertRepo(wsDb, 'sibling', sibling, null);
      insertTask(wsDb, 11, 'fix/1-foo', { spec: '' });
      const out = run(ws, spawn('swe', 'task_id=11 You are SWE.'), wsDb);
      deny(out, 'multi-repo with no task.repo and no .git at workspace root must block');
      has(out, 'tasks.repo IS NULL', 'block message must explain the unresolved-repo cause');
      has(out, 'Allowed form: task_create with repo=<name>', "block message must suggest setting the task's repo");
      hasNot(out, 'tmb_default_repo', 'block message must NOT mention the retired tmb_default_repo key');
    });
  });
});
