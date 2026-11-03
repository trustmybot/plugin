/**
 * `cli.js assert-sql` (GH 1692), with every case of the former shell helper's
 * --self-test, run against the built dist/cli.js bundle on scratch DBs.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { installRoot } from '../hooks/lib/project-env.js';
const PLUGIN_ROOT = installRoot(dirname(fileURLToPath(import.meta.url)));
const CLI = join(PLUGIN_ROOT, 'mcp/trajectory-server/dist/cli.js');
const SLOW = 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 100000000000) SELECT count(*) FROM c';
const OLD = new Date('2020-01-01T00:00:00Z');
let dir;
let db;
function run(args, env = process.env) {
    const r = spawnSync(process.execPath, ['--experimental-sqlite', CLI, 'assert-sql', ...args], { encoding: 'utf8', env, cwd: dir });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}
function exec(path, sql) {
    const d = new DatabaseSync(path);
    try {
        d.exec(sql);
    }
    finally {
        d.close();
    }
}
function mtime(path) {
    return statSync(path).mtimeMs;
}
describe('cli.js assert-sql', () => {
    before(() => {
        dir = mkdtempSync(join(tmpdir(), 'assert-sql-test.'));
        db = join(dir, 'ref.db');
        exec(db, "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t (v) VALUES ('a'), ('b'), (NULL);");
    });
    after(() => rmSync(dir, { recursive: true, force: true }));
    const cases = [
        [0, 'eq match', ['SELECT count(*) FROM t', '3']],
        [0, 'eq on text', ['SELECT v FROM t WHERE id = 1', 'a']],
        [0, 'ge match', ['SELECT count(*) FROM t WHERE v IS NOT NULL', '1', '--op', 'ge']],
        [0, 'le match', ['SELECT count(*) FROM t WHERE v IS NULL', '1', '--op', 'le']],
        [0, '--op=<op> form', ['SELECT count(*) FROM t', '3', '--op=ge']],
        [1, 'eq mismatch', ['SELECT count(*) FROM t', '4']],
        [1, 'ge mismatch', ['SELECT count(*) FROM t', '5', '--op', 'ge']],
        [1, 'le mismatch', ['SELECT count(*) FROM t', '2', '--op', 'le']],
        [1, 'more than one row', ['SELECT id FROM t', '1']],
        [1, 'NULL result fails against an empty expectation', ['SELECT v FROM t WHERE id = 3', '']],
        [2, 'bad op', ['SELECT 1', '1', '--op', 'gt']],
        [2, 'too few arguments', ['SELECT 1']],
    ];
    for (const [want, name, args] of cases) {
        it(`${name}: exit ${want}`, () => {
            const r = run([db, ...args]);
            assert.equal(r.code, want, r.stdout + r.stderr);
        });
    }
    for (const op of ['eq', 'ge', 'le']) {
        it(`NULL result fails (${op})`, () => {
            const r = run([db, 'SELECT v FROM t WHERE id = 3', '0', '--op', op]);
            assert.equal(r.code, 1);
            assert.match(r.stdout, /got NULL or no rows/);
        });
        it(`no rows fails (${op})`, () => {
            const r = run([db, 'SELECT v FROM t WHERE id = 99', '0', '--op', op]);
            assert.equal(r.code, 1);
            assert.match(r.stdout, /got NULL or no rows/);
        });
    }
    it('names a NULL result and a no-row result', () => {
        assert.match(run([db, 'SELECT v FROM t WHERE id = 3', '0']).stdout, /got NULL or no rows/);
        assert.match(run([db, 'SELECT v FROM t WHERE id = 99', '0', '--op', 'ge']).stdout, /got NULL or no rows/);
    });
    it('a missing DB exits 2 naming it', () => {
        const absent = join(dir, 'absent.db');
        const r = run([absent, 'SELECT 1', '1']);
        assert.equal(r.code, 2);
        assert.equal(r.stdout, `assert-sql: ERROR database not found: ${absent}\n`);
    });
    it('a bad op prints the usage line on stderr', () => {
        const r = run([db, 'SELECT 1', '1', '--op', 'gt']);
        assert.equal(r.stdout, '');
        assert.match(r.stderr, /^usage: cli\.js assert-sql /);
    });
    it('PASS and FAIL each print exactly one line', () => {
        assert.equal(run([db, 'SELECT count(*) FROM t', '3']).stdout, "assert-sql: PASS '3' eq '3': SELECT count(*) FROM t\n");
        assert.equal(run([db, 'SELECT count(*) FROM t', '4']).stdout, "assert-sql: FAIL got '3', want eq '4': SELECT count(*) FROM t\n");
    });
    it('ge/le name a non-number', () => {
        const r = run([db, 'SELECT v FROM t WHERE id = 1', '1', '--op', 'ge']);
        assert.equal(r.code, 1);
        assert.equal(r.stdout, "assert-sql: FAIL --op ge needs numbers, got 'a' vs '1': SELECT v FROM t WHERE id = 1\n");
    });
    it('a WAL-mode copy without -shm is readable and grows no -shm/-wal', () => {
        const wal = join(dir, 'wal.db');
        exec(wal, "PRAGMA journal_mode=WAL; CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('w');");
        rmSync(`${wal}-shm`, { force: true });
        rmSync(`${wal}-wal`, { force: true });
        assert.equal(run([wal, 'SELECT v FROM t', 'w']).code, 0);
        assert.equal(existsSync(`${wal}-shm`), false, 'WAL-mode copy grew a -shm');
        assert.equal(existsSync(`${wal}-wal`), false, 'WAL-mode copy grew a -wal');
    });
    it('a row only in -wal with -shm missing is read, the main file and -wal left as they were', () => {
        const src = join(dir, 'wal-src.db');
        const walonly = join(dir, 'wal-only.db');
        const holder = new DatabaseSync(src);
        try {
            holder.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('only-in-wal');");
            copyFileSync(src, walonly);
            copyFileSync(`${src}-wal`, `${walonly}-wal`);
        }
        finally {
            holder.close();
        }
        utimesSync(walonly, OLD, OLD);
        const mainBefore = `${statSync(walonly).size} ${mtime(walonly)}`;
        const walBefore = statSync(`${walonly}-wal`).size;
        assert.ok(walBefore > 0, 'setup: the -wal holds the row');
        const r = run([walonly, 'SELECT v FROM t', 'only-in-wal']);
        assert.equal(r.code, 0, r.stdout);
        assert.equal(`${statSync(walonly).size} ${mtime(walonly)}`, mainBefore, "the main file's size and mtime");
        assert.equal(statSync(`${walonly}-wal`).size, walBefore, "the -wal's size");
    });
    it('a row only in -wal of a DB held open elsewhere is read', () => {
        const held = join(dir, 'held.db');
        exec(held, 'PRAGMA journal_mode=WAL; CREATE TABLE t (v TEXT);');
        const holder = new DatabaseSync(held);
        try {
            holder.prepare('SELECT count(*) FROM t').get();
            exec(held, "INSERT INTO t VALUES ('in-wal');");
            assert.ok(statSync(`${held}-wal`).size > 0, 'setup: the held-open DB has -wal content');
            assert.equal(run([held, 'SELECT v FROM t', 'in-wal']).code, 0);
        }
        finally {
            holder.close();
        }
    });
    it('refuses a write and leaves the DB as it was', () => {
        utimesSync(db, OLD, OLD);
        const before = mtime(db);
        const refused = run([db, "INSERT INTO t (v) VALUES ('c')", '0']);
        assert.equal(refused.code, 2);
        assert.match(refused.stdout, /^assert-sql: ERROR query failed: .*readonly/);
        assert.equal(run([db, 'SELECT count(*) FROM t', '3']).code, 0, 'read leaves the DB as it was');
        assert.equal(mtime(db), before, 'DB mtime unchanged');
    });
    it('SIGINT to the process group stops the run and leaves no temp copy', async () => {
        const tmp = join(dir, 'tmp');
        mkdirSync(tmp);
        const child = spawn(process.execPath, ['--experimental-sqlite', CLI, 'assert-sql', db, SLOW, '0'], {
            cwd: dir,
            env: { ...process.env, TMPDIR: tmp },
            stdio: 'ignore',
            detached: true,
        });
        const exited = new Promise((done) => child.on('exit', (code, signal) => done({ code, signal })));
        await new Promise((done) => setTimeout(done, 1000));
        process.kill(-child.pid, 'SIGINT');
        const killer = setTimeout(() => process.kill(-child.pid, 'SIGKILL'), 10_000);
        const { code, signal } = await exited;
        clearTimeout(killer);
        assert.ok(signal === 'SIGINT' || code === 130, `SIGINT did not stop the run (code ${code}, signal ${signal})`);
        assert.deepEqual(readdirSync(tmp), [], 'SIGINT left a temp copy');
    });
});
//# sourceMappingURL=cli-assert-sql.test.js.map