import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = mkdtempSync(join(tmpdir(), 'tmb-shutdown-stdio-'));
after(() => rmSync(root, { recursive: true, force: true }));

async function run(args: string[], options: { input?: string; db?: string; signal?: boolean; reader?: 'closed' | 'stalled' } = {}) {
  const child = spawn(process.execPath, ['--experimental-sqlite', ...args], {
    cwd: root, stdio: ['pipe', 'pipe', 'pipe'], timeout: 10_000, killSignal: 'SIGKILL',
    env: { ...process.env, TRAJECTORY_DB_PATH: options.db ?? ':memory:', CLAUDE_PROJECT_DIR: root, TMB_SKIP_AUTO_RESCAN: '1', TMPDIR: root },
  });
  const chunks: Buffer[] = [];
  // Yield on every chunk to exercise pipe backpressure without timing sleeps.
  const sink = new Writable({ highWaterMark: 1, write(chunk: Buffer, _encoding, callback) {
    chunks.push(Buffer.from(chunk));
    setImmediate(callback);
  } });
  if (!options.reader) child.stdout.pipe(sink);
  else child.once('exit', () => child.stdout.resume());
  let stderr = '';
  let signaled = false;
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
    if (options.reader === 'closed' && stderr.includes('db-closed\n')) child.stdout.destroy();
    if (options.signal && !signaled && stderr.includes('ready\n')) {
      signaled = true;
      child.kill('SIGTERM');
    }
  });
  try {
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    if (!options.signal) child.stdin.end(options.input ?? '');
    const [status] = await Promise.all([closed, options.reader ? Promise.resolve() : finished(sink)]);
    return { ...status, stdout: Buffer.concat(chunks).toString(), stderr };
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

function largeResponseFixture(flushTimeoutMs = 5000): string[] {
  return ['--input-type=module', '-e', `
    import { createShutdown, installShutdownHandlers } from ${JSON.stringify(new URL('../shutdown.js', import.meta.url).href)};
    const shutdown = createShutdown({ closeDb: () => process.stderr.write('db-closed\\n'), log: () => {}, exit: (code) => process.exit(code), pid: process.pid, flushTimeoutMs: ${flushTimeoutMs} });
    installShutdownHandlers(shutdown, process, process.stdin);
    process.stdin.resume();
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'x'.repeat(2 * 1024 * 1024) }) + '\\n');
    process.stderr.write('ready\\n');
  `];
}

describe('stdio shutdown preserves queued responses (GH 2161)', () => {
  for (const signal of [false, true]) {
    it(`drains a response larger than pipe capacity on ${signal ? 'SIGTERM' : 'stdin EOF'}`, async () => {
      const result = await run(largeResponseFixture(), { signal });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.signal, null);
      assert.equal(result.stderr.match(/db-closed\n/g)?.length, 1, 'DB closes exactly once');
      const expected = JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'x'.repeat(2 * 1024 * 1024) }) + '\n';
      assert.equal(Buffer.byteLength(result.stdout), Buffer.byteLength(expected), `truncated response tail: ${result.stdout.slice(-80)}`);
      assert.deepEqual(JSON.parse(result.stdout), JSON.parse(expected));
    });
  }

  for (const reader of ['closed', 'stalled'] as const) {
    it(`reports failed output and leaves no process when the stdout reader is ${reader}`, async () => {
      const result = await run(largeResponseFixture(reader === 'stalled' ? 100 : 5000), { reader });
      assert.equal(result.code, 1, result.stderr);
      assert.equal(result.signal, null, 'shutdown must finish before the external SIGKILL deadline');
      assert.equal(result.stderr.match(/db-closed\n/g)?.length, 1);
      assert.match(result.stderr, reader === 'closed' ? /stdout drain failed: EPIPE/ : /stdout drain failed: ETIMEDOUT/);
    });
  }

  for (const persistent of [false, true]) {
    it(`returns complete tools/list JSON after EOF with a ${persistent ? 'persistent' : 'memory'} DB`, async () => {
      const db = persistent ? join(root, 'trajectory.db') : ':memory:';
      const result = await run([fileURLToPath(new URL('../index.js', import.meta.url))], {
        db, input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n',
      });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.signal, null, 'EOF must not leave an orphan waiting for the test deadline');
      assert.ok(result.stdout.length > 64 * 1024, `catalog truncated at ${result.stdout.length} bytes; tail: ${result.stdout.slice(-80)}`);
      const response = JSON.parse(result.stdout);
      assert.equal(response.id, 1);
      assert.ok(response.result.tools.some((tool: { name: string }) => tool.name === 'onboard_state_get'));
      if (persistent) {
        const reopened = new DatabaseSync(db);
        try { assert.equal(reopened.prepare('PRAGMA integrity_check').get()?.['integrity_check'], 'ok'); }
        finally { reopened.close(); }
      }
    });
  }

  it('empty stdin EOF releases the server without producing protocol output', async () => {
    const result = await run([fileURLToPath(new URL('../index.js', import.meta.url))]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.signal, null);
    assert.equal(result.stdout, '');
  });
});
