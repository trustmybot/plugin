/**
 * The hook write library in node:test (GH 1692), the port of the former l3
 * db-write-lib shell test, run against the TS hooks:
 * src/hooks/lib/audit.ts (nowIso, dbWrite, auditSql, auditAppend and their
 * from_node, event-list, writer-role and dedupe checks), src/hooks/lib/db.ts
 * (gateRead's __ERR__ sentinel and its single retry of an unopenable DB,
 * sqliteRo, dbReadBudget on a WAL DB with no holder), the per-run write
 * budget under a held lock, the swe-verification-gate waiver on a corrupt DB,
 * and the verification-run record (src/hooks/lib/verification-runs.ts).
 *
 * The DB is built from src/schema.sql. A held lock is a second node process
 * in BEGIN IMMEDIATE/EXCLUSIVE that reports once it holds it; every holder is
 * released in `finally`.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import { auditAppend, auditSql, dbWrite, nowIso } from '../hooks/lib/audit.js';
import { dbReadBudget, gateRead, sqliteRo } from '../hooks/lib/db.js';
import { reusableRun, runCommandSql, runFinishSql, runStartSql } from '../hooks/lib/verification-runs.js';
import { childEnv, sqlExec, sqlRows } from './db-test-fixtures.js';
import { makeSandbox, PLUGIN_ROOT, runGate } from './hook-sandbox.js';
import { sqliteLogWrapper, walDetach } from './wal-gate-cases.js';
const SCHEMA = join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema.sql');
const CALLER = 'db-write-lib-l3';
/**
 * A node process holding <db> in BEGIN <mode> after running <sql>, resolved
 * once it holds the lock; it commits after <releaseAfterMs> when given, else
 * rolls back on release().
 */
async function holdLock(db, mode, sql = '', releaseAfterMs) {
    const script = `const { DatabaseSync } = require('node:sqlite');
const d = new DatabaseSync(process.argv[1], { timeout: 2000 });
d.exec('BEGIN ${mode}');
${sql ? `d.exec(${JSON.stringify(sql)});` : ''}
process.stdout.write('held\\n');
const end = (stmt) => { d.exec(stmt); d.close(); process.exit(0); };
${releaseAfterMs !== undefined ? `setTimeout(() => end('COMMIT'), ${releaseAfterMs});` : ''}
process.stdin.on('data', () => end('ROLLBACK'));
process.stdin.on('end', () => end('ROLLBACK'));`;
    const child = spawn(process.execPath, ['--no-warnings', '-e', script, db], { stdio: ['pipe', 'pipe', 'inherit'] });
    const exited = once(child, 'exit');
    const [chunk] = (await once(child.stdout, 'data'));
    assert.equal(chunk.toString(), 'held\n', 'fixture: the holder acquired the lock');
    return {
        async release() {
            if (releaseAfterMs === undefined)
                child.stdin.end('release\n');
            await exited;
        },
    };
}
/** No connection can take <db>'s write lock right now. */
function stillLocked(db) {
    const d = new DatabaseSync(db, { timeout: 0 });
    try {
        d.exec('BEGIN IMMEDIATE; ROLLBACK;');
        return false;
    }
    catch {
        return true;
    }
    finally {
        d.close();
    }
}
describe('db-write lib l3', () => {
    let sb;
    let DB;
    const count = (sql) => sqlRows(DB, sql);
    const env = (extra = {}) => childEnv(extra);
    const write = (sql, extra = {}) => dbWrite(DB, sql, { caller: CALLER, env: env(extra) });
    const row = (r) => ({
        issueId: '-1',
        branchId: '',
        summary: 'x',
        contentJson: '{}',
        ...r,
    });
    const append = (r, opts = {}) => auditAppend(DB, r, { caller: CALLER, env: env(), ...opts });
    before(() => {
        sb = makeSandbox('db-write-lib');
        DB = join(sb.dir, 'trajectory.db');
        sqlExec(DB, readFileSync(SCHEMA, 'utf8'));
    });
    after(() => sb.remove());
    it('nowIso prints a 24-char UTC ms-ISO timestamp', () => {
        const now = nowIso();
        assert.equal(now.length, 24, 'nowIso length');
        assert.match(now, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/, 'nowIso shape');
    });
    it('dbWrite commits a valid transaction', () => {
        const r = write("INSERT INTO plugin_config (key, value_json) VALUES ('dbw_ok', '1');");
        assert.equal(r.code, 0, 'exit code on success');
        assert.equal(count("SELECT COUNT(*) FROM plugin_config WHERE key='dbw_ok';"), '1', 'row committed');
    });
    it('dbWrite rolls back when a later statement violates a CHECK', () => {
        const r = write(`INSERT INTO plugin_config (key, value_json) VALUES ('dbw_rollback', '1');
INSERT INTO validation_attempts (task_id, attempt_n, agent, verdict, feedback, mcp_available, created_at)
VALUES (1, 1, 'code-reviewer', 'not-a-verdict', '', 0, '${nowIso()}');`);
        assert.notEqual(r.code, 0, 'CHECK violation returns non-zero');
        assert.equal(count("SELECT COUNT(*) FROM plugin_config WHERE key='dbw_rollback';"), '0', 'first statement rolled back');
        assert.ok(r.error.includes('tmb_db_write: '), `one stderr line names the library: ${r.error}`);
        assert.equal(r.error.split('\n').filter((l) => l !== '').length, 1, 'exactly one stderr line');
    });
    it('dbWrite enforces foreign keys (audit row for a missing issue)', () => {
        const r = write(`INSERT INTO audit (issue_id, from_node, event_type, summary, content_json, created_at)
VALUES (424242, 'hook:x', 'fk_probe', 'x', '{}', '${nowIso()}');`);
        assert.notEqual(r.code, 0, 'FK violation returns non-zero');
        assert.ok(r.error.includes('FOREIGN KEY'), `stderr names the FK failure: ${r.error}`);
        assert.equal(count("SELECT COUNT(*) FROM audit WHERE event_type='fk_probe';"), '0', 'no orphan audit row');
    });
    it('dbWrite on a missing DB file fails visibly without creating it', () => {
        const missing = join(sb.dir, 'missing.db');
        const r = dbWrite(missing, "INSERT INTO plugin_config (key, value_json) VALUES ('x', '1');", { caller: CALLER, env: env() });
        assert.notEqual(r.code, 0, 'missing DB returns non-zero');
        assert.ok(r.error.includes('database not found'), `stderr names the missing DB: ${r.error}`);
        assert.ok(!existsSync(missing), 'missing DB must not be created');
    });
    it('dbWrite retries through a held write lock (default 1500 ms x 2 attempts)', async () => {
        const holder = await holdLock(DB, 'IMMEDIATE', "INSERT INTO plugin_config (key, value_json) VALUES ('dbw_holder', '1');", 2000);
        let r;
        try {
            r = write("INSERT INTO plugin_config (key, value_json) VALUES ('dbw_busy', '1');");
        }
        finally {
            await holder.release();
        }
        assert.equal(r.code, 0, `write lands once the lock is released: ${r.error}`);
        assert.equal(count("SELECT COUNT(*) FROM plugin_config WHERE key='dbw_busy';"), '1', 'busy-retried row present');
        assert.equal(count("SELECT COUNT(*) FROM plugin_config WHERE key='dbw_holder';"), '1', "lock holder's row present");
    });
    it('dbWrite gives up within its bounded budget when the lock outlasts every attempt', async () => {
        const holder = await holdLock(DB, 'IMMEDIATE');
        try {
            const r = write("INSERT INTO plugin_config (key, value_json) VALUES ('dbw_gaveup', '1');", { TMB_DB_WRITE_TIMEOUT_MS: '500' });
            assert.ok(stillLocked(DB), 'TMB_DB_WRITE_TIMEOUT_MS=500 gives up while the lock is still held');
            assert.notEqual(r.code, 0, 'write under a permanent lock fails');
            assert.ok(r.error.includes('locked'), `stderr names the lock: ${r.error}`);
        }
        finally {
            await holder.release();
        }
        assert.equal(count("SELECT COUNT(*) FROM plugin_config WHERE key='dbw_gaveup';"), '0', 'no row written');
    });
    it('auditAppend rejects an agent-impersonating from_node', () => {
        let r = append(row({ fromNode: 'bro', eventType: 'probe_event' }));
        assert.equal(r.code, 2, 'from_node outside the allowed set exits 2');
        assert.ok(r.error.includes('invalid from_node'), `stderr names the invalid from_node: ${r.error}`);
        r = append(row({ fromNode: 'hook:Bad_Name', eventType: 'probe_event' }));
        assert.equal(r.code, 2, 'malformed hook:<name> exits 2');
        assert.equal(count("SELECT COUNT(*) FROM audit WHERE event_type='probe_event';"), '0', 'rejected rows not written');
    });
    it('auditAppend accepts hook:<name> and quotes every value', () => {
        const r = append(row({ fromNode: 'hook:x', eventType: 'containment_denied', summary: "it's quoted", contentJson: `{"note":"it's"}` }));
        assert.equal(r.code, 0, `hook:x accepted: ${r.error}`);
        assert.equal(count("SELECT from_node || '|' || summary || '|' || json_extract(content_json, '$.note') || '|' || COALESCE(branch_id, 'NULL') || '|' || length(created_at) FROM audit WHERE event_type='containment_denied';"), "hook:x|it's quoted|it's|NULL|24", 'row values round-trip');
    });
    it('auditAppend writes repo from the parent issue', () => {
        const now = nowIso();
        sqlExec(DB, `INSERT INTO repos (name, path) VALUES ('dbw-repo', '/tmp/dbw-repo');
INSERT INTO issues (id, objective, description, status, repo, created_at, updated_at) VALUES (77, 'o', 'd', 'open', 'dbw-repo', '${now}', '${now}');`);
        const r = append(row({ issueId: '77', branchId: 'feat/x', fromNode: 'hook:x', eventType: 'readme_staleness_surfaced', summary: 's' }));
        assert.equal(r.code, 0, r.error);
        assert.equal(count("SELECT repo || '|' || branch_id FROM audit WHERE event_type='readme_staleness_surfaced';"), 'dbw-repo|feat/x', 'repo + branch_id');
    });
    it('auditSql guard: audit row only when the preceding UPDATE changed a row', () => {
        const guarded = (summary) => {
            const s = auditSql(row({ issueId: '77', fromNode: 'hook:x', eventType: 'issue_auto_closed_on_merge', summary }), '(SELECT changes()) > 0', { caller: CALLER });
            assert.equal(s.code, 0, s.error);
            return s.sql;
        };
        const hit = guarded('hit');
        const miss = guarded('miss');
        write(`UPDATE issues SET status = 'closed' WHERE id = 77 AND status != 'closed';\n${hit}`);
        write(`UPDATE issues SET status = 'closed' WHERE id = 77 AND status != 'closed';\n${miss}`);
        assert.equal(count("SELECT group_concat(summary) FROM audit WHERE event_type='issue_auto_closed_on_merge';"), 'hit', 'guarded row written once');
    });
    it('auditAppend rejects an event_type outside audit-events.txt', () => {
        const r = append(row({ fromNode: 'hook:x', eventType: 'not_an_event' }));
        assert.equal(r.code, 2, 'unknown event_type rejected');
        assert.ok(r.error.includes("unknown event_type 'not_an_event'"), `stderr names the unknown event: ${r.error}`);
        const s = auditSql(row({ fromNode: 'hook:x', eventType: '' }), '', { caller: CALLER });
        assert.equal(s.code, 2, 'empty event_type rejected by auditSql');
        assert.equal(count("SELECT COUNT(*) FROM audit WHERE event_type IN ('not_an_event', '');"), '0', 'rejected rows not written');
    });
    it('audit-events.txt lists every type in audit-events.ts', () => {
        const ts = readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/audit-events.ts'), 'utf8');
        const tsTypes = [...ts.matchAll(/\{ type: '([a-z_]+)'/g)].map((m) => m[1]);
        const txt = readFileSync(join(PLUGIN_ROOT, 'scripts/hooks/lib/audit-events.txt'), 'utf8');
        const txtTypes = txt.replace(/\n$/, '').split('\n').map((l) => l.split('\t')[0]);
        assert.deepEqual(txtTypes, tsTypes, 'generated txt equals the TS list');
    });
    it('auditAppend rejects a hook write of an event hooks may not write', () => {
        let r = append(row({ fromNode: 'hook:x', eventType: 'scope_gate_waived' }));
        assert.equal(r.code, 2, 'bro-only event rejected for a hook');
        assert.ok(r.error.includes('audit_event_not_writable_by_role'), `stderr names the writer refusal: ${r.error}`);
        assert.ok(r.error.includes('writers: bro'), 'stderr lists the allowed writers');
        r = append(row({ fromNode: 'system', eventType: 'verification_gate_waived' }));
        assert.equal(r.code, 2, 'hook-only event rejected for system');
        assert.equal(count("SELECT COUNT(*) FROM audit WHERE event_type IN ('scope_gate_waived') OR (event_type = 'verification_gate_waived' AND from_node = 'system');"), '0', 'refused rows not written');
    });
    it('auditAppend names a missing audit-events.txt', () => {
        const missing = join(sb.dir, 'missing/audit-events.txt');
        const r = append(row({ fromNode: 'hook:x', eventType: 'containment_denied' }), { eventsFile: missing });
        assert.equal(r.code, 2, 'missing list fails closed');
        assert.ok(r.error.includes(`audit event list missing or unreadable: ${missing}`), `stderr names the condition and the path: ${r.error}`);
    });
    it('auditAppend dedupe paths: one row per (event_type, task_id, commit_sha)', () => {
        for (const contentJson of [
            '{"task_id":9,"commit_sha":"abc1234","waiver_reason":"first"}',
            '{"task_id":9,"commit_sha":"abc1234","waiver_reason":"second"}',
            '{"task_id":9,"commit_sha":"def5678","waiver_reason":"new commit"}',
        ]) {
            const r = append(row({ fromNode: 'hook:x', eventType: 'verification_gate_waived', summary: 'dedupe', contentJson, dedupePaths: ['$.task_id', '$.commit_sha'] }));
            assert.equal(r.code, 0, `dedupe write: ${r.error}`);
        }
        assert.equal(count("SELECT group_concat(json_extract(content_json, '$.waiver_reason')) FROM (SELECT content_json FROM audit WHERE event_type='verification_gate_waived' ORDER BY id);"), 'first,new commit', 'repeat skipped, new commit written');
        const r = append(row({ fromNode: 'hook:x', eventType: 'verification_gate_waived', dedupePaths: ["$.a'); DROP TABLE audit;--"] }));
        assert.equal(r.code, 2, 'malformed dedupe path rejected');
        assert.ok(r.error.includes('invalid dedupe json path'), `stderr names the bad path: ${r.error}`);
    });
    it('gateRead prints __ERR__ on a missing DB file', () => {
        const nope = join(sb.dir, 'nope.db');
        assert.equal(gateRead(nope, 'SELECT 1;', env()), '__ERR__', 'missing DB');
        assert.ok(!existsSync(nope), 'the read never creates the DB');
    });
    it('gateRead prints __ERR__ on a sqlite error', () => {
        assert.equal(gateRead(DB, 'SELECT * FROM no_such_table;', env()), '__ERR__', 'query error');
    });
    it('gateRead distinguishes no rows from an error', () => {
        assert.equal(gateRead(DB, "SELECT key FROM plugin_config WHERE key='absent';", env()), '', 'empty result');
        assert.equal(gateRead(DB, "SELECT value_json FROM plugin_config WHERE key='dbw_ok';", env()), '1', 'row result');
    });
    describe('a WAL DB with no holder, and gateRead retrying only an unopenable DB', () => {
        let roBin;
        let roLog;
        const cli = (extra = {}) => childEnv({ TMB_HOOKS_SQLITE: 'cli', PATH: [roBin, process.env.PATH ?? ''].join(delimiter), ...extra });
        const logLines = () => readFileSync(roLog, 'utf8').split('\n').filter((l) => l !== '').length;
        before(() => {
            roBin = join(sb.dir, 'ro-bin');
            roLog = join(sb.dir, 'ro-sqlite3.log');
            sqliteLogWrapper(roBin, roLog);
        });
        for (const backend of ['node', 'cli']) {
            it(`gateRead, sqliteRo and dbReadBudget read a WAL DB with no holder (${backend} backend)`, () => {
                const e = () => (backend === 'cli' ? cli() : env());
                const cold = join(sb.dir, `cold-${backend}/trajectory.db`);
                mkdirSync(join(sb.dir, `cold-${backend}`));
                sqlExec(DB, `VACUUM INTO '${cold}';`);
                const sql = "SELECT value_json FROM plugin_config WHERE key='dbw_ok';";
                walDetach(cold);
                assert.equal(gateRead(cold, sql, e()), '1', 'gateRead');
                walDetach(cold);
                assert.equal(sqliteRo(cold, sql, e()), '1', 'sqliteRo');
                walDetach(cold);
                assert.equal(dbReadBudget(cold, '1500', `${sql}\n`, e()).out, '1', 'dbReadBudget');
            });
        }
        it('gateRead retries nothing but an unopenable DB: a SQL error runs sqlite3 once', () => {
            writeFileSync(roLog, '');
            assert.equal(gateRead(DB, 'SELECT * FROM no_such_table;', cli()), '__ERR__', 'query error');
            assert.equal(logLines(), 1, 'one sqlite3 run');
        });
        it('gateRead retries nothing but an unopenable DB: a locked DB runs sqlite3 once', async () => {
            const locked = join(sb.dir, 'locked.db');
            sqlExec(locked, 'CREATE TABLE x (a);');
            const holder = await holdLock(locked, 'EXCLUSIVE', 'INSERT INTO x VALUES (1);');
            try {
                writeFileSync(roLog, '');
                assert.equal(gateRead(locked, 'SELECT count(*) FROM x;', cli({ TMB_DB_WRITE_TIMEOUT_MS: '100' })), '__ERR__', 'locked DB');
                assert.equal(logLines(), 1, 'one sqlite3 run');
            }
            finally {
                await holder.release();
            }
        });
    });
    it('run budget: three writes under a held lock stop waiting once the budget is spent', async () => {
        const holder = await holdLock(DB, 'IMMEDIATE');
        const shared = env();
        const errors = [];
        let out = '';
        try {
            for (const i of [1, 2, 3]) {
                const r = dbWrite(DB, `INSERT INTO plugin_config (key, value_json) VALUES ('dbw_budget_${i}', '1');`, { caller: CALLER, env: shared });
                if (!r.ok) {
                    out += `fail${i} `;
                    errors.push(r.error);
                }
            }
            assert.ok(stillLocked(DB), 'the three writes stop waiting while the lock is still held');
        }
        finally {
            await holder.release();
        }
        assert.equal(out, 'fail1 fail2 fail3 ', 'all three writes fail under the held lock');
        assert.ok(errors[0].includes('database is locked'), `the first write waits out its attempts on the lock: ${errors[0]}`);
        assert.equal(errors.filter((e) => e.includes('run budget spent')).length, 2, `later writes fail fast naming the spent budget: ${errors.join(' / ')}`);
        assert.equal(count("SELECT COUNT(*) FROM plugin_config WHERE key LIKE 'dbw_budget_%';"), '0', 'no row written');
    });
    it('swe-verification-gate denies the waiver when the task-row read errors', () => {
        const corrupt = join(sb.dir, 'corrupt.db');
        writeFileSync(corrupt, 'this is not a sqlite database, only text');
        const input = JSON.stringify({
            tool_name: 'mcp__plugin_tmb_trajectory-server__task_update_status',
            tool_input: { agent: 'swe', task_id: '5', status: 'completed', waive_verification_gate_reason: 'verification impossible offline' },
        });
        const r = runGate('swe-verification-gate', { cwd: sb.dir, input, env: { ...sb.env, TRAJECTORY_DB_PATH: corrupt } });
        assert.ok(r.stdout.includes('"permissionDecision":"deny"'), `waiver denied: ${r.stdout}`);
        assert.ok(r.stdout.includes('trajectory DB unavailable'), 'unavailable reason');
    });
    describe('verification runs', () => {
        const SHA = '0123456789abcdef0123456789abcdef01234567';
        const OTHER_SHA = 'fedcba9876543210fedcba9876543210fedcba98';
        const CMDS = JSON.stringify(["echo it's ok", 'true']);
        let run = '';
        let run2 = '';
        const start = (sha, budgetS, task = '4242') => write(runStartSql(task, sha, budgetS));
        const command = (runId, ordinal, cmd, rc, elapsed, output, extra = {}) => {
            const s = runCommandSql(CALLER, runId, ordinal, cmd, rc, elapsed, output, env(extra));
            assert.equal(s.code, 0, s.error);
            return write(s.sql);
        };
        const finish = (runId, rc, timedOut) => {
            const s = runFinishSql(CALLER, runId, rc, timedOut);
            assert.equal(s.code, 0, s.error);
            return write(s.sql);
        };
        const reusable = (sha, cmds = CMDS) => reusableRun(DB, '4242', sha, cmds, env());
        before(() => {
            const now = nowIso();
            sqlExec(DB, `INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (4242, 'vr', 'open', '${now}', '${now}');
INSERT INTO tasks (id, issue_id, branch_id, description, status, created_at, updated_at) VALUES (4242, 4242, 'feat/vr', 'd', 'running', '${now}', '${now}');`);
        });
        it('start prints the id, command and finish rows land, reusable finds the pass', () => {
            const r = start(SHA, 900);
            assert.equal(r.code, 0, `start succeeds: ${r.error}`);
            run = r.stdout.trim();
            assert.match(run, /^[0-9]+$/, 'start prints a numeric run id');
            assert.equal(count(`SELECT COALESCE(finished_at, '') || '|' || COALESCE(exit_code, '') FROM verification_runs WHERE id = ${run};`), '|', 'finished_at and exit_code NULL while in progress');
            assert.equal(reusable(SHA), '', 'an unfinished run is not reusable');
            assert.equal(command(run, 1, "echo it's ok", 0, '1.25', 'line one\nline two').code, 0, 'command row write');
            assert.equal(command(run, 2, 'true', 0, '0.0', '').code, 0, 'second command row write');
            assert.equal(count(`SELECT command || '|' || exit_code || '|' || elapsed_s || '|' || output_tail FROM verification_run_commands WHERE run_id = ${run} AND ordinal = 1;`), "echo it's ok|0|1.25|line one\nline two", 'command row round-trips quotes and newlines');
            assert.equal(finish(run, 0, 0).code, 0, 'finish write');
            assert.equal(count(`SELECT exit_code || '|' || timed_out || '|' || (finished_at IS NOT NULL) FROM verification_runs WHERE id = ${run};`), '0|0|1', 'finish stamps the row');
            assert.equal(reusable(SHA).split('|')[0], run, 'a finished pass is reusable');
            assert.equal(reusable('ffff'), '', 'another sha is not');
        });
        it('the output tail is capped; a timed-out or failed run is not reusable', () => {
            run2 = start(SHA, 5).stdout.trim();
            command(run2, 1, 'sleep 9', 124, '5.0', '0123456789abcdefghij', { TMB_VERIFICATION_TAIL_CHARS: '10' });
            assert.equal(count(`SELECT output_tail FROM verification_run_commands WHERE run_id = ${run2};`), 'abcdefghij', 'last 10 characters kept');
            finish(run2, 124, 1);
            write(`DELETE FROM verification_runs WHERE id = ${run};`);
            assert.equal(reusable(SHA, JSON.stringify(['sleep 9'])), '', 'a timed-out run is not reusable');
            assert.equal(count(`SELECT COUNT(*) FROM verification_run_commands WHERE run_id = ${run};`), '0', 'deleting a run cascades to its commands');
        });
        it('start finishes unfinished runs past budget_s + 60 s as exit 137 (GH 1814)', () => {
            const isoAgo = (s) => `strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${s} seconds')`;
            const seed = (sha, source, agoS, budgetS) => count(`INSERT INTO verification_runs (task_id, commit_sha, source, started_at, budget_s) VALUES (4242, '${sha}', '${source}', ${isoAgo(agoS)}, ${budgetS}) RETURNING id;`);
            const stale = seed(SHA, 'manual', 10800, 900);
            const staleGate = seed(OTHER_SHA, 'gate', 70, 5);
            const live = seed(SHA, 'manual', 900, 900);
            const finished = count(`INSERT INTO verification_runs (task_id, commit_sha, source, started_at, finished_at, exit_code, budget_s) VALUES (4242, '${SHA}', 'gate', ${isoAgo(5000)}, ${isoAgo(4990)}, 1, 900) RETURNING id;`);
            const finishedAt = count(`SELECT finished_at FROM verification_runs WHERE id = ${finished};`);
            const contracts = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'scripts/hooks/lib/data-contracts.json'), 'utf8'));
            const contractSql = contracts.contracts.find((c) => c.id === 'no_unfinished_verification_runs').sql;
            assert.equal(count(contractSql), '1', 'no_unfinished_verification_runs counts the 3 h old run before the sweep');
            const r = start(SHA, 900);
            assert.equal(r.code, 0, `start succeeds while sweeping: ${r.error}`);
            const next = r.stdout.trim();
            assert.match(next, /^[0-9]+$/, 'start still prints a numeric run id');
            assert.equal(count(`SELECT COUNT(*) FROM verification_runs WHERE id = ${next} AND finished_at IS NULL AND exit_code IS NULL;`), '1', 'the new run row is inserted unfinished');
            assert.equal(count(`SELECT exit_code || '|' || timed_out || '|' || (finished_at IS NOT NULL) FROM verification_runs WHERE id = ${stale};`), '137|0|1', 'a run past budget_s + 60 s is finished as 137, not timed out');
            assert.equal(count(`SELECT exit_code || '|' || timed_out FROM verification_runs WHERE id = ${staleGate};`), '137|0', "the sweep spans sources, by each row's own budget_s");
            assert.equal(count(`SELECT COALESCE(finished_at, '') || '|' || COALESCE(exit_code, '') FROM verification_runs WHERE id = ${live};`), '|', 'a run within budget_s + 60 s is left unfinished');
            assert.equal(count(`SELECT exit_code || '|' || finished_at FROM verification_runs WHERE id = ${finished};`), `1|${finishedAt}`, 'a finished run is not rewritten');
            assert.equal(count(contractSql), '0', 'no_unfinished_verification_runs counts 0 after the sweep');
            assert.equal(reusable(OTHER_SHA, '[]'), '', 'a swept run is not reusable');
            assert.equal(reusable(SHA, '[]'), '', 'nor is one of the commit the new run is for');
            sqlExec(DB, `DELETE FROM verification_runs WHERE id IN (${stale}, ${staleGate}, ${live}, ${finished}, ${next});`);
        });
        it('invalid input is refused with exit 2 and nothing written', () => {
            const before = count('SELECT COUNT(*) FROM verification_runs;');
            for (const runId of ['', 'x', '1; DROP TABLE tasks']) {
                const c = runCommandSql(CALLER, runId, 2, 'x', 0, '0.0', '', env());
                assert.equal(c.code, 2, `command refuses run_id <${runId}>`);
                assert.ok(c.error.includes('tmb_verification_run'), `stderr names the helper: ${c.error}`);
                const f = runFinishSql(CALLER, runId, 0, 0);
                assert.equal(f.code, 2, `finish refuses run_id <${runId}>`);
                assert.ok(f.error.includes('tmb_verification_run'), `stderr names the helper: ${f.error}`);
            }
            const r = start(SHA, 900, '999');
            assert.notEqual(r.code, 0, 'a run for a missing task fails the FK');
            assert.ok(r.error.includes('FOREIGN KEY'), `stderr names the FK failure: ${r.error}`);
            assert.equal(count('SELECT COUNT(*) FROM verification_runs;'), before, 'no run row written');
        });
    });
});
//# sourceMappingURL=db-write-lib-l3.test.js.map