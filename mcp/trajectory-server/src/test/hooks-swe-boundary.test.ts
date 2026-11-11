/**
 * The TypeScript swe-boundary where it differs from
 * the bash swe-boundary.sh (GH 1692), each difference stricter: a
 * command tree-sitter-bash cannot parse is denied with PARSE_REASON, the DB
 * is read through node:sqlite with no sqlite3 CLI on PATH, where the .sh
 * enforces nothing, a gh api verb is upper-cased by toUpperCase in every
 * locale, and a multibyte prompt-surface name the .sh's macOS awk cannot
 * convert is still judged (GH 2030). Also: the analyzer's never-judged write targets are left
 * to containment-guard, a deny record whose time bash's arithmetic rejects
 * ends the gate with no output as it ends the .sh, and the gate is
 * registered by name.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { ambiguousSubcommandReason, CAP_FIX, CAP_REASON, cmdStatements, ghMutation, ghMutationFrom, writePaths } from '../hooks/cmd-analysis/index.js';
import { haveSqlite } from '../hooks/lib/db.js';
import { findGate } from '../hooks/registry.js';
import {
  ALIAS_FIX,
  ALIAS_REASON as ALIAS_TEXT,
  COMMAND_WORD_FIX,
  EXPAND_ALIASES_FIX,
  EXPAND_ALIASES_REASON as EXPAND_ALIASES_TEXT,
  COMMAND_WORD_REASON as COMMAND_WORD_TEXT,
  GATE_NAME,
  PARSE_FIX,
  PARSE_REASON as PARSE_TEXT,
  STASH_FIX,
  STASH_REASON as STASH_TEXT,
  SUBCOMMAND_FIX,
  SUBCOMMAND_REASON as SUBCOMMAND_TEXT,
  sweBoundary,
} from '../hooks/swe-boundary.js';
import { fixedReason } from '../hooks/lib/deny.js';

const PARSE_REASON = fixedReason(PARSE_TEXT, PARSE_FIX);
const STASH_REASON = fixedReason(STASH_TEXT, STASH_FIX);
const SUBCOMMAND_REASON = fixedReason(SUBCOMMAND_TEXT, SUBCOMMAND_FIX);
const COMMAND_WORD_REASON = fixedReason(COMMAND_WORD_TEXT, COMMAND_WORD_FIX);
const ALIAS_REASON = fixedReason(ALIAS_TEXT, ALIAS_FIX);
const EXPAND_ALIASES_REASON = fixedReason(EXPAND_ALIASES_TEXT, EXPAND_ALIASES_FIX);
const STASH_WRITES = [
  'git stash',
  'git stash push -m x',
  'git stash pop',
  'git stash apply stash@{0}',
  'git stash drop',
  'git stash clear',
  'git -C x stash save y',
  'cd x && git stash pop',
  'git stash $op',
  'a=pop; git stash $a',
  "git stash 'pop'",
  "git stash $'pop'",
  "git stash 'list'",
  'git stash "show"',
  'git stash l\\ist',
  'git stash list$(echo x)',
  'git STASH pop',
];
const STASH_READS = [
  'git stash list',
  "git stash list --format='%H %gs'",
  'git stash show -p',
  'git stash show -p stash@{1}',
  'git stash \\\n  list',
  "git -C 'a b' stash list",
  'git -C "$(git rev-parse --show-toplevel)" stash list',
  'git -c core.quotepath=off stash show -p',
];
const AMBIGUOUS_SUBCOMMANDS: ReadonlyArray<readonly [string, string]> = [
  ['p=stash; git $p pop', 'git $p pop'],
  ['git $(echo stash) pop', 'git $(echo stash) pop'],
];
const UNKNOWN_FIX = 'git -C <path> <subcommand> …, the subcommand written literally';
const UNREADABLE_SUBCOMMANDS = [
  "git 'stash' pop",
  'git "stash" pop',
  "git $'stash' pop",
  'git st\\ash pop',
  'git st\\\nash pop',
  '\\git stash pop',
  '/usr/bin/git stash pop',
  'git -c alias.s=stash s pop',
  "git -c 'Alias.s=stash' s pop",
  'git -c include.path=/tmp/x s pop',
  'git -c $(echo alias.s=stash) s pop',
  'git --config-env=alias.s=V s pop',
  'git --config-env alias.s=V s pop',
];
const GIT_CONFIG_ENV = [
  'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.s GIT_CONFIG_VALUE_0=stash git s pop',
  `GIT_CONFIG_PARAMETERS="'alias.s=stash'" git s pop`,
  `export GIT_CONFIG_PARAMETERS="'alias.s=stash'"; git s pop`,
  'export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.s GIT_CONFIG_VALUE_0=stash; git s pop',
  'GIT_CONFIG_GLOBAL=/tmp/c git s pop',
  'GIT_CONFIG_SYSTEM=/tmp/c git s pop',
  'GIT_CONFIG=/tmp/c git s pop',
  'env GIT_CONFIG_PARAMETERS=x git s pop',
  'export "GIT_CONFIG_COUNT=1"; git s pop',
  'v=GIT_CONF; export ${v}IG_COUNT=1; git s pop',
  'read GIT_CONFIG_PARAMETERS <<< x; export GIT_CONFIG_PARAMETERS; git s pop',
  "bash -c 'GIT_CONFIG_COUNT=1 git s pop'",
];
const HIDDEN_COMMAND_WORDS = [
  'g=git; $g stash pop',
  '"$g" stash pop',
  '${g} stash pop',
  '$(echo git) stash pop',
  '`echo git` stash pop',
  'git{,} stash pop',
  'env $(echo git) stash pop',
  "bash -c '$(echo git) stash pop'",
  "bash -o pipefail -c '$g stash pop'",
  'eval "$g stash pop"',
  "$'g\\x69t' stash pop",
];
const PATTERN_COMMAND_WORDS = ['g?t stash pop', '{git,x} stash pop'];
const ALIAS_DEFINITIONS = [
  "shopt -s expand_aliases\nalias g='git stash'\ng pop",
  "shopt -s expand_aliases; alias gsp='git stash pop'\ngsp",
  'shopt -s expand_aliases\nalias g=git\ng stash drop',
  'shopt -s expand_aliases\nx=git; alias g="$x stash"\ng pop',
  "alias g='git stash'",
  'alias g=git',
  "alias -- 'g=git stash'",
  "alias ll='ls -l' g='git stash'",
  'alias "$x"',
  "builtin alias g='git stash'",
  "command alias g='git stash'",
  "eval \"alias g='git stash'\"",
  "bash -c \"alias g='git stash'\"",
  "BASH_ALIASES[g]='git stash'",
  "BASH_ALIASES=([g]='git stash')",
  "declare 'BASH_ALIASES[g]=git stash'",
  "aliases[g]='git stash'",
  "read 'BASH_ALIASES[g]' <<< 'git stash'",
  "printf -v 'BASH_ALIASES[g]' 'git stash'",
  'printf -v "$n" x',
  'declare "$n"',
];
const EXPAND_ALIASES_ENABLES = ['shopt -s expand_aliases', 'shopt -qs expand_aliases', 'shopt -s nullglob expand_aliases', 'shopt -s $opt', 'bash -O expand_aliases -c "g pop"', 'builtin shopt -s expand_aliases'];
const ALIAS_READS = ['alias', 'alias -p', 'alias g', 'shopt -s nullglob', 'shopt -u expand_aliases', 'shopt expand_aliases', 'shopt -p', 'echo aliases', 'grep -rn BASH_ALIASES src', 'printf %s "$x"'];
const LITERAL_COMMANDS = ['ls *.ts', 'echo $HOME', "'ls' -la", '[ -f x ] && git log', "bash -c 'git status'", 'grep -rn GIT_CONFIG_COUNT src', 'git grep GIT_CONFIG_COUNT'];
const LITERAL_GIT = ['git status', 'git -C x log', 'git log -1', 'git -c user.name=$NAME log -1', 'git log --format=x $(cat f)'];
const STASH_ROLES = ['tmb:swe', 'tmb:code-reviewer'];

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SCHEMA = readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema.sql'), 'utf8');
const NOW = '2026-10-11T10:00:00.000Z';
const UNPARSEABLE = 'cat <<E"M"\nx\nEM\necho x > agents/a.md';

interface Out {
  hookSpecificOutput: { permissionDecision?: string; permissionDecisionReason?: string; additionalContext?: string };
}

function decision(stdout: string): Out['hookSpecificOutput'] | null {
  return stdout === '' ? null : (JSON.parse(stdout) as Out).hookSpecificOutput;
}

describe('swe-boundary.ts: stricter than the .sh, and the rest of its contract', () => {
  let dir: string;
  let wt: string;
  let db: string;
  let env: NodeJS.ProcessEnv;
  let noCli: string;
  const payload = (tool: string, input: Record<string, string>, extra: Record<string, string> = {}): string =>
    JSON.stringify({
      session_id: 'unit',
      cwd: wt,
      tool_name: tool,
      tool_input: input,
      agent_type: 'swe',
      agent_transcript_path: join(dir, 'spawn.jsonl'),
      ...extra,
    });

  before(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-sb-unit-')));
    const project = join(dir, 'project');
    wt = join(project, '.claude/worktrees/sb-unit');
    mkdirSync(join(wt, 'src'), { recursive: true });
    mkdirSync(join(dir, 'outside'));
    db = join(dir, 'db/trajectory.db');
    mkdirSync(dirname(db));
    const d = new DatabaseSync(db);
    try {
      d.exec(SCHEMA);
      d.prepare('INSERT INTO repos (name, path) VALUES (?, ?)').run('project', project);
      d.prepare("INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (2, 'o', 'open', ?, ?)").run(NOW, NOW);
      d.prepare(
        "INSERT INTO tasks (id, issue_id, branch_id, description, status, created_at, updated_at, repo, files) VALUES (7, 2, 'feat/sb-unit', 'd', 'running', ?, ?, 'project', '[\"src\"]')",
      ).run(NOW, NOW);
    } finally {
      d.close();
    }
    writeFileSync(join(dir, 'spawn.jsonl'), '{"message":{"content":[{"type":"text","text":"task_id=7"}]}}\n');
    noCli = join(dir, 'empty-path');
    mkdirSync(noCli);
    env = { ...process.env, TRAJECTORY_DB_PATH: db, CLAUDE_PROJECT_DIR: project };
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('is registered under its gate name', () => {
    assert.equal(GATE_NAME, 'swe-boundary');
    assert.equal(findGate(GATE_NAME), sweBoundary);
  });

  it('denies a command tree-sitter-bash cannot parse with PARSE_REASON', async () => {
    assert.deepEqual(await cmdStatements(UNPARSEABLE, wt, env), { ok: false });
    const r = await sweBoundary(payload('Bash', { command: UNPARSEABLE }), env);
    assert.equal(r.code, 0);
    assert.equal(decision(r.stdout)?.permissionDecisionReason, PARSE_REASON);
  });

  it('upper-cases a gh api verb with toUpperCase, so `poſt` is POST in every locale', async () => {
    assert.equal(ghMutationFrom(['gh', 'api', '-X', 'poſt', 'repos/o/r']), 'POST');
    assert.equal(ghMutation('gh api --method=poſt repos/o/r'), 'POST');
    const r = await sweBoundary(payload('Bash', { command: 'gh api -X poſt repos/o/r/issues' }), env);
    assert.match(decision(r.stdout)?.permissionDecisionReason ?? '', /^BLOCKED: SWE may not run gh\/glab mutating commands/);
  });

  it('denies a Bash write to a multibyte prompt-surface name such as agents/é.md (GH 2030)', async () => {
    const r = await sweBoundary(payload('Bash', { command: 'echo x > agents/é.md' }), { ...env, LC_ALL: 'en_US.UTF-8' });
    const reason = decision(r.stdout)?.permissionDecisionReason ?? '';
    assert.match(reason, /^BLOCKED: SWE may not write prompt-surface files via Bash /);
    assert.ok(reason.includes(`Target: ${join(wt, 'agents/é.md')}.`), reason);
  });

  it('denies an Edit of a prompt-surface file and routes the swe to its report, not to task_create_batch (GH 2713)', async () => {
    const r = await sweBoundary(payload('Edit', { file_path: join(wt, 'agents/a.md'), old_string: 'a', new_string: 'b' }), env);
    const reason = decision(r.stdout)?.permissionDecisionReason ?? '';
    assert.match(reason, /^BLOCKED: SWE may not edit prompt-surface files /);
    assert.ok(
      reason.includes('If the spec needs this edit, stop and name the file in your report; bro re-plans it as a new prompt_bearing=1 task.'),
      reason,
    );
    assert.ok(!reason.includes('task_create_batch'), reason);
  });

  it('lets a non-swe caller run the same unparseable command', async () => {
    const r = await sweBoundary(JSON.stringify({ tool_name: 'Bash', cwd: wt, tool_input: { command: UNPARSEABLE } }), env);
    assert.equal(r.stdout, '');
  });

  it('reads the DB through node:sqlite with no sqlite3 CLI on PATH, so rule (c) still holds', async () => {
    const bare: NodeJS.ProcessEnv = { ...env, PATH: noCli };
    delete bare.TMB_HOOKS_SQLITE;
    assert.equal(haveSqlite(bare), true);
    const r = await sweBoundary(payload('Write', { file_path: join(dir, 'outside/x.txt'), content: 'x' }), bare);
    assert.match(decision(r.stdout)?.permissionDecisionReason ?? '', /^BLOCKED: SWE may only edit files inside its assigned worktree/);
  });

  it('enforces nothing with neither node:sqlite nor the CLI, as the .sh does without the CLI', async () => {
    const bare = { ...env, PATH: noCli, TMB_HOOKS_SQLITE: 'cli' };
    assert.equal(haveSqlite(bare), false);
    const input = payload('Write', { file_path: join(dir, 'outside/x.txt'), content: 'x' });
    const r = await sweBoundary(input, bare);
    assert.equal(r.stdout, '');
  });

  it('leaves never-judged write targets to containment-guard', async () => {
    const command = `perl -i -pe 'BEGIN{open(F,"skills/s/SKILL.md")}' src/a.ts`;
    const lines = await writePaths(command, { cwd: wt, root: wt, env });
    assert.ok(
      lines.some((l) => l.startsWith('UNRESOLVED:$(')),
      lines.join('\n'),
    );
    const r = await sweBoundary(payload('Bash', { command }), env);
    assert.equal(r.stdout, '');
  });

  it('denies a command past the analyzer cap, naming the cap, on a stack shape and a work shape (GH 2090)', async () => {
    for (const depth of [5000, 2000]) {
      const r = await sweBoundary(payload('Bash', { command: `echo ${'$('.repeat(depth)}x${')'.repeat(depth)}` }), env);
      assert.equal(r.code, 0);
      assert.equal(decision(r.stdout)?.permissionDecisionReason, fixedReason(CAP_REASON, CAP_FIX));
    }
  });

  it('denies every git stash form but list and show for swe and code-reviewer with STASH_REASON (GH 2786)', async () => {
    for (const agent_type of STASH_ROLES) {
      for (const command of STASH_WRITES) {
        const r = await sweBoundary(payload('Bash', { command }, { agent_type }), env);
        assert.equal(r.code, 0);
        assert.equal(decision(r.stdout)?.permissionDecisionReason, STASH_REASON, `${agent_type}: ${command}`);
      }
    }
  });

  it('admits git stash list and git stash show for swe and code-reviewer (GH 2786)', async () => {
    for (const agent_type of STASH_ROLES) {
      for (const command of STASH_READS) {
        assert.deepEqual(await sweBoundary(payload('Bash', { command }, { agent_type }), env), { stdout: '', code: 0 }, `${agent_type}: ${command}`);
      }
    }
  });

  it('denies a git statement whose subcommand it cannot read literally for swe and code-reviewer with SUBCOMMAND_REASON (GH 2837)', async () => {
    for (const agent_type of STASH_ROLES) {
      for (const command of UNREADABLE_SUBCOMMANDS) {
        const r = await sweBoundary(payload('Bash', { command }, { agent_type }), env);
        assert.equal(r.code, 0);
        assert.equal(decision(r.stdout)?.permissionDecisionReason, SUBCOMMAND_REASON, `${agent_type}: ${command}`);
      }
    }
  });

  it('denies a git statement whose subcommand gitSubcommandOf cannot read as ambiguous_git_subcommand for swe and code-reviewer (GH 2641, GH 2837)', async () => {
    const verbs: Record<string, string> = { 'tmb:swe': 'pushes', 'tmb:code-reviewer': 'writes the git stash' };
    for (const agent_type of STASH_ROLES) {
      for (const [command, what] of AMBIGUOUS_SUBCOMMANDS) {
        const r = await sweBoundary(payload('Bash', { command }, { agent_type }), env);
        assert.equal(r.code, 0);
        assert.equal(decision(r.stdout)?.permissionDecisionReason, `${ambiguousSubcommandReason(what, verbs[agent_type])} Allowed form: ${UNKNOWN_FIX}`, `${agent_type}: ${command}`);
      }
    }
  });

  it('denies an alias git may read from a GIT_CONFIG_* variable the command sets or names for swe and code-reviewer with SUBCOMMAND_REASON (GH 2837)', async () => {
    for (const agent_type of STASH_ROLES) {
      for (const command of GIT_CONFIG_ENV) {
        const r = await sweBoundary(payload('Bash', { command }, { agent_type }), env);
        assert.equal(r.code, 0);
        assert.equal(decision(r.stdout)?.permissionDecisionReason, SUBCOMMAND_REASON, `${agent_type}: ${command}`);
      }
    }
  });

  it('denies a command name from an expansion, a substitution or a pattern for swe and code-reviewer with COMMAND_WORD_REASON (GH 2837)', async () => {
    for (const agent_type of STASH_ROLES) {
      for (const command of HIDDEN_COMMAND_WORDS) {
        const r = await sweBoundary(payload('Bash', { command }, { agent_type }), env);
        assert.equal(r.code, 0);
        assert.equal(decision(r.stdout)?.permissionDecisionReason, COMMAND_WORD_REASON, `${agent_type}: ${command}`);
      }
    }
  });

  it('denies a pattern command name the analyzer cannot list: code-reviewer with COMMAND_WORD_REASON, swe with PARSE_REASON (GH 2837)', async () => {
    const reasons: Record<string, string> = { 'tmb:swe': PARSE_REASON, 'tmb:code-reviewer': COMMAND_WORD_REASON };
    for (const agent_type of STASH_ROLES) {
      for (const command of PATTERN_COMMAND_WORDS) {
        const r = await sweBoundary(payload('Bash', { command }, { agent_type }), env);
        assert.equal(decision(r.stdout)?.permissionDecisionReason, reasons[agent_type], `${agent_type}: ${command}`);
      }
    }
  });

  it('denies a shell alias definition, an alias table write or a variable it cannot name for swe and code-reviewer with ALIAS_REASON (GH 2837)', async () => {
    for (const agent_type of STASH_ROLES) {
      for (const command of ALIAS_DEFINITIONS) {
        const r = await sweBoundary(payload('Bash', { command }, { agent_type }), env);
        assert.equal(r.code, 0);
        assert.equal(decision(r.stdout)?.permissionDecisionReason, ALIAS_REASON, `${agent_type}: ${command}`);
      }
    }
  });

  it('denies turning on expand_aliases for swe and code-reviewer with EXPAND_ALIASES_REASON (GH 2837)', async () => {
    for (const agent_type of STASH_ROLES) {
      for (const command of EXPAND_ALIASES_ENABLES) {
        const r = await sweBoundary(payload('Bash', { command }, { agent_type }), env);
        assert.equal(r.code, 0);
        assert.equal(decision(r.stdout)?.permissionDecisionReason, EXPAND_ALIASES_REASON, `${agent_type}: ${command}`);
      }
    }
  });

  it('admits a listing alias, other shopt options and words that only name an alias table for swe and code-reviewer (GH 2837)', async () => {
    for (const agent_type of STASH_ROLES) {
      for (const command of ALIAS_READS) {
        assert.deepEqual(await sweBoundary(payload('Bash', { command }, { agent_type }), env), { stdout: '', code: 0 }, `${agent_type}: ${command}`);
      }
    }
  });

  it('admits literal command names and a GIT_CONFIG_* name git or a non-git command only reads for swe and code-reviewer (GH 2837)', async () => {
    for (const agent_type of STASH_ROLES) {
      for (const command of LITERAL_COMMANDS) {
        assert.deepEqual(await sweBoundary(payload('Bash', { command }, { agent_type }), env), { stdout: '', code: 0 }, `${agent_type}: ${command}`);
      }
    }
  });

  it('admits literal non-stash git commands for swe and code-reviewer (GH 2837)', async () => {
    for (const agent_type of STASH_ROLES) {
      for (const command of LITERAL_GIT) {
        assert.deepEqual(await sweBoundary(payload('Bash', { command }, { agent_type }), env), { stdout: '', code: 0 }, `${agent_type}: ${command}`);
      }
    }
  });

  it('admits bro on git stash pop, and code-reviewer on a non-stash, unparseable or over-cap command (GH 2786)', async () => {
    const bro = JSON.stringify({ tool_name: 'Bash', cwd: wt, tool_input: { command: 'git stash pop' } });
    assert.deepEqual(await sweBoundary(bro, env), { stdout: '', code: 0 });
    const reviewer = { agent_type: 'tmb:code-reviewer' };
    for (const command of ['git log -1', 'git push origin main', UNPARSEABLE, `echo ${'$('.repeat(5000)}x${')'.repeat(5000)}`]) {
      assert.deepEqual(await sweBoundary(payload('Bash', { command }, reviewer), env), { stdout: '', code: 0 }, command.slice(0, 40));
    }
  });

  it('drops the Edit/Write as bash does on a deny record whose time is not valid octal: no output, exit 0', async () => {
    const target = join(wt, 'src/a.ts');
    const record = join(dirname(db), 'locks/boundary-denies/unit', createHash('sha256').update(target).digest('hex'));
    const input = payload('Edit', { file_path: target, old_string: 'a', new_string: 'b' });
    mkdirSync(dirname(record), { recursive: true });
    writeFileSync(record, 'containment-guard\n0999\n');
    assert.deepEqual(await sweBoundary(input, env), { stdout: '', code: 0 });
    assert.deepEqual(await sweBoundary(input, env), { stdout: '', code: 0 }, 'the record still holds no valid time on the next call');
    rmSync(join(dirname(db), 'locks'), { recursive: true, force: true });
  });
});
