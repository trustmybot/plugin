/**
 * Entry of dist/cli.js (GH 1692), the MCP-down fallbacks, the health check,
 * bro's integrate, the assert-sql verification check, the prompt-author-lint
 * pre-write lint, the stale-docs pre-close check and the Human-run maintenance tools (heal-mcp-cache,
 * trajectory-doctor, backfill-agent-runs) and the hook-lib db-path answer the
 * L6 chain runner asks for run with
 * `node --experimental-sqlite "${CLAUDE_PLUGIN_ROOT}/mcp/trajectory-server/dist/cli.js" <subcommand> ...`.
 * They read and write the trajectory DB through node:sqlite and never need the
 * server process. SIGINT and SIGTERM exit 130 and 143 as the shell traps did,
 * once the synchronous part of the run returns; a subcommand cleans up on the
 * process 'exit' event.
 */
import { assertSql } from './assert-sql.js';
import { backfillAgentRuns } from './backfill-agent-runs.js';
import { broSqliteReadonly } from './bro-sqlite-readonly.js';
import { healMcpCache } from './heal-mcp-cache.js';
import { health } from './health.js';
import { hookLib } from './hook-lib.js';
import { integrate } from './integrate.js';
import { promptAuthorLint } from './prompt-author-lint.js';
import { staleDocs } from './stale-docs.js';
import { trajectoryDoctor } from './trajectory-doctor.js';
import { validationRecordFallback } from './validation-record-fallback.js';
const SUBCOMMANDS = {
    'assert-sql': assertSql,
    'backfill-agent-runs': backfillAgentRuns,
    'bro-sqlite-readonly': broSqliteReadonly,
    'heal-mcp-cache': healMcpCache,
    health,
    'hook-lib': hookLib,
    integrate,
    'prompt-author-lint': promptAuthorLint,
    'stale-docs': staleDocs,
    'trajectory-doctor': trajectoryDoctor,
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
    void Promise.resolve(run(argv, process.env, io)).then((code) => {
        process.exitCode = code;
    });
}
//# sourceMappingURL=index.js.map