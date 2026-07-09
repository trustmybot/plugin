import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';
import { createShutdown, installShutdownHandlers, type ShutdownDeps } from '../shutdown.js';

function spyDeps(): {
  deps: ShutdownDeps;
  calls: { closeDb: number; closeGraph: number; exit: number[]; signals: string[] };
} {
  const calls = { closeDb: 0, closeGraph: 0, exit: [] as number[], signals: [] as string[] };
  const deps: ShutdownDeps = {
    closeDb: () => {
      calls.closeDb++;
    },
    closeGraph: () => {
      calls.closeGraph++;
    },
    log: (signal: string) => {
      calls.signals.push(signal);
    },
    exit: (code: number) => {
      calls.exit.push(code);
    },
    pid: 1234,
  };
  return { deps, calls };
}

describe('createShutdown — idempotency (#145)', () => {
  it('closes db then graph and exits(0) on first call', () => {
    const { deps, calls } = spyDeps();
    const shutdown = createShutdown(deps);
    shutdown('SIGTERM');
    assert.equal(calls.closeDb, 1);
    assert.equal(calls.closeGraph, 1);
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
    assert.equal(calls.closeGraph, 1, 'graph closed exactly once');
    assert.deepEqual(calls.exit, [0], 'exits exactly once');
    assert.deepEqual(calls.signals, ['SIGINT'], 'only the first signal is logged');
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
    assert.equal(calls.closeGraph, 1, 'graph (kuzu lock) released on EOF');
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
    assert.equal(calls.closeGraph, 1, 'graph (kuzu lock) released on close');
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
    assert.equal(calls.closeGraph, 1);
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
    assert.equal(calls.closeGraph, 1);
    assert.deepEqual(calls.exit, [0]);
    assert.deepEqual(calls.signals, ['SIGTERM']);
  });
});
