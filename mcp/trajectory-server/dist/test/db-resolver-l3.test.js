/**
 * The hook trajectory-DB resolver (`dbPath` in src/hooks/lib/db.ts, the TS
 * port of query-task.sh's tmb_db_path and _tmb_db_probe), node:test form of
 * the three former l3 shell tests (GH 1692):
 *
 * - no walk-up under a test flag: TMB_FORBID_LIVE_SYNC=1 or a set
 *   TMB_TEST_RUN_ID with neither TRAJECTORY_DB_PATH nor CLAUDE_PROJECT_DIR is
 *   unresolved with one warning naming the flag; either path resolves; no flag
 *   walks up from the cwd.
 * - the probe never writes the DB (GH 1636): a WAL DB held open with its -shm,
 *   a WAL-cold copy whose rows sit only in a non-empty -wal, and a detached WAL
 *   DB all resolve, every SQLite open is read-only, and the main file and -wal
 *   stay byte-for-byte and mtime as they were. Run once per SQLite backend.
 * - a session in a subdirectory of a workspace resolves the workspace DB
 *   (GH 1553), on the hook side and the server's resolveClaudeDbPath; a
 *   `standalone` marker ends the walk; a DB in $HOME itself is never picked.
 *
 * Everything lives under a temp dir with a temp HOME; every resolution gets a
 * fresh env object, since dbPath memoizes per env object.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { accessSync, chmodSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { after, before, describe, it } from 'node:test';
import { dbPath, dbState, projectRoot, repoPathAbs, stateDir } from '../hooks/lib/db.js';
import { sqliteBackend } from '../hooks/lib/sqlite-shell.js';
import { resolveClaudeDbPath } from '../platform.js';
import { sandboxDir, sqlExec } from './db-test-fixtures.js';
const TASKS = 'CREATE TABLE tasks (id INTEGER PRIMARY KEY, prompt_bearing INTEGER NOT NULL DEFAULT 0);';
const dbIn = (dir) => join(dir, '.claude/tmb/trajectory.db');
/** Every node:sqlite open made through process.getBuiltinModule, as `[-readonly ]<target>`, while a log is armed. */
let nodeOpens = null;
const builtin = process.getBuiltinModule.bind(process);
const realSqlite = builtin('node:sqlite');
class TracedDatabase extends realSqlite.DatabaseSync {
    constructor(target, options) {
        super(target, options);
        nodeOpens?.push(`${options?.readOnly ? '-readonly ' : ''}${target}`);
    }
}
const tracedSqlite = { ...realSqlite, DatabaseSync: TracedDatabase };
process.getBuiltinModule = ((id) => id === 'node:sqlite' || id === 'sqlite' ? tracedSqlite : builtin(id));
function onPath(command) {
    for (const dir of (process.env.PATH ?? '').split(delimiter)) {
        try {
            accessSync(join(dir || '.', command), constants.X_OK);
            return join(dir || '.', command);
        }
        catch {
            /* next dir */
        }
    }
    return null;
}
function resolve(env) {
    const warnings = [];
    const path = dbPath({ ...env }, (line) => warnings.push(line));
    return { path, warnings };
}
describe('db-resolver-l3: no walk-up under a test flag', () => {
    let base;
    let ws;
    let db;
    let home;
    let cwd;
    before(() => {
        base = sandboxDir('db-lookup-no-walkup');
        ws = join(base, 'ws');
        db = dbIn(ws);
        home = join(base, 'home');
        mkdirSync(join(ws, 'a/b'), { recursive: true });
        mkdirSync(home, { recursive: true });
        mkdirSync(dirname(db), { recursive: true });
        sqlExec(db, TASKS);
        cwd = process.cwd();
        process.chdir(join(ws, 'a/b'));
    });
    after(() => {
        process.chdir(cwd);
        rmSync(base, { recursive: true, force: true });
    });
    /** The resolver from <ws>/a/b with only HOME, PATH and <extra> set. */
    const run = (extra = {}) => resolve({ HOME: home, PATH: process.env.PATH, ...extra });
    for (const [name, value] of [
        ['TMB_FORBID_LIVE_SYNC', '1'],
        ['TMB_TEST_RUN_ID', 'tmb-l3-walkup'],
    ]) {
        it(`${name} set, no path: unresolved, no walk-up, one warning line naming the flag`, () => {
            const got = run({ [name]: value });
            assert.equal(got.path, null, `unresolved (${name})`);
            assert.ok(got.warnings.join('\n').includes(`tmb: trajectory DB unresolved: ${name} is set`), `the warning names the flag (${name}): ${JSON.stringify(got.warnings)}`);
            assert.equal(got.warnings.join('\n').split('\n').length, 1, `exactly one warning line (${name})`);
        });
        it(`${name} set, CLAUDE_PROJECT_DIR=<ws>: resolves the fixture DB`, () => {
            assert.deepEqual(run({ [name]: value, CLAUDE_PROJECT_DIR: ws }), { path: db, warnings: [] }, `project dir resolves (${name})`);
        });
        it(`${name} set, TRAJECTORY_DB_PATH: resolves the fixture DB`, () => {
            assert.deepEqual(run({ [name]: value, TRAJECTORY_DB_PATH: db }), { path: db, warnings: [] }, `explicit path resolves (${name})`);
        });
    }
    it('TMB_FORBID_LIVE_SYNC=0 is not a test flag: walks up', () => {
        assert.deepEqual(run({ TMB_FORBID_LIVE_SYNC: '0' }), { path: db, warnings: [] }, 'FORBID=0 walks up');
    });
    it('no flag, no path: walks up to the fixture DB (unchanged)', () => {
        assert.deepEqual(run(), { path: db, warnings: [] }, 'walk-up resolves');
    });
    it('a hook under a test flag reports the DB unresolved', () => {
        assert.equal(dbState({ HOME: home, PATH: process.env.PATH, TMB_TEST_RUN_ID: 'tmb-l3-walkup' }), 'unresolved', 'dbState unresolved under the flag');
    });
});
const SCHEMA = 'CREATE TABLE tasks (id INTEGER PRIMARY KEY, prompt_bearing INTEGER);';
const ROWS = 'INSERT INTO tasks (id, prompt_bearing) VALUES (1, 0); CREATE TABLE wal_only (x);';
const OLD = new Date('2020-01-01T00:00:00');
/** Size, mtime and checksum of <path>, or "absent". */
function fingerprint(path) {
    if (!existsSync(path))
        return 'absent';
    const st = statSync(path);
    return `${st.size} ${st.mtimeMs} ${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
}
const REAL_SQLITE3 = onPath('sqlite3');
for (const backend of ['node', 'cli']) {
    const skip = backend === 'cli' && REAL_SQLITE3 === null
        ? 'sqlite3 not installed'
        : backend === 'node' && sqliteBackend({}) !== 'node'
            ? 'this Node has no usable node:sqlite'
            : false;
    describe(`db-resolver-l3: the probe never writes the DB (GH 1636), ${backend} backend`, { skip }, () => {
        let tmp;
        let fakeHome;
        let bin;
        let cliLog;
        let pristine;
        let held;
        let holder = null;
        let rc;
        let out;
        /** <home>/<name>/.claude/tmb/trajectory.db with a `standalone` marker beside it. */
        function project(name) {
            const db = dbIn(join(fakeHome, name));
            mkdirSync(dirname(db), { recursive: true });
            writeFileSync(join(dirname(db), 'standalone'), '');
            return db;
        }
        /** dbPath as a hook sees it, from CLAUDE_PROJECT_DIR=<dir>; sets rc and out, arms the open log. */
        function resolveFrom(dir) {
            writeFileSync(cliLog, '');
            nodeOpens = [];
            try {
                const path = dbPath({
                    HOME: fakeHome,
                    PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
                    CLAUDE_PROJECT_DIR: dir,
                    ...(backend === 'cli' ? { TMB_HOOKS_SQLITE: 'cli' } : {}),
                });
                rc = path === null ? 1 : 0;
                out = path ?? '';
            }
            finally {
                if (backend === 'cli')
                    nodeOpens = readFileSync(cliLog, 'utf8').split('\n').filter((l) => l !== '');
            }
        }
        const opens = () => nodeOpens ?? [];
        function assertReadonlyOpens() {
            assert.ok(opens().length > 0, 'no SQLite open was logged');
            assert.deepEqual(opens().filter((l) => !l.startsWith('-readonly ')), [], 'every SQLite open is -readonly');
        }
        before(() => {
            tmp = sandboxDir(`db-probe-readonly-${backend}`);
            fakeHome = join(tmp, 'home');
            bin = join(tmp, 'bin');
            cliLog = join(tmp, 'sqlite3.log');
            mkdirSync(fakeHome, { recursive: true });
            mkdirSync(bin, { recursive: true });
            writeFileSync(cliLog, '');
            if (backend === 'cli') {
                writeFileSync(join(bin, 'sqlite3'), `#!${process.execPath}
const { appendFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(cliLog)}, args.join(' ') + '\\n');
const r = spawnSync(${JSON.stringify(REAL_SQLITE3)}, args, { stdio: 'inherit' });
process.exit(r.status ?? 1);
`);
                chmodSync(join(bin, 'sqlite3'), 0o755);
            }
            held = project('held');
            sqlExec(held, `PRAGMA journal_mode=WAL; ${SCHEMA}`);
            holder = new DatabaseSync(held);
            holder.prepare('SELECT count(*) FROM sqlite_master').get();
            sqlExec(held, ROWS);
            pristine = join(tmp, 'pristine');
            mkdirSync(pristine, { recursive: true });
            copyFileSync(held, join(pristine, 'trajectory.db'));
            copyFileSync(`${held}-wal`, join(pristine, 'trajectory.db-wal'));
        });
        after(() => {
            nodeOpens = null;
            holder?.close();
            rmSync(tmp, { recursive: true, force: true });
        });
        it('WAL DB with its -shm: resolves from CLAUDE_PROJECT_DIR, the DB is unchanged', () => {
            utimesSync(held, OLD, OLD);
            const mainBefore = fingerprint(held);
            const walBefore = fingerprint(`${held}-wal`);
            assert.ok(existsSync(`${held}-shm`) && statSync(`${held}-wal`).size > 0, 'setup: no -shm or an empty -wal');
            resolveFrom(join(fakeHome, 'held'));
            assert.equal(rc, 0, 'resolution succeeded');
            assert.equal(out, held, 'dbPath is the planted DB');
            assertReadonlyOpens();
            assert.equal(fingerprint(held), mainBefore, 'main file size, mtime and content unchanged');
            assert.equal(fingerprint(`${held}-wal`), walBefore, '-wal size, mtime and checksum unchanged');
            holder?.close();
            holder = null;
        });
        describe('the same DB copied without its -shm: WAL-cold, -wal non-empty', () => {
            let cold;
            before(() => {
                cold = project('cold');
                copyFileSync(join(pristine, 'trajectory.db'), cold);
                copyFileSync(join(pristine, 'trajectory.db-wal'), `${cold}-wal`);
                utimesSync(cold, OLD, OLD);
                utimesSync(`${cold}-wal`, OLD, OLD);
            });
            it('setup: the WAL-cold copy has a non-empty -wal and no -shm', () => {
                assert.ok(statSync(`${cold}-wal`).size > 0 && !existsSync(`${cold}-shm`), 'the copy is not WAL-cold');
                const d = new DatabaseSync(`file:${join(pristine, 'trajectory.db')}?immutable=1`, { readOnly: true });
                try {
                    const row = d.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'wal_only'").get();
                    assert.equal(row.n, 0, 'the main file lacks what the -wal holds');
                }
                finally {
                    d.close();
                }
            });
            it('WAL-cold DB with a non-empty -wal: resolves, nothing is checkpointed', () => {
                const mainBefore = fingerprint(cold);
                const walBefore = fingerprint(`${cold}-wal`);
                resolveFrom(join(fakeHome, 'cold'));
                assert.equal(rc, 0, 'resolution succeeded');
                assert.equal(out, cold, 'dbPath is the planted DB');
                assertReadonlyOpens();
                assert.equal(fingerprint(cold), mainBefore, 'main file size, mtime and content unchanged');
                assert.equal(fingerprint(`${cold}-wal`), walBefore, '-wal size, mtime and checksum unchanged');
            });
        });
        describe('a detached WAL DB: no -wal, no -shm', () => {
            let det;
            let readonlyOpens = false;
            before(() => {
                det = project('detached');
                sqlExec(det, `PRAGMA journal_mode=WAL; ${SCHEMA} ${ROWS} PRAGMA wal_checkpoint(TRUNCATE);`);
                rmSync(`${det}-wal`, { force: true });
                rmSync(`${det}-shm`, { force: true });
                utimesSync(det, OLD, OLD);
                if (backend === 'cli' && REAL_SQLITE3 !== null) {
                    const capability = join(tmp, 'capability.db');
                    copyFileSync(det, capability);
                    readonlyOpens = spawnSync(REAL_SQLITE3, ['-readonly', capability, 'SELECT 1;'], { stdio: 'ignore' }).status === 0;
                }
            });
            it('detached WAL DB: resolves, the main file is unchanged, no -wal is written', (t) => {
                const mainBefore = fingerprint(det);
                resolveFrom(join(fakeHome, 'detached'));
                assert.equal(rc, 0, 'resolution succeeded');
                assert.equal(out, det, 'dbPath is the planted DB');
                assertReadonlyOpens();
                assert.equal(fingerprint(det), mainBefore, 'main file size, mtime and content unchanged');
                assert.ok(!existsSync(`${det}-wal`) || statSync(`${det}-wal`).size === 0, 'the probe wrote a -wal');
                if (readonlyOpens) {
                    t.diagnostic('sqlite3 -readonly opens a detached WAL DB on this platform; the immutable retry is not exercised');
                    return;
                }
                assert.ok(opens().join('\n').includes('immutable=1'), `-readonly failed or node:sqlite, so the probe read immutable: ${opens().join('; ')}`);
                assert.equal(`${fingerprint(`${det}-wal`)} ${fingerprint(`${det}-shm`)}`, 'absent absent', 'no -wal or -shm created');
            });
        });
    });
}
describe('db-resolver-l3: a session in a workspace subdirectory resolves the workspace DB (GH 1553)', () => {
    let base;
    let fakeHome;
    let ws;
    let session;
    let wsDb;
    const plant = (dir) => {
        mkdirSync(dirname(dbIn(dir)), { recursive: true });
        sqlExec(dbIn(dir), SCHEMA);
    };
    const hookEnv = (cpd) => ({ HOME: fakeHome, PATH: process.env.PATH, CLAUDE_PROJECT_DIR: cpd });
    const serverDb = (cpd) => resolveClaudeDbPath({ env: hookEnv(cpd), cwd: '/', home: fakeHome });
    before(() => {
        base = sandboxDir('db-walkup-nest');
        fakeHome = join(base, 'home');
        ws = join(fakeHome, 'ws');
        session = join(ws, 'a/b');
        mkdirSync(session, { recursive: true });
        plant(ws);
        wsDb = dbIn(ws);
    });
    after(() => rmSync(base, { recursive: true, force: true }));
    it('hooks: CLAUDE_PROJECT_DIR=<ws>/a/b resolves the workspace DB', () => {
        assert.equal(dbPath(hookEnv(session)), wsDb, 'dbPath');
    });
    it('server: CLAUDE_PROJECT_DIR=<ws>/a/b resolves the workspace DB', () => {
        assert.equal(serverDb(session), wsDb, 'resolveClaudeDbPath');
    });
    it('hooks: the project root is the workspace', () => {
        assert.equal(projectRoot(hookEnv(session)), ws, 'projectRoot');
        assert.equal(stateDir(hookEnv(session)), join(ws, '.claude/tmb'), 'stateDir');
    });
    it('hooks: a relative repos.path joins the project root, not the DB dir', () => {
        assert.equal(repoPathAbs(wsDb, 'svc'), join(ws, 'svc'), 'repoPathAbs relative');
        assert.equal(repoPathAbs(wsDb, '/abs/svc'), '/abs/svc', 'repoPathAbs absolute');
    });
    it('nothing is created under <ws>/a/b/.claude', () => {
        assert.equal(existsSync(join(session, '.claude')), false, `found ${join(session, '.claude')}`);
    });
    describe('a standalone DB at <ws>/a/b', () => {
        let innerDb;
        before(() => {
            plant(session);
            innerDb = dbIn(session);
            writeFileSync(join(dirname(innerDb), 'standalone'), '');
        });
        it('wins on both sides', () => {
            assert.equal(dbPath(hookEnv(session)), innerDb, 'dbPath');
            assert.equal(serverDb(session), innerDb, 'resolveClaudeDbPath');
            assert.equal(projectRoot(hookEnv(session)), session, 'projectRoot');
        });
        it('without the marker the outermost DB wins again', () => {
            rmSync(join(dirname(innerDb), 'standalone'));
            assert.equal(dbPath(hookEnv(session)), wsDb, 'dbPath');
            assert.equal(serverDb(session), wsDb, 'resolveClaudeDbPath');
        });
    });
    it('a DB in $HOME itself is never picked from a start below it', () => {
        plant(fakeHome);
        const outside = join(fakeHome, 'elsewhere/x');
        mkdirSync(outside, { recursive: true });
        assert.equal(dbPath(hookEnv(outside)) ?? '', '', 'dbPath unresolved');
        assert.equal(serverDb(outside), dbIn(outside), 'server falls back to the fresh-init path');
        assert.equal(projectRoot(hookEnv(outside)), outside, 'projectRoot falls back to CLAUDE_PROJECT_DIR');
    });
});
//# sourceMappingURL=db-resolver-l3.test.js.map