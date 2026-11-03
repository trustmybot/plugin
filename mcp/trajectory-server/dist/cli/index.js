/**
 * Entry of dist/cli.js (GH 1692), the MCP-down fallbacks and the health check run with
 * `node --experimental-sqlite "${CLAUDE_PLUGIN_ROOT}/mcp/trajectory-server/dist/cli.js" <subcommand> ...`.
 * They read and write the trajectory DB through node:sqlite and never need the
 * server process. SIGINT and SIGTERM wait for the synchronous run, which
 * removes its scratch files, then exit 130 and 143 as the shell traps did.
 */
import { broSqliteReadonly } from './bro-sqlite-readonly.js';
import { health } from './health.js';
import { validationRecordFallback } from './validation-record-fallback.js';
const SUBCOMMANDS = {
    'bro-sqlite-readonly': broSqliteReadonly,
    health,
    'validation-record-fallback': validationRecordFallback,
};
const USAGE = `usage: cli.js <${Object.keys(SUBCOMMANDS).join('|')}> [args...]\n`;
const io = {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
};
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));
const [name, ...argv] = process.argv.slice(2);
const run = name !== undefined && Object.hasOwn(SUBCOMMANDS, name) ? SUBCOMMANDS[name] : undefined;
if (name === '--help' || name === '-h') {
    io.out(USAGE);
}
else if (!run) {
    io.err(name === undefined ? USAGE : `cli.js: unknown subcommand '${name}'\n${USAGE}`);
    process.exitCode = 2;
}
else {
    process.exitCode = run(argv, process.env, io);
}
//# sourceMappingURL=index.js.map