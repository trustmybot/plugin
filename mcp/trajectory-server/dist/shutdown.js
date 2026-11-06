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
 * the two stdin events may all fire without a double-close.
 */
export function createShutdown(deps) {
    let shuttingDown = false;
    return function shutdown(signal) {
        if (shuttingDown)
            return;
        shuttingDown = true;
        deps.log(signal);
        deps.closeDb();
        deps.exit(0);
    };
}
export function installShutdownHandlers(shutdown, proc, stdin) {
    proc.on('SIGINT', () => shutdown('SIGINT'));
    proc.on('SIGTERM', () => shutdown('SIGTERM'));
    stdin.on('end', () => shutdown('stdin-eof'));
    stdin.on('close', () => shutdown('stdin-close'));
}
//# sourceMappingURL=shutdown.js.map