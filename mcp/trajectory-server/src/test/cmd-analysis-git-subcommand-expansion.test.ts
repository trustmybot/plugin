/**
 * git-push-guard reads git's subcommand allowlist-style (GH 2634): a git
 * statement counts as no push only when its subcommand word and every git
 * option word before it are literal text. An expansion there (`git $p`,
 * `git "$@"`, `git ${p}sh`, `git $(echo push)`), a brace or glob pattern, or
 * a redirect leaves the subcommand unknown, and the guard denies it. An
 * expansion in the argument of `-C`, `-c`, `--git-dir`, `--work-tree` or
 * `--namespace` cannot move the subcommand, so it leaves it known.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdStatements, gitSubcommandOf, gitSubcommandUnknown } from '../hooks/cmd-analysis/index.js';
import { gitPushGuard } from '../hooks/git-push-guard.js';

const UNKNOWN = /ambiguous_git_subcommand/;
const TARGET = /ambiguous_git_target/;
const WORKTREE = /push from \.claude\/worktrees\/ is forbidden/;

async function withGuard(body: (run: (command: string) => Promise<string>, dir: string, wt: string) => Promise<void>): Promise<void> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-gh2634-')));
  try {
    const env = { ...process.env, CLAUDE_PROJECT_DIR: dir, TRAJECTORY_DB_PATH: join(dir, 'none.db') };
    const wt = `${dir}/.claude/worktrees/t`;
    mkdirSync(wt, { recursive: true });
    const run = async (command: string) => (await gitPushGuard(JSON.stringify({ tool_name: 'Bash', cwd: wt, tool_input: { command } }), env)).stdout;
    await body(run, dir, wt);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const subsOf = async (cmd: string): Promise<Array<string | undefined>> => {
  const out = await cmdStatements(cmd, '/w', {});
  assert.ok(out.ok, cmd);
  return out.statements.map((statement) => gitSubcommandOf(statement));
};

describe('git-push-guard denies a git statement whose subcommand is an expansion (GH 2634)', () => {
  it('denies each expansion form of the subcommand from .claude/worktrees/', async () => {
    await withGuard(async (run, _dir, wt) => {
      for (const command of [
        'p=push; git $p origin dev',
        'git "$@"',
        'g() { git "$@"; }; g push',
        'git ${p}sh origin dev',
        'git $(echo push) origin dev',
        'git -C . $p origin dev',
        'git -c x=y "$sub"',
        `cd ${wt}; git $p origin dev`,
        'git -C $W $p origin dev',
        'git -C "$W" "$@"',
        'git --git-dir=$G $p',
        'git --work-tree "$W" ${p}sh',
        'git -C $(pwd) $p origin dev',
        'git -c x=`echo y` $(echo push)',
      ]) {
        assert.match(await run(command), UNKNOWN, command);
      }
    });
  });

  it('denies a substitution glued to the subcommand or after git, and patterns and redirects', async () => {
    await withGuard(async (run) => {
      for (const command of [
        'git pu$(echo sh) origin dev',
        'git $(true)push origin dev',
        'git `echo push` origin dev',
        'git "$(echo push)" origin dev',
        'git $((1)) origin dev',
        'git {push,x} origin dev',
        'git pu?h origin dev',
        'git -c x={y,push} origin dev',
        'git -C {.,push} origin dev',
        'git -C >out push origin dev',
        'git --git-dir=* status',
        'git >out push origin dev',
        'git 2>&1 push origin dev',
        'git -$x push origin dev',
        'g\\it $p origin dev',
        "bash -c 'git $(echo push) origin dev'",
      ]) {
        assert.match(await run(command), UNKNOWN, command);
      }
    });
  });

  it('a quote-split literal push is still judged as a push', async () => {
    await withGuard(async (run) => {
      for (const command of ["git pu''sh origin dev", 'git pu\\sh origin dev', 'git "push" origin dev']) {
        assert.match(await run(command), WORKTREE, command);
      }
    });
  });

  it('allows literal non-push git statements with expansions only in later args', async () => {
    await withGuard(async (run) => {
      for (const command of [
        'git status',
        'git log $ref',
        'git commit -m "$msg"',
        'git fetch origin $b',
        'git show $(git rev-parse HEAD)',
        'git log `cat ref`',
        'git diff <(echo a) <(echo b)',
        'git -C . status',
        "git -C '' log -1",
      ]) {
        assert.equal(await run(command), '', command);
      }
    });
  });

  it('allows literal non-push git statements with an expansion in a value-taking option argument', async () => {
    await withGuard(async (run, dir) => {
      for (const command of [
        'git -C "$W" status',
        'git -C $W diff --stat a b',
        'git -c "user.name=$n" log',
        'for f in a b; do git -C $f status; done',
        'git -C ${W} status',
        `W=${dir}; git -C $W status`,
        'git -C $X -C $W status',
        'git --git-dir $G log',
        'git --git-dir="$G" log',
        'git --work-tree=$W status',
        'git --namespace=$ns log',
        'git -C $(pwd) status',
        'git -C "$(pwd)" status',
        'git -C `pwd` log -1',
        'git --git-dir=$(pwd)/.git status',
        'git -c x=`echo y` log',
        'git -C $(git rev-parse --show-toplevel) -c "a=$(echo \')\')" status',
      ]) {
        assert.equal(await run(command), '', command);
      }
    });
  });

  it('a literal push with an expansion in an option argument is judged as a push', async () => {
    await withGuard(async (run, dir, wt) => {
      assert.match(await run('git -C $W push'), TARGET);
      assert.match(await run('git -C $W push origin HEAD'), TARGET);
      assert.match(await run('git -C $(pwd) push origin dev'), TARGET);
      assert.match(await run(`W=${wt}; git -C $W push origin HEAD`), WORKTREE);
      assert.match(await run('git --git-dir=$(pwd)/.git push origin dev'), WORKTREE);
      assert.match(await run('git -c "user.name=$n" push origin dev'), WORKTREE);
      assert.equal(await run(`cd ${dir}; git push --force origin dev`), '');
    });
  });

  it('a literal git push from .claude/worktrees/ keeps the worktree deny', async () => {
    await withGuard(async (run, _dir, wt) => {
      assert.match(await run('git push origin dev'), WORKTREE);
      assert.match(await run(`cd ${wt}; git push origin "$b"`), WORKTREE);
    });
  });

  it('gitSubcommandOf reads the subcommand span only, option arguments aside', async () => {
    assert.equal(gitSubcommandUnknown('git $p origin dev'), true);
    assert.equal(gitSubcommandUnknown('git -C $d $p'), true);
    assert.equal(gitSubcommandUnknown('git -C $d status'), false);
    assert.equal(gitSubcommandUnknown('git -c a=$b --git-dir=$g --work-tree $w --namespace=$n log'), false);
    assert.equal(gitSubcommandUnknown('git log $ref'), false);
    assert.equal(gitSubcommandUnknown('git'), false);
    assert.equal(gitSubcommandUnknown('echo $p'), false);
    assert.equal(gitSubcommandOf('git -C $d push origin'), 'push origin');
    assert.equal(gitSubcommandOf('echo push'), '');
    assert.equal(gitSubcommandUnknown({ stmt: 'git', cut: 'word' }), true);
    assert.equal(gitSubcommandUnknown({ stmt: 'git -C', cut: 'word' }), true);
    assert.equal(gitSubcommandUnknown({ stmt: 'git show', cut: 'word' }), false);
    assert.equal(gitSubcommandUnknown({ stmt: 'git show', cut: 'glued' }), true);
    assert.deepEqual(await subsOf('git show$(x)'), [undefined, '']);
    assert.deepEqual(await subsOf('git show $(x)'), ['show', '']);
    assert.deepEqual(await subsOf('git -C $(pwd) push origin'), ['push origin', '', '']);
    assert.ok((await subsOf('x=$(git $(echo push))')).includes(undefined));
  });
});
