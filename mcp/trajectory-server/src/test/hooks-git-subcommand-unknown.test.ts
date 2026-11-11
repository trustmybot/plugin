/**
 * Every git guard reads git's subcommand allowlist-style (GH 2641), as
 * git-push-guard does (GH 2634): a git statement whose subcommand word, or a
 * git option word before it, is an expansion (`git $p`, `git "$@"`,
 * `git ${p}out`) is denied as `ambiguous_git_subcommand` in the scope where
 * the guard judges a literal statement of its kind, and admitted outside it.
 * An expansion in a value-taking option's argument (`git -C "$wt" status`)
 * leaves the subcommand known.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ambiguousSubcommandReason, gitBesideExpansion } from '../hooks/cmd-analysis/index.js';
import type { Gate } from '../hooks/gate.js';
import { branchUpToDateWithRemote } from '../hooks/branch-up-to-date-with-remote.js';
import { gitGuards, needsGitGuard } from '../hooks/git-guards.js';
import { gitPushGuard } from '../hooks/git-push-guard.js';
import { noWorktreeBranchCreate } from '../hooks/no-worktree-branch-create.js';
import { stayOnBaseGuard } from '../hooks/stay-on-base-guard.js';
import { sweBoundary } from '../hooks/swe-boundary.js';
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

const PUSH_REASON =
  "BLOCKED: ambiguous_git_subcommand: `git $p origin dev` takes git's subcommand, or an option before it, from an expansion, a pattern or a redirect the guard cannot resolve, so it cannot tell whether the statement pushes. Write the subcommand and git's options before it literally. An option value in double quotes, such as `git -C \"$W\" status`, is allowed. Allowed form: git -C <path> push …, or the literal subcommand it runs";

function git(dir: string, ...args: string[]): void {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: GIT_ENV });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
}

function reason(stdout: string): string {
  if (stdout === '') return '';
  const out = JSON.parse(stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  return out.hookSpecificOutput.permissionDecisionReason;
}

interface Case {
  name: string;
  gate: Gate;
  verb: string;
  fix: string;
  /** The three unknown shapes, each with the statement its deny names. */
  unknown: ReadonlyArray<readonly [string, string]>;
  /** Literal forms the guard admits in scope. */
  admitted: readonly string[];
}

