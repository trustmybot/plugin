/**
 * `cli.js backfill-agent-runs` (GH 1692), ported from the former maintenance
 * shell wrapper. The DB path is resolved and checked before any tool module
 * is loaded, so a missing DB exits 2 and creates nothing.
 */
import { existsSync } from 'node:fs';
const USAGE = `Recover agent_runs rows from the Claude Code transcripts still on disk — a
terminal wrapper over the trajectory server's agent_runs_backfill tool,
called as bro. Transcripts are read, never written; the only write is to the
project's trajectory DB, and only with --apply.

Usage (from the project directory, or with TRAJECTORY_DB_PATH set):
  node --experimental-sqlite <plugin>/mcp/trajectory-server/dist/cli.js backfill-agent-runs [--apply] [--since <ISO>] [--transcripts-dir <dir>]

Without --apply it is a dry run: prints the report, writes nothing.
--transcripts-dir overrides ~/.claude/projects/<project-slug>.
Exits 2 with this usage when no trajectory DB exists (nothing is created),
1 when the tool reports an error.
`;
export async function backfillAgentRuns(argv, env, io) {
    let dryRun = true;
    let since = '';
    let transcriptsDir = '';
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--apply')
            dryRun = false;
        else if (arg === '--since' || arg === '--transcripts-dir') {
            const value = argv[i + 1] ?? '';
            if (value === '') {
                io.err(`backfill-agent-runs: ${arg} needs ${arg === '--since' ? 'an ISO timestamp' : 'a path'}\n`);
                return 2;
            }
            if (arg === '--since')
                since = value;
            else
                transcriptsDir = value;
            i += 1;
        }
        else if (arg === '-h' || arg === '--help') {
            io.out(USAGE);
            return 0;
        }
        else {
            io.err(`backfill-agent-runs: unknown argument: ${arg}\n`);
            return 2;
        }
    }
    const { TrajectoryDB, resolveDbPath } = await import('../db.js');
    const dbPath = resolveDbPath({ env });
    if (dbPath === ':memory:' || !existsSync(dbPath)) {
        io.err(`backfill-agent-runs: no trajectory DB at ${dbPath}; run from the project or set TRAJECTORY_DB_PATH\n\n${USAGE}`);
        return 2;
    }
    const { agentRunsBackfillTools } = await import('../tools/agent-runs-backfill.js');
    const db = new TrajectoryDB(dbPath);
    const args = { agent: 'bro', dry_run: dryRun };
    if (since)
        args.since = since;
    if (transcriptsDir)
        args.transcripts_dir = transcriptsDir;
    const res = await agentRunsBackfillTools(db, dbPath).handlers.agent_runs_backfill(args);
    db.close();
    const first = res.content[0];
    const body = JSON.parse(first.type === 'text' ? first.text : '');
    io.out(`${JSON.stringify(body, null, 2)}\n`);
    return res.isError ? 1 : 0;
}
//# sourceMappingURL=backfill-agent-runs.js.map