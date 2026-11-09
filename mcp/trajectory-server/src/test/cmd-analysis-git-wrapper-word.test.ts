/**
 * The git gates find git behind wrappers and by path (GH 2797): `env`,
 * `command`, `sudo`, `nice`, `timeout`, `xargs` and the rest of the wrapper
 * table, chained, and a first word whose basename is git. A wrapper option
 * the table does not know, or a word it must skip that is not literal, leaves
 * the subcommand unknown, and git-push-guard denies it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdStatements, gitSubcommand, gitSubcommandOf } from '../hooks/cmd-analysis/index.js';
import { gitPushGuard } from '../hooks/git-push-guard.js';

const UNKNOWN = /ambiguous_git_subcommand/;
const WORKTREE = /push from \.claude\/worktrees\/ is forbidden/;

async function withGuard(body: (run: (command: string) => Promise<string>) => Promise<void>): Promise<void> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-gh2797-')));
  try {
    const env = { ...process.env, CLAUDE_PROJECT_DIR: dir, TRAJECTORY_DB_PATH: join(dir, 'none.db') };
    const wt = `${dir}/.claude/worktrees/t`;
    mkdirSync(wt, { recursive: true });
    const run = async (command: string) => (await gitPushGuard(JSON.stringify({ tool_name: 'Bash', cwd: wt, tool_input: { command } }), env)).stdout;
    await body(run);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const listed = async (cmd: string) => {
  const out = await cmdStatements(cmd, '/w', {});
  assert.ok(out.ok, cmd);
  return out.statements;
};

const subsOf = async (cmd: string): Promise<Array<string | undefined>> => (await listed(cmd)).map((statement) => gitSubcommandOf(statement));

const WRAPPED = [
  'git push origin x',
  '/usr/bin/git push origin x',
  'env git push origin x',
  'env -i A=1 git push origin x',
  'command git push origin x',
  'sudo -u me git push origin x',
  'nice -n 5 git push origin x',
  'timeout 5 git push origin x',
  'xargs git push origin x',
  'sudo env git push origin x',
];

describe('git behind a wrapper or by path (GH 2797)', () => {
  it('gitSubcommand and gitSubcommandOf read git behind each wrapper and by path', () => {
    for (const stmt of WRAPPED) {
      assert.equal(gitSubcommand(stmt), 'push origin x', stmt);
      assert.equal(gitSubcommandOf(stmt), 'push origin x', stmt);
    }
  });

  it('reads the rest of the wrapper table, chained and by path', () => {
    for (const stmt of [
      './git push',
      '~/bin/git push',
      '/usr/bin/env git push',
      'exec -a x git push',
      'nohup git push',
      'time -p git push',
      'doas -u me git push',
      'stdbuf -oL git push',
      'ionice -c 2 -n 0 git push',
      'chrt -f 10 git push',
      'taskset -c 0-3 git push',
      'setsid -f git push',
      'timeout -k 5 10s git push',
      'gtimeout 5 git push',
      'nice -5 git push',
      'env - git push',
      'sudo --user=me -- git push',
      'xargs -0 -n1 -P4 git push',
      'sudo nice -n 5 timeout 5 env A=1 git push',
    ]) {
      assert.equal(gitSubcommandOf(stmt), 'push', stmt);
    }
  });

  it('gitSubcommandOf leaves an unknown wrapper option, a non-literal skipped word or an xargs git with no subcommand unknown', () => {
    for (const stmt of [
      'env --bogus git push',
      'nice -n $N git push',
      'xargs git',
      'xargs -0 git',
      'timeout bad git push',
      'env $X git push',
      'sudo -D /x git push',
      'xargs -I {} git push {}',
    ]) {
      assert.equal(gitSubcommandOf(stmt), undefined, stmt);
    }
    assert.equal(gitSubcommand('env --bogus git push'), 'push');
    assert.equal(gitSubcommand('nice -n $N git push'), 'push');
    assert.equal(gitSubcommand('xargs git'), '');
  });

  it('a statement whose wrappers run another command or nothing is no git command', () => {
    for (const stmt of ['echo git push', 'printf git', 'env -u git push', 'command -v git', 'nice -n 5 echo git push', 'gitk push', 'git-lfs push']) {
      assert.equal(gitSubcommandOf(stmt), '', stmt);
      assert.equal(gitSubcommand(stmt), '', stmt);
    }
  });

  it('the listing keeps the wrapper words it skips, and gitSubcommandOf reads them', async () => {
    const [bogus] = await listed('env --bogus git push origin dev');
    assert.equal(bogus.stmt, 'git push origin dev');
    assert.equal(bogus.wrappers, 'env --bogus');
    assert.deepEqual(await subsOf('env --bogus git push origin dev'), [undefined]);
    assert.deepEqual(await subsOf('nice -n $N git push'), [undefined]);
    assert.deepEqual(await subsOf('env -C /x git push'), [undefined]);
    assert.deepEqual(await subsOf('sudo env A=1 git push origin dev'), ['push origin dev']);
    assert.deepEqual(await subsOf('time -p A=1 git push'), ['push']);
    assert.deepEqual(await subsOf('cd /a && env git push'), ['', 'push']);
    assert.equal((await listed('A=1 git push'))[0].wrappers, undefined);
  });

  it('the listing tracks git -C, kept empty words and a cut behind a wrapper or path', async () => {
    assert.equal((await listed('doas git -C /x push'))[0].dir, '/x');
    assert.equal((await listed('/usr/bin/git -C /x push'))[0].dir, '/x');
    assert.equal((await listed('xargs git -C /x push'))[0].dir, '/x');
    assert.equal((await listed("/usr/bin/git -C '' push"))[0].stmt, "/usr/bin/git -C '' push");
    assert.deepEqual(await subsOf('doas git $(echo push) origin dev'), [undefined, '', '']);
    assert.deepEqual(await subsOf('/usr/bin/git $(echo push)'), [undefined, '']);
    assert.deepEqual(await subsOf('env git $(echo push)'), [undefined, '']);
    assert.deepEqual(await subsOf('xargs git push $(x)'), ['push', '']);
  });
});

describe('git-push-guard gates git behind a wrapper or by path (GH 2797)', () => {
  it('denies a wrapped or path git push as it denies git push', async () => {
    await withGuard(async (run) => {
      assert.match(await run('git push origin dev'), WORKTREE);
      for (const command of ['env git push origin dev', '/usr/bin/git push origin dev', 'xargs git push origin dev', 'doas git push origin dev', 'setsid git push origin dev']) {
        assert.match(await run(command), WORKTREE, command);
      }
    });
  });

  it('denies a push behind an unknown wrapper option or with an unknown subcommand as unknown', async () => {
    await withGuard(async (run) => {
      for (const command of ['env --bogus git push origin dev', 'nice -n $N git push origin dev', 'echo dev | xargs git', 'env -C . git push origin dev', '/usr/bin/git $(echo push) origin dev']) {
        assert.match(await run(command), UNKNOWN, command);
      }
    });
  });

  it('allows a wrapped non-push git and a wrapper that runs no git', async () => {
    await withGuard(async (run) => {
      for (const command of ['env git status', '/usr/bin/git log push', 'echo git push', 'nice -n 5 echo push']) {
        assert.equal(await run(command), '', command);
      }
    });
  });
});