describe('git guards deny a git subcommand they cannot read literally (GH 2641)', () => {
  let dir: string;
  let main: string;
  let other: string;
  let db: string;
  const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => {
    const e: NodeJS.ProcessEnv = { ...GIT_ENV, CLAUDE_PROJECT_DIR: dir, TRAJECTORY_DB_PATH: db, wt: main };
    delete e.TMB_HOOKS_SQLITE;
    delete e.TMB_ALLOW_STALE_BRANCH;
    return { ...e, ...extra };
  };
  const noDb = () => env({ TRAJECTORY_DB_PATH: join(dir, 'none.db') });
  const run = async (gate: Gate, command: string, cwd: string, e: NodeJS.ProcessEnv, role?: string): Promise<string> =>
    reason((await gate(JSON.stringify({ tool_name: 'Bash', cwd, tool_input: { command }, ...(role ? { agent_type: role } : {}) }), e)).stdout);

  before(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-gh2641-')));
    main = join(dir, 'main');
    other = join(dir, 'other');
    for (const repo of [main, other]) {
      mkdirSync(repo);
      git(repo, 'init', '-q', '-b', 'main');
      writeFileSync(join(repo, 'README.md'), 'x\n');
      git(repo, 'add', '-A');
      git(repo, 'commit', '-qm', 'init');
    }
    spawnSync('git', ['init', '-q', '--bare', '-b', 'main', join(dir, 'origin.git')], { env: GIT_ENV });
    git(main, 'remote', 'add', 'origin', join(dir, 'origin.git'));
    git(main, 'push', '-q', '-u', 'origin', 'main');
    git(main, 'branch', 'dev');
    mkdirSync(join(main, '.claude/worktrees/t'), { recursive: true });
    db = join(dir, 'trajectory.db');
    const d = new DatabaseSync(db);
    d.exec(SCHEMA);
    d.prepare("INSERT INTO repos (name, path, target_branch, branching_model, protected_branches) VALUES ('main', ?, 'main', 'github-flow', '[\"main\"]')").run(main);
    d.close();
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const cases: Case[] = [
    {
      name: 'git-guards',
      gate: gitGuards,
      verb: 'commits, merges, rebases, cherry-picks, pushes or creates a branch',
      fix: 'git -C <path> <subcommand> …, the subcommand written literally',
      unknown: [
        ['p=commit; git $p -m x', 'git $p -m x'],
        ['git "$@"', 'git "$@"'],
        ['git ${p}mit -m x', 'git ${p}mit -m x'],
        ['p=merge; git $p dev', 'git $p dev'],
      ],
      admitted: ['git status', 'git -C "$wt" status', 'git log --oneline -1'],
    },
    {
      name: 'stay-on-base-guard',
      gate: stayOnBaseGuard,
      verb: 'switches the checkout to another branch',
      fix: 'git -C <path> checkout <branch> or git -C <path> switch <branch>, the subcommand written literally',
      unknown: [
        ['p=checkout; git $p dev', 'git $p dev'],
        ['git "$@"', 'git "$@"'],
        ['git ${p}out dev', 'git ${p}out dev'],
      ],
      admitted: ['git checkout dev', 'git switch dev', 'git -C "$wt" status'],
    },
    {
      name: 'no-worktree-branch-create',
      gate: noWorktreeBranchCreate,
      verb: 'adds a worktree',
      fix: 'git -C <path> worktree add <path> <branch>, the subcommand written literally',
      unknown: [
        ['p=worktree; git $p add ../x dev', 'git $p add ../x dev'],
        ['git "$@"', 'git "$@"'],
        ['git ${p}tree add ../x dev', 'git ${p}tree add ../x dev'],
      ],
      admitted: ['git worktree add ../x dev', 'git -C "$wt" worktree list'],
    },
    {
      name: 'branch-up-to-date-with-remote',
      gate: branchUpToDateWithRemote,
      verb: 'adds a worktree',
      fix: 'git -C <path> worktree add <path> <branch>, the subcommand written literally',
      unknown: [
        ['p=worktree; git $p add ../x dev', 'git $p add ../x dev'],
        ['git "$@"', 'git "$@"'],
        ['git ${p}tree add ../x dev', 'git ${p}tree add ../x dev'],
      ],
      admitted: ['git worktree add ../x dev', 'git -C "$wt" worktree list'],
    },
  ];

  for (const c of cases) {
    it(`${c.name} denies each unknown shape in scope with the ambiguous_git_subcommand reason`, async () => {
      for (const [command, what] of c.unknown) {
        assert.equal(await run(c.gate, command, main, env()), `${ambiguousSubcommandReason(what, c.verb)} Allowed form: ${c.fix}`, command);
      }
    });

    it(`${c.name} admits its literal forms${c.gate === gitGuards ? '' : ', and the unknown shapes with no DB'}`, async () => {
      for (const command of c.admitted) assert.equal(await run(c.gate, command, main, env()), '', command);
      if (c.gate === gitGuards) return;
      for (const [command] of c.unknown) assert.equal(await run(c.gate, command, main, noDb()), '', command);
    });
  }

  it('git-guards judges a repo with no DB on its default policy, an unknown shape as a literal commit', async () => {
    assert.match(await run(gitGuards, 'git commit -m x', main, noDb()), /^BLOCKED: main is a shared workflow base/);
    assert.match(await run(gitGuards, 'p=commit; git $p -m x', main, noDb()), /^BLOCKED: ambiguous_git_subcommand: /);
  });

  it('git-guards admits the unknown shapes in a repo the DB does not register, and outside any repo', async () => {
    for (const [command] of cases[0].unknown) {
      assert.equal(await run(gitGuards, command, other, env()), '', command);
      assert.equal(await run(gitGuards, command, dir, env()), '', command);
    }
  });

  it('git-guards counts no unknown statement as a read beside a fast-forward sync', async () => {
    assert.equal(await run(gitGuards, 'git fetch origin && git merge --ff-only @{u}', main, env()), '');
    assert.match(await run(gitGuards, 'git merge --ff-only @{u} && git $p', main, env()), /^BLOCKED: local merge\/rebase\/cherry-pick in the main checkout/);
  });

  it('stay-on-base-guard admits the unknown shapes in a .claude/worktrees/ dir', async () => {
    for (const [command] of cases[1].unknown) assert.equal(await run(stayOnBaseGuard, command, join(main, '.claude/worktrees/t'), env()), '', command);
  });

  it('branch-up-to-date-with-remote admits the unknown shapes under TMB_ALLOW_STALE_BRANCH=1', async () => {
    for (const [command] of cases[3].unknown) assert.equal(await run(branchUpToDateWithRemote, command, main, env({ TMB_ALLOW_STALE_BRANCH: '1' })), '', command);
  });

  describe('swe-boundary', () => {
    const verb = 'pushes';
    const fix = 'git -C <path> <subcommand> …, the subcommand written literally';
    const unknown: ReadonlyArray<readonly [string, string]> = [
      ['p=push; git $p origin dev', 'git $p origin dev'],
      ['git "$@"', 'git "$@"'],
      ['git ${p}sh origin dev', 'git ${p}sh origin dev'],
    ];

    it("denies each unknown shape in an swe's Bash", async () => {
      for (const [command, what] of unknown) {
        assert.equal(await run(sweBoundary, command, main, noDb(), 'swe'), `${ambiguousSubcommandReason(what, verb)} Allowed form: ${fix}`, command);
      }
    });

    it("admits its literal forms for an swe, denies the unknown shapes in a code-reviewer's Bash, and admits them with no role", async () => {
      for (const command of ['git status', 'git -C "$wt" status', 'git commit -m x']) assert.equal(await run(sweBoundary, command, main, noDb(), 'swe'), '', command);
      for (const [command, what] of unknown) {
        assert.equal(await run(sweBoundary, command, main, noDb()), '', command);
        assert.equal(
          await run(sweBoundary, command, main, noDb(), 'code-reviewer'),
          `${ambiguousSubcommandReason(what, 'writes the git stash')} Allowed form: ${fix}`,
          command,
        );
      }
    });
  });

  it("git-push-guard's deny text is unchanged", async () => {
    assert.equal(await run(gitPushGuard, 'p=push; git $p origin dev', main, noDb()), PUSH_REASON);
  });

  it('the keyword prefilters read the command unquoted, so a quoted git word or subcommand is judged', async () => {
    assert.match(await run(gitGuards, "'git' commit -m x", main, env()), /^BLOCKED: main is a shared workflow base/);
    assert.match(await run(gitGuards, 'g""it commit -m x', main, env()), /^BLOCKED: main is a shared workflow base/);
    assert.match(await run(noWorktreeBranchCreate, "git work''tree add -b x ../x", main, env()), /^BLOCKED: `git worktree add` cannot create a branch/);
    const open = (sql: string) => {
      const d = new DatabaseSync(db);
      d.exec(sql);
      d.close();
    };
    open(
      "INSERT INTO issues (id, objective, created_at, updated_at) VALUES (9001, 'o', 'now', 'now'); INSERT INTO tasks (id, issue_id, title, description, status, branch_id, created_at, updated_at) VALUES (9001, 9001, 't', '', 'running', 'dev', 'now', 'now');",
    );
    try {
      for (const command of ['git checkout dev', "git che''ckout dev", 'git sw"it"ch dev']) {
        assert.match(await run(stayOnBaseGuard, command, main, env()), /^BLOCKED: the main checkout stays on the base|^the main checkout stays on the base/, command);
      }
    } finally {
      open('DELETE FROM tasks WHERE id = 9001; DELETE FROM issues WHERE id = 9001;');
    }
  });

  it('the keyword prefilters let a git word beside an expansion through to parsing', () => {
    for (const command of ['git ${p}out dev', "'git' $p", 'git \\\n"$@"', '/usr/bin/git $p']) assert.equal(gitBesideExpansion(command), true, command);
    for (const command of ['git status', 'legit $p', 'echo $p']) assert.equal(gitBesideExpansion(command), false, command);
    assert.equal(needsGitGuard("'git' $p"), true);
    assert.equal(needsGitGuard('cat .git/config'), false);
  });
});
