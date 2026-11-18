/**
 * The git branch gates read git run through xargs, whose input adds words to
 * git's arguments (GH 2144, GH 2850), and git behind a wrapper the listing
 * stripped with a non-literal word, `env $X git …` (GH 2808): each gate
 * denies such a statement among the subcommands it judges once its DB
 * resolves, and admits the literal forms it admitted before.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ambiguousSubcommandReason, cmdStatements, gitBehindXargs, gitFedByXargs, lineWrappers, xargsArgumentsReason, xargsInputSlot } from '../hooks/cmd-analysis/index.js';
import type { Gate } from '../hooks/gate.js';
import { branchUpToDateWithRemote } from '../hooks/branch-up-to-date-with-remote.js';
import { gitGuards } from '../hooks/git-guards.js';
import { noWorktreeBranchCreate } from '../hooks/no-worktree-branch-create.js';
import { stayOnBaseGuard } from '../hooks/stay-on-base-guard.js';
import { PLUGIN_ROOT } from './hook-sandbox.js';

const SCHEMA = readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema.sql'), 'utf8');
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};
const TASK_BRANCH = 'feat/xargs-task';
const REPO_LABEL = '(repo main, mode truest)';
const GIT_TIMEOUT_MS = 30_000;

function git(dir: string, ...args: string[]): void {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: GIT_ENV, timeout: GIT_TIMEOUT_MS });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
}

function reason(stdout: string): string {
  if (stdout === '') return '';
  const out = JSON.parse(stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  return out.hookSpecificOutput.permissionDecisionReason;
}

describe('git branch gates read git fed by xargs or behind a non-literal wrapper (GH 2144, GH 2850, GH 2808)', () => {
  let dir: string;
  let main: string;
  let other: string;
  let wt: string;
  let db: string;
  const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => {
    const e: NodeJS.ProcessEnv = { ...GIT_ENV, CLAUDE_PROJECT_DIR: dir, TRAJECTORY_DB_PATH: db };
    delete e.TMB_HOOKS_SQLITE;
    delete e.TMB_ALLOW_STALE_BRANCH;
    delete e.TMB_ALLOW_WORKTREE_BRANCH_CREATE;
    delete e.TMB_ALLOW_WORKTREE_DETACH;
    return { ...e, ...extra };
  };
  const noDb = () => env({ TRAJECTORY_DB_PATH: join(dir, 'none.db') });
  const run = async (gate: Gate, command: string, cwd: string, e: NodeJS.ProcessEnv, role?: string): Promise<string> =>
    reason((await gate(JSON.stringify({ tool_name: 'Bash', cwd, tool_input: { command }, ...(role ? { agent_type: role } : {}) }), e)).stdout);

  before(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-gh2850-')));
    main = join(dir, 'main');
    other = join(dir, 'other');
    for (const repo of [main, other]) {
      mkdirSync(repo);
      git(repo, 'init', '-q', '-b', 'main');
      writeFileSync(join(repo, 'README.md'), 'x\n');
      git(repo, 'add', '-A');
      git(repo, 'commit', '-qm', 'init');
    }
    git(dir, 'init', '-q', '--bare', '-b', 'main', join(dir, 'origin.git'));
    git(main, 'remote', 'add', 'origin', join(dir, 'origin.git'));
    git(main, 'push', '-q', '-u', 'origin', 'main');
    git(main, 'branch', 'dev');
    git(main, 'branch', TASK_BRANCH);
    wt = join(main, '.claude/worktrees/xargs-task');
    git(main, 'worktree', 'add', '-q', wt, TASK_BRANCH);
    db = join(dir, 'trajectory.db');
    const d = new DatabaseSync(db);
    d.exec(SCHEMA);
    d.prepare("INSERT INTO repos (name, path, target_branch, branching_model, protected_branches) VALUES ('main', ?, 'main', 'github-flow', '[\"main\"]')").run(main);
    d.exec(
      `INSERT INTO issues (id, objective, created_at, updated_at) VALUES (9101, 'o', 'now', 'now');
       INSERT INTO tasks (id, issue_id, title, description, status, branch_id, created_at, updated_at) VALUES (9101, 9101, 't', '', 'running', '${TASK_BRANCH}', 'now', 'now');`,
    );
    d.close();
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('the git.ts readers', () => {
    it('gitFedByXargs reads xargs before git, in the statement or its stripped wrappers', () => {
      assert.equal(gitFedByXargs('xargs git checkout'), true);
      assert.equal(gitFedByXargs('xargs -n1 git -C /m branch'), true);
      assert.equal(gitFedByXargs({ stmt: 'xargs git checkout', wrappers: 'env' }), true);
      assert.equal(gitFedByXargs('git checkout dev'), false);
      assert.equal(gitFedByXargs({ stmt: 'git checkout -b x', wrappers: 'env FOO=1' }), false);
      assert.equal(gitFedByXargs('xargs echo git'), false);
    });

    it('xargsInputSlot reads where xargs puts its input: appended, or in place of the replace string', () => {
      assert.equal(xargsInputSlot('git checkout --'), undefined);
      assert.equal(xargsInputSlot('xargs -n1 git checkout --'), 'append');
      assert.equal(xargsInputSlot({ stmt: 'xargs git branch -d', wrappers: 'env' }), 'append');
      assert.deepEqual(xargsInputSlot('xargs -I{} git checkout -- {}'), { replace: '{}' });
      assert.deepEqual(xargsInputSlot('xargs -I %% git checkout -- %%'), { replace: '%%' });
      assert.deepEqual(xargsInputSlot('xargs -0I@ git checkout -- @'), { replace: '@' });
      assert.deepEqual(xargsInputSlot('xargs -i git checkout -- {}'), { replace: '{}' });
      assert.deepEqual(xargsInputSlot('xargs --replace=X git checkout -- X'), { replace: 'X' });
    });

    it('lineWrappers gives each statement-starting line its wrappers', async () => {
      const listed = await cmdStatements('env $X git commit -F - <<EOF\nmsg\nEOF\nenv $Y git status', main, env());
      assert.ok(listed.ok);
      const wrappers = lineWrappers(listed.statements);
      assert.equal(wrappers[0], 'env');
      assert.equal(wrappers[wrappers.length - 1], 'env');
      assert.ok(wrappers.slice(1, -1).every((w) => w === undefined));
    });

    it('gitBehindXargs hands a command naming xargs and git to parsing', () => {
      for (const command of ['cat f | xargs git', 'echo b | xargs -n1 git -C /m checkout', "printf x | 'xargs' g''it"]) assert.equal(gitBehindXargs(command), true, command);
      for (const command of ['git status', 'ls | xargs rm', 'echo xargs']) assert.equal(gitBehindXargs(command), false, command);
    });
  });

  describe('git-guards (SC1)', () => {
    const fix = 'git -C <path> checkout -b <branch> or git -C <path> switch -c <branch>, the branch written literally';
    const denies = (stmt: string) => `${xargsArgumentsReason(stmt, 'creates a branch')} ${REPO_LABEL} Allowed form: ${fix}`;

    it('denies a checkout -b, switch -c or branch whose name xargs supplies', async () => {
      for (const sub of ['checkout -b', 'switch -c', 'branch', 'checkout']) {
        const stmt = `xargs git -C ${main} ${sub}`;
        assert.equal(await run(gitGuards, `echo zzfoo | ${stmt}`, main, env()), denies(stmt), sub);
      }
    });

    it('denies a checkout -B, switch -C, branch rename or checkout whose fed word lands before `--`', async () => {
      for (const stmt of [
        `xargs git -C ${main} checkout -B`,
        `xargs git -C ${main} switch -C`,
        `xargs git -C ${main} branch -m`,
        `xargs git -C ${main} checkout main`,
        `xargs -I% git -C ${main} checkout % -- README.md`,
      ]) {
        assert.equal(await run(gitGuards, `echo zzfoo | ${stmt}`, main, env()), denies(stmt), stmt);
      }
    });

    it('admits an xargs checkout that feeds only pathspecs and an xargs branch delete or list (F111-1)', async () => {
      for (const [cwd, d] of [[main, main], [wt, wt]]) {
        for (const command of [
          `git -C ${d} diff --name-only | xargs git -C ${d} checkout --`,
          `git -C ${d} diff --name-only | xargs git -C ${d} checkout HEAD --`,
          `git -C ${d} ls-files | xargs -I% git -C ${d} checkout -- %`,
          `git -C ${d} branch --merged | grep -v main | xargs git -C ${d} branch -d`,
          `git -C ${d} branch --merged | grep -v main | xargs git -C ${d} branch -D`,
          `echo origin/x | xargs git -C ${d} branch -dr`,
          `echo 'feat/*' | xargs git -C ${d} branch --list`,
        ]) {
          assert.equal(await run(gitGuards, command, cwd, env()), '', command);
        }
      }
    });

    it('admits the literal new-branch form, through xargs too, and an xargs read', async () => {
      for (const command of [`git -C ${main} checkout -b x`, `echo y | xargs git -C ${main} checkout -b x`, 'echo HEAD | xargs git status', `env FOO=1 git -C ${main} checkout -b x`]) {
        assert.equal(await run(gitGuards, command, main, env()), '', command);
      }
    });

    it('admits the xargs forms in a repo the DB does not register', async () => {
      assert.equal(await run(gitGuards, `echo zzfoo | xargs git -C ${other} checkout -b`, other, env()), '');
    });

    it('reads no merge run through xargs as a sync with its own upstream', async () => {
      assert.equal(await run(gitGuards, `git -C ${main} merge --ff-only @{u}`, main, env()), '');
      assert.match(await run(gitGuards, `echo dev | xargs git -C ${main} merge --ff-only @{u}`, main, env()),/^BLOCKED: local merge\/rebase\/cherry-pick in the main checkout/);
    });

    it('denies env $X git on a statement that spans lines', async () => {
      assert.match(await run(gitGuards, `env $X git -C ${main} commit -F - <<EOF\nmsg\nEOF`, main, env()), /^BLOCKED: ambiguous_git_subcommand: /);
    });
  });

  describe('stay-on-base-guard (SC2)', () => {
    const verb = 'switches the checkout to another branch';

    it('denies a switch whose branch xargs supplies, and env $X git', async () => {
      const stmt = `xargs git -C ${main} checkout`;
      assert.equal(
        await run(stayOnBaseGuard, `echo ${TASK_BRANCH} | ${stmt}`, main, env()),
        `${xargsArgumentsReason(stmt, verb)} Allowed form: git -C <path> checkout <branch> or git -C <path> switch <branch>, the branch written literally`,
      );
      assert.equal(
        await run(stayOnBaseGuard, `env $X git -C ${main} checkout ${TASK_BRANCH}`, main, env()),
        `${ambiguousSubcommandReason(`$X git -C ${main} checkout ${TASK_BRANCH}`, verb)} Allowed form: git -C <path> checkout <branch> or git -C <path> switch <branch>, the subcommand written literally`,
      );
    });

    it('admits the literal forms, the xargs form in a worktree and with no DB', async () => {
      assert.match(await run(stayOnBaseGuard, `git -C ${main} checkout ${TASK_BRANCH}`, main, env()), /the main checkout stays on the base/);
      for (const command of [`git -C ${main} checkout main`, 'echo x | xargs git status', `echo x | xargs git -C ${main} checkout -b`, `env FOO=1 git -C ${main} checkout -b x`]) {
        assert.equal(await run(stayOnBaseGuard, command, main, env()), '', command);
      }
      assert.equal(await run(stayOnBaseGuard, `echo ${TASK_BRANCH} | xargs git checkout`, wt, env()), '');
      assert.equal(await run(stayOnBaseGuard, `echo ${TASK_BRANCH} | xargs git -C ${main} checkout`, main, noDb()), '');
    });

    it('parses an xargs git that names no checkout keyword', async () => {
      assert.match(await run(stayOnBaseGuard, `cat list | xargs git -C ${main}`, main, env()), /^BLOCKED: ambiguous_git_subcommand: /);
    });
  });

  describe('no-worktree-branch-create (SC2)', () => {
    it('denies env $X git in a worktree for swe', async () => {
      assert.equal(
        await run(noWorktreeBranchCreate, `env $X git -C ${wt} checkout -b x`, wt, env(), 'swe'),
        `${ambiguousSubcommandReason(`$X git -C ${wt} checkout -b x`, 'adds a worktree')} Allowed form: git -C <path> worktree add <path> <branch>, the subcommand written literally`,
      );
    });

    it('denies a worktree add whose flags xargs may supply, unless both bypasses are set', async () => {
      const stmt = `xargs git -C ${wt} worktree add ../p`;
      const denied = `${xargsArgumentsReason(stmt, 'adds a worktree that creates a branch or detaches HEAD')} Allowed form: git -C <path> worktree add <path> <branch>, its arguments written literally`;
      assert.equal(await run(noWorktreeBranchCreate, `echo x | ${stmt}`, wt, env(), 'swe'), denied);
      assert.equal(await run(noWorktreeBranchCreate, `echo x | ${stmt}`, wt, env({ TMB_ALLOW_WORKTREE_BRANCH_CREATE: '1' }), 'swe'), denied);
      assert.equal(await run(noWorktreeBranchCreate, `echo x | ${stmt}`, wt, env({ TMB_ALLOW_WORKTREE_BRANCH_CREATE: '1', TMB_ALLOW_WORKTREE_DETACH: '1' }), 'swe'), '');
      assert.match(await run(noWorktreeBranchCreate, `echo add ../p b | xargs git -C ${wt} worktree`, wt, env(), 'swe'), /^BLOCKED: ambiguous_git_arguments: /);
    });

    it('admits the literal forms and the xargs forms with no DB', async () => {
      for (const command of [`git -C ${wt} worktree add ../p ${TASK_BRANCH}`, 'echo x | xargs git status', `echo x | xargs git -C ${wt} worktree list`, `env FOO=1 git -C ${wt} checkout -b x`]) {
        assert.equal(await run(noWorktreeBranchCreate, command, wt, env(), 'swe'), '', command);
      }
      assert.equal(await run(noWorktreeBranchCreate, `echo x | xargs git -C ${wt} worktree add ../p`, wt, noDb(), 'swe'), '');
    });
  });

  describe('branch-up-to-date-with-remote (SC3)', () => {
    it('denies a worktree add whose branch xargs supplies, and env $X git', async () => {
      const stmt = `xargs git -C ${main} worktree add ${join(dir, 'p')}`;
      assert.equal(
        await run(branchUpToDateWithRemote, `echo dev | ${stmt}`, main, env()),
        `${xargsArgumentsReason(stmt, 'adds a worktree on a branch behind its base')} Allowed form: git -C <path> worktree add <path> <branch>, the branch written literally`,
      );
      const wrapped = `$X git -C ${main} worktree add ${join(dir, 'p')} dev`;
      assert.equal(
        await run(branchUpToDateWithRemote, `env ${wrapped}`, main, env()),
        `${ambiguousSubcommandReason(wrapped, 'adds a worktree')} Allowed form: git -C <path> worktree add <path> <branch>, the subcommand written literally`,
      );
    });

    it('admits the literal form, a new branch through xargs, no DB and the bypass', async () => {
      const add = `xargs git -C ${main} worktree add ${join(dir, 'p')}`;
      assert.equal(await run(branchUpToDateWithRemote, `git -C ${main} worktree add ${join(dir, 'p')} dev`, main, env()), '');
      assert.equal(await run(branchUpToDateWithRemote, `echo nb | xargs git -C ${main} worktree add -b`, main, env()), '');
      assert.equal(await run(branchUpToDateWithRemote, `echo dev | ${add}`, main, noDb()), '');
      assert.equal(await run(branchUpToDateWithRemote, `echo dev | ${add}`, main, env({ TMB_ALLOW_STALE_BRANCH: '1' })), '');
    });
  });
});
