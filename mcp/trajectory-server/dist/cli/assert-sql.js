/**
 * `cli.js assert-sql` (GH 1692): a dry-run or smoke assertion as a verification[] command.
 *
 *   node --experimental-sqlite "${CLAUDE_PLUGIN_ROOT}/mcp/trajectory-server/dist/cli.js" assert-sql <db> "<sql>" <expected> [--op eq|ge|le]
 *
 * Runs <sql> read-only against a private VACUUM INTO snapshot of <db>, taken
 * over a read-only connection: rows still in its -wal are included (even while
 * another connection writes), and <db> and its -wal are never written or
 * checkpointed. A WAL-mode <db> with no -wal is opened immutable, so no
 * -wal/-shm appears beside it; a -wal without its -shm gets the -shm back, as
 * for any reader. Point it at a cp of the reference data.
 * Compares the single value it returns to <expected> and prints one line.
 *   eq  string equality (default)
 *   ge  numeric: result >= expected
 *   le  numeric: result <= expected
 * A NULL result or no rows fails under every op ("got NULL or no rows").
 * The snapshot is opened, then removed before the query runs, so an INT or
 * TERM at any point leaves no copy behind.
 * Exit 0 = pass, 1 = mismatch, 2 = usage error, missing DB, or SQL error.
 */
import { closeSync, existsSync, mkdtempSync, openSync, readSync, rmSync } from 'node:fs';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { stripTrailingNewlines } from '../hooks/lib/db.js';
import { listValue, loadNodeSqlite, splitStatements } from '../hooks/lib/sqlite-shell.js';
import { isFile } from './fallback-db.js';
const USAGE = 'usage: cli.js assert-sql <db> "<sql>" <expected> [--op eq|ge|le]\n';
const SNAPSHOT_TIMEOUT_MS = 5000;
const NUMBER = /^-?[0-9]+(\.[0-9]+)?$/;
const OPS = ['eq', 'ge', 'le'];
function parseArgs(argv) {
    let op = 'eq';
    const positional = [];
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--op') {
            if (i + 1 >= argv.length)
                return null;
            op = argv[(i += 1)];
        }
        else if (arg.startsWith('--op=')) {
            op = arg.slice('--op='.length);
        }
        else {
            positional.push(arg);
        }
    }
    if (positional.length !== 3 || !OPS.includes(op))
        return null;
    const [db, sql, expected] = positional;
    return { db, sql, expected, op: op };
}
function uriPath(path) {
    return path.replace(/%/g, '%25').replace(/\?/g, '%3f').replace(/#/g, '%23');
}
function walModeHeader(db) {
    const byte = Buffer.alloc(1);
    const fd = openSync(db, 'r');
    try {
        return readSync(fd, byte, 0, 1, 18) === 1 && byte[0] === 2;
    }
    finally {
        closeSync(fd);
    }
}
function message(e) {
    const err = e;
    const text = err && typeof err.message === 'string' ? err.message : String(e);
    const code = err && typeof err.errcode === 'number' ? err.errcode & 0xff : 0;
    return code > 1 ? `${text} (${code})` : text;
}
/** The snapshot of <db>, opened read-only; its directory is already gone. */
function openSnapshot(db, env) {
    const { DatabaseSync } = loadNodeSqlite();
    const src = !existsSync(`${db}-wal`) && walModeHeader(db) ? `file:${uriPath(db)}?immutable=1` : db;
    const dir = mkdtempSync(`${(env.TMPDIR || '/tmp').replace(/\/+$/, '')}/assert-sql.`);
    try {
        const snap = `${dir}/ref.db`;
        const source = new DatabaseSync(src, { readOnly: true, timeout: SNAPSHOT_TIMEOUT_MS });
        try {
            source.prepare('VACUUM INTO ?').run(snap);
        }
        finally {
            source.close();
        }
        const copy = new DatabaseSync(snap);
        try {
            copy.exec('PRAGMA journal_mode=DELETE;');
        }
        finally {
            copy.close();
        }
        return new DatabaseSync(snap, { readOnly: true });
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
}
/** sqlite3 -bail list mode: the rows of every statement, `|`-separated; throws the first error line. */
function query(db, sql) {
    let out = '';
    for (const stmt of splitStatements(sql)) {
        let prepared;
        try {
            prepared = db.prepare(stmt.text);
        }
        catch (e) {
            throw new Error(`Error: in prepare, ${message(e)}`);
        }
        try {
            prepared.setReturnArrays(true);
            prepared.setReadBigInts(true);
            for (const row of prepared.iterate())
                out += `${row.map(listValue).join('|')}\n`;
        }
        catch (e) {
            throw new Error(`Error: stepping, ${message(e)}`);
        }
    }
    return stripTrailingNewlines(out);
}
function compare(op, got, expected) {
    if (op === 'eq')
        return got === expected;
    if (!NUMBER.test(got) || !NUMBER.test(expected))
        return null;
    return op === 'ge' ? Number(got) >= Number(expected) : Number(got) <= Number(expected);
}
export async function assertSql(argv, env, io) {
    const args = parseArgs(argv);
    if (!args) {
        io.err(USAGE);
        return 2;
    }
    const { db, sql, expected, op } = args;
    if (!isFile(db)) {
        io.out(`assert-sql: ERROR database not found: ${db}\n`);
        return 2;
    }
    if (!loadNodeSqlite()) {
        io.out('assert-sql: ERROR node:sqlite is unavailable in this Node (needs Node 22.13+)\n');
        return 2;
    }
    let reader;
    try {
        reader = openSnapshot(db, env);
    }
    catch (e) {
        io.out(`assert-sql: ERROR query failed: Error: ${message(e)}\n`);
        return 2;
    }
    // A signal that arrived while the snapshot was taken exits here; from now on
    // INT and TERM kill the process outright, since the query blocks the loop and
    // there is nothing left to remove.
    await nextTurn();
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
    let out;
    try {
        out = query(reader, sql);
    }
    catch (e) {
        io.out(`assert-sql: ERROR query failed: ${e.message.split('\n')[0]}\n`);
        return 2;
    }
    finally {
        reader.close();
    }
    if (out === '') {
        io.out(`assert-sql: FAIL got NULL or no rows, want ${op} '${expected}': ${sql}\n`);
        return 1;
    }
    const rows = out.split('\n').length;
    if (rows > 1) {
        io.out(`assert-sql: FAIL expected a single value, got ${rows} rows: ${sql}\n`);
        return 1;
    }
    const ok = compare(op, out, expected);
    if (ok === null) {
        io.out(`assert-sql: FAIL --op ${op} needs numbers, got '${out}' vs '${expected}': ${sql}\n`);
        return 1;
    }
    if (ok) {
        io.out(`assert-sql: PASS '${out}' ${op} '${expected}': ${sql}\n`);
        return 0;
    }
    io.out(`assert-sql: FAIL got '${out}', want ${op} '${expected}': ${sql}\n`);
    return 1;
}
//# sourceMappingURL=assert-sql.js.map