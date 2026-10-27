/**
 * Unit tests of the TypeScript swe-scope-fence gate (GH 1692): registration,
 * the jq read semantics the parity corpus leans on, the worktree prefix test,
 * each silent branch, the once-per-path note, and the divergence decision 703
 * allows: on a PATH holding neither jq nor the sqlite3 CLI, where the .sh stays
 * silent, the gate still notes a write outside files[].
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findGate, gateNames } from '../hooks/registry.js';
import { commandOnPath } from '../hooks/lib/persona.js';
import { jqInput } from '../hooks/lib/jq-raw.js';
import { cksum } from '../hooks/lib/scope-fence.js';
import { jqFirst, scopeNote, sweScopeFence, worktreeRelative } from '../hooks/swe-scope-fence.js';
import { buildScopeSandbox } from './hooks-swe-scope-fence-parity.suite.js';

const ALLOWED = { stdout: '', code: 0 };

function note(stdout: string): string {
  assert.ok(stdout.endsWith('\n'));
  const out = JSON.parse(stdout) as { hookSpecificOutput: Record<string, string> };
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, undefined);
  return out.hookSpecificOutput.additionalContext;
}

describe('swe-scope-fence is registered', () => {
  it('is a gate dist/hooks-gates.txt lists', () => {
    assert.equal(findGate('swe-scope-fence'), sweScopeFence);
    assert.ok(gateNames().includes('swe-scope-fence'));
  });
});

describe('swe-scope-fence helpers', () => {
  it('jqFirst takes the first truthy path, left to right, one line per value', () => {
    const paths = [['tool_input', 'file_path'], ['tool_input', 'notebook_path']];
    assert.equal(jqFirst(jqInput('{"tool_input":{"file_path":"a","notebook_path":"b"}}\n'), paths), 'a');
    assert.equal(jqFirst(jqInput('{"tool_input":{"file_path":false,"notebook_path":"b"}}\n'), paths), 'b');
    assert.equal(jqFirst(jqInput('{"tool_input":{}}\n'), paths), '');
    assert.equal(jqFirst(jqInput('{"a":1}\n{"a":2}\n'), [['a']]), '1\n2');
    assert.equal(jqFirst(jqInput('{}\n{"a":"x"}\n'), [['a']], true), 'x');
  });

  it('jqFirst skips a value an evaluated path cannot index, and only an evaluated one', () => {
    assert.equal(jqFirst(jqInput('{"tool_input":"s"}\n{"tool_input":{"file_path":"y"}}\n'), [['tool_input', 'file_path']]), 'y');
    assert.equal(jqFirst(jqInput('{"agent_type":"swe","tool_input":"s"}\n'), [['agent_type'], ['tool_input', 'subagent_type']], true), 'swe');
    assert.equal(jqFirst(jqInput('{"tool_input":"s"}\n'), [['agent_type'], ['tool_input', 'subagent_type']], true), '');
  });

  it('worktreeRelative strips the worktree prefix, never a sibling or the worktree itself', () => {
    assert.equal(worktreeRelative('/w/t/lib/x.ts', '/w/t'), 'lib/x.ts');
    assert.equal(worktreeRelative('/w/t/lib/x.ts', '/w/t/'), 'lib/x.ts');
    assert.equal(worktreeRelative('/w/tt/lib/x.ts', '/w/t'), null);
    assert.equal(worktreeRelative('/w/t', '/w/t'), null);
  });

  it('scopeNote is a compact PreToolUse additionalContext line', () => {
    assert.equal(scopeNote('n'), '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"TMB: n"}}\n');
  });
});

describe('swe-scope-fence over a sandbox, without jq or the sqlite3 CLI (decision 703)', () => {
  let base: string;
  let s: string;
  let emptyBin: string;
  before(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-swe-scope-fence-')));
    s = join(base, 'sandbox');
    emptyBin = join(base, 'empty-bin');
    mkdirSync(emptyBin);
  });
  beforeEach(() => buildScopeSandbox(s));
  after(() => rmSync(base, { recursive: true, force: true }));

  const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    HOME: join(s, 'home'),
    CLAUDE_PROJECT_DIR: join(s, 'project'),
    TRAJECTORY_DB_PATH: join(s, 'project/.claude/tmb/trajectory.db'),
    PATH: emptyBin,
    LC_ALL: 'C',
    PWD: join(s, 'project'),
    ...extra,
  });
  const wt = (slug: string): string => join(s, 'project/checkout/.claude/worktrees', slug);
  const edit = (task: number, target: string, extra: Record<string, unknown> = {}): string =>
    JSON.stringify({ agent_type: 'swe', agent_transcript_path: join(s, 'tr', `task-${task}.jsonl`), tool_name: 'Edit', tool_input: { file_path: target }, ...extra });

  it('the PATH under test holds neither jq nor sqlite3', () => {
    assert.equal(commandOnPath('jq', env()), false);
    assert.equal(commandOnPath('sqlite3', env()), false);
  });

  it('notes a write outside files[] once per path per task, where the .sh stays silent', () => {
    const payload = edit(10, join(wt('sf-task'), 'lib/util.ts'));
    assert.equal(note(sweScopeFence(payload, env()).stdout), "TMB: lib/util.ts is outside this task's files[] (src, tests/unit/a.test.ts); list it and why in your report");
    assert.ok(existsSync(join(s, 'project/.claude/tmb/locks/scope-notes/10', cksum('lib/util.ts'))));
    assert.deepEqual(sweScopeFence(payload, env()), ALLOWED);
    assert.match(note(sweScopeFence(edit(12, join(wt('sf-noted'), 'lib/util.ts')), env()).stdout), /^TMB: lib\/util\.ts is outside/);
  });

  it('joins a relative target to the payload cwd, else PWD', () => {
    assert.match(note(sweScopeFence(edit(10, 'lib/rel.ts', { cwd: wt('sf-task') }), env()).stdout), /^TMB: lib\/rel\.ts /);
    assert.match(note(sweScopeFence(edit(10, 'lib/pwd.ts'), env({ PWD: wt('sf-task') })).stdout), /^TMB: lib\/pwd\.ts /);
    assert.deepEqual(sweScopeFence(edit(10, 'lib/x.ts', { cwd: join(s, 'outside') }), env({ PWD: wt('sf-task') })), ALLOWED);
  });

  it('canonicalizes a symlinked worktree and a target reached through a symlink', () => {
    assert.match(note(sweScopeFence(edit(13, join(wt('sf-linked'), 'lib/x.ts')), env()).stdout), /^TMB: lib\/x\.ts is outside this task's files\[\] \(src\)/);
    assert.match(note(sweScopeFence(edit(10, join(s, 'linked/.claude/worktrees/sf-task/lib/via.ts')), env()).stdout), /^TMB: lib\/via\.ts /);
  });

  it('reads notebook_path for NotebookEdit and gates MultiEdit', () => {
    const nb = JSON.stringify({ agent_type: 'swe', agent_transcript_path: join(s, 'tr/task-10.jsonl'), tool_name: 'NotebookEdit', tool_input: { notebook_path: join(wt('sf-task'), 'nb/a.ipynb') } });
    assert.match(note(sweScopeFence(nb, env()).stdout), /^TMB: nb\/a\.ipynb /);
    assert.match(note(sweScopeFence(edit(10, join(wt('sf-task'), 'lib/m.ts'), { tool_name: 'MultiEdit' }), env()).stdout), /^TMB: lib\/m\.ts /);
  });

  it('stays silent inside files[], outside the worktree, for an empty files[] and for a path already noted', () => {
    assert.deepEqual(sweScopeFence(edit(10, join(wt('sf-task'), 'src/a.ts')), env()), ALLOWED);
    assert.deepEqual(sweScopeFence(edit(10, join(wt('sf-task'), 'tests/l3/x.sh')), env()), ALLOWED);
    assert.deepEqual(sweScopeFence(edit(10, join(s, 'outside/x.ts')), env()), ALLOWED);
    assert.deepEqual(sweScopeFence(edit(10, wt('sf-task')), env()), ALLOWED);
    assert.deepEqual(sweScopeFence(edit(11, join(wt('sf-empty'), 'lib/x.ts')), env()), ALLOWED);
    assert.deepEqual(sweScopeFence(edit(12, join(wt('sf-noted'), 'docs/noted.md')), env()), ALLOWED);
  });

  it('stays silent for another role, another tool, an unresolved context, no DB and a DB read error', () => {
    const target = join(wt('sf-task'), 'lib/x.ts');
    assert.deepEqual(sweScopeFence(edit(10, target, { agent_type: 'bro' }), env()), ALLOWED);
    assert.deepEqual(sweScopeFence(edit(10, target, { tool_name: 'Read' }), env()), ALLOWED);
    assert.deepEqual(sweScopeFence(edit(99, target), env()), ALLOWED);
    assert.deepEqual(sweScopeFence(JSON.stringify({ agent_type: 'swe', tool_name: 'Edit', tool_input: { file_path: target } }), env()), ALLOWED);
    assert.deepEqual(sweScopeFence(edit(10, target), env({ TRAJECTORY_DB_PATH: join(s, 'nowhere/trajectory.db'), CLAUDE_PROJECT_DIR: join(s, 'home') })), ALLOWED);
    assert.deepEqual(sweScopeFence(edit(10, target), env({ TRAJECTORY_DB_PATH: join(s, 'bad/.claude/tmb/trajectory.db') })), ALLOWED);
    assert.equal(existsSync(join(s, 'project/.claude/tmb/locks/scope-notes/10')), false);
  });
});
