/**
 * prepush-hook-guard (GH 3281 slice 2, SC9): an agent's Bash command may not
 * skip, disable or replace TMB's pre-push hook, nor strip the agent mark; the
 * Human is never gated, and ordinary git use passes.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { prepushHookGuard, prepushHookGuardWith, standsDownFor } from '../hooks/prepush-hook-guard.js';
import { findGate, gateNames, ROUTER_GROUPS } from '../hooks/registry.js';
import { PLUGIN_ROOT } from './hook-sandbox.js';

const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const MARKS = ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'TMB_AGENT_SHELL'] as const;
const SCHEMA = readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema.sql'), 'utf8');

let dir: string;
let repo: string;
let separate: string;
let store: string;

function human(): NodeJS.ProcessEnv {
  // No DB: the forms below are judged with no repo exempt.
  const env: NodeJS.ProcessEnv = { ...process.env, ...GIT_ENV, TRAJECTORY_DB_PATH: join(tmpdir(), 'prepush-hook-guard-no.db') };
  delete env.CLAUDE_PROJECT_DIR;
  for (const k of MARKS) delete env[k];
  return env;
}
const agent = (): NodeJS.ProcessEnv => ({ ...human(), CLAUDECODE: '1' });

async function reason(command: string, cwd = repo, env = agent()): Promise<string> {
  const r = await prepushHookGuard(JSON.stringify({ tool_name: 'Bash', cwd, tool_input: { command } }), env);
  if (r.stdout === '') return '';
  const out = JSON.parse(r.stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  return out.hookSpecificOutput.permissionDecisionReason;
}

async function assertDenied(command: string, phrase: string | RegExp, cwd = repo): Promise<void> {
  const why = await reason(command, cwd);
  assert.notEqual(why, '', `expected a deny for: ${command}`);
  if (typeof phrase === 'string') assert.ok(why.includes(phrase), `${command}\n${why}`);
  else assert.match(why, phrase, command);
  assert.ok(why.includes('only observes in this release'), why);
}

before(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'prepush-hook-guard-')));
  repo = join(dir, 'repo');
  separate = join(dir, 'separate');
  store = join(dir, 'store.git');
  const git = (...args: string[]) => execFileSync('git', args, { env: { ...process.env, ...GIT_ENV }, timeout: 10_000 });
  git('init', '-q', repo);
  git('init', '-q', `--separate-git-dir=${store}`, separate);
});
after(() => rmSync(dir, { recursive: true, force: true }));

describe('prepush-hook-guard denies each way to skip the hook (SC9)', () => {
  const forms: readonly (readonly [string, string, string | RegExp])[] = [
    ['(a) push --no-verify', 'git push --no-verify origin main', '`git push --no-verify`'],
    ['(a) a unique prefix of --no-verify', 'git push --no-veri origin main', '`git push --no-veri`'],
    ['(b) -c hook.tmb.enabled=false', 'git -c hook.tmb.enabled=false push', '`git -c hook.tmb.enabled=false`'],
    ['(b) -c hook.pre-push.enabled=false', 'git -c hook.pre-push.enabled=false push origin main', 'hook.pre-push.enabled=false'],
    ['(b) -c hook.tmb.event= (empty)', 'git -c hook.tmb.event= push', 'hook.tmb.event='],
    ['(b) -c hook.tmb.command=X', 'git -c hook.tmb.command=true push', 'hook.tmb.command=true'],
    ['(b) --config-env with a hook key', 'git --config-env=hook.tmb.command=X push', '--config-env=hook.tmb.command=X'],
    ['(b) a hook key in another case, on another subcommand', 'git -c HOOK.tmb.enabled=false status', 'HOOK.tmb.enabled=false'],
    ['(c) GIT_CONFIG_COUNT prefix assignment', 'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=hook.tmb.enabled GIT_CONFIG_VALUE_0=false git push', 'setting GIT_CONFIG_COUNT'],
    ['(c) GIT_CONFIG_KEY_n through env', 'env GIT_CONFIG_KEY_0=hook.tmb.enabled git push', 'setting GIT_CONFIG_KEY_0'],
    ['(c) GIT_CONFIG_PARAMETERS through export', `export GIT_CONFIG_PARAMETERS="'hook.tmb.enabled'='false'"`, 'setting GIT_CONFIG_PARAMETERS'],
    ['(c) a GIT_CONFIG_VALUE_n exported by name', 'GIT_CONFIG_VALUE_0=false; export GIT_CONFIG_VALUE_0', 'GIT_CONFIG_VALUE_0'],
    ['(d) git config <hook key> <value>', 'git config hook.tmb.enabled false', 'which writes hook.tmb.enabled'],
    ['(d) --global scope', 'git config --global hook.pre-push.enabled false', 'which writes hook.pre-push.enabled'],
    ['(d) set', 'git config set hook.tmb.enabled false', 'which writes hook.tmb.enabled'],
    ['(d) unset', 'git config unset hook.tmb.command', 'which writes hook.tmb.command'],
    ['(d) --add', 'git config --add hook.tmb.event pre-commit', 'which writes hook.tmb.event'],
    ['(d) --unset-all', 'git config --unset-all hook.tmb.command', 'which writes hook.tmb.command'],
    ['(d) --remove-section', 'git config --remove-section hook.tmb', 'which writes hook.tmb'],
    ['(d) --rename-section', 'git config --rename-section hook.tmb hook.old', 'which writes hook.tmb'],
    ['(d) extensions.worktreeConfig', 'git config extensions.worktreeConfig true', 'which writes extensions.worktreeConfig'],
    ['(e) a redirect into the git config file', 'echo x >> .git/config', /a write to .*\/repo\/\.git\/config/],
    ['(e) rm of the hook dir', 'rm -rf .git/tmb', /a write to .*\/\.git\/tmb/],
    ['(e) mv of the hook script', 'mv .git/tmb/pre-push /tmp/pre-push.bak', /\.git\/tmb\/pre-push/],
    ['(e) cp over the hook script', 'cp /dev/null .git/tmb/pre-push', /\.git\/tmb\/pre-push/],
    ['(e) chmod of the hook script', 'chmod -x .git/tmb/pre-push', /`chmod` of .*\.git\/tmb\/pre-push/],
    ['(e) chmod through the common dir git names', 'chmod 000 "$(git rev-parse --git-common-dir)/tmb/pre-push"', /`chmod` of .*tmb\/pre-push/],
    ['(e) sed -i on the git config file', "sed -i.bak 's/true/false/' .git/config", /\.git\/config/],
    ['(e) tee into the hook script', 'echo exit 0 | tee .git/tmb/pre-push', /\.git\/tmb\/pre-push/],
    ['(f) unset', 'unset TMB_AGENT_SHELL; git push', '`unset TMB_AGENT_SHELL`'],
    ['(f) env -u', 'env -u TMB_AGENT_SHELL git push', '`env -u TMB_AGENT_SHELL`'],
    ['(f) env -i', 'env -i PATH=/usr/bin git push', '`env -i`'],
    ['(f) an empty prefix value', 'TMB_AGENT_SHELL= git push', 'setting TMB_AGENT_SHELL to anything but 1'],
    ['(f) another prefix value', 'TMB_AGENT_SHELL=0 git push', 'setting TMB_AGENT_SHELL to anything but 1'],
    ['(f) export of another value', 'export TMB_AGENT_SHELL=no', 'setting TMB_AGENT_SHELL to anything but 1'],
    ['(f) export -n', 'export -n TMB_AGENT_SHELL', '`export -n TMB_AGENT_SHELL`'],
    ['(f) inside a bash -c body', "bash -c 'unset TMB_AGENT_SHELL; git push'", '`unset TMB_AGENT_SHELL`'],
    ['(f) inside an eval body', 'eval "env -u TMB_AGENT_SHELL git push"', '`env -u TMB_AGENT_SHELL`'],
  ];
  for (const [name, command, phrase] of forms) {
    it(name, async () => assertDenied(command, phrase));
  }

  it('(e) the hook dir of a common dir not named .git', async () => {
    await assertDenied(`rm -rf ${store}/tmb`, `a write to ${store}/tmb`, separate);
  });

  // F101-1: a git word whose value bash only knows when it runs is judged unknown, never as its literal text.
  const unresolved: readonly (readonly [string, string, string | RegExp])[] = [
    ['(d) a hook key set from a $( ) that cut the statement', 'git config hook.tmb.enabled $(echo false)', 'which writes hook.tmb.enabled'],
    ['(a) a push option from a $( )', 'git push $(echo --no-verify)', /cannot tell what this git command runs: `git push \$\(…\)`/],
    ['(a) a push option from a backtick', 'git push origin `echo --no-verify`', /`git push origin \$\(…\)` takes an argument from/],
    ['(a) a push option from a variable', 'x=--no-verify; git push $x', /`git push \$x` takes an argument from \$x, which may be --no-verify/],
    ['(a) a push option from a quoted variable', 'git push origin "$BR"', /takes an argument from \$BR/],
    ['(a) a push option from a brace pattern', 'git push origin {--no-verify,main}', /takes an argument from \{--no-verify,main\}/],
    ['(d) a config key from a variable', 'git config "$K" false', /takes its key, an action or an option before the key from \$K/],
    ['(d) a config key glued to a $( )', 'git config h$(echo ook.tmb.enabled) false', /from h\$\(…\)/],
    ['(d) a config action from a variable', 'git config "$ACTION" hook.tmb.enabled', /from \$ACTION/],
    ['(b) a -c key from a variable', 'git -c "$KV" push', /`git -c \$KV` takes its config key from \$KV/],
    ['(b) a hook key whose -c value expands unquoted', 'git -c hook.tmb.enabled=$V push', /takes git's subcommand, or an option before it/],
    ['(b) an unquoted -c value bash may split into a hook key', 'git -c color.ui=$C push', /takes git's subcommand, or an option before it/],
  ];
  for (const [name, command, phrase] of unresolved) {
    it(name, async () => assertDenied(command, phrase));
  }

  it('a command that does not parse and names a form is denied with the parse reason', async () => {
    const why = await reason('git push --no-verify "$(');
    assert.match(why, /could not read this command/);
    assert.match(why, /could not parse/);
  });
});

describe('prepush-hook-guard allows ordinary use (SC9)', () => {
  const allowed = [
    'git push origin main',
    'git push -u origin feat/x',
    'git push origin feat/push-gate-prepush-observe',
    'git push origin -- "$BR"',
    'git config user.name someone',
    'git config user.name "$NAME"',
    'git config user.name $(whoami)',
    'git -c "color.ui=$C" log --oneline',
    'git -C "$DIR" log --oneline',
    'git commit -m "$(cat msg)"',
    'git config --get hook.tmb.command',
    'git config hook.tmb.command',
    'git config --list',
    'git -c color.ui=never log --oneline',
    'git hook list pre-push',
    'cat .git/config',
    'export TMB_AGENT_SHELL=1',
    'TMB_AGENT_SHELL=1 git push',
    'env FOO=1 git push',
    'echo hi > out.txt',
    'rm -rf build',
    'echo "$(" unbalanced',
  ];
  for (const command of allowed) {
    it(command, async () => assert.equal(await reason(command), ''));
  }

  it("the Human's command is never gated", async () => {
    assert.equal(await reason('git push --no-verify origin main', repo, human()), '');
    assert.equal(await reason('unset TMB_AGENT_SHELL', repo, human()), '');
  });

  it('a session marked only by TMB_AGENT_SHELL=1 is gated', async () => {
    assert.notEqual(await reason('git push --no-verify', repo, { ...human(), TMB_AGENT_SHELL: '1' }), '');
  });

  it('is registered as a PreToolUse Bash enforcement gate', () => {
    assert.equal(findGate('prepush-hook-guard'), prepushHookGuard);
    assert.ok(gateNames().includes('prepush-hook-guard'));
    const bash = ROUTER_GROUPS.find((g) => g.event === 'PreToolUse' && g.matcher === 'Bash' && g.part === undefined);
    assert.ok(bash?.gates.some((g) => g.name === 'prepush-hook-guard' && g.kind === 'enforcement'));
  });
});

describe('prepush-hook-guard stands down through one predicate (SC9)', () => {
  it('admits every form when standsDown answers true, for the repo the form lands in', async () => {
    const roots: string[] = [];
    const gate = prepushHookGuardWith((root) => {
      roots.push(root);
      return true;
    });
    for (const command of ['git push --no-verify', 'unset TMB_AGENT_SHELL', 'rm -rf .git/tmb', 'git push --no-verify "$(']) {
      const r = await gate(JSON.stringify({ tool_name: 'Bash', cwd: repo, tool_input: { command } }), agent());
      assert.equal(r.stdout, '', command);
    }
    assert.deepEqual(roots, [repo, repo, repo, repo]);
  });

  it('denies when standsDown answers false', async () => {
    const gate = prepushHookGuardWith(() => false);
    const r = await gate(JSON.stringify({ tool_name: 'Bash', cwd: repo, tool_input: { command: 'git push --no-verify' } }), agent());
    assert.notEqual(r.stdout, '');
  });
});

describe('prepush-hook-guard stands down in an exempt repo (SC10)', () => {
  let free: string;
  let held: string;
  let db: string;
  const withDb = (path = db): NodeJS.ProcessEnv => ({ ...agent(), TRAJECTORY_DB_PATH: path });
  const deniedIn = async (command: string, cwd: string, env = withDb()): Promise<boolean> => (await reason(command, cwd, env)) !== '';

  before(() => {
    free = join(dir, 'free');
    held = join(dir, 'held');
    for (const r of [free, held]) execFileSync('git', ['init', '-q', r], { env: { ...process.env, ...GIT_ENV }, timeout: 10_000 });
    db = join(dir, 'trajectory.db');
    const d = new DatabaseSync(db);
    try {
      d.exec(SCHEMA);
      // scan_run registers a new repo exempt (GH 3279); onboarding gives a repo its own mode.
      d.prepare('INSERT INTO repos (name, path, mode) VALUES (?, ?, ?)').run('free', free, 'exempt');
      d.prepare('INSERT INTO repos (name, path, mode) VALUES (?, ?, ?)').run('held', held, 'truest');
    } finally {
      d.close();
    }
  });

  const forms = ['git push --no-verify', 'git -c hook.tmb.enabled=false push', 'unset TMB_AGENT_SHELL', 'rm -rf .git/tmb'];
  for (const command of forms) {
    it(`${command}: passes in the exempt repo, denied in the truest one`, async () => {
      assert.equal(await deniedIn(command, free), false);
      assert.equal(await deniedIn(command, held), true);
    });
  }

  it('goes by the repo the command acts on, not the shell cwd', async () => {
    assert.equal(await deniedIn(`git -C ${free} push --no-verify`, held), false);
    assert.equal(await deniedIn(`git -C ${held} push --no-verify`, free), true);
    assert.equal(await deniedIn(`git -C ${held} -c hook.tmb.enabled=false push`, free), true);
    assert.equal(await deniedIn(`rm -rf ${held}/.git/tmb`, free), true);
    assert.equal(await deniedIn(`rm -rf ${free}/.git/tmb`, held), false);
    assert.equal(await deniedIn(`git -C ${free} push $(echo --no-verify)`, held), false);
    assert.equal(await deniedIn(`git -C ${held} push $(echo --no-verify)`, free), true);
  });

  it('a DB that does not read, or is missing, keeps the deny', async () => {
    const junk = join(dir, 'junk.db');
    writeFileSync(junk, 'not a sqlite file');
    assert.equal(await deniedIn('git push --no-verify', free, withDb(junk)), true);
    assert.equal(await deniedIn('git push --no-verify', free, withDb(join(dir, 'missing.db'))), true);
  });

  it('standsDownFor answers from the stored mode', () => {
    assert.equal(standsDownFor(free, withDb()), true);
    assert.equal(standsDownFor(held, withDb()), false);
    assert.equal(standsDownFor('', withDb()), false);
  });
});
