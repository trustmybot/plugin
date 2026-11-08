import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { bFailures, commandStatuses, parseArgs, parseDotEnv, parseEvents, probeMarker, promptFor, regressions, reportTable } from './sandbox-network-probe.ts';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'sandbox-network-probe.ts');

function bashUse(id: string, n: number, extra: Record<string, unknown> = {}) {
  return {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command: `true; echo "${probeMarker(n)}=$?"`, ...extra } }] },
  };
}

function result(id: string, content: unknown) {
  return { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } };
}

test('classifies tool results as pass, fail, unsandboxed, not-run and no-exit', () => {
  const events = [
    bashUse('t1', 1),
    result('t1', 'is-number\nTMB_PROBE_1_EXIT=0'),
    bashUse('t2', 2),
    result('t2', [{ type: 'text', text: 'fatal: unable to access' }, { type: 'text', text: 'TMB_PROBE_2_EXIT=128' }]),
    bashUse('t3', 3, { dangerouslyDisableSandbox: true }),
    result('t3', 'TMB_PROBE_3_EXIT=0'),
    bashUse('t5', 5),
    result('t5', 'killed'),
  ];
  assert.deepEqual(commandStatuses(events, 5), ['0', '128', 'unsandboxed', 'not-run', 'no-exit']);
});

test('reads the last Bash call per command and the last exit marker in its result', () => {
  const events = [bashUse('a', 1), result('a', 'TMB_PROBE_1_EXIT=1'), bashUse('b', 1), result('b', 'TMB_PROBE_1_EXIT=7\nTMB_PROBE_1_EXIT=0')];
  assert.deepEqual(commandStatuses(events, 1), ['0']);
});

test('parseEvents reads stream-json lines and skips non-JSON lines', () => {
  const jsonl = [JSON.stringify(bashUse('t1', 1)), 'not json', '', JSON.stringify(result('t1', 'TMB_PROBE_1_EXIT=2'))].join('\n');
  assert.deepEqual(commandStatuses(parseEvents(jsonl), 1), ['2']);
});

test('B failures count only commands that pass on the host', () => {
  const commands = ['c1', 'c2', 'c3'];
  assert.deepEqual(bFailures(['0', '1', '0'], ['1', '1', '0'], commands), ['c1']);
  assert.deepEqual(bFailures(['0', '0', '0'], ['0', 'unsandboxed', 'not-run'], commands), ['c2', 'c3']);
});

test('regressions: a new failure regresses, a recorded failure does not, no platform entry counts every failure', () => {
  assert.deepEqual(regressions(['bun add is-number'], { failed: [] }), ['bun add is-number']);
  assert.deepEqual(regressions(['bun add is-number'], { failed: ['bun add is-number'] }), []);
  assert.deepEqual(regressions(['bun add is-number', 'npm view is-number version'], null), ['bun add is-number', 'npm view is-number version']);
  assert.deepEqual(regressions(['x'], {}), ['x']);
  assert.deepEqual(regressions([], undefined), []);
});

test('report table marks a B failure the host shares as not counted', () => {
  assert.deepEqual(reportTable(['0', '1'], ['1', '0'], ['0', '2'], ['c1', 'c2']), [
    "| Command | host | A: filesystem only | B: /onboard's block |",
    '|---|---|---|---|',
    '| `c1` | pass | FAIL (1) | pass |',
    '| `c2` | FAIL (1) | pass | FAIL (2), not counted: host fails |',
  ]);
});

test('the prompt runs each command with its exit marker', () => {
  const prompt = promptFor(['gh api x']);
  assert.match(prompt, /never set dangerouslyDisableSandbox/);
  assert.ok(prompt.includes('1. `gh api x; echo "TMB_PROBE_1_EXIT=$?"`\n'));
});

test('parseArgs accepts --keep and --check-recorded and names an unknown argument', () => {
  assert.deepEqual(parseArgs(['--keep', '--check-recorded']), { keep: true, checkRecorded: true });
  assert.deepEqual(parseArgs([]), { keep: false, checkRecorded: false });
  assert.deepEqual(parseArgs(['--keep', '--bogus']), { unknown: '--bogus' });
});

test('an unknown argument exits 2 before any live run', () => {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', SCRIPT, '--bogus'], { cwd: dirname(SCRIPT), encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.equal(r.stderr, 'sandbox-network-probe: unknown argument --bogus\n');
  assert.equal(r.stdout, '');
});

test('run through a symlinked path, an unknown argument still exits 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tmb-probe-link-'));
  try {
    const link = join(dir, 'sandbox-network-probe.ts');
    symlinkSync(SCRIPT, link);
    const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', link, '--bogus'], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 2);
    assert.equal(r.stderr, 'sandbox-network-probe: unknown argument --bogus\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseDotEnv reads values the way sourcing the file does', () => {
  const env = parseDotEnv(
    [
      'A=plain',
      'export B=exported',
      'C=token # trailing comment',
      'D="quoted # kept" # dropped',
      "E='single'",
      'F=a#b',
      'G=',
      '# H=commented',
      'I=  spaced  ',
    ].join('\n'),
  );
  assert.deepEqual(env, { A: 'plain', B: 'exported', C: 'token', D: 'quoted # kept', E: 'single', F: 'a#b', G: '', I: 'spaced' });
});
