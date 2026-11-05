/**
 * The gate WAL cases (GH 1692): a gate must read a healthy WAL trajectory DB
 * that no process holds open (its -shm/-wal absent), keep the -readonly fast
 * path while a holder exists, and fail closed when neither read can open the
 * DB. The gate reads through the sqlite3 CLI (TMB_HOOKS_SQLITE=cli), behind a
 * wrapper (sqliteLogWrapper) that logs each call's first argument.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { runGate } from './hook-sandbox.js';
export const REAL_SQLITE3 = spawnSync('sh', ['-c', 'command -v sqlite3'], { encoding: 'utf8' }).stdout.trim();
/** <db> in WAL mode, checkpointed, with no -shm or -wal beside it. */
export function walDetach(db) {
    const d = new DatabaseSync(db);
    try {
        d.exec('PRAGMA journal_mode=WAL; PRAGMA wal_checkpoint(TRUNCATE);');
    }
    finally {
        d.close();
    }
    rmSync(`${db}-shm`, { force: true });
    rmSync(`${db}-wal`, { force: true });
}
/** A sqlite3 in <bin> that appends its first argument to <log>, then runs the real one. */
export function sqliteLogWrapper(bin, log) {
    mkdirSync(bin, { recursive: true });
    const script = `#!${process.execPath}
const { appendFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
appendFileSync(${JSON.stringify(log)}, (process.argv[2] ?? '') + '\\n');
const r = spawnSync(${JSON.stringify(REAL_SQLITE3)}, process.argv.slice(2), { stdio: 'inherit' });
process.exit(r.status ?? 1);
`;
    writeFileSync(join(bin, 'sqlite3'), script);
    chmodSync(join(bin, 'sqlite3'), 0o755);
}
function sleep(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function strays(dir, keep) {
    const out = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory())
            out.push(...strays(p, keep));
        else if ((e.name.endsWith('-shm') || e.name.endsWith('-wal')) && !keep.has(p))
            out.push(p);
    }
    return out;
}
/** Registers the four WAL cases as `it` blocks in the calling describe. */
export function walGateCases(c) {
    const paths = () => {
        const work = c.work();
        return { work, bin: join(work, 'bin'), log: join(work, 'sqlite3.log'), home: join(work, 'home'), tmp: join(work, 'tmp') };
    };
    const run = () => {
        const p = paths();
        const base = c.env();
        const r = runGate(c.gate, {
            cwd: c.cwd,
            input: c.input,
            env: { ...base, PATH: [p.bin, base.PATH ?? ''].join(delimiter), HOME: p.home, TMPDIR: p.tmp, TRAJECTORY_DB_PATH: c.db, TMB_HOOKS_SQLITE: 'cli' },
        });
        return r.stdout + r.stderr;
    };
    const logText = () => readFileSync(paths().log, 'utf8');
    const decidesNormally = (out, what) => {
        assert.ok(!out.includes('trajectory DB unavailable'), `${what} is not an unavailable DB: ${out}`);
        if (c.expect !== '')
            assert.ok(out.includes(c.expect), `the gate's normal decision: ${out}`);
        assert.ok(!out.includes(c.forbid), `no read came back empty: ${out}`);
    };
    it(`${c.label}: WAL DB with no holder → the gate reads it and decides normally`, (t) => {
        const p = paths();
        mkdirSync(p.home, { recursive: true });
        mkdirSync(p.tmp, { recursive: true });
        sqliteLogWrapper(p.bin, p.log);
        walDetach(c.db);
        const readonlyOpens = spawnSync(REAL_SQLITE3, ['-readonly', c.db, 'SELECT 1;'], { stdio: 'ignore' }).status === 0;
        writeFileSync(p.log, '');
        decidesNormally(run(), 'no holder');
        if (readonlyOpens) {
            assert.ok(logText() !== '', 'a sqlite3 invocation was logged');
            t.diagnostic('sqlite3 -readonly opens a detached WAL DB on this platform; -cmd fallback not exercised');
        }
        else {
            assert.ok(logText().includes('-cmd'), 'the read ran without -readonly');
        }
    });
    it(`${c.label}: the no-holder read leaves -shm/-wal beside the DB, nothing under HOME or TMPDIR`, () => {
        const p = paths();
        const found = [...strays(c.proj, new Set([`${c.db}-shm`, `${c.db}-wal`])), ...readdirSync(p.home), ...readdirSync(p.tmp)];
        assert.deepEqual(found, [], 'no sidecar outside the DB directory, HOME and TMPDIR untouched');
    });
    it(`${c.label}: WAL DB with a holder open → -readonly reads only`, async () => {
        const p = paths();
        walDetach(c.db);
        const holder = spawn(REAL_SQLITE3, [c.db], { stdio: ['pipe', 'ignore', 'ignore'] });
        holder.stdin.write('SELECT count(*) FROM sqlite_master;\n');
        for (let i = 0; i < 50 && !existsSync(`${c.db}-shm`); i += 1)
            sleep(100);
        writeFileSync(p.log, '');
        let out;
        try {
            out = run();
        }
        finally {
            holder.stdin.end();
            await once(holder, 'exit');
        }
        decidesNormally(out, 'a held DB');
        assert.equal(logText().split('\n')[0], '-readonly', 'the first sqlite3 invocation is -readonly');
        assert.ok(!logText().includes('-cmd'), 'no read ran without -readonly');
    });
    it(`${c.label}: a DB no read can open → deny with the unavailable reason`, () => {
        walDetach(c.db);
        const dir = dirname(c.db);
        chmodSync(dir, 0o555);
        let out;
        try {
            out = run();
        }
        finally {
            chmodSync(dir, 0o755);
        }
        assert.ok(out.includes('"permissionDecision":"deny"'), `fails closed: ${out}`);
        assert.ok(out.includes('trajectory DB unavailable'), 'deny names the unavailable DB');
    });
}
//# sourceMappingURL=wal-gate-cases.js.map