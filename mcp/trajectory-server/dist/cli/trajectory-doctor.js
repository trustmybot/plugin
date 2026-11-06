/**
 * `cli.js trajectory-doctor` (GH 1692), ported from the former maintenance
 * shell wrapper. The DB path is resolved and checked before any tool module
 * is loaded, so a missing DB exits 2 and creates nothing.
 */
import { existsSync } from 'node:fs';
const HELP = `Check a trajectory DB against its data contracts. Prints the JSON report.
The check opens the DB file on a query-only connection — never as the
server does — so it applies no schema and runs no migration: an older DB is
reported as it is. --record adds one trajectory_doctor_run audit row through
the trajectory server's trajectory_doctor tool, called as bro, and only on a
DB already at the server's schema version.

Usage (from the project directory, or with --db / TRAJECTORY_DB_PATH):
  node --experimental-sqlite <plugin>/mcp/trajectory-server/dist/cli.js trajectory-doctor [--db <path>] [--ids <id,id,...>] [--record]

Exits 0 when healthy, 1 when an error-severity contract fails or cannot run,
2 when the DB schema is older than the contracts need (start the trajectory
server to migrate), on a usage error, a missing DB, or a tool error.

`;
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
export async function trajectoryDoctor(argv, env, io) {
    let record = false;
    let idList = '';
    const runEnv = { ...env };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--record')
            record = true;
        else if (arg === '--ids' || arg === '--db') {
            const value = argv[i + 1] ?? '';
            if (value === '') {
                io.err(`trajectory-doctor: ${arg} needs ${arg === '--ids' ? 'a comma-separated id list' : 'a path'}\n`);
                return 2;
            }
            if (arg === '--ids')
                idList = value;
            else
                runEnv.TRAJECTORY_DB_PATH = value;
            i += 1;
        }
        else if (arg === '-h' || arg === '--help') {
            io.out(HELP);
            return 0;
        }
        else {
            io.err(`trajectory-doctor: unknown argument: ${arg}\n`);
            return 2;
        }
    }
    const { resolveDbPath } = await import('../db.js');
    const dbPath = resolveDbPath({ env: runEnv });
    if (dbPath === ':memory:' || !existsSync(dbPath)) {
        io.err(`trajectory-doctor: no trajectory DB at ${dbPath}; run from the project or pass --db\n`);
        return 2;
    }
    const { checkTrajectoryDbFile, selectContracts, trajectoryDoctorTools } = await import('../tools/trajectory-doctor.js');
    const ids = idList
        ? idList
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined;
    const selected = selectContracts(ids);
    if ('error' in selected) {
        io.out(json(selected));
        return 2;
    }
    let report = checkTrajectoryDbFile(dbPath, selected.contracts);
    if (!report.schema.current) {
        io.out(json(report));
        io.err(`trajectory-doctor: unchecked (schema v${report.schema.stored} < v${report.schema.required} — start the trajectory server to migrate)\n`);
        return 2;
    }
    if (record) {
        const { TrajectoryDB, TARGET_SCHEMA_VERSION } = await import('../db.js');
        if (report.schema.stored !== TARGET_SCHEMA_VERSION) {
            io.out(json(report));
            io.err(`trajectory-doctor: --record needs the server schema v${TARGET_SCHEMA_VERSION} (DB is v${report.schema.stored}) — start the trajectory server to migrate; nothing recorded\n`);
            return 2;
        }
        const db = new TrajectoryDB(dbPath);
        const args = { agent: 'bro', record: true };
        if (ids)
            args.ids = ids;
        const res = await trajectoryDoctorTools(db).handlers.trajectory_doctor(args);
        db.close();
        const first = res.content[0];
        report = JSON.parse(first.type === 'text' ? first.text : '');
        if (res.isError) {
            io.out(json(report));
            return 2;
        }
    }
    io.out(json(report));
    return report.healthy ? 0 : 1;
}
//# sourceMappingURL=trajectory-doctor.js.map