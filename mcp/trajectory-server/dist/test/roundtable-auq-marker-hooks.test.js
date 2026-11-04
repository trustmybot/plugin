/**
 * The roundtable, AskUserQuestion and plugin-hooks-marker hook cases (GH 1692)
 * that neither tests/fixtures/hook-corpus/<gate>/ nor an existing node:test
 * holds: roundtable-auq-shape passing a roundtable still collecting votes,
 * roundtable-slash-detect waiting out a write lock held 1 s and 2 s and
 * warning when the lock outlasts its retries, and plugin-hooks-marker refusing
 * a `../` session id. roundtable-cleanup-postcheck and
 * askuserquestion-length-lint have no case left here: their corpus payloads
 * hold them. Each case runs `node dist/hooks.js <gate>` in a sandbox with its
 * own HOME.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import { makeSandbox, PLUGIN_ROOT, runGate } from './hook-sandbox.js';
const SCHEMA = readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema.sql'), 'utf8');
function schemaDb(path, rows = '') {
    mkdirSync(dirname(path), { recursive: true });
    const d = new DatabaseSync(path);
    try {
        d.exec(SCHEMA);
        d.exec(rows);
    }
    finally {
        d.close();
    }
}
function count(db, sql) {
    const d = new DatabaseSync(db);
    try {
        return Number(d.prepare(sql).get().n);
    }
    finally {
        d.close();
    }
}
function clearAudit(db) {
    const d = new DatabaseSync(db);
    try {
        d.exec('DELETE FROM audit');
    }
    finally {
        d.close();
    }
}
function files(root) {
    if (!existsSync(root))
        return [];
    return readdirSync(root, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => relative(root, join(e.parentPath, e.name)))
        .sort();
}
describe('roundtable-auq-shape: a roundtable still collecting votes', () => {
    let sb;
    let db;
    before(() => {
        sb = makeSandbox('roundtable-auq-shape');
        db = join(sb.dir, 'project/.claude/tmb/trajectory.db');
        schemaDb(db, `INSERT INTO issues (id, objective, created_at, updated_at) VALUES (1, 'test issue', datetime('now'), datetime('now'));
       INSERT INTO roundtables (issue_id, topic, created_at, state) VALUES (1, 'test topic', datetime('now'), 'collecting');`);
    });
    after(() => sb.remove());
    it('passes an all-radios AUQ silently while no roundtable awaits the human', () => {
        const question = { multiSelect: false, options: [{ label: 'Opt A', description: 'desc' }, { label: 'Opt B', description: 'desc' }] };
        const r = runGate('roundtable-auq-shape', {
            cwd: sb.dir,
            input: JSON.stringify({ tool_name: 'AskUserQuestion', tool_input: { questions: [question] } }),
            env: { ...sb.env, TRAJECTORY_DB_PATH: db },
        });
        assert.equal(r.status, 0);
        assert.equal(r.stdout + r.stderr, '');
    });
});
describe('roundtable-slash-detect: the audit write under a concurrent write lock', () => {
    const SLASH_ROWS = "SELECT COUNT(*) AS n FROM audit WHERE event_type='roundtable_slash_invoked'";
    let sb;
    let db;
    before(() => {
        sb = makeSandbox('roundtable-slash-detect');
        db = join(sb.dir, 'project/.claude/tmb/trajectory.db');
        schemaDb(db);
    });
    after(() => sb.remove());
    /** A process holding BEGIN IMMEDIATE on <db> for <ms>, resolved once it holds the lock. */
    async function holdWriteLock(ms) {
        const script = `const { DatabaseSync } = require('node:sqlite');
const d = new DatabaseSync(process.argv[1]);
d.exec('BEGIN IMMEDIATE');
process.stdout.write('locked\\n');
setTimeout(() => { d.exec('COMMIT'); d.close(); }, ${ms});`;
        const child = spawn(process.execPath, ['--no-warnings', '-e', script, db], { stdio: ['ignore', 'pipe', 'inherit'] });
        const exited = once(child, 'exit');
        const [chunk] = (await once(child.stdout, 'data'));
        assert.equal(chunk.toString(), 'locked\n');
        return { exited, kill: () => child.kill() };
    }
    const run = (prompt) => runGate('roundtable-slash-detect', { cwd: sb.dir, input: JSON.stringify({ prompt }), env: { ...sb.env, TRAJECTORY_DB_PATH: db } });
    for (const ms of [1000, 2000]) {
        it(`lands the row and exits 0 once a lock held ${ms / 1000} s releases`, async () => {
            clearAudit(db);
            const holder = await holdWriteLock(ms);
            const r = run(`/roundtable under a ${ms} ms lock`);
            await holder.exited;
            assert.equal(r.status, 0, r.stderr);
            assert.equal(count(db, SLASH_ROWS), 1);
        });
    }
    it('warns on stderr, writes no row and exits 0 when the lock outlasts every attempt', async () => {
        clearAudit(db);
        const holder = await holdWriteLock(30_000);
        let r;
        try {
            r = run('/roundtable permanent lock');
        }
        finally {
            holder.kill();
            await holder.exited;
        }
        assert.equal(r.status, 0, 'fail-open');
        assert.equal(count(db, SLASH_ROWS), 0);
        assert.match(r.stderr, /FAILED to record roundtable_slash_invoked after retrying/);
    });
});
describe('plugin-hooks-marker: a session id that climbs out of the sessions dir', () => {
    let sb;
    let project;
    before(() => {
        sb = makeSandbox('plugin-hooks-marker');
        project = join(sb.dir, 'project');
        schemaDb(join(project, '.claude/tmb/trajectory.db'));
    });
    after(() => sb.remove());
    it('writes no marker for ../escape', () => {
        const before = files(join(project, '.claude'));
        const r = runGate('plugin-hooks-marker', {
            cwd: project,
            input: JSON.stringify({ session_id: '../escape' }),
            env: { ...sb.env, CLAUDE_PROJECT_DIR: project },
        });
        assert.equal(r.status, 0);
        assert.equal(r.stdout, '');
        assert.deepEqual(files(join(project, '.claude')), before);
        assert.ok(!existsSync(join(project, '.claude/escape.plugin-hooks')), 'no path escape');
    });
});
//# sourceMappingURL=roundtable-auq-marker-hooks.test.js.map