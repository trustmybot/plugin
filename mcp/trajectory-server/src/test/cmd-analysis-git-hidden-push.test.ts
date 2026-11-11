/**
 * git-push-guard sees a push the listing used to hide (GH 2635): behind a
 * leading redirect, an assignment and redirect, or a `builtin` prefix; in a
 * $( ) or backtick of an unquoted heredoc body; in deferred code (a trap
 * action, an alias value, a `mapfile` / `readarray` / `compgen` /
 * `complete -C` callback, a PS4 that `set -x` expands), listed in `-`; and
 * behind a `bash -c` or `eval` string the guard cannot read, which it denies
 * when the command names `push`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdStatements } from '../hooks/cmd-analysis/index.js';
import { gitPushGuard } from '../hooks/git-push-guard.js';

const UNKNOWN = /ambiguous_git_subcommand/;
const TARGET = /ambiguous_git_target/;
const WORKTREE = /push from \.claude\/worktrees\/ is forbidden/;

async function withGuard(body: (run: (command: string) => Promise<string>, wt: string) => Promise<void>): Promise<void> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-gh2635-')));
  try {
    const env = { ...process.env, CLAUDE_PROJECT_DIR: dir, TRAJECTORY_DB_PATH: join(dir, 'none.db') };
    const wt = `${dir}/.claude/worktrees/t`;
    mkdirSync(wt, { recursive: true });
    const run = async (command: string) => (await gitPushGuard(JSON.stringify({ tool_name: 'Bash', cwd: wt, tool_input: { command } }), env)).stdout;
    await body(run, wt);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function expect(cases: ReadonlyArray<readonly [string, RegExp | '']>): Promise<void> {
  await withGuard(async (run) => {
    for (const [command, want] of cases) {
      const out = await run(command);
      if (want === '') assert.equal(out, '', command);
      else assert.match(out, want, command);
    }
  });
}

describe('git-push-guard sees pushes the listing hid (GH 2635)', () => {
  it('denies a plain push from .claude/worktrees/', async () => {
    await expect([['git push origin dev', WORKTREE]]);
  });

  it('skips leading redirects, assignments and a builtin prefix before argv0', async () => {
    await expect([
      ['>out git push origin dev', WORKTREE],
      ['2>&1 git push origin dev', WORKTREE],
      ['< /dev/null git push origin dev', WORKTREE],
      ['FOO=1 >out git push origin dev', WORKTREE],
      ['<&0 git push origin dev', WORKTREE],
      ["builtin eval 'git push origin dev'", WORKTREE],
      ['builtin command git push origin dev', WORKTREE],
      ['env -C . git push origin dev', WORKTREE],
      ['>out git status', ''],
      ['builtin echo hi', ''],
    ]);
  });

  it('lists the substitutions of an unquoted heredoc body, <<- included', async () => {
    await expect([
      ['cat <<EOF\n$(git push origin dev)\nEOF', WORKTREE],
      ['cat <<EOF\n`git push origin dev`\nEOF', WORKTREE],
      ['cat <<-EOF\n\t`git push origin dev`\n\tEOF', WORKTREE],
      ['cat <<-EOF\n\t$(git push origin dev)\n\tEOF', WORKTREE],
      ['cat <<EOF\n$(( $(git push origin dev) ))\nEOF', WORKTREE],
      ["cat <<'EOF'\n$(git push origin dev)\nEOF", ''],
      ['cat <<"EOF"\n`git push origin dev`\nEOF', ''],
      ['cat <<\\EOF\n$(git push origin dev)\nEOF', ''],
      ['cat <<EOF\nx \\`git push origin dev\\`\nEOF', ''],
      ['cat <<EOF\n$(git status)\nEOF', ''],
    ]);
  });

  it('lists deferred code in `-` and denies a push in it', async () => {
    await expect([
      ["trap 'git push origin dev' EXIT", TARGET],
      ["trap -- 'git push origin dev' EXIT", TARGET],
      ["mapfile -C 'git push origin dev' -c 1 < /dev/null", TARGET],
      ["readarray -C 'git push origin dev' -c 1 < /dev/null", TARGET],
      ["compgen -C 'git push origin dev' x", TARGET],
      ["complete -C 'git push origin dev' x", TARGET],
      ["compgen -W '$(git push origin dev)' x", TARGET],
      ["alias p='git push origin dev'", TARGET],
      ["PS4='$(git push origin dev)'; set -x; true", TARGET],
      ["PS4='`git push origin dev`'; set -x; true", TARGET],
      ["export PS4='$(git push origin dev)'; set -x; true", TARGET],
      ["PS4='$(git push origin dev)' bash -x -c true", TARGET],
      ["PS4+='$(git push origin dev)'; set -x; true", TARGET],
      ['f() { git push origin dev; }; builtin mapfile -C f -c 1 < /dev/null', TARGET],
      ['a=(1); echo $(( a[$(git push origin dev)] ))', WORKTREE],
      ["PS4='+ '; set -x; git status", ''],
      ["trap 'rm -f t' EXIT", ''],
      ["alias ll='ls -l'", ''],
    ]);
  });

  it('denies a PS4 set behind a wrapper, from an expansion or by a builtin operand (F680-1)', async () => {
    await expect([
      ["env PS4='$(git push origin dev)' bash -xc true", UNKNOWN],
      ["env FOO=1 PS4='$(git push origin dev)' bash -xc true", UNKNOWN],
      ["sudo PS4='$(git push origin dev)' bash -xc true", UNKNOWN],
      ["X='$(git push origin dev)'; PS4=$X; set -x; true", UNKNOWN],
      ['X=\'$(git push origin dev)\'; PS4="$X"; set -x; true', UNKNOWN],
      ['X=\'$(git push origin dev)\'; export PS4="$X"; set -x; true', UNKNOWN],
      ['f() { local PS4=$X; set -x; true; }; f push', UNKNOWN],
      ["printf -v PS4 '$(git push origin dev)'; set -x; true", UNKNOWN],
      ["printf -vPS4 '$(git push origin dev)'; set -x; true", UNKNOWN],
      ["read -r PS4 <<< '$(git push origin dev)'; set -x; true", UNKNOWN],
      ["declare -n p=PS4; p='$(git push origin dev)'; set -x; true", UNKNOWN],
      ["env PS4='+ $(date)' bash -xc 'git status'", ''],
      ['PS4=$X; set -x; git status', ''],
      ['unset PS4; git status', ''],
      ['git push origin PS4', WORKTREE],
    ]);
  });

  it('reads a case pattern inside a heredoc $( ) (F680-2)', async () => {
    await expect([
      ['cat <<EOF\n$(case x in a) git push origin dev;; esac)\nEOF', WORKTREE],
      ['cat <<EOF\n$( (case x in (a) git push origin dev;; esac) )\nEOF', WORKTREE],
      ['cat <<EOF\n$(case x in a) git status;; esac) (note)\nEOF', ''],
    ]);
  });

  it('ends a heredoc $( ) where bash does, past a comment (F680-5)', async () => {
    await expect([
      ['cat <<EOF\n$(echo # )\ngit push origin dev\n)\nEOF', WORKTREE],
      ['cat <<EOF\n$(echo hi # )\ngit push origin dev )\nEOF', WORKTREE],
      ['cat <<-EOF\n\t$(true # ) x\n\tgit push origin dev\n\t)\n\tEOF', WORKTREE],
      ['cat <<EOF\n`echo # `git push origin dev\nEOF', ''],
      ['cat <<EOF\n`echo # `$(git push origin dev)\nEOF', WORKTREE],
      ['cat <<EOF\n`git push \\`echo origin\\``\nEOF', WORKTREE],
      ['cat <<EOF\n`a\ngit push origin dev\nEOF', /could not parse/],
      ['cat <<EOF\n$(echo # )\ngit status\n)\nEOF', ''],
      ['cat <<EOF\nx \\$(git push origin dev)\nEOF', ''],
    ]);
  });

  it('denies a PS4 set out of sight or a variable name it cannot read (F680-6)', async () => {
    await expect([
      ["PS4=; : ${PS4:='$(git push origin dev)'}; set -x; true", UNKNOWN],
      ["unset PS4; : ${PS4='$(git push origin dev)'}; set -x; true", UNKNOWN],
      ['X=PS4; declare "$X=\\$(git push origin dev)"; set -x; true', UNKNOWN],
      ['X=PS4; export "$X=\\$(git push origin dev)"; set -x; true', UNKNOWN],
      ['X=PS4; printf -v "$X" %s "\\$(git push origin dev)"; set -x; true', UNKNOWN],
      ["X=PS4; read \"$X\" <<< '$(git push origin dev)'; set -x; true", UNKNOWN],
      ["read P\\S4 <<< '$(git push origin dev)'; set -x; true", UNKNOWN],
      ["X=PS4; mapfile -t \"$X\" <<< '$(git push origin dev)'; set -x; true", UNKNOWN],
      ["declare -n p=$X; p='$(git push origin dev)'; set -x; true", UNKNOWN],
      ["P=PS4; : ${!P:='$(git push origin dev)'}; set -x; true", UNKNOWN],
      ['G=git; $G push origin dev', UNKNOWN],
      ["env \"$X=\\$(git push origin dev)\" bash -xc true", UNKNOWN],
      ['export SHA=$(git rev-parse HEAD); git push origin dev', WORKTREE],
      ["git commit -m 'PS4 fix'; git push origin dev", WORKTREE],
      ["PS4='+ '; export PS4; git push origin dev", UNKNOWN],
      ["PS4='+ '; export PS4='+ '; git push origin dev", WORKTREE],
      ['SHA=$(git rev-parse HEAD); git push origin "$SHA"', WORKTREE],
      ['X=1; read -r Y <<< "$X"; git status', ''],
      ['printf -v Y %s "$X"; git status', ''],
    ]);
  });

  it('denies a bash -c or eval string it cannot read when the command names push', async () => {
    await expect([
      ['bash -c "$(echo git push origin dev)"', UNKNOWN],
      ['eval "$X push"', UNKNOWN],
      ['eval $(echo git push origin dev)', UNKNOWN],
      ['bash -c $(echo git) push', UNKNOWN],
      ['sh -c "$CMD" push', UNKNOWN],
      ['echo git push origin dev | sh', UNKNOWN],
      ["bash <<<'git push origin dev'", UNKNOWN],
      ['bash -s <<EOF\ngit push origin dev\nEOF', UNKNOWN],
      ['echo ${X@P} push', UNKNOWN],
      ["bash -o pipefail -c 'git push origin dev'", WORKTREE],
      ["bash -c -x 'git push origin dev'", WORKTREE],
      ["bash -c 'git status'", ''],
      ["eval 'git status'", ''],
      ['bash -c "$(echo git status)"', ''],
      ["bash -c 'echo $HOME'", ''],
    ]);
  });
});

describe('cmdStatements marks code it cannot read (GH 2635)', () => {
  it('marks a non-literal code string opaque and still lists what it can read', async () => {
    const out = await cmdStatements('bash -c "git log $X"', '/w', {});
    assert.ok(out.ok);
    assert.deepEqual(
      out.statements.map((s) => [s.stmt, s.opaque ?? false]),
      [
        ['bash -c git_log_$X', true],
        ['git log $X', false],
      ],
    );
  });

  it('lists a trap action after the trap, in `-`', async () => {
    const out = await cmdStatements("cd /a; trap 'git status' EXIT", '/w', {});
    assert.ok(out.ok);
    assert.deepEqual(
      out.statements.map((s) => [s.dir, s.stmt]),
      [
        ['-', 'cd /a'],
        ['/a', 'trap git_status EXIT'],
        ['-', 'git status'],
      ],
    );
  });

  it('reads a heredoc body $( ) from the parse tree and a backtick from the text (F680-5)', async () => {
    const stmts = async (command: string): Promise<string[] | null> => {
      const out = await cmdStatements(command, '/w', {});
      return out.ok ? out.statements.map((s) => s.stmt) : null;
    };
    assert.deepEqual(await stmts('cat <<EOF\na $(b "c)") `d \\`e\\`` x \\$(f) $(( $(g) ))\nEOF'), ['b c_', 'd', 'e', 'g', 'cat <<EOF $_b_c__ $_d__e__ $___$_g____']);
    assert.deepEqual(await stmts('cat <<EOF\n$(a # )\nb\n)\nEOF'), ['a', 'b', 'cat <<EOF $_a__b__']);
    assert.equal(await stmts('cat <<EOF\n$(a\nEOF'), null);
    assert.equal(await stmts('cat <<EOF\n`a\nEOF'), null);
    assert.equal(await stmts('cat <<-EOF\n\t$(a\n\tEOF'), null);
  });

  it('reads a heredoc body $(( )) as bash does: arithmetic runs no command, a paren group that closes early is a $( ) (GH 2876)', async () => {
    const stmts = async (command: string): Promise<string[] | null> => {
      const out = await cmdStatements(command, '/w', {});
      return out.ok ? out.statements.map((s) => s.stmt) : null;
    };
    assert.deepEqual(await stmts('cat <<EOF\n$((W=0)) $((a+1))\nEOF'), ['cat <<EOF']);
    assert.deepEqual(await stmts('cat <<-EOF\n\t$((W=0))\n\tEOF'), ['cat <<EOF']);
    assert.deepEqual(await stmts('cat <<EOF\n$((a);(b))\nEOF'), ['a', 'b', 'cat <<EOF $__a___b__']);
    assert.deepEqual(await stmts('cat <<EOF\n$((a) )\nEOF'), ['a', 'cat <<EOF $__a___']);
    await expect([
      ['cat <<EOF\n$((git push origin dev);(true))\nEOF', WORKTREE],
      ['cat <<EOF\n$((git push origin dev) )\nEOF', WORKTREE],
      ['cat <<EOF\n$((`git push origin dev`))\nEOF', WORKTREE],
      ['cat <<EOF\n$((W=0))\nEOF', ''],
    ]);
  });

  it('keeps a heredoc body $(( )) holding a quote, ; or other non-arithmetic char as code, since zsh runs it as a command (F823-1)', async () => {
    await expect([
      ['cat <<EOF\n$((echo ")";git push origin dev))\nEOF', WORKTREE],
      ['cat <<EOF\n$((echo "(" ;git push origin dev))\nEOF', WORKTREE],
      ["cat <<EOF\n$((echo ')';git push origin dev))\nEOF", WORKTREE],
      ['cat <<EOF\n$((a|git push origin dev))\nEOF', WORKTREE],
      ['cat <<EOF\n$((a&git push origin dev))\nEOF', WORKTREE],
      ['cat <<EOF\n$((a\ngit push origin dev))\nEOF', WORKTREE],
      ['cat <<EOF\n$((x[1]=a?b:c, ~d^e<<2))\nEOF', ''],
    ]);
  });
});
