import type { Readable } from 'node:stream';

export interface ShutdownDeps {
  closeDb: () => void;
  log: (signal: string) => void;
  exit: (code: number) => void;
  pid: number;
  /** Test seam; production queues a stdout write callback after pending output. */
  flushStdout?: (done: (error?: Error | null) => void) => void;
  /** Upper bound for a connected stdout reader that never consumes output. */
  flushTimeoutMs?: number;
}

/**
 * Builds an idempotent shutdown() and wires the signal + stdin-EOF watchdog.
 *
 * A graceful exit closes the trajectory DB via closeDb(). But when the parent
 * `claude` process dies ungracefully (terminal close, Force-Quit, `kill -9`,
 * crash, OOM) no SIGINT/SIGTERM reaches this stdio child — it reparents to
 * launchd and would linger as an orphan holding its DB handle open.
 *
 * The portable fix: when the parent dies for ANY reason the OS closes the
 * child's stdin write-end, so the child sees EOF. Listening for stdin
 * `end`/`close` turns that EOF into the same clean shutdown() path. The MCP
 * stdio transport reads stdin via a `data` listener; `end`/`close` are
 * lifecycle events that fire alongside it, so the watchdog observes the same
 * stream without competing with or starving the transport's reader.
 *
 * shutdown() is idempotent (the `shuttingDown` guard) so SIGINT, SIGTERM, and
 * the two stdin events may all fire without a double-close. Explicit exit must
 * wait for queued stdout writes: pipe output is asynchronous and process.exit
 * would otherwise truncate large JSON-RPC responses on stdin EOF (GH 2161).
 * This flushes bytes already queued; it does not wait for unfinished handlers.
 */
export function createShutdown(deps: ShutdownDeps): (signal: string) => void {
  let shuttingDown = false;
  return function shutdown(signal: string): void {
    if (shuttingDown) return;
    shuttingDown = true;
    deps.log(signal);
    deps.closeDb();
    let finished = false;
    const finish = (error?: Error | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      if (error) {
        const code = (error as NodeJS.ErrnoException).code ?? error.message;
        deps.log(`stdout-drain-error:${code}`);
        process.stderr.write(`stdout drain failed: ${code}\n`);
      }
      deps.exit(error ? 1 : 0);
    };
    // A deadline bounds failed shutdown; successful writes exit immediately on
    // completion. Never keep an orphan alive behind an unresponsive reader.
    const deadline = setTimeout(
      () => finish(Object.assign(new Error('stdout drain timed out'), { code: 'ETIMEDOUT' })),
      deps.flushTimeoutMs ?? 5000,
    );
    deadline.unref();
    const flushStdout = deps.flushStdout ?? ((done: (error?: Error | null) => void) => {
      process.stdout.write('', done);
    });
    try {
      flushStdout(finish);
    } catch (error) {
      finish(error as Error);
    }
  };
}

export function installShutdownHandlers(
  shutdown: (signal: string) => void,
  proc: NodeJS.Process,
  stdin: Readable,
): void {
  proc.on('SIGINT', () => shutdown('SIGINT'));
  proc.on('SIGTERM', () => shutdown('SIGTERM'));
  stdin.on('end', () => shutdown('stdin-eof'));
  stdin.on('close', () => shutdown('stdin-close'));
}
