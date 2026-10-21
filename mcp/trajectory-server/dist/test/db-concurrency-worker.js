// Child process for db-concurrency.test.ts: one trajectory-server-like
// process opening the shared DB through TrajectoryDB. It prints `ready`, waits
// for the parent's go-file so every worker starts together, then prints one
// JSON result line.
//
//   node db-concurrency-worker.js write <db> <go-file> <worker-id> <writes>
//   node db-concurrency-worker.js open <db> <go-file>
import { existsSync } from 'node:fs';
import { TrajectoryDB } from '../db.js';
const [mode, dbPath, goFile, ...rest] = process.argv.slice(2);
if (!mode || !dbPath || !goFile) {
    process.stderr.write('usage: db-concurrency-worker.js write|open <db> <go-file> ...\n');
    process.exit(2);
}
const pause = new Int32Array(new SharedArrayBuffer(4));
process.stdout.write('ready\n');
while (!existsSync(goFile))
    Atomics.wait(pause, 0, 0, 2);
const serverLogEntries = [];
const dependencies = {
    pluginVersion: null,
    serverLog: (entry) => serverLogEntries.push(entry),
    sqlLog: () => { },
};
function errorMessage(err) {
    return err instanceof Error ? err.message : String(err);
}
function runWrites(workerId, writes) {
    const errors = [];
    let committed = 0;
    const db = new TrajectoryDB(dbPath, dependencies);
    try {
        for (let i = 0; i < writes; i++) {
            try {
                db.transaction(() => {
                    const next = db.get('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM concurrency_probe').next;
                    db.run('INSERT INTO concurrency_probe (seq, worker) VALUES (?, ?)', [next, workerId]);
                });
                committed++;
            }
            catch (err) {
                errors.push(errorMessage(err));
            }
        }
    }
    finally {
        db.close();
    }
    return { committed, errors };
}
function runOpen() {
    try {
        const db = new TrajectoryDB(dbPath, dependencies, { migrate: true });
        const version = db.get('SELECT schema_version FROM plugin_meta WHERE id = 1')?.schema_version;
        db.close();
        return {
            version,
            migrations: serverLogEntries.filter((e) => e['kind'] === 'schema_migrated').length,
            errors: [],
        };
    }
    catch (err) {
        return { version: null, migrations: 0, errors: [errorMessage(err)] };
    }
}
const result = mode === 'write' ? runWrites(rest[0] ?? 'w', Number(rest[1] ?? '0')) : runOpen();
process.stdout.write(`${JSON.stringify(result)}\n`);
//# sourceMappingURL=db-concurrency-worker.js.map