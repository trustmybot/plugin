import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';
import { createShutdown, installShutdownHandlers, type ShutdownDeps } from '../shutdown.js';

function spyDeps(): {
  deps: ShutdownDeps;
  calls: { closeDb: number; exit: number[]; signals: string[] };
} {
  const calls = { closeDb: 0, exit: [] as number[], signals: [] as string[] };
  const deps: ShutdownDeps = {
    closeDb: () => {
      calls.closeDb++;
    },
    log: (signal: string) => {
      calls.signals.push(signal);
    },
    exit: (code: number) => {
      calls.exit.push(code);
    },
    pid: 1234,
    flushStdout: (done) => done(),
  };
  return { deps, calls };
}

describe('createShutdown — idempotency (#145)', () => {
  it('closes the db and exits(0) on first call', () => {
    const { deps, calls } = spyDeps();
    const shutdown = createShutdown(deps);
    shutdown('SIGTERM');
    assert.equal(calls.closeDb, 1);
    assert.deepEqual(calls.exit, [0]);
    assert.deepEqual(calls.signals, ['SIGTERM']);
  });

  it('is a no-op on every call after the first (shuttingDown guard)', () => {
    const { deps, calls } = spyDeps();
    const shutdown = createShutdown(deps);
    shutdown('SIGINT');
    shutdown('stdin-eof');
    shutdown('stdin-close');
    shutdown('SIGTERM');
    assert.equal(calls.closeDb, 1, 'db closed exactly once');
    assert.deepEqual(calls.exit, [0], 'exits exactly once');
    assert.deepEqual(calls.signals, ['SIGINT'], 'only the first signal is logged');
  });

  it('releases the DB once but waits for stdout completion before exit (GH 2161)', () => {
    const { deps, calls } = spyDeps();
    let complete: ((error?: Error | null) => void) | undefined;
    deps.flushStdout = (done) => { complete = done; };
    const shutdown = createShutdown(deps);
    shutdown('stdin-eof');
    shutdown('stdin-close');
    shutdown('SIGTERM');
    assert.equal(calls.closeDb, 1, 'DB release does not wait for a slow stdout consumer');
    assert.deepEqual(calls.exit, [], 'exit must not discard queued stdout');
    assert.ok(complete);
    complete();
    assert.deepEqual(calls.exit, [0]);
    assert.deepEqual(calls.signals, ['stdin-eof']);
  });

  it('reports a failed flush and exits once with failure instead of hanging', () => {
    const { deps, calls } = spyDeps();
    deps.flushStdout = (done) => {
      done(Object.assign(new Error('reader disappeared'), { code: 'EPIPE' }));
      done();
    };
    createShutdown(deps)('stdin-eof');
    assert.equal(calls.closeDb, 1);
    assert.deepEqual(calls.exit, [1]);
    assert.deepEqual(calls.signals, ['stdin-eof', 'stdout-drain-error:EPIPE']);
  });
});

describe('installShutdownHandlers — stdin-EOF watchdog (#145)', () => {
  it('triggers a single shutdown on stdin end', () => {
    const { deps, calls } = spyDeps();
    const shutdown = createShutdown(deps);
    const stdin = new EventEmitter() as unknown as Readable;
    const proc = new EventEmitter() as unknown as NodeJS.Process;
    installShutdownHandlers(shutdown, proc, stdin);

    (stdin as unknown as EventEmitter).emit('end');
    assert.deepEqual(calls.signals, ['stdin-eof']);
    assert.equal(calls.closeDb, 1, 'db released on EOF');
    assert.deepEqual(calls.exit, [0]);
  });

  it('triggers a single shutdown on stdin close', () => {
    const { deps, calls } = spyDeps();
    const shutdown = createShutdown(deps);
    const stdin = new EventEmitter() as unknown as Readable;
    const proc = new EventEmitter() as unknown as NodeJS.Process;
    installShutdownHandlers(shutdown, proc, stdin);

    (stdin as unknown as EventEmitter).emit('close');
    assert.deepEqual(calls.signals, ['stdin-close']);
    assert.equal(calls.closeDb, 1, 'db released on close');
    assert.deepEqual(calls.exit, [0]);
  });

  it('composes safely when both end and close fire (single close)', () => {
    const { deps, calls } = spyDeps();
    const shutdown = createShutdown(deps);
    const stdin = new EventEmitter() as unknown as Readable;
    const proc = new EventEmitter() as unknown as NodeJS.Process;
    installShutdownHandlers(shutdown, proc, stdin);

    (stdin as unknown as EventEmitter).emit('end');
    (stdin as unknown as EventEmitter).emit('close');
    assert.equal(calls.closeDb, 1);
    assert.deepEqual(calls.exit, [0], 'EOF + close + any signal = one shutdown');
    assert.deepEqual(calls.signals, ['stdin-eof']);
  });

  it('composes safely when a signal then stdin-eof fire', () => {
    const { deps, calls } = spyDeps();
    const shutdown = createShutdown(deps);
    const stdin = new EventEmitter() as unknown as Readable;
    const proc = new EventEmitter() as unknown as NodeJS.Process;
    installShutdownHandlers(shutdown, proc, stdin);

    (proc as unknown as EventEmitter).emit('SIGTERM');
    (stdin as unknown as EventEmitter).emit('end');
    assert.equal(calls.closeDb, 1);
    assert.deepEqual(calls.exit, [0]);
    assert.deepEqual(calls.signals, ['SIGTERM']);
  });
});
