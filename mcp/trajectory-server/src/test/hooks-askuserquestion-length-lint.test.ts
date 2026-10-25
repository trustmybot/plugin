/**
 * The TypeScript askuserquestion-length-lint gate (GH 1692) and the
 * `node dist/hooks.js` entry that runs it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { askuserquestionLengthLint } from '../hooks/askuserquestion-length-lint.js';
import { findGate, gateNames } from '../hooks/registry.js';

const HOOKS_BUNDLE = join(resolve(dirname(fileURLToPath(import.meta.url)), '../..'), 'dist/hooks.js');
const C = { LC_ALL: 'C' };
const UTF8 = { LC_ALL: 'en_US.UTF-8' };

function ask(options: unknown[], questions: unknown[] = [{ options }]): string {
  return JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions } });
}

function context(payload: string, env: NodeJS.ProcessEnv = C): string | null {
  const result = askuserquestionLengthLint(payload, env);
  assert.equal(result.code, 0, 'the gate never blocks');
  if (result.stdout === '') return null;
  const out = JSON.parse(result.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(Object.keys(out).length, 1);
  return out.hookSpecificOutput.additionalContext;
}

describe('askuserquestion-length-lint (TS)', () => {
  it('is silent for another tool, a non-JSON payload and an empty one', () => {
    assert.equal(context(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'echo hi' } })), null);
    assert.equal(context('not json'), null);
    assert.equal(context(''), null);
  });

  it('is silent at the limits: 5-word label, 15-word description, 4-line preview', () => {
    const desc = Array.from({ length: 15 }, (_, i) => `w${i}`).join(' ');
    assert.equal(context(ask([{ label: 'a b c d e', description: desc, preview: '1\n2\n3\n4\n\n' }])), null);
  });

  it('warns one past each limit with the .sh message text', () => {
    const desc = Array.from({ length: 16 }, (_, i) => `w${i}`).join(' ');
    assert.equal(
      context(ask([{ label: 'a b c d e f', description: desc, preview: '1\n2\n3\n4\n5' }])),
      'AskUserQuestion brevity violations (per feedback_ask_user_question.md):\n'
        + '  - q0.opt0 label is 6 words (target ≤5)\n'
        + '  - q0.opt0 description is 16 words (target ≤15)\n'
        + '  - q0.opt0 preview is 5 lines (target ≤4)\n\n'
        + 'Targets: label <=5 words, description <=15 words, preview <=4 lines. See #96.',
    );
  });

  it('indexes questions and options by position, counting malformed entries', () => {
    const ctx = context(ask([], ['q', { options: [null, 'x', { label: '1 2 3 4 5 6' }] }]));
    assert.equal(ctx?.split('\n')[1], '  - q1.opt2 label is 6 words (target ≤5)');
  });

  it('counts words like wc -w: any ASCII whitespace, NBSP only under a UTF-8 locale', () => {
    assert.match(context(ask([{ label: ' a\tb\nc\vd\fe\rf ' }])) ?? '', /label is 6 words/);
    const nbsp = ask([{ label: 'a b c d e f' }]);
    assert.equal(context(nbsp, C), null);
    assert.match(context(nbsp, UTF8) ?? '', /label is 6 words/);
    assert.match(context(nbsp, { LC_ALL: 'UTF-8' }) ?? '', /label is 6 words/, 'the bare UTF-8 locale splits on NBSP too');
    assert.equal(context(ask([{ label: 'a　b　c　d　e　f' }]), UTF8), null);
  });

  it('counts preview lines like grep -c after trailing newlines are dropped', () => {
    assert.equal(context(ask([{ preview: 'a\nb\nc\nd\n\n\n\n' }])), null);
    assert.match(context(ask([{ preview: '\na\nb\nc\nd' }])) ?? '', /preview is 5 lines/);
  });

  it('renders non-string fields as jq -r does: pretty-printed JSON', () => {
    assert.equal(context(ask([{ label: ['a b', 'c'] }])), null);
    assert.match(context(ask([{ label: ['a b', 'c d'] }])) ?? '', /label is 6 words/);
    assert.match(context(ask([{ preview: { a: 1, b: 2, c: 3 } }])) ?? '', /preview is 5 lines/);
    assert.equal(context(ask([{ label: false, description: null, preview: 12345 }])), null);
  });
});

describe('node dist/hooks.js', () => {
  it('lists askuserquestion-length-lint in the registry', () => {
    assert.ok(gateNames().includes('askuserquestion-length-lint'));
    assert.equal(findGate('askuserquestion-length-lint'), askuserquestionLengthLint);
    assert.equal(findGate('constructor'), undefined);
  });

  it('runs a gate: its stdout, its exit code', () => {
    const r = spawnSync(process.execPath, [HOOKS_BUNDLE, 'askuserquestion-length-lint'], {
      input: ask([{ label: 'one two three four five six', description: 'd' }]),
      encoding: 'utf8',
    });
    assert.equal(r.status, 0);
    assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /label is 6 words/);
    assert.equal(r.stderr, '');
  });

  it('an unknown or missing gate exits 1 with one stderr line and no stdout', () => {
    for (const args of [['no-such-gate'], []]) {
      const r = spawnSync(process.execPath, [HOOKS_BUNDLE, ...args], { input: '{}', encoding: 'utf8' });
      assert.equal(r.status, 1);
      assert.equal(r.stdout, '');
      assert.match(r.stderr, /^TMB hooks: unknown gate '.*' — not run\n$/);
    }
  });
});
