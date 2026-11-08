// node:test suite for timeout.ts: a command past its limit reports 124, one under it its own code.
// Run: node --experimental-strip-types --test tests/l5-l6/lib/timeout.test.ts

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { runWithTimeout, TIMEOUT_STATUS } from './timeout.ts';

const node = process.execPath;

describe('runWithTimeout', () => {
  test('a command over its limit is killed and returns 124', () => {
    const r = runWithTimeout(1, node, ['-e', 'setTimeout(() => {}, 30000)']);
    assert.equal(r.status, TIMEOUT_STATUS);
    assert.equal(r.status, 124);
    assert.equal(r.timedOut, true);
  });

  test('a command under its limit returns its own exit code', () => {
    const r = runWithTimeout(30, node, ['-e', 'process.exit(7)']);
    assert.equal(r.status, 7);
    assert.equal(r.timedOut, false);
  });

  test('a command under its limit that succeeds returns 0 and its output', () => {
    const r = runWithTimeout(30, node, ['-e', 'process.stdout.write("out"); process.stderr.write("err")']);
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, 'out', 'err']);
  });

  test('input reaches the command on stdin', () => {
    const r = runWithTimeout(30, node, ['-e', 'process.stdin.pipe(process.stdout)'], { input: 'piped\n' });
    assert.equal(r.stdout, 'piped\n');
  });

  test('a command that cannot be found returns 127', () => {
    assert.equal(runWithTimeout(5, 'tmb-no-such-command-xyz').status, 127);
  });

  test('a command a signal ends returns 128 + the signal number', () => {
    const r = runWithTimeout(30, node, ['-e', 'process.kill(process.pid, "SIGTERM")']);
    assert.equal(r.status, 128 + 15);
  });
});
