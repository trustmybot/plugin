/**
 * `cli.js hook-lib <mode>` (GH 1692): the hook-lib answer callers outside
 * the hooks ask for, such as tests/l5-l6/run-l6-chain.ts.
 *   db-path  dbPath(env) on stdout; exit 1 and no stdout when no DB resolves
 * Exit 2 on a missing or unknown mode.
 */
import { dbPath } from '../hooks/lib/db.js';
const USAGE = 'usage: cli.js hook-lib <db-path>\n';
export function hookLib(argv, env, io) {
    const [mode] = argv;
    if (mode === 'db-path') {
        const db = dbPath(env, (line) => io.err(`${line}\n`));
        if (db === null)
            return 1;
        io.out(`${db}\n`);
        return 0;
    }
    io.err(mode === undefined ? USAGE : `hook-lib: unknown mode '${mode}'\n${USAGE}`);
    return 2;
}
//# sourceMappingURL=hook-lib.js.map