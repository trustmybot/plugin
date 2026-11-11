/**
 * Every keyword prefilter reads past a line continuation and a `$'…'` word
 * (GH 2758): a keyword split by a backslash-newline (`gh auth lo\` then `gin`)
 * or written in ANSI-C quoting (`$'\x6cogin'`, `$'\x67it' push`) reaches the
 * analyzer, which joins and decodes it, so each gate gives the verdict it
 * gives the plain command. A command with neither the keyword nor `$'` still
 * takes the fast-path ALLOW.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdStatements, prefilterPasses, type GitStatements } from '../hooks/cmd-analysis/index.js';
import type { Gate, GateResult } from '../hooks/gate.js';
import { branchUpToDateWithRemote } from '../hooks/branch-up-to-date-with-remote.js';
import { gitGuards, needsGitGuard } from '../hooks/git-guards.js';
import { gitPushGuard, SWE_PUSH_REASON } from '../hooks/git-push-guard.js';
import { noRemoteAuthGuard } from '../hooks/no-remote-auth-guard.js';
import { noWorktreeBranchCreate } from '../hooks/no-worktree-branch-create.js';
import { REAL_SEAMS, refMoveReindexWith, type RepoStamp } from '../hooks/ref-move-reindex.js';
import { remoteIdGuard } from '../hooks/remote-id-guard.js';
import { stayOnBaseGuard } from '../hooks/stay-on-base-guard.js';
import { buildSandbox } from './hooks-git-branch-guards-parity.suite.js';
import { localIssuesDb } from './hooks-remote-id-guard-parity.suite.js';

function verdict(r: GateResult): string {
  assert.equal(r.code, 0);
  if (r.stdout === '') return '';
  const out = JSON.parse(r.stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  return out.hookSpecificOutput.permissionDecisionReason;
}

const bash = (command: string, cwd: string, role?: string): string =>
  JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd, ...(role ? { agent_type: role } : {}) });

describe('prefilterPasses (GH 2758)', () => {
  const login = (text: string) => text.includes('login');
  it('passes a keyword as written, split by a line continuation or by quotes, and any $\' word', () => {
    for (const command of ['gh auth login', 'gh auth lo\\\ngin', "gh auth lo''gin", "gh auth $'\\x6cogin'", "echo $'hi'"]) {
      assert.equal(prefilterPasses(command, login), true, command);
    }
  });
  it('fails a command holding neither the keyword nor $\'', () => {
    for (const command of ['echo hi', 'git status', 'gh auth status', 'echo $HOME', 'echo "it\'s"']) assert.equal(prefilterPasses(command, login), false, command);
  });
  it("needsGitGuard passes $'\\x67it', where no git word is visible, and still skips a command with none", () => {
    assert.equal(needsGitGuard("$'\\x67it' commit -m x"), true);
    assert.equal(needsGitGuard('echo hi'), false);
    assert.equal(needsGitGuard('cat .git/config'), false);
  });
});

describe('the gates judge a keyword behind a line continuation or $\'…\' as the plain command (GH 2758)', () => {
  let base: string;
  let s: string;
  let bin: string;
  let issuesDb: string;
  before(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-gh2758-')));
    s = join(base, 'sandbox');
    mkdirSync(s);
    buildSandbox(s);
    bin = join(base, 'bin');
    mkdirSync(bin);
    symlinkSync(spawnSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim(), join(bin, 'git'));
    issuesDb = join(base, 'issues/trajectory.db');
    localIssuesDb(issuesDb);
  });
  after(() => rmSync(base, { recursive: true, force: true }));

  const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    HOME: join(s, 'home'),
    CLAUDE_PROJECT_DIR: join(s, 'project'),
    TRAJECTORY_DB_PATH: join(s, 'trajectory.db'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    PATH: bin,
    LC_ALL: 'C',
    ...extra,
  });

  interface Case {
    name: string;
    gate: Gate;
    cwd: string;
    role?: string;
    plain: string;
    hidden: readonly string[];
  }

  const cases: Case[] = [
    { name: 'no-remote-auth-guard', gate: noRemoteAuthGuard, cwd: 'stale', plain: 'gh auth login', hidden: ['gh auth lo\\\ngin', "gh auth $'\\x6cogin'"] },
    {
      name: 'git-guards',
      gate: gitGuards,
      cwd: 'base',
      plain: 'git commit -m x',
      hidden: ["$'\\x67it' commit -m x", 'git com\\\nmit -m x', "git $'\\x63ommit' -m x", "$'\\x67it' $'\\x63ommit' -m x"],
    },
    {
      name: 'git-push-guard',
      gate: gitPushGuard,
      cwd: 'base',
      role: 'swe',
      plain: 'git push origin main',
      hidden: ["$'\\x67it' push origin main", 'git pu\\\nsh origin main', "git $'\\x70ush' origin main", "$'\\x67it' $'\\x70ush' origin main"],
    },
    {
      name: 'stay-on-base-guard',
      gate: stayOnBaseGuard,
      cwd: 'base',
      plain: 'git checkout feat/open',
      hidden: ["$'\\x67it' checkout feat/open", 'git check\\\nout feat/open', "git $'\\x73witch' feat/open", "$'\\x67it' $'\\x63heckout' feat/open"],
    },
    {
      name: 'no-worktree-branch-create',
      gate: noWorktreeBranchCreate,
      cwd: 'project',
      plain: 'git worktree add -b feat/x ../x',
      hidden: ["$'\\x67it' worktree add -b feat/x ../x", 'git work\\\ntree add -b feat/x ../x', "$'\\x67it' $'\\x77orktree' add -b feat/x ../x"],
    },
    {
      name: 'branch-up-to-date-with-remote',
      gate: branchUpToDateWithRemote,
      cwd: 'stale',
      plain: 'git worktree add ../wt feat/behind',
      hidden: ["$'\\x67it' worktree add ../wt feat/behind", 'git work\\\ntree add ../wt feat/behind', "$'\\x67it' $'\\x77orktree' add ../wt feat/behind"],
    },
  ];

  for (const c of cases) {
    it(`${c.name} gives each hidden keyword the plain command's deny`, async () => {
      const plain = verdict(await c.gate(bash(c.plain, join(s, c.cwd), c.role), env()));
      assert.notEqual(plain, '', `${c.plain} is denied`);
      if (c.gate === gitPushGuard) assert.ok(plain.startsWith(SWE_PUSH_REASON), plain);
      for (const command of c.hidden) assert.equal(verdict(await c.gate(bash(command, join(s, c.cwd), c.role), env())), plain, command);
    });

    it(`${c.name} still allows a command without its keyword`, async () => {
      for (const command of ['echo hi', 'git status']) assert.equal(verdict(await c.gate(bash(command, join(s, c.cwd), c.role), env())), '', command);
    });
  }

  it('remote-id-guard denies a text option behind a line continuation or $\'…\' as the plain one', async () => {
    const rigEnv: NodeJS.ProcessEnv = { CLAUDE_PROJECT_DIR: join(base, 'issues'), TRAJECTORY_DB_PATH: issuesDb, PATH: process.env.PATH, LC_ALL: 'C' };
    const run = async (command: string) => verdict(await remoteIdGuard(bash(command, base), rigEnv));
    const plain = await run("gh pr create --body 'Closes #5'");
    assert.ok(plain.includes('#5 → #42 (GitHub)'), plain);
    for (const command of ["gh pr create --bo\\\ndy 'Closes #5'", "gh pr create $'--\\x62ody' 'Closes #5'", "gh pr create $'-\\x62' 'Closes #5'"]) {
      assert.equal(await run(command), plain, command);
    }
    for (const command of ['echo hi', "gh pr view 5"]) assert.equal(await run(command), '', command);
  });

  describe('ref-move-reindex', () => {
    const stamp: RepoStamp = { name: 'app', indexed_commit: 'c'.repeat(40), target_branch: 'main' };
    const recording = () => {
      const parsed: string[] = [];
      const launch: string[][] = [];
      const seams = {
        ...REAL_SEAMS,
        statements: (command: string, cwd: string, e: NodeJS.ProcessEnv): Promise<GitStatements> => {
          parsed.push(command);
          return cmdStatements(command, cwd, e);
        },
        repoRoot: () => Promise.resolve('/repo'),
        repoStamp: () => stamp,
        targetCommit: () => 'd'.repeat(40),
        launch: (args: readonly string[]) => {
          launch.push([...args]);
        },
      };
      return { seams, parsed, launch };
    };
    const refEnv = (): NodeJS.ProcessEnv => {
      const dir = mkdtempSync(join(base, 'ref-move-db-'));
      writeFileSync(join(dir, 'trajectory.db'), '');
      const e: NodeJS.ProcessEnv = { ...process.env, TRAJECTORY_DB_PATH: join(dir, 'trajectory.db') };
      delete e.TMB_SKIP_AUTO_RESCAN;
      return e;
    };
    const post = (command: string): string =>
      JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: '', stderr: '', interrupted: false }, cwd: '/repo' });

    for (const command of ['git push origin main', 'git pu\\\nsh origin main', "git $'\\x70ush' origin main", "$'\\x67it' fetch origin"]) {
      it(`launches a reindex for ${JSON.stringify(command)}`, async () => {
        const { seams, launch } = recording();
        await refMoveReindexWith(seams)(post(command), refEnv());
        assert.deepEqual(launch, [['/repo', 'hook', 'app']]);
      });
    }

    it('a command with no ref-moving word and no $\' never parses', async () => {
      for (const command of ['echo hi', 'git status', 'ls -la']) {
        const { seams, parsed, launch } = recording();
        await refMoveReindexWith(seams)(post(command), refEnv());
        assert.deepEqual([parsed, launch], [[], []], command);
      }
    });
  });
});
