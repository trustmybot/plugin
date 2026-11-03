/**
 * Entry of dist/cli.js (GH 1692), the MCP-down fallbacks, the health check,
 * bro's integrate, the assert-sql verification check and the prompt-author-lint
 * pre-write lint run with
 * `node --experimental-sqlite "${CLAUDE_PLUGIN_ROOT}/mcp/trajectory-server/dist/cli.js" <subcommand> ...`.
 * They read and write the trajectory DB through node:sqlite and never need the
 * server process. SIGINT and SIGTERM exit 130 and 143 as the shell traps did,
 * once the synchronous part of the run returns; a subcommand cleans up on the
 * process 'exit' event.
 */
import { assertSql } from './assert-sql.js';
import { broSqliteReadonly } from './bro-sqlite-readonly.js';
import type { CliIo } from './fallback-db.js';
import { health } from './health.js';
import { integrate } from './integrate.js';
import { promptAuthorLint } from './prompt-author-lint.js';
import { validationRecordFallback } from './validation-record-fallback.js';

type Subcommand = (argv: readonly string[], env: NodeJS.ProcessEnv, io: CliIo) => number | Promise<number>;

const SUBCOMMANDS: Record<string, Subcommand> = {
  'assert-sql': assertSql,
  'bro-sqlite-readonly': broSqliteReadonly,
  health,
  integrate,
  'prompt-author-lint': promptAuthorLint,
  'validation-record-fallback': validationRecordFallback,
};

const USAGE = `usage: cli.js <${Object.keys(SUBCOMMANDS).join('|')}> [args...]\n`;

const io: CliIo = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
};

process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));

const [name, ...argv] = process.argv.slice(2);
const run = name !== undefined && Object.hasOwn(SUBCOMMANDS, name) ? SUBCOMMANDS[name] : undefined;
if (name === '--help' || name === '-h') {
  io.out(USAGE);
} else if (!run) {
  io.err(name === undefined ? USAGE : `cli.js: unknown subcommand '${name}'\n${USAGE}`);
  process.exitCode = 2;
} else {
  void Promise.resolve(run(argv, process.env, io)).then((code) => {
    process.exitCode = code;
  });
}
