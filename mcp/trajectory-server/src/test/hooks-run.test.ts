/**
 * runHook (GH 1692): a gate may answer at once or as a Promise; the runner
 * writes its stdout and returns its code either way. An unknown gate and a
 * gate that throws or rejects each write one stderr line and return 1.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Gate } from '../hooks/gate.js';
import { runHook } from '../hooks/run.js';

interface Captured {
  code: number;
  stdout: string;
  stderr: string;
}

async function capture(gate: Gate | undefined, name = 'probe'): Promise<Captured> {
  let stdout = '';
  let stderr = '';
  const code = await runHook(name, (n) => (n === name ? gate : undefined), { PROBE: '1' }, {
    readStdin: () => '{"tool_name":"Bash"}',
    writeStdout: (t) => {
      stdout += t;
    },
    writeStderr: (t) => {
      stderr += t;
    },
  });
  return { code, stdout, stderr };
}

describe('runHook (GH 1692)', () => {
  it('awaits a Promise gate and writes its stdout and code', async () => {
    let seen: [string, string | undefined] = ['', undefined];
    const gate: Gate = async (payload, env) => {
      seen = [payload, env.PROBE];
      await new Promise((r) => setImmediate(r));
      return { stdout: '{"decision":"block"}\n', code: 2 };
    };
    const out = await capture(gate);
    assert.deepEqual(seen, ['{"tool_name":"Bash"}', '1']);
    assert.equal(out.code, 2);
    assert.equal(out.stdout, '{"decision":"block"}\n');
    assert.equal(out.stderr, '');
  });

  it('runs a synchronous gate the same way', async () => {
    const out = await capture(() => ({ stdout: 'ctx\n', code: 0 }));
    assert.deepEqual([out.code, out.stdout, out.stderr], [0, 'ctx\n', '']);
  });

  it('fails an unknown gate with one stderr line', async () => {
    const out = await capture(undefined, 'no-such\ngate');
    assert.deepEqual([out.code, out.stdout], [1, '']);
    assert.equal(out.stderr, "TMB hooks: unknown gate 'no-such gate' — not run\n");
  });

  it('fails a rejecting gate with one stderr line and no stdout', async () => {
    const out = await capture(() => Promise.reject(new Error('boom\n  at frame')));
    assert.deepEqual([out.code, out.stdout], [1, '']);
    assert.equal(out.stderr, "TMB hooks: gate 'probe' failed: boom at frame\n");
  });

  it('fails a throwing gate the same way', async () => {
    const out = await capture(() => {
      throw new Error('sync boom');
    });
    assert.equal(out.code, 1);
    assert.equal(out.stderr, "TMB hooks: gate 'probe' failed: sync boom\n");
  });
});
