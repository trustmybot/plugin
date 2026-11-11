/**
 * The TypeScript git-push-guard where it is stricter than
 * the bash git-push-guard.sh (decision 369): a command naming `push`
 * that encode() cannot parse faithfully is denied with PARSE_REASON, where the
 * .sh judges its misread statements (GH 1927). tree-sitter-bash runs a heredoc
 * whose delimiter is quoted mid-word (`<<E"M"`) or whose body holds a lone `$`
 * line to the end of the command, hiding the push after it inside the body.
 * The rebased-commit deny names cli.js integrate where the .sh named its
 * shell script (decision 703, GH 1692). git is git by its basename, read past
 * its known global options (GH 2647), and an unquoted expansion in `-C`'s
 * value leaves the subcommand unknown (GH 2643) unless it resolves to a
 * literal assignment bash cannot split or glob. A push split by a
 * backslash-newline (GH 2646) or spelled with `$'…'` escapes (GH 2640) is read
 * as bash joins and decodes it; an escape whose result is unknown denies.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bashParser } from '../hooks/cmd-analysis/parser.js';
import { encode } from '../hooks/cmd-analysis/encode.js';
import { cmdStatements } from '../hooks/cmd-analysis/index.js';
import { gitPushGuard, PARSE_FIX, PARSE_REASON as PARSE_TEXT, SWE_PUSH_FIX, SWE_PUSH_REASON } from '../hooks/git-push-guard.js';
import { fixedReason } from '../hooks/lib/deny.js';
import { CODE_REVIEWER_ROLE } from '../hooks/lib/role.js';
import { findGate } from '../hooks/registry.js';
import { buildSandbox, materialize } from './hooks-git-push-guard-parity.suite.js';
import { GIT_ENV } from './hook-sandbox.js';

const PARSE_REASON = fixedReason(PARSE_TEXT, PARSE_FIX);
const PUSH_CORPUS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../tests/fixtures/hook-corpus/git-push-guard');
const INTEGRATE = 'node --experimental-sqlite "${CLAUDE_PLUGIN_ROOT}/mcp/trajectory-server/dist/cli.js" integrate <task_id> <base>';

const MID_WORD_QUOTE = (wt: string) => `W=${wt}; cat <<E"M"\nx\nEM\ngit -C $W push origin HEAD`;
const DOLLAR_LINE = (wt: string) => `W=${wt}; cat <<EOF\n$\nEOF\ngit -C $W push origin HEAD`;

function payload(command: string, cwd: string): string {
  return JSON.stringify({ tool_name: 'Bash', cwd, tool_input: { command } });
}

function reason(stdout: string): string {
  if (stdout === '') return '';
  const out = JSON.parse(stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  return out.hookSpecificOutput.permissionDecisionReason;
}

describe('git-push-guard: GH 1927 misparsed heredocs fail closed', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;
  before(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-gpg-')));
    env = { ...process.env, CLAUDE_PROJECT_DIR: dir, TRAJECTORY_DB_PATH: join(dir, 'none.db') };
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('encode() reports both shapes as not ok', async () => {
    const parser = await bashParser();
    for (const shape of [MID_WORD_QUOTE, DOLLAR_LINE]) assert.equal(encode(parser, shape('/w/r')).ok, false, shape('/w/r'));
  });

  it('encode() still parses a heredoc whose delimiter line ends it', async () => {
    const parser = await bashParser();
    assert.equal(encode(parser, 'W=/w/r; cat <<EOF\nx\nEOF\ngit -C $W push origin HEAD').ok, true);
    assert.equal(encode(parser, 'cat <<"EM"\n$x\nEM\ngit push').ok, true);
  });

  it('cmdStatements() fails closed on both shapes, directly and inside bash -c', async () => {
    for (const shape of [MID_WORD_QUOTE, DOLLAR_LINE]) {
      assert.deepEqual(await cmdStatements(shape(`${dir}/.claude/worktrees/t`), dir, env), { ok: false });
      const inner = `bash -c '${shape(`${dir}/.claude/worktrees/t`).replaceAll("'", `'"'"'`)}'`;
      assert.deepEqual(await cmdStatements(inner, dir, env), { ok: false }, inner);
    }
  });

  it('the gate denies the mid-word-quoted delimiter shape with the parse reason', async () => {
    const r = await gitPushGuard(payload(MID_WORD_QUOTE(`${dir}/.claude/worktrees/t`), dir), env);
    assert.equal(r.code, 0);
    assert.equal(reason(r.stdout), PARSE_REASON);
  });

  it('the gate denies the lone-$ body line shape with the parse reason', async () => {
    const r = await gitPushGuard(payload(DOLLAR_LINE(`${dir}/.claude/worktrees/t`), dir), env);
    assert.equal(r.code, 0);
    assert.equal(reason(r.stdout), PARSE_REASON);
  });

  it('a well-terminated heredoc before a worktree push gets the worktree deny, not the parse deny', async () => {
    const r = await gitPushGuard(payload(`W=${dir}/.claude/worktrees/t; cat <<EOF\nx\nEOF\ngit -C "$W" push origin HEAD`, dir), env);
    const why = reason(r.stdout);
    assert.notEqual(why, PARSE_REASON);
    assert.match(why, /push from \.claude\/worktrees\/ is forbidden/);
  });

  it('an unparseable command that never names push is allowed untouched', async () => {
    const r = await gitPushGuard(payload(`cat <<E"M"\nx\nEM\ngit -C ${dir} status`, dir), env);
    assert.deepEqual(r, { stdout: '', code: 0 });
  });

  it('an unparseable command whose git words hold an expansion gets the parse deny (GH 2634)', async () => {
    const r = await gitPushGuard(payload(`W=${dir}; cat <<E"M"\nx\nEM\ngit -C $W $sub`, dir), env);
    assert.equal(reason(r.stdout), PARSE_REASON);
  });
});

describe('git-push-guard: GH 1692 the rebased-commit deny names cli.js integrate', () => {
  let sandbox: string;
  before(() => {
    sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-gpg-integrate-')));
    buildSandbox(sandbox);
  });
  after(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  for (const [file, phrase] of [
    ['deny-unchecked-rebase.json', 'no passing verification run for this commit'],
    ['deny-unchecked-rebase-regenerated-dist.json', 'rebase with regenerated dist'],
    ['deny-unchecked-rebase-unreviewed-task.json', 'the task has no passing review'],
  ] as const) {
    it(`${file}: the deny ends with the cli.js integrate invocation`, async () => {
      const c = materialize(join(PUSH_CORPUS, file), sandbox);
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        CLAUDE_PROJECT_DIR: join(sandbox, 'project'),
        TRAJECTORY_DB_PATH: join(sandbox, 'db/trajectory.db'),
        ...c.env,
      };
      const why = reason((await gitPushGuard(c.input, env)).stdout);
      assert.ok(why.includes(phrase), why);
      assert.ok(why.includes('Then rebase it with cli.js integrate, which re-runs verification[]'), why);
      assert.ok(why.endsWith(` Allowed form: ${INTEGRATE}`), why);
      assert.ok(!why.includes('skills/tmb_planning/scripts'), why);
    });
  }
});

describe("git-push-guard: GH 2549 an empty quoted git -C '' value still names the push", () => {
  let root: string;
  let repo: string;
  let env: NodeJS.ProcessEnv;
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-gpg-2549-')));
    repo = join(root, 'repo');
    env = { ...process.env, ...GIT_ENV, CLAUDE_PROJECT_DIR: repo, TRAJECTORY_DB_PATH: join(root, 'none.db') };
    git(root, 'init', '-q', '-b', 'dev', repo);
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
    git(repo, 'worktree', 'add', '-q', '-b', 'fix/x', join(repo, 'wt'));
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  for (const command of ["git -C '' push origin dev", 'git -C "" push origin dev', '/usr/bin/git push origin dev', './git push origin dev'])
    it(`${command}: swe gets the SWE push deny`, async () => {
      const input = JSON.stringify({ tool_name: 'Bash', cwd: repo, agent_type: 'tmb:swe', tool_input: { command } });
      assert.equal(reason((await gitPushGuard(input, env)).stdout), fixedReason(SWE_PUSH_REASON, SWE_PUSH_FIX));
    });

  it("git -C '' push origin dev: bro in a repo with linked worktrees gets the ambiguous-target deny", async () => {
    const why = reason((await gitPushGuard(payload("git -C '' push origin dev", repo), env)).stdout);
    assert.match(why, /^BLOCKED: ambiguous_git_target: /);
    assert.ok(why.endsWith(' Allowed form: git -C <path> push origin dev'), why);
  });
});

describe('git-push-guard: GH 2647 git by basename and past its known global options', () => {
  let root: string;
  let repo: string;
  let wt: string;
  let env: NodeJS.ProcessEnv;
  const WORKTREE = /^BLOCKED: push from \.claude\/worktrees\/ is forbidden/;
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  const run = async (command: string, cwd: string, agent?: string) =>
    reason((await gitPushGuard(JSON.stringify({ tool_name: 'Bash', cwd, ...(agent ? { agent_type: agent } : {}), tool_input: { command } }), env)).stdout);
  before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-gpg-2647-')));
    repo = join(root, 'repo');
    wt = join(repo, '.claude/worktrees/t');
    env = { ...process.env, ...GIT_ENV, CLAUDE_PROJECT_DIR: repo, TRAJECTORY_DB_PATH: join(root, 'none.db') };
    git(root, 'init', '-q', '-b', 'dev', repo);
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
    git(repo, 'worktree', 'add', '-q', '-b', 'fix/x', wt);
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  for (const command of ['/usr/bin/git push origin dev', './git push origin dev', 'bin/git push origin dev', 'git --attr-source HEAD push origin dev', '/usr/bin/git --no-pager push'])
    it(`${command}: from a .claude/worktrees/ cwd gets the worktree deny`, async () => {
      assert.match(await run(command, wt), WORKTREE);
    });

  it('/usr/bin/git -C <main checkout> push: runs in the main checkout, and swe gets the SWE push deny from a worktree cwd', async () => {
    const listed = await cmdStatements(`/usr/bin/git -C ${repo} push origin dev`, wt, env);
    assert.ok(listed.ok);
    assert.deepEqual(
      listed.statements.map((s) => s.dir),
      [repo],
    );
    assert.equal(await run(`/usr/bin/git -C ${repo} push origin dev`, wt, 'tmb:swe'), fixedReason(SWE_PUSH_REASON, SWE_PUSH_FIX));
  });

  it('/usr/bin/git -C <worktree> push and git --attr-source HEAD -C <worktree> push from the main checkout get the worktree deny', async () => {
    assert.match(await run(`/usr/bin/git -C ${wt} push origin dev`, repo), WORKTREE);
    assert.match(await run(`git --attr-source HEAD -C ${wt} push origin dev`, repo), WORKTREE);
    assert.match(await run(`git --git-dir ${repo}/.git -C ${wt} push origin dev`, repo), WORKTREE);
  });

  for (const command of ['/usr/bin/git status', 'git --attr-source HEAD status', '/usr/bin/git --attr-source HEAD log -1 --format=push'])
    it(`${command}: is allowed`, async () => {
      assert.equal(await run(command, wt), '');
    });
});

describe('git-push-guard: GH 2643 an unquoted expansion in git -C may split into the subcommand', () => {
  let dir: string;
  let wt: string;
  let env: NodeJS.ProcessEnv;
  before(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-gpg-2643-')));
    wt = join(dir, '.claude/worktrees/t');
    mkdirSync(wt, { recursive: true });
    env = { ...process.env, CLAUDE_PROJECT_DIR: dir, TRAJECTORY_DB_PATH: join(dir, 'none.db') };
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  for (const command of [
    "W='/x push'; git -C $W status",
    'git -C $(echo /x push) status',
    'git -C $W status',
    'W=; git -C $W status',
    'W=/x*; git -C $W status',
    'W=/x{a,b}; git -C $W status',
    'W=$(echo /x); git -C $W status',
  ])
    it(`${command}: from a worktree cwd gets the ambiguous-subcommand deny`, async () => {
      assert.match(reason((await gitPushGuard(payload(command, wt), env)).stdout), /^BLOCKED: ambiguous_git_subcommand: /);
    });

  it('the ambiguous-subcommand deny names the double-quoted option value form as allowed', async () => {
    const text = reason((await gitPushGuard(payload("W='/x push'; git -C $W status", wt), env)).stdout);
    assert.ok(text.includes(' An option value in double quotes, such as `git -C "$W" status`, is allowed.'), text);
  });

  it('W=/x; git -C "$W" status: from a worktree cwd is allowed', async () => {
    assert.equal(reason((await gitPushGuard(payload('W=/x; git -C "$W" status', wt), env)).stdout), '');
  });

  for (const command of ['W=/x; git -C $W status', 'W=/x; git -C ${W} status', 'W=/x; git --git-dir=$W/.git status'])
    it(`${command}: a literal one-word assignment bash cannot split is allowed from a worktree cwd`, async () => {
      assert.equal(reason((await gitPushGuard(payload(command, wt), env)).stdout), '');
    });

  it('W=<worktree>; git -C $W push: a literal one-word assignment is judged as the push it is', async () => {
    assert.match(reason((await gitPushGuard(payload(`W=${wt}; git -C $W push origin dev`, wt), env)).stdout), /push from \.claude\/worktrees\/ is forbidden/);
  });
});

describe('git-push-guard: GH 2646 / GH 2640 a push behind a line continuation or $\'…\' escape is still a push', () => {
  let root: string;
  let wt: string;
  let env: NodeJS.ProcessEnv;
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-gpg-2646-')));
    const repo = join(root, 'repo');
    wt = join(repo, '.claude/worktrees/t');
    env = { ...process.env, ...GIT_ENV, CLAUDE_PROJECT_DIR: repo, TRAJECTORY_DB_PATH: join(root, 'none.db') };
    git(root, 'init', '-q', '-b', 'dev', repo);
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
    git(repo, 'worktree', 'add', '-q', '-b', 'fix/x', wt);
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  const gate = async (command: string) => gitPushGuard(payload(command, wt), env);

  for (const command of ['git \\\npush origin dev', 'git pu\\\nsh origin dev', 'git "pu\\\nsh" origin dev', 'git pu\\\n\\\nsh origin dev', '/usr/bin/git push origin dev'])
    it(`${JSON.stringify(command)} gets the worktree deny`, async () => {
      assert.match(reason((await gate(command)).stdout), /^BLOCKED: push from \.claude\/worktrees\/ is forbidden/);
    });

  it('a path-qualified git is git, its -C followed to the dir it pushes from (GH 2987)', async () => {
    const why = reason((await gitPushGuard(payload('/usr/bin/git -C .claude/worktrees/t push origin dev', dirname(dirname(dirname(wt)))), env)).stdout);
    assert.match(why, /^BLOCKED: push from \.claude\/worktrees\/ is forbidden/);
  });

  for (const command of ["git $'\\x70ush' origin dev", "git $'\\160ush' origin dev", "git $'push' origin dev", "git $'\\u0070ush' origin dev", "git $'p\\U00000075sh' origin dev"])
    it(`${command} gets the worktree deny`, async () => {
      assert.match(reason((await gate(command)).stdout), /^BLOCKED: push from \.claude\/worktrees\/ is forbidden/);
    });

  it('p=push; git \\<NL>$p origin dev gets the unknown-subcommand deny, quoting the command as written', async () => {
    const why = reason((await gate('p=push; git \\\n$p origin dev')).stdout);
    assert.match(why, /^BLOCKED: ambiguous_git_subcommand: `git \\\n\$p origin dev`/);
  });

  for (const command of [
    "git $'pu\\csh' origin dev",
    "git $'pu\\x00sh' origin dev",
    "git $'pu\\xsh' origin dev",
    "git $'pu\\c?sh' origin dev",
    "git $'\\ud800push' origin dev",
    "git $'\\xf0push' origin dev",
    "git $'\\360push' origin dev",
  ])
    it(`${command}: an escape whose result is unknown or a control char gets the unknown-subcommand deny`, async () => {
      assert.match(reason((await gate(command)).stdout), /^BLOCKED: ambiguous_git_subcommand: /);
    });

  for (const command of [
    'cat <<EOF\nx\nEO\\\nF\ngit push origin dev\nEOF',
    'cat <<-EOF\nx\n\tE\\\nOF\ngit push origin dev\nEOF',
    'cat <<EOF\nx\nEOF\\\n\ngit push origin dev\nEOF',
    'cat <<EOF\nx\\\nEOF\nEOF\ngit push origin dev',
    'cat <<EOF\nx\\\\\\\nEOF\nEOF\ngit push origin dev',
  ])
    it(`${JSON.stringify(command)}: a heredoc bash ends on a joined delimiter line (F753-1) gets the parse deny`, async () => {
      assert.equal(reason((await gate(command)).stdout), PARSE_REASON);
    });

  it('a body line ending in an escaped backslash does not join the delimiter line after it', async () => {
    assert.match(reason((await gate('cat <<EOF\nx\\\\\nEOF\ngit push origin dev')).stdout), /^BLOCKED: push from \.claude\/worktrees\/ is forbidden/);
  });

  for (const command of [
    'git \\\nstatus',
    "echo 'a\\\nb'",
    "git $'status'",
    "echo $'a\\tb'",
    "echo 'pu\\\nsh'",
    "git $'pu\\\nsh' origin dev",
    "cat <<'EOF'\nEO\\\nF\ngit push origin dev\nEOF",
    'cat <<"EOF"\nEO\\\nF\ngit push origin dev\nEOF',
    'cat <<\\EOF\nEO\\\nF\ngit push origin dev\nEOF',
    'cat <<EOF\nfoo \\\nbar\nEOF\ngit status',
  ])
    it(`${JSON.stringify(command)} is allowed`, async () => {
      assert.deepEqual(await gate(command), { stdout: '', code: 0 });
    });
});

describe('git-push-guard: wiring', () => {
  it('is registered under its gate name', () => {
    assert.equal(findGate('git-push-guard'), gitPushGuard);
  });

  it('names the code-reviewer role through the one shared constant', () => {
    assert.equal(CODE_REVIEWER_ROLE, 'code-reviewer');
  });
});
