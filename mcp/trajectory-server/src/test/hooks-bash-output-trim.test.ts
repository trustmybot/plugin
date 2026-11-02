/**
 * The bash-output-trim gate (GH 2193): every allowlisted read with a long
 * stdout comes back as updatedToolOutput with a head, one marker line and a
 * tail; every other call prints nothing.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bashOutputTrim, GATE_NAME, HEAD_CHARS, isRoutineRead, TAIL_CHARS, TRIM_ABOVE, trimMarker, trimOutput } from '../hooks/bash-output-trim.js';
import { findGate, routerGroup } from '../hooks/registry.js';

const LINES = Array.from({ length: 250 }, (_, i) => `line ${String(i).padStart(3, '0')} ${'x'.repeat(31)}`);
const LONG = LINES.join('\n');
const MARKER = /^\[bash-output-trim: cut (\d+) lines \((\d+) chars\) of (\d+) lines; rerun with a narrower command, or append \| cat for the full output\]$/m;

type Response = { stdout: string; stderr: string; interrupted: boolean; isImage: boolean; noOutputExpected?: boolean };

function payload(command: string, response: Partial<Response> = {}, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    hook_event_name: 'PostToolUse',
    session_id: 'sess-trim',
    tool_name: 'Bash',
    tool_input: { command },
    tool_use_id: 'tu-trim',
    tool_response: { stdout: LONG, stderr: '', interrupted: false, isImage: false, noOutputExpected: false, ...response },
    ...extra,
  });
}

function run(input: string): string {
  const r = bashOutputTrim(input, {});
  assert.equal(r.code, 0);
  return r.stdout;
}

function trimmed(input: string): Response {
  const out = run(input);
  assert.notEqual(out, '', 'expected a trimmed output');
  const o = JSON.parse(out) as { hookSpecificOutput: { hookEventName: string; updatedToolOutput: Response } };
  assert.equal(o.hookSpecificOutput.hookEventName, 'PostToolUse');
  return o.hookSpecificOutput.updatedToolOutput;
}

const MARKER_MAX = trimMarker(LINES.length, LONG.length, LINES.length).length;

describe('bash-output-trim trims each allowlisted read (SC1)', () => {
  assert.ok(LONG.length >= 10000);
  const forms = [
    'git log',
    'git log --oneline -n 500',
    'git -C /Users/me/repo log --format=%H',
    'git -C "$WT" log',
    'git status',
    'git -C /tmp/wt status --short',
    'git diff --stat',
    'git -C /tmp/wt diff --stat=200 origin/dev...HEAD',
    'gh pr view 12',
    'gh pr view 12 --comments',
    'gh pr list --state open',
    'gh pr checks 12',
    'gh issue view 2193',
    'gh issue list --label Bug',
    'gh run view 99 --log',
    'gh run list --limit 50',
    "sqlite3 -readonly .claude/tmb/trajectory.db 'SELECT id, title FROM tasks'",
    'sqlite3 -readonly -header -column db.sqlite "with t as (select 1) select * from t"',
    'GH_PAGER= git log',
    'NO_COLOR=1 PAGER=cat gh pr list',
  ];
  for (const command of forms) {
    it(command, () => {
      const r = trimmed(payload(command, { stdout: LONG }));
      assert.ok(r.stdout.length <= HEAD_CHARS + TAIL_CHARS + MARKER_MAX, `length ${r.stdout.length}`);
      assert.ok(r.stdout.startsWith(`${LINES[0]}\n`));
      assert.ok(r.stdout.endsWith(`\n${LINES[LINES.length - 1]}`));
      const m = MARKER.exec(r.stdout);
      assert.ok(m, 'marker line');
      assert.equal(Number(m[3]), LINES.length);
      assert.deepEqual({ ...r, stdout: '' }, { stdout: '', stderr: '', interrupted: false, isImage: false, noOutputExpected: false });
    });
  }

  it('a 10000-char stdout keeps whole lines and accounts for every cut one', () => {
    const big = Array.from({ length: 400 }, (_, i) => `${i} ${'y'.repeat(25)}`).join('\n');
    assert.ok(big.length >= 10000);
    const r = trimmed(payload('git log', { stdout: big }));
    const out = r.stdout.split('\n');
    const at = out.findIndex((l) => MARKER.test(l));
    const head = out.slice(0, at);
    const tail = out.slice(at + 1);
    const all = big.split('\n');
    assert.deepEqual(head, all.slice(0, head.length));
    assert.deepEqual(tail, all.slice(all.length - tail.length));
    const m = MARKER.exec(out[at]) as RegExpExecArray;
    assert.equal(head.length + Number(m[1]) + tail.length, all.length);
    assert.equal(Number(m[2]), all.slice(head.length, all.length - tail.length).join('\n').length + 1);
    assert.ok(head.join('\n').length < HEAD_CHARS && tail.join('\n').length < TAIL_CHARS);
  });

  it('a trailing newline is not counted as a line', () => {
    const r = trimmed(payload('git log', { stdout: `${LONG}\n` }));
    assert.equal(Number((MARKER.exec(r.stdout) as RegExpExecArray)[3]), LINES.length);
    assert.ok(r.stdout.endsWith(`${LINES[LINES.length - 1]}\n`));
  });
});

describe('bash-output-trim passes every other call unchanged (SC2)', () => {
  it('a subagent call (agent_id present)', () => assert.equal(run(payload('git log', {}, { agent_id: 'a1', agent_type: 'swe' })), ''));
  it('non-empty stderr', () => assert.equal(run(payload('git log', { stderr: 'warning: x' })), ''));
  it('an interrupted call', () => assert.equal(run(payload('git log', { interrupted: true })), ''));
  it('an image result', () => assert.equal(run(payload('git log', { isImage: true })), ''));
  it('stdout at or below TRIM_ABOVE', () => assert.equal(run(payload('git log', { stdout: 'a\n'.repeat(TRIM_ABOVE / 2) })), ''));
  it('a piped git log | head', () => assert.equal(run(payload('git log | head -50')), ''));
  it('an && chain', () => assert.equal(run(payload('git status && git log')), ''));
  it('a ; chain', () => assert.equal(run(payload('git status; git log')), ''));
  it('gh pr view --json body', () => assert.equal(run(payload('gh pr view 12 --json body')), ''));
  it('gh pr view --jq / -q / --template / -t', () => {
    for (const c of ['gh pr view 12 --jq .body', 'gh pr view 12 -q .body', 'gh pr list --template "{{.}}"', 'gh pr list -t x', 'gh pr view 12 --json=body']) assert.equal(run(payload(c)), '', c);
  });
  it('sqlite3 without -readonly', () => assert.equal(run(payload("sqlite3 db.sqlite 'SELECT * FROM t'")), ''));
  it('sqlite3 -readonly with UPDATE', () => assert.equal(run(payload("sqlite3 -readonly db.sqlite 'UPDATE t SET a = 1'")), ''));
  it('an unlisted program: cat', () => assert.equal(run(payload('cat big.txt')), ''));
  it('an unlisted program: ls', () => assert.equal(run(payload('ls -laR')), ''));
  it('an unlisted program: npm test', () => assert.equal(run(payload('npm test')), ''));
  it('a redirect, a subshell, a command substitution, a background job', () => {
    for (const c of ['git log > out.txt', 'git log < /dev/null', 'git log $(echo x)', 'git log `echo x`', 'git log &', '(git log)', 'git log\ngit status']) assert.equal(run(payload(c)), '', JSON.stringify(c));
  });
  it('git diff without --stat and other git subcommands', () => {
    for (const c of ['git diff', 'git -C /tmp diff HEAD', 'git show HEAD', 'git -C', 'git -c core.pager=x log']) assert.equal(run(payload(c)), '', c);
  });
  it('other gh groups and verbs', () => {
    for (const c of ['gh api repos/x/y', 'gh pr diff 12', 'gh repo view', 'gh issue']) assert.equal(run(payload(c)), '', c);
  });
  it('a non-Bash tool, a malformed payload, a missing tool_response', () => {
    assert.equal(run(JSON.stringify({ tool_name: 'Read', tool_input: { command: 'git log' }, tool_response: { stdout: LONG, stderr: '' } })), '');
    assert.equal(run('{not json'), '');
    assert.equal(run(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git log' } })), '');
  });
  it('one line too long to keep whole in the head', () => {
    assert.equal(run(payload('git log', { stdout: 'z'.repeat(TRIM_ABOVE + 10) })), '');
  });
});

describe('bash-output-trim helpers', () => {
  it('isRoutineRead reads the allowlist', () => {
    assert.equal(isRoutineRead('git log'), true);
    assert.equal(isRoutineRead('sqlite3 -readonly db "SELECT 1"'), true);
    assert.equal(isRoutineRead('sqlite3 -readonly db ".dump"'), false);
    assert.equal(isRoutineRead('sqlite3 -readonly db "SELECT 1" extra'), false);
    assert.equal(isRoutineRead('$GIT log'), false);
  });
  it('trimOutput leaves an output its head and tail cover', () => {
    assert.equal(trimOutput('a\nb\nc'), null);
  });
});

describe('bash-output-trim registration', () => {
  it('the router finds the gate and runs it first in the PostToolUse Bash group', () => {
    assert.equal(findGate(GATE_NAME), bashOutputTrim);
    const g = routerGroup('PostToolUse', 'Bash');
    assert.ok(g);
    assert.deepEqual(g.gates[0], { name: GATE_NAME, kind: 'advisory', budgetMs: 4000 });
  });
});
