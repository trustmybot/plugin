/**
 * The git statement listing judges a function's git statements at its call
 * dirs (GH 2630): a statement in a function body is listed in the dir it is
 * defined in and in every dir a call starts it in, `function NAME { … }`
 * bodies split into statements, and a call whose dir cannot be pinned leaves
 * `-`, so git-push-guard denies a push hidden in a function.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdStatements } from '../hooks/cmd-analysis/index.js';
import { gitPushGuard } from '../hooks/git-push-guard.js';

const listed = async (cmd: string) => {
  const out = await cmdStatements(cmd, '/w', {});
  assert.ok(out.ok, cmd);
  return out.statements;
};

const dirsOf = async (cmd: string, stmt: string): Promise<string[]> =>
  (await listed(cmd)).filter((s) => s.stmt === stmt).map(({ dir }) => dir);

const pushDirs = (cmd: string): Promise<string[]> => dirsOf(cmd, 'git push origin dev');

describe('git statement listing judges a function body at its call dirs (GH 2630)', () => {
  it('a call after a cd lists the body push in the definition dir and the call dir', async () => {
    assert.deepEqual(await pushDirs('cd /tmp; f() { git push origin dev; }; cd /etc; f'), ['/tmp', '/etc']);
    assert.deepEqual(await pushDirs('cd /tmp; function f { git push origin dev; }; cd /etc; f'), ['/tmp', '/etc']);
    assert.deepEqual(await pushDirs('cd /tmp; function f() { git push origin dev; }; cd /etc; f'), ['/tmp', '/etc']);
    assert.deepEqual(await pushDirs('cd /tmp; f ( ) { git push origin dev; }; cd /etc; f'), ['/tmp', '/etc']);
    assert.deepEqual(await pushDirs('cd /tmp; f()\n{\n  git push origin dev\n}\ncd /etc\nf'), ['/tmp', '/etc']);
  });

  it('a subshell body runs at the call dir and leaves the dir after the call alone', async () => {
    const cmd = 'cd /tmp; f() ( cd /usr; git status ); cd /etc; f; git push origin dev';
    assert.deepEqual(await dirsOf(cmd, 'cd /usr'), ['/tmp', '/etc']);
    assert.deepEqual(await pushDirs(cmd), ['/etc']);
  });

  it('function NAME { … } bodies split into one record per statement', async () => {
    for (const cmd of ['function f { git push origin dev; git status; }; f', 'function f() { git push origin dev; git status; }; f']) {
      const stmts = (await listed(cmd)).map(({ stmt }) => stmt);
      assert.ok(stmts.includes('git push origin dev'), cmd);
      assert.ok(stmts.includes('git status'), cmd);
      assert.ok(!stmts.some((s) => s.startsWith('function ') && s.includes('git')), cmd);
    }
  });

  it('a call in a loop body combines with the loop dirs', async () => {
    assert.deepEqual([...(await pushDirs('cd /tmp; f() { git push origin dev; }; while :; do f; cd /etc; done'))].sort(), ['/etc', '/tmp']);
  });

  it('a call from another function runs at that function’s call dirs', async () => {
    assert.deepEqual(await pushDirs('cd /tmp; f() { git push origin dev; }; g() { f; }; cd /etc; g'), ['/tmp', '/etc']);
  });

  it('a body that cds moves the dir after the call, and the definition alone moves nothing', async () => {
    const cmd = 'cd /tmp; f() { cd /etc; }; git push origin dev; f; git push origin dev';
    assert.deepEqual(await pushDirs(cmd), ['/tmp', '/tmp', '/etc']);
    assert.deepEqual(await pushDirs('cd /tmp; f() { cd /etc; return; cd /usr; }; f; git push origin dev'), ['/tmp', '/etc', '/usr']);
  });

  it('a body that never cds leaves the call dir as it was', async () => {
    assert.deepEqual(await pushDirs('cd /tmp; f() { git status; }; cd /etc; f; git push origin dev'), ['/etc']);
  });

  it('a call whose dir cannot be pinned lists the body push in -', async () => {
    for (const cmd of [
      'cd /tmp; f() { git push origin dev; }; cd /etc; eval f',
      'cd /tmp; f() { git push origin dev; }; cd /etc; fn=f; "$fn"',
      'cd /tmp; f() { git push origin dev; }; cd /etc; trap f EXIT',
      'cd /tmp; f() { git push origin dev; f; }; cd /etc; f',
      'cd /tmp; g() { f; }; f() { git push origin dev; }; cd /etc; g',
      'cd /tmp; f() if :; then git push origin dev; fi; cd /etc; f',
      'eval "f() { git push origin dev; }"; cd /etc; f',
      'cd /tmp; f() { git push origin dev; }; export -f f; cd /etc; bash -c f',
      'cd /tmp; f() { git push origin dev; }; declare -fx f; cd /etc; bash -c f',
      'cd /tmp; set -a; f() { git push origin dev; }; cd /etc; bash -c f',
      'cd /tmp; f() { git push origin dev; }; shopt -s expand_aliases; alias g=f\ncd /etc; g',
    ]) {
      assert.ok((await pushDirs(cmd)).includes('-'), cmd);
    }
  });

  it('a function a builtin or the shell calls by name lists the body push in -', async () => {
    for (const cmd of [
      'cd /tmp; f() { git push origin dev; }; cd /etc; mapfile -C f -c 1 a </etc/hosts',
      'cd /tmp; f() { git push origin dev; }; cd /etc; mapfile -tC f -c1 </etc/hosts',
      'cd /tmp; f() { git push origin dev; }; cd /etc; mapfile "-C" f a </etc/hosts',
      'cd /tmp; f() { git push origin dev; }; cd /etc; readarray -C f -c 1 a </etc/hosts',
      'cd /tmp; f() { git push origin dev; }; cd /etc; compgen -F f x',
      "cd /tmp; f() { git push origin dev; }; cd /etc; compgen -C 'f' x",
      'cd /tmp; f() { git push origin dev; }; cd /etc; complete -F f x',
      'cd /tmp; command_not_found_handle() { git push origin dev; }; cd /etc; zzz',
      'cd /tmp; command_not_found_handler() { git push origin dev; }; cd /etc; zzz',
      'cd /tmp; chpwd() { git push origin dev; }; cd /etc',
      'cd /tmp; function TRAPEXIT { git push origin dev; }; cd /etc',
      'cd /tmp; zshexit() { git push origin dev; }; cd /etc',
      'cd /tmp; g() { git push origin dev; }; chpwd_functions=(g); cd /etc',
      'cd /tmp; g() { git push origin dev; }; chpwd_functions+=(g); cd /etc',
      'cd /tmp; g() { git push origin dev; }; typeset -a chpwd_functions=(g); cd /etc',
      'cd /tmp; chpwd_functions=(g); g() { git push origin dev; }; cd /etc',
      'cd /tmp; g() { git push origin dev; }; add-zsh-hook chpwd g; cd /etc',
    ]) {
      assert.ok((await pushDirs(cmd)).includes('-'), cmd);
    }
  });

  it('a builtin with no callback option leaves the call dirs pinned', async () => {
    assert.deepEqual(await pushDirs('cd /tmp; f() { git push origin dev; }; cd /etc; mapfile -t a </etc/hosts; f'), ['/tmp', '/etc']);
    assert.deepEqual(await pushDirs('cd /tmp; f() { git push origin dev; }; compgen -c gi; f'), ['/tmp']);
  });

  it('a function export calls nothing, so the dir after it stays pinned', async () => {
    assert.deepEqual(await pushDirs('cd /tmp; f() { :; }; export -f f; git push origin dev'), ['/tmp']);
    assert.deepEqual(await pushDirs('cd /tmp; set -euo pipefail; f() { git push origin dev; }; f'), ['/tmp']);
  });

  it('a call in $( ) runs at the dir the substitution starts in', async () => {
    assert.deepEqual(await pushDirs('cd /tmp; f() { git push origin dev; }; cd /etc; x=$(f)'), ['/tmp', '/etc']);
  });

  it('an assignment in a function body leaves later variable dirs unresolved', async () => {
    assert.deepEqual(await dirsOf('cd /tmp; X=/usr; f() { X=/etc; }; cd $X; git status', 'git status'), ['-']);
  });

  it('git-push-guard denies a push hidden in a function called from .claude/worktrees/', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-gh2630-')));
    try {
      const env = { ...process.env, CLAUDE_PROJECT_DIR: dir, TRAJECTORY_DB_PATH: join(dir, 'none.db') };
      const run = async (command: string) => (await gitPushGuard(JSON.stringify({ tool_name: 'Bash', cwd: dir, tool_input: { command } }), env)).stdout;
      const wt = `${dir}/.claude/worktrees/t`;
      const plain = await run(`cd ${wt}; git push origin dev`);
      assert.match(plain, /push from \.claude\/worktrees\/ is forbidden/);
      for (const command of [
        `cd ${dir}; f() { git push origin dev; }; cd ${wt}; f`,
        `cd ${dir}; function f { git push origin dev; }; cd ${wt}; f`,
        `cd ${wt}; function f { git push origin dev; }; f`,
        `cd ${dir}; f() { git push origin dev; }; cd ${wt}; $(f)`,
        `cd ${dir}; f() { cd ${wt}; }; f; git push origin dev`,
      ]) {
        assert.equal(await run(command), plain, command);
      }
      for (const command of [
        `cd ${dir}; f() { git push origin dev; }; cd ${wt}; eval f`,
        `cd ${dir}; f() { git push origin dev; }; cd ${wt}; fn=f; "$fn"`,
        `cd ${dir}; f() { git push origin dev; }; cd ${wt}; mapfile -C f -c 1 </etc/hosts`,
        `cd ${dir}; f() { git push origin dev; }; cd ${wt}; readarray -C f -c 1 </etc/hosts`,
        `cd ${dir}; f() { git push origin dev; }; cd ${wt}; compgen -F f x`,
        `cd ${dir}; command_not_found_handle() { git push origin dev; }; cd ${wt}; zzz`,
        `cd ${dir}; command_not_found_handler() { git push origin dev; }; cd ${wt}; zzz`,
        `cd ${dir}; chpwd() { git push origin dev; }; cd ${wt}`,
      ]) {
        assert.match(await run(command), /ambiguous_git_(target|subcommand)|push from \.claude\/worktrees\/ is forbidden/, command);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('git-push-guard still lets a function push through when no call moves it', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-gh2630-')));
    try {
      const env = { ...process.env, CLAUDE_PROJECT_DIR: dir, TRAJECTORY_DB_PATH: join(dir, 'none.db') };
      const run = async (command: string) => (await gitPushGuard(JSON.stringify({ tool_name: 'Bash', cwd: dir, tool_input: { command } }), env)).stdout;
      assert.equal(await run(`cd ${dir}; f() { git push origin dev; }; f`), '');
      assert.equal(await run(`cd ${dir}; f() { git push origin dev; }`), '');
      assert.equal(await run(`cd ${dir}; function f { git push origin dev; }; f; cd ${dir}/.claude/worktrees/t`), '');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
