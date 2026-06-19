import type { Readable } from 'node:stream';

export interface ShutdownDeps {
  closeDb: () => void;
  closeGraph: () => void;
  log: (signal: string) => void;
  exit: (code: number) => void;
  pid: number;
}

/**
 * Builds an idempotent shutdown() and wires the signal + stdin-EOF watchdog.
 *
 * The kuzu world-model graph is a single-writer store: the server holds an
 * exclusive lock on `world-model.kuzu` for its whole lifetime. A graceful exit
 * releases it via closeGraph(). But when the parent `claude` process dies
 * ungracefully (terminal close, Force-Quit, `kill -9`, crash, OOM) no
 * SIGINT/SIGTERM reaches this stdio child — it reparents to launchd and would
 * hold the lock forever, so later servers fail to open the graph
 * (`Could not set lock on file`) and fall back to world-model-empty.
 *
 * The portable fix: when the parent dies for ANY reason the OS closes the
 * child's stdin write-end, so the child sees EOF. Listening for stdin
 * `end`/`close` turns that EOF into the same clean shutdown() path. The MCP
 * stdio transport reads stdin via a `data` listener; `end`/`close` are
 * lifecycle events that fire alongside it, so the watchdog observes the same
 * stream without competing with or starving the transport's reader.
 *
 * shutdown() is idempotent (the `shuttingDown` guard) so SIGINT, SIGTERM, and
 * the two stdin events may all fire without a double-close.
 */
export function createShutdown(deps: ShutdownDeps): (signal: string) => void {
  let shuttingDown = false;
  return function shutdown(signal: string): void {
    if (shuttingDown) return;
    shuttingDown = true;
    deps.log(signal);
    deps.closeDb();
    deps.closeGraph();
    deps.exit(0);
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
