/**
 * The bash-output-trim gate (GH 2193): every allowlisted read, read chains and
 * pipelines included, with a long stdout comes back as updatedToolOutput with a head, one marker line and a
 * tail; every other call prints nothing.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bashOutputTrim, GATE_NAME, HEAD_CHARS, isRoutineRead, sedPrintOnly, TAIL_CHARS, TRIM_ABOVE, trimMarker, trimOutput } from '../hooks/bash-output-trim.js';
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
    'cd /x && git log | head -50',
    'P=/x; git -C $P show abc',
    'export P=/x && git -C "${P}" grep -n foo',
    'GH_PAGER=cat gh issue view 1 --json body -q .body',
    'gh pr view 12 --json body --jq .body',
    'gh pr diff 12',
    "sed -n '1,200p' f",
    "sed -n '/^## /p;$p' f",
    "grep -n 'a|b' f | head",
    'sqlite3 -readonly db "SELECT a; SELECT b"',
    'git log --oneline\ngit status --short',
    'git diff 2>&1 | grep -v x | sort | uniq -c | sort -rn',
    'rg -n foo src 2>/dev/null | cut -c1-200',
    'ls -la /x | wc -l',
    'cat big.txt | tr a b | column -t | nl',
    'echo "$HOME" ; printf x | jq .',
    'diff a b | tail -20',
    'git log &&\n  git status # a comment',
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
  const rejects = [
    "sed -n 'w out' f",
    "sed -n '1,5w out' f",
    "sed -n 's/a/b/p' f",
    "sed -n '1r /etc/passwd' f",
    "sed -n '1e date' f",
    "sed -i 's/a/b/' f",
    "sed -i -n '1p' f",
    "sed '1,5p' f",
    'git diff --output=x',
    'git log --output x',
    'rg --pre cat x',
    'rg --pre-glob "*.gz" x',
    'git log > f',
    'git log >> f',
    'git log 2>f',
    'git log >&2',
    'echo $(id)',
    'echo "$(id)"',
    'echo `id`',
    'echo $1',
    'echo ${P:-x}',
    'cd x && rm f',
    'git push',
    'git -C',
    'git -c core.pager=x log',
    '$CMD log',
    'git $V',
    'gh $G view 1',
    'sort -o f',
    'sort -uo f',
    'sort --output=f',
    'uniq a b',
    'uniq -- -c out',
    "grep 'a",
    'echo "a',
    'cat <<EOF\nhi\nEOF',
    'cat < f',
    'diff <(ls a) <(ls b)',
    'git log | tee f',
    'git log || true',
    'git log &',
    'git log & git status',
    '(git log)',
    'git log | | head',
    'git log |& head',
    'npm test',
    'gh api repos/x/y',
    'gh repo view',
    'gh issue',
    "sqlite3 db.sqlite 'SELECT * FROM t'",
    "sqlite3 -readonly db.sqlite 'UPDATE t SET a = 1'",
    'sqlite3 -readonly db ".dump"',
    'sqlite3 -readonly db "SELECT 1" extra',
    'sqlite3 -readonly -cmd ".output x" db "SELECT 1"',
    'export',
    'A=1 B=2',
  ];
  for (const c of rejects) it(`rejects ${JSON.stringify(c)}`, () => assert.equal(run(payload(c)), ''));
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
    assert.equal(isRoutineRead('$GIT log'), false);
    assert.equal(isRoutineRead(`grep -c ';' f; sqlite3 -readonly db 'SELECT "|" || x FROM t'`), true);
  });
  it('sedPrintOnly admits only addressed p commands', () => {
    for (const s of ['p', '10p', '1,200p', '$p', '/a\\/b/p', '/^x/,/^y/p', '1p; $p']) assert.equal(sedPrintOnly(s), true, s);
    for (const s of ['', '1d', '1,5w out', '/a/s/a/b/p', '1r f', '1e date', 'W f', '1~2p', '/a/Ip', '1,5{p}']) assert.equal(sedPrintOnly(s), false, s);
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
