// Several trajectory-server processes (bro, PM, SEO, growth, dashboard) share
// one trajectory.db (GH 1624). These tests run real child processes against a
// temp DB: concurrent read-then-write transactions must never hit
// SQLITE_BUSY, a cold start on an old schema must migrate exactly once, and
// the pre-migration backup must carry rows still sitting in the -wal file.
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { TARGET_SCHEMA_VERSION, TrajectoryDB } from '../db.js';
import { SCHEMA_V36_SQL } from './fixtures/schema-v36.js';
const WORKER = join(dirname(fileURLToPath(import.meta.url)), 'db-concurrency-worker.js');
const PROCESSES = 4;
const WRITES_PER_PROCESS = 50;
const noLog = { pluginVersion: null, serverLog: () => { }, sqlLog: () => { } };
const tmpDirs = [];
after(() => {
    for (const dir of tmpDirs)
        rmSync(dir, { recursive: true, force: true });
});
function makeTmpDir() {
    const dir = mkdtempSync(join(tmpdir(), 'tmb-db-concurrency-'));
    tmpDirs.push(dir);
    return dir;
}
// Spawns every worker, waits until each has printed `ready`, then creates the
// go-file so they all hit the DB at once.
async function runWorkers(dir, argsFor) {
    const goFile = join(dir, 'go');
    let ready = 0;
    let release = () => { };
    const allReady = new Promise((resolve) => {
        release = resolve;
    });
    const runs = Array.from({ length: PROCESSES }, (_, i) => {
        const [mode, ...rest] = argsFor(i);
        const child = spawn(process.execPath, ['--experimental-sqlite', '--no-warnings', WORKER, mode, join(dir, 'trajectory.db'), goFile, ...rest], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        let sawReady = false;
        child.stdout.on('data', (chunk) => {
            stdout += chunk.toString();
            if (!sawReady && stdout.includes('ready\n')) {
                sawReady = true;
                if (++ready === PROCESSES)
                    release();
            }
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });
        return new Promise((resolve, reject) => {
            child.on('error', reject);
            child.on('close', (code) => {
                const last = stdout.trim().split('\n').pop() ?? '';
                if (code !== 0 || !last.startsWith('{')) {
                    reject(new Error(`worker ${i} exited ${code}: ${stderr || stdout}`));
                    return;
                }
                resolve(JSON.parse(last));
            });
        });
    });
    await allReady;
    writeFileSync(goFile, '');
    return Promise.all(runs);
}
function seedV36(dbPath) {
    const db = new DatabaseSync(dbPath);
    db.exec(SCHEMA_V36_SQL);
    db.exec(`
    INSERT INTO issues (objective, status, created_at, updated_at)
      VALUES ('o', 'open', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO tasks (issue_id, branch_id, description, status, commit_sha, created_at, updated_at)
      VALUES (1, 'feat/x', 'd', 'closed', 'abc1234', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  `);
    db.close();
}
function backupsOf(dbPath) {
    return readdirSync(dirname(dbPath)).filter((f) => f.startsWith(`${basename(dbPath)}.pre-v${TARGET_SCHEMA_VERSION}.`) && f.endsWith('.bak'));
}
describe('concurrent trajectory-server processes on one DB (GH 1624)', () => {
    it(`${PROCESSES} processes × ${WRITES_PER_PROCESS} read-then-write transactions: no SQLITE_BUSY, no lost write`, async () => {
        const dir = makeTmpDir();
        const dbPath = join(dir, 'trajectory.db');
        const setup = new TrajectoryDB(dbPath, noLog);
        setup.run('CREATE TABLE concurrency_probe (seq INTEGER PRIMARY KEY, worker TEXT NOT NULL)');
        setup.close();
        const results = await runWorkers(dir, (i) => ['write', `w${i}`, String(WRITES_PER_PROCESS)]);
        const errors = results.flatMap((r) => r.errors);
        assert.deepEqual(errors, [], 'no worker transaction may fail');
        const db = new DatabaseSync(dbPath);
        const row = db
            .prepare('SELECT COUNT(*) AS n, MAX(seq) AS top FROM concurrency_probe')
            .get();
        db.close();
        const total = PROCESSES * WRITES_PER_PROCESS;
        assert.equal(row.n, total, 'every committed write is in the table');
        assert.equal(row.top, total, 'each read-then-write saw the previous commit');
    });
    it(`${PROCESSES} processes cold-opening a v36 DB at once migrate it exactly once`, async () => {
        const dir = makeTmpDir();
        const dbPath = join(dir, 'trajectory.db');
        seedV36(dbPath);
        const results = await runWorkers(dir, () => ['open']);
        assert.deepEqual(results.flatMap((r) => r.errors), [], 'every process opens cleanly');
        assert.deepEqual(results.map((r) => r['version']), Array(PROCESSES).fill(TARGET_SCHEMA_VERSION), 'every process ends at the current schema version');
        const migrations = results.reduce((sum, r) => sum + Number(r['migrations']), 0);
        assert.equal(migrations, 1, 'exactly one process runs the migration');
        assert.equal(backupsOf(dbPath).length, 1, 'exactly one pre-migration backup');
    });
    it(`${PROCESSES} processes cold-opening a brand-new DB file at once all reach the current version`, async () => {
        const dir = makeTmpDir();
        const results = await runWorkers(dir, () => ['open']);
        assert.deepEqual(results.flatMap((r) => r.errors), [], 'every process opens cleanly');
        assert.deepEqual(results.map((r) => r['version']), Array(PROCESSES).fill(TARGET_SCHEMA_VERSION));
        assert.equal(results.reduce((sum, r) => sum + Number(r['migrations']), 0), 0);
    });
});
describe('pre-migration backup (GH 1624)', () => {
    it('contains a row that is only in the -wal file of a connection still holding it open', () => {
        const dir = makeTmpDir();
        const dbPath = join(dir, 'trajectory.db');
        seedV36(dbPath);
        const holder = new DatabaseSync(dbPath);
        holder.exec('PRAGMA journal_mode = WAL');
        holder.exec('PRAGMA wal_autocheckpoint = 0');
        holder.exec(`INSERT INTO issues (objective, status, created_at, updated_at)
         VALUES ('written-just-before-backup', 'open', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')`);
        assert.ok(statSync(`${dbPath}-wal`).size > 0, 'the row must still be in the -wal file');
        const db = new TrajectoryDB(dbPath, noLog);
        db.close();
        holder.close();
        const backups = backupsOf(dbPath);
        assert.equal(backups.length, 1, 'the migration takes one backup');
        const bak = new DatabaseSync(join(dir, backups[0]), { readOnly: true });
        const row = bak
            .prepare("SELECT objective FROM issues WHERE objective = 'written-just-before-backup'")
            .get();
        const version = bak.prepare('SELECT schema_version FROM plugin_meta').get();
        bak.close();
        assert.equal(row?.objective, 'written-just-before-backup');
        assert.equal(version.schema_version, 36, 'the backup is the pre-migration state');
    });
});
describe('transaction() nesting', () => {
    it('a nested transaction is a savepoint: its rollback keeps the outer writes', () => {
        const db = new TrajectoryDB(':memory:', noLog);
        db.run('CREATE TABLE t (v TEXT)');
        db.transaction(() => {
            db.run("INSERT INTO t VALUES ('outer')");
            assert.throws(() => db.transaction(() => {
                db.run("INSERT INTO t VALUES ('inner')");
                throw new Error('inner fails');
            }));
        });
        assert.deepEqual(db.all('SELECT v FROM t').map((r) => r.v), ['outer']);
        db.close();
    });
});
//# sourceMappingURL=db-concurrency.test.js.map