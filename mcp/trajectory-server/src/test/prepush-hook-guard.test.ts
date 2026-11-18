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
    // SC3 (c): a push with any expansion but a double-quoted -C, --git-dir or --work-tree value fails closed.
    ['(a) a push option from a $( )', 'git push $(echo --no-verify)', /`git push \$\(…\)` takes \$\(…\), which bash expands when it runs: its value may be --no-verify/],
    ['(a) a push option from a backtick', 'git push origin `echo --no-verify`', /`git push origin \$\(…\)` takes \$\(…\), which bash expands/],
    ['(a) a push option from a variable', 'x=--no-verify; git push $x', /`git push \$x` takes \$x, which bash expands when it runs: its value may be --no-verify/],
    ['(a) a push option from a quoted variable', 'git push origin "$BR"', /takes \$BR, which bash expands/],
    ['(a) a push option from a brace pattern', 'git push origin {--no-verify,main}', /takes \{--no-verify,main\}, which bash expands/],
    ['(c) a push refspec from a quoted variable after --', 'git push origin -- "$BR"', /`git push origin -- \$BR` takes \$BR, which bash expands/],
    ['(c) a push with a quoted -C and an expanded refspec', 'git -C "$WT" push origin "$BR"', /takes \$BR, which bash expands/],
    ['(c) a push with a quoted value of another global option', 'git --namespace="$NS" push origin main', /takes --namespace=\$NS, which bash expands/],
    ['(c) a push behind a wrapper holding an expansion', 'sudo -u "$U" git push origin main', /takes git's subcommand, or an option before it, from text the guard cannot read literally/],
    ['(d) a config key from a variable', 'git config "$K" false', /takes \$K before the key/],
    ['(d) a config key glued to a $( )', 'git config h$(echo ook.tmb.enabled) false', /takes h\$\(…\) before the key/],
    ['(d) a config action from a variable', 'git config "$ACTION" hook.tmb.enabled', 'which writes hook.tmb.enabled'],
    ['(b) a -c key from a variable', 'git -c "$KV" push', /`git -c \$KV push` takes \$KV, which bash expands/],
    ['(b) a -c key from a variable on another subcommand', 'git -c "$KV" status', /`git -c \$KV` takes its config key from \$KV/],
    ['(b) a hook key whose -c value expands unquoted', 'git -c hook.tmb.enabled=$V push', '`git -c hook.tmb.enabled=$V` would skip'],
    ['(b) an unquoted -c value bash may split into a hook key', 'git -c color.ui=$C push', 'Allowed form: git -c color.ui="$C" push'],
    // F101-3 / F101-4 / decision #423: an expanded config word passes only in a read whose literal read form follows
    // fully spelled known literal options, and whose expansions after it are double-quoted single words.
    ['(d) a config read with an unquoted expansion', 'git config --get $KEY', /takes \$KEY unquoted, which bash may split/],
    ['(d) a config read with an unquoted file argument', 'git config -f $F --list', /takes the value of -f from \$F/],
    ['(d) a config read with an unquoted --type argument', 'git config --type $T --get "$K"', /takes --type, which is not a scope flag, a literal --type=<t> or -f\/--file/],
    ['(d) a config read with an unquoted file argument that may glob', 'git config --file "$D"/* --list', /takes the value of --file from \$D\/\*/],
    ['(d) "$@" as a value option argument', 'git config -f "$@" --list', /takes the value of -f from \$@/],
    ['(d) "${a[@]}" as a value option argument', 'git config --file "${a[@]}" --get "$K"', /takes the value of --file from \$\{a\[@\]\}/],
    // SC3 (e), decision #438: before an expanded read's read form only a scope flag, a literal --type=<t>, or -f/--file
    // with a literal or double-quoted path; `O=--comment; git config --type=bool "$O" --get k v` would write k.
    ['(e) an expanded --comment before the read form, a write of a plain key', 'git config --type=bool "$O" --get k.x v', /takes \$O before a literal read form/],
    ['(e) "$@" before the read form, a write of a plain key', 'git config --type=bool "$@" --get k.x v', /takes \$@ before a literal read form/],
    ['(e) an abbreviated option before the read form', 'git config --com --get k.x "$V"', /takes --com, which is not a git config option spelled out in full/],
    ['(e) a literal --comment before an expanded read', 'git config --comment x --get "$K"', /takes --comment, which is not a scope flag/],
    ['(e) --type with its value in the next word', 'git config --type bool --get "$K"', /takes --type, which is not a scope flag/],
    ['(e) -t with its value in the next word', 'git config -t bool --get "$K"', /takes -t, which is not a scope flag/],
    ['(e) a quoted --type value', 'git config --type "$T" --get "$K"', /takes --type, which is not a scope flag/],
    ['(e) a quoted -t value', 'git config -t "$T" --get-regexp "$PAT"', /takes -t, which is not a scope flag/],
    ['(e) an expanded --type= value', 'git config --type="$T" --get "$K"', /takes --type=\$T before a literal read form/],
    ['(e) a quoted --blob value', 'git config --blob "$B" --get-all "$K"', /takes --blob, which is not a scope flag/],
    ['(e) a quoted --default value', 'git config --default "$D" --get "$K"', /takes --default, which is not a scope flag/],
    ['(e) --show-origin before an expanded read', 'git config --global -f "$F" --show-origin -l', /takes --show-origin, which is not a scope flag/],
    ['(d) a quoted file argument glued to its option', 'git config -f"$F" --list', /takes -f\$F before a literal read form/],
    ['(d) a quoted file argument glued with =', 'git config --file="$F" --list', /takes --file=\$F before a literal read form/],
    ['(d) a quoted expansion after a quoted file argument, before the read form', 'git config -f "$F" "$O" --get hook.tmb.enabled false', 'which writes hook.tmb.enabled'],
    ['(d) a quoted expansion after a quoted file argument, no hook key named', 'git config -f "$F" "$O" --get "$K"', /takes \$O before a literal read form/],
    ['(d) a quoted value option argument with no read form', 'git config -f "$F" user.name x', /takes -f, which is not an option a config write with an expansion may carry before its key/],
    ['(d) a quoted value option argument beside a literal write form', 'git config -f "$F" --get --unset "$K"', /takes \$F beside a literal write form/],
    ['(d) a literal read form beside a literal write form', 'git config --get --unset "$K"', /takes \$K beside a literal write form/],
    // Options end at the first other word, so a word before --get makes it a value: `"$O"` there may be --comment.
    ['(d) an expanded word in the action slot', 'git config "$A" --get hook.tmb.enabled', 'which writes hook.tmb.enabled'],
    ['(d) a quoted expansion that may take the read form as its value', 'git config --type=bool "$O" --get hook.tmb.enabled false', 'which writes hook.tmb.enabled'],
    ['(d) a quoted expansion after a literal file argument, before the read form', 'git config -f .git/config "$O" --get hook.tmb.enabled false', 'which writes hook.tmb.enabled'],
    ['(d) a quoted expansion before --get-regexp', 'git config --type=bool "$O" --get-regexp hook.tmb.enabled false', 'which writes hook.tmb.enabled'],
    ['(d) "$@" before the read form', 'git config --type=bool "$@" --get hook.tmb.enabled false', 'which writes hook.tmb.enabled'],
    ['(d) a quoted expansion before the read form, no hook key named', 'git config --type=bool "$O" --get "$K"', /takes \$O before a literal read form/],
    ['(d) "$@" before the read form, no hook key named', 'git config "$@" --get "$K"', /takes \$@ before a literal read form/],
    ['(d) a literal key before the read form', 'git config hook.tmb.enabled --get "$K"', 'which writes hook.tmb.enabled'],
    ['(d) a literal key before a literal --get', 'git config hook.tmb.command --get', 'which writes hook.tmb.command'],
    // F101-4: git takes any unique prefix of an option, so only fully spelled options pass.
    ['(d) an abbreviated option that takes the read form as its value', 'git config --com --get hook.tmb.enabled false', /takes --com, which is not a git config option spelled out in full/],
    ['(d) an abbreviated write option', 'git config --unset-a hook.tmb.command', /takes --unset-a, which is not a git config option spelled out in full/],
    ['(d) an abbreviated --edit', 'git config --ed', /takes --ed, which is not a git config option spelled out in full/],
    ['(d) an abbreviated option before an expanded read', 'git config --bool-or-st --get "$K"', /takes --bool-or-st, which is not a git config option spelled out in full/],
    ['(d) a value option off the read allowlist', 'git config --comment x --get hook.tmb.enabled false', /takes --comment, which is not a fully spelled option a read may carry/],
    ['(d) "$@" after the read form', 'git config --get "$@"', /takes \$@, which may stand for several words/],
    ['(d) "${a[@]}" after the read form', 'git config --get "${a[@]}"', /takes \$\{a\[@\]\}, which may stand for several words/],
    ['(d) "$*" after the read form', 'git config --get "$*"', /takes \$\*, which may stand for several words/],
    ['(d) a get action not right after config', 'git config --global get "$K"', /takes get where a literal key belongs/],
    // SC3 (d): an expanded config write passes only with literal allowlisted options and a literal, non-hook key before it.
    ['(d) a write with a value from a $( )', 'git config user.name $(whoami)', /takes an expansion in words the guard cannot line up/],
    ['(d) a write with an unquoted value', 'git config user.name $NAME', /takes \$NAME unquoted, which bash may split into options/],
    ['(d) a write through the set action', 'git config set user.name "$NAME"', /takes set where a literal key belongs/],
    ['(d) a write with "$@" after the key', 'git config user.name "$@"', /takes \$@, which may stand for several words/],
    ['(d) a write with an option off the allowlist before the key', 'git config --comment x user.name "$NAME"', /takes --comment, which is not an option a config write/],
    ['(d) a write with an expanded --type value', 'git config --type "$T" user.name "$NAME"', /takes the value of --type from \$T/],
    ['(d) a write renaming a section from a variable', 'git config --rename-section "$S" old', /takes --rename-section, which is not an option/],
    ['(d) a write of extensions.worktreeConfig in any case, its value quoted', 'git config EXTENSIONS.WORKTREECONFIG "$V"', 'which writes EXTENSIONS.WORKTREECONFIG'],
    ['(d) a write of a hook key, its value quoted', 'git config --add Hook.tmb.event "$E"', 'which writes Hook.tmb.event'],
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

describe('prepush-hook-guard: an unquoted expansion in a git global option value (SC3 a)', () => {
  // Each deny's allowed form is the agent's own command with each such expansion double-quoted.
  const cases: readonly (readonly [string, string, string])[] = [
    ['-C on status', 'git -C $WT status', 'git -C "$WT" status'],
    ['-C on log', 'git -C $WT log', 'git -C "$WT" log'],
    ['-C on push', 'git -C $WT push origin main', 'git -C "$WT" push origin main'],
    ['--git-dir as a separate word', 'git --git-dir $D status', 'git --git-dir "$D" status'],
    ['--work-tree joined with =', 'git --work-tree=$W status', 'git --work-tree="$W" status'],
    ['-c with an expanded value', 'git -c color.ui=$C log', 'git -c color.ui="$C" log'],
    ['--config-env with an expanded value', 'git --config-env=core.editor=$E commit', 'git --config-env=core.editor="$E" commit'],
    ['a $( ) as the -C value', 'git -C $(pwd) status', 'git -C "$(pwd)" status'],
    ['each one in a list, the rest of the command kept', 'cd /tmp && git -C $A status && git -C $B log', 'cd /tmp && git -C "$A" status && git -C "$B" log'],
    ['half-quoted values', 'git -C $ROOT/"sub dir" status', 'git -C "$ROOT"/"sub dir" status'],
  ];
  for (const [name, command, fixed] of cases) {
    it(name, async () => {
      const why = await reason(command);
      assert.match(why, /an unquoted expansion, which bash splits into words/, why);
      assert.ok(why.endsWith(`Allowed form: ${fixed}`), why);
      assert.ok(why.includes('only observes in this release'), why);
      // The corrected command passes when it is no push with another expansion.
      if (!fixed.includes('push')) assert.equal(await reason(fixed), '', fixed);
    });
  }
});

describe('prepush-hook-guard allows ordinary use (SC9)', () => {
  const allowed = [
    'git push origin main',
    'git push -u origin feat/x',
    'git push origin feat/push-gate-prepush-observe',
    'git config user.name someone',
    'git -c "color.ui=$C" log --oneline',
    'git -C "$DIR" log --oneline',
    // SC3 (b): a double-quoted -C, --git-dir or --work-tree value passes on any subcommand, a push included.
    'git -C "$WT" push origin main',
    'git -C "$WT" push -u origin feat/x',
    'git --git-dir="$D" push origin main',
    'git --work-tree "$W" --git-dir "$D" push origin main',
    'git -C "$WT" status',
    'git -C "$(pwd)/sub" commit -m msg',
    // SC3 (d): a config write with literal allowlisted options, a literal non-hook key and double-quoted expansions after it.
    'git config user.name "$NAME"',
    'git config --global user.email "$EMAIL"',
    'git config --local --add remote.origin.fetch "$SPEC"',
    'git config --type=bool core.bare "$B"',
    'git config -t int core.compression "$N"',
    'git config --replace-all remote.origin.url "$URL" "$OLD"',
    'git config --unset user.name "$PATTERN"',
    'git -C "$WT" config user.name "$NAME"',
    // SC2: the switch named only as an argument to a read-only command, with no redirection.
    'grep -rn TMB_DISABLE_PREPUSH_INSTALL src',
    'rg TMB_DISABLE_PREPUSH_INSTALL docs',
    'git grep -n TMB_DISABLE_PREPUSH_INSTALL',
    'cat notes.txt | grep TMB_DISABLE_PREPUSH_INSTALL',
    'grep -rn TMB_DISABLE_PREPUSH_INSTALL src | head -5',
    'printenv TMB_DISABLE_PREPUSH_INSTALL',
    'echo "$TMB_DISABLE_PREPUSH_INSTALL"',
    'cd src && grep -rln TMB_DISABLE_PREPUSH_INSTALL .',
    'grep -rn "TMB_DISABLE_PREPUSH_INSTALL=1" docs',
    'git commit -m "$(cat msg)"',
    'git config --get hook.tmb.command',
    'git config hook.tmb.command',
    'git config --list',
    // SC9 (decision #423): a literal read form after known literal options makes a git config with
    // double-quoted single-word expansions after it a read.
    'git config --get "$KEY"',
    'git config get "$K"',
    'git config --get remote."$R".url',
    'git config --get-regexp "$PAT"',
    'git config --list --file "$F"',
    'git config --type=bool --get "$K"',
    'git config --global --get user.name',
    'git config core.compression -1',
    'git config -f .git/config --get "$K"',
    'git config --file=.git/config --get-all "$K"',
    'git config --local --file=.git/config --get-all "$K"',
    'git config -f.git/config --worktree --get "$K"',
    'git config --get-all "$K"',
    // Decision #438 narrows only reads with an expansion: a literal read keeps the shipped allowlist before its read form.
    'git config --show-origin --type bool --get user.name',
    'git config -l -f "$F"',
    'git config list --file "$F"',
    'git config --get "$(echo hook.tmb.command)"',
    // Decision #425: a value option's separate-word argument before the read form may be one
    // double-quoted expansion, since git takes that word as the argument whatever it holds.
    'git config -f "$F" --list',
    'git config --file "$F" --get k',
    'git config --file "$F" --get "$K"',
    'git config --global -f "$F" -l',
    'git config -f "$(git rev-parse --git-common-dir)/config" --get "$K"',
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

  it('is registered as a PreToolUse Bash and Write|Edit enforcement gate', () => {
    assert.equal(findGate('prepush-hook-guard'), prepushHookGuard);
    assert.ok(gateNames().includes('prepush-hook-guard'));
    for (const matcher of ['Bash', 'Write|Edit|MultiEdit|NotebookEdit']) {
      const group = ROUTER_GROUPS.find((g) => g.event === 'PreToolUse' && g.matcher === matcher && g.part === undefined);
      assert.ok(group?.gates.some((g) => g.name === 'prepush-hook-guard' && g.kind === 'enforcement'), matcher);
    }
  });
});

describe('prepush-hook-guard: only the Human sets the switch (SC2)', () => {
  const SWITCH = 'TMB_DISABLE_PREPUSH_INSTALL';
  const switchDenied = (why: string): boolean => why.includes(`names ${SWITCH}`) && why.includes('only the Human sets it');

  const commands = [
    `export ${SWITCH}=1`,
    `${SWITCH}=1 claude`,
    `echo ${SWITCH}=1 >> ~/.zshrc`,
    `echo "export ${SWITCH}=1" > "$CLAUDE_ENV_FILE"`,
    `printf 'export %s=1\\n' ${SWITCH} >> ~/.bashrc`,
    `echo ${SWITCH}=1 | tee -a ~/.profile`,
    `sed -i 's/x/${SWITCH}=1/' ~/.zshenv`,
    `cat <<EOF >> ~/.zprofile\nexport ${SWITCH}=1\nEOF`,
    `bash -c 'export ${SWITCH}=1'`,
    `grep ${SWITCH} src > hits.txt`,
    `grep -rn ${SWITCH} src 2>/dev/null`,
    `echo $(echo ${SWITCH}=1 >> ~/.zshrc)`,
    `rg --pre ./run.sh ${SWITCH} src`,
    `git grep -O'sh -c x' ${SWITCH}`,
    `(grep ${SWITCH} src)`,
    `TMB_DISABLE_"PREPUSH"_INSTALL=1 claude`,
    `grep ${SWITCH} src | xargs sed -i s/a/b/`,
    `declare -x ${SWITCH}=1`,
  ];
  for (const command of commands) {
    it(`denies ${JSON.stringify(command)}`, async () => {
      const why = await reason(command);
      assert.ok(switchDenied(why), `${command}\n${why}`);
      assert.match(why, /Allowed form: a read-only grep, rg, git grep, cat, printenv or echo/);
    });
  }

  it('denies in an exempt repo too: the switch reaches every repo', async () => {
    const gate = prepushHookGuardWith(() => true);
    const r = await gate(JSON.stringify({ tool_name: 'Bash', cwd: repo, tool_input: { command: `export ${SWITCH}=1` } }), agent());
    assert.ok(switchDenied(r.stdout));
  });

  it("the Human's command is never gated", async () => {
    assert.equal(await reason(`export ${SWITCH}=1`, repo, human()), '');
  });

  async function edit(tool: string, toolInput: Record<string, unknown>, env = agent()): Promise<string> {
    const r = await prepushHookGuard(JSON.stringify({ tool_name: tool, cwd: repo, tool_input: toolInput }), env);
    return r.stdout;
  }

  const home = '/Users/someone';
  const targets = [
    ['CLAUDE_ENV_FILE', join(dir ?? tmpdir(), 'session-env.sh')],
    ['a project .claude/settings.json', `${home}/proj/.claude/settings.json`],
    ['a project .claude/settings.local.json', `${home}/proj/.claude/settings.local.json`],
    ['the user ~/.claude/settings.json', `${home}/.claude/settings.json`],
    ...['.zshrc', '.zshenv', '.zprofile', '.zlogin', '.bashrc', '.bash_profile', '.bash_login', '.profile'].map((p) => [`the shell profile ${p}`, `${home}/${p}`]),
  ] as const;
  for (const [name, path] of targets) {
    it(`denies an Edit, Write or MultiEdit putting the switch into ${name}`, async () => {
      const env = { ...agent(), CLAUDE_ENV_FILE: join(dir, 'session-env.sh') };
      const file = name === 'CLAUDE_ENV_FILE' ? join(dir, 'session-env.sh') : path;
      const text = file.endsWith('.json') ? `{"env": {"${SWITCH}": "1"}}` : `export ${SWITCH}=1\n`;
      for (const [tool, input] of [
        ['Write', { file_path: file, content: text }],
        ['Edit', { file_path: file, old_string: 'x', new_string: text }],
        ['MultiEdit', { file_path: file, edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'x', new_string: text }] }],
      ] as const) {
        const out = await edit(tool, input, env);
        assert.ok(switchDenied(out), `${tool} ${file}\n${out}`);
      }
      // The same file without the switch, or the switch leaving it, passes.
      assert.equal(await edit('Write', { file_path: file, content: 'export FOO=1\n' }, env), '');
      assert.equal(await edit('Edit', { file_path: file, old_string: `export ${SWITCH}=1`, new_string: '' }, env), '');
      assert.equal(await edit('Write', { file_path: file, content: text }, { ...human(), CLAUDE_ENV_FILE: join(dir, 'session-env.sh') }), '');
    });
  }

  it('passes the switch named in any other file', async () => {
    for (const file of [join(repo, 'docs/INSTALL.md'), join(repo, 'src/settings.json'), join(repo, '.claude/notes.json'), join(repo, 'zshrc.example')]) {
      assert.equal(await edit('Write', { file_path: file, content: `${SWITCH}=1` }), '', file);
    }
  });
});

describe('prepush-hook-guard records each fail-closed deny (SC4)', () => {
  let db: string;
  type Row = { from_node: string; event_type: string; content_json: string };
  const rows = (): Row[] => {
    const d = new DatabaseSync(db);
    try {
      return d.prepare("SELECT from_node, event_type, content_json FROM audit WHERE event_type = 'prepush_observed' ORDER BY id").all() as Row[];
    } finally {
      d.close();
    }
  };

  before(() => {
    db = join(dir, 'observe.db');
    const d = new DatabaseSync(db);
    try {
      d.exec(SCHEMA);
    } finally {
      d.close();
    }
  });

  const cases: readonly (readonly [string, string, string])[] = [
    ['global_option_expansion', 'git -C $WT status', 'git -C $WT status'],
    ['push_expansion', 'git push origin "$BR"', 'git push <arg> "$BR"'],
    ['config_expansion', 'git config user.name $NAME', 'git config <arg> $NAME'],
    ['unresolved', 'git $SUB origin', 'git $SUB <arg>'],
    ['unreadable', 'git push --no-verify "$(', ''],
  ];
  for (const [denyClass, command, form] of cases) {
    it(`a ${denyClass} deny writes one guard_fail_closed row`, async () => {
      const before = rows().length;
      const why = await reason(command, repo, { ...agent(), TRAJECTORY_DB_PATH: db, CLAUDE_CODE_SESSION_ID: 's-1' });
      assert.notEqual(why, '');
      const added = rows().slice(before);
      assert.equal(added.length, 1, command);
      assert.equal(added[0].from_node, 'hook:prepush-hook-guard');
      const c = JSON.parse(added[0].content_json) as Record<string, unknown>;
      assert.equal(c.source, 'guard_fail_closed');
      assert.equal(c.deny_class, denyClass);
      // The row keeps the reason; the deny adds its allowed form.
      assert.ok(typeof c.reason === 'string' && c.reason !== '' && why.startsWith(c.reason), `${String(c.reason)}\n${why}`);
      assert.equal(typeof c.command_form, 'string');
      assert.ok((c.command_form as string).length > 0 && (c.command_form as string).length <= 200, String(c.command_form));
      if (form !== '') assert.equal(c.command_form, form);
      assert.equal(c.hook_verdict, null);
      assert.equal(c.legacy_verdict, null);
      assert.deepEqual(Object.keys(c.hook_live as object).sort(), ['command_matches', 'listed', 'script_intact', 'switched_off']);
    });
  }

  it('masks literal arguments, keeps options, the subcommand and expansions, and caps the form at 200 chars', async () => {
    const before = rows().length;
    const long = `git push --force-with-lease=main:abc 'my remote' "$BR" ${'x'.repeat(300)}`;
    await reason(long, repo, { ...agent(), TRAJECTORY_DB_PATH: db });
    const c = JSON.parse(rows().slice(before)[0].content_json) as { command_form: string };
    assert.equal(c.command_form, 'git push --force-with-lease=<arg> <arg> "$BR" <arg>');
    await reason(`git push origin "$BR" ${'"$X" '.repeat(60)}`, repo, { ...agent(), TRAJECTORY_DB_PATH: db });
    const capped = JSON.parse(rows().at(-1)?.content_json ?? '{}') as { command_form: string };
    assert.equal(capped.command_form.length, 200);
  });

  it('a form deny or a switch deny writes no row', async () => {
    const before = rows().length;
    await reason('git push --no-verify', repo, { ...agent(), TRAJECTORY_DB_PATH: db });
    await reason('export TMB_DISABLE_PREPUSH_INSTALL=1', repo, { ...agent(), TRAJECTORY_DB_PATH: db });
    assert.equal(rows().length, before);
  });

  it('a write that fails leaves the deny unchanged', async () => {
    const junk = join(dir, 'junk-observe.db');
    writeFileSync(junk, 'not a sqlite file');
    const plain = await reason('git push origin "$BR"');
    assert.equal(await reason('git push origin "$BR"', repo, { ...agent(), TRAJECTORY_DB_PATH: junk }), plain);
    assert.equal(await reason('git push origin "$BR"', repo, { ...agent(), TRAJECTORY_DB_PATH: join(dir, 'missing-observe.db') }), plain);
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
