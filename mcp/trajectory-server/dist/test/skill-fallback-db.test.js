/**
 * The skill fallbacks' DB resolution (GH 1553, GH 1692): the
 * `bro-sqlite-readonly` and `validation-record-fallback` subcommands of
 * dist/cli.js resolve the trajectory DB through CLAUDE_PROJECT_DIR, never from
 * the cwd. Each runs from / and from a worktree path whose ancestor holds a
 * decoy DB; both must read and write the project's DB and create no .claude
 * dir in the cwd. validation-record-fallback also records review_findings as
 * validation_record does (GH 1783): fail requires them, pass refuses them.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import { CLI_JS, childEnv, migratedDb, runNode, sandboxDir, sqlExec, sqlRows } from './db-test-fixtures.js';
const RUN_ID = 'skill-fallback-db';
describe('skill-fallback-db: the skill fallbacks resolve the DB through CLAUDE_PROJECT_DIR (GH 1553)', () => {
    let tmp;
    let project;
    let projectDb;
    let decoyDb;
    let wt;
    let env;
    function seedDb(db, sentinel) {
        migratedDb(db);
        sqlExec(db, `PRAGMA journal_mode=DELETE;
       INSERT INTO issues (id, objective, status, created_at, updated_at)
         VALUES (1, 'fallback db', 'open', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
       INSERT INTO tasks (id, issue_id, branch_id, description, created_at, updated_at)
         VALUES (7, 1, 'fix/fallback-db', 'validated task', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');`);
        const d = new DatabaseSync(db);
        try {
            d.prepare('INSERT OR REPLACE INTO plugin_config (key, value_json) VALUES (?, ?)').run('sentinel', JSON.stringify(sentinel));
        }
        finally {
            d.close();
        }
    }
    /** stdout and stderr together, as the shell suite's 2>&1 read them. */
    const runIn = (cwd, sub, ...args) => {
        const r = runNode(['--experimental-sqlite', CLI_JS, sub, ...args], { cwd, env });
        return `${r.stdout}${r.stderr}`;
    };
    const readonly = (cwd, ...args) => runIn(cwd, 'bro-sqlite-readonly', ...args);
    const validation = (cwd, ...args) => runIn(cwd, 'validation-record-fallback', ...args);
    const q = (sql) => sqlRows(projectDb, sql);
    const rows = () => q("SELECT (SELECT COUNT(*) FROM validation_attempts) || '/' || (SELECT COUNT(*) FROM review_findings);");
    before(() => {
        tmp = sandboxDir('skill-fallback-db');
        project = join(tmp, 'project');
        projectDb = join(project, '.claude/tmb/trajectory.db');
        seedDb(projectDb, 'project-db');
        decoyDb = join(tmp, 'decoy/.claude/tmb/trajectory.db');
        seedDb(decoyDb, 'decoy-db');
        wt = join(tmp, 'decoy/.claude/worktrees/wt');
        mkdirSync(wt, { recursive: true });
        mkdirSync(join(tmp, 'home'), { recursive: true });
        env = childEnv({ HOME: join(tmp, 'home'), CLAUDE_PROJECT_DIR: project, TMB_TEST_RUN_ID: RUN_ID });
    });
    after(() => rmSync(tmp, { recursive: true, force: true }));
    let attempt = 0;
    for (const where of ['/', 'the worktree']) {
        const cwdOf = () => (where === '/' ? '/' : wt);
        it(`bro-sqlite-readonly from ${where} reads the project's DB`, () => {
            const out = readonly(cwdOf(), 'config_get', '{"key":"sentinel"}');
            assert.ok(out.includes('project-db'), 'sentinel row read');
            assert.ok(!out.includes('decoy-db'), 'decoy DB never read');
            assert.ok(readonly(cwdOf(), '--dry-run').includes(`"db_path":"${projectDb}"`), "dry-run names the project's DB");
        });
        it(`validation-record-fallback from ${where} writes the project's DB`, () => {
            attempt += 1;
            const out = validation(cwdOf(), '7', String(attempt), 'pass', 'ok', `sess-${attempt}`);
            assert.ok(out.includes('"ok":true'), 'insert reported');
            assert.equal(q(`SELECT COUNT(*) FROM validation_attempts WHERE attempt_n = ${attempt} AND mcp_available = 0;`), '1', "row landed in the project's DB");
            assert.equal(sqlRows(decoyDb, 'SELECT COUNT(*) FROM validation_attempts;'), '0', 'decoy DB untouched');
        });
    }
    it("validation-record-fallback waits out a concurrent writer; a quote in feedback survives", async () => {
        const holder = new DatabaseSync(projectDb);
        holder.exec('BEGIN IMMEDIATE;');
        const child = spawn(process.execPath, [
            '--experimental-sqlite',
            CLI_JS,
            'validation-record-fallback',
            '7',
            '50',
            'fail',
            "it's not done",
            'sess-lock',
            `[{"criterion_id":"SC1","probe_cmd":"test -f it's","expected":"e","observed":"o"}]`,
        ], { cwd: '/', env: { ...env, PWD: '/' } });
        let out = '';
        child.stdout.on('data', (b) => (out += b));
        child.stderr.on('data', (b) => (out += b));
        const exited = new Promise((resolve) => child.on('close', resolve));
        await new Promise((resolve) => setTimeout(resolve, 600));
        holder.exec('COMMIT;');
        holder.close();
        await exited;
        assert.ok(out.includes('"ok":true'), "insert waited for the writer's lock");
        assert.ok(out.includes('"findings":["F7-1"]'), 'finding id reported');
        assert.equal(q('SELECT feedback FROM validation_attempts WHERE attempt_n = 50;'), "it's not done", 'feedback stored verbatim');
        assert.equal(q("SELECT probe_cmd FROM review_findings WHERE id = 'F7-1';"), "test -f it's", 'a quote in probe_cmd survives');
    });
    it('fail without findings, or with [], is findings_required and writes nothing', () => {
        const before_ = rows();
        assert.ok(validation('/', '7', '60', 'fail', 'broken', 'sess-60').includes('"error":"findings_required"'), 'omitted findings refused');
        assert.ok(validation('/', '7', '60', 'fail', 'broken', 'sess-60', '[]').includes('"error":"findings_required"'), 'empty findings refused');
        assert.equal(rows(), before_, 'no attempt or finding row written');
    });
    it('pass with findings is findings_refused; pass with none or [] records as before', () => {
        const before_ = rows();
        assert.ok(validation('/', '7', '61', 'pass', 'fine', 'sess-61', '[{"probe_cmd":"true","expected":"e","observed":"o"}]').includes('"error":"findings_refused"'), 'pass with a finding refused');
        assert.equal(rows(), before_, 'nothing written');
        const out = validation('/', '7', '62', 'pass', 'fine', 'sess-62', '[]');
        assert.ok(out.includes('"ok":true'), 'pass with [] recorded');
        assert.ok(out.includes('"findings":[]'), 'no finding ids');
        assert.equal(q("SELECT COUNT(*), (SELECT COUNT(*) FROM review_findings WHERE attempt_n = 62) FROM validation_attempts WHERE attempt_n = 62 AND verdict = 'pass' AND mcp_available = 0;"), '1|0', 'pass row, no findings');
    });
    it("fail with findings writes one open row per entry, trimmed, ids continuing after the task's highest", () => {
        const out = validation('/', '7', '70', 'fail', 'two defects', 'sess-70', '[{"probe_cmd":"  bash -c \\"exit 1\\"\\n","expected":" exits 0 ","observed":"\\texits 1 "},{"criterion_id":null,"probe_cmd":"false","expected":"e2","observed":"o2"},{"criterion_id":" SC3 ","probe_cmd":"false","expected":"e3","observed":"o3"}]');
        assert.ok(out.includes('"findings":["F7-2","F7-3","F7-4"]'), 'ids continue after F7-1');
        assert.equal(q("SELECT COUNT(*) FROM validation_attempts WHERE attempt_n = 70 AND verdict = 'fail' AND mcp_available = 0;"), '1', 'attempt row with mcp_available = 0');
        assert.equal(q("SELECT id, attempt_n, COALESCE(criterion_id, '<null>'), probe_cmd, expected, observed, status FROM review_findings WHERE attempt_n = 70 ORDER BY id;"), 'F7-2|70|<null>|bash -c "exit 1"|exits 0|exits 1|open\nF7-3|70|<null>|false|e2|o2|open\nF7-4|70|SC3|false|e3|o3|open', 'rows open, criterion_id NULL when absent or null, text trimmed');
    });
    it('re-recording an attempt replaces only its open rows, never reusing an id', () => {
        sqlExec(projectDb, "UPDATE review_findings SET status = 'fixed', resolved_at = '2026-01-02T00:00:00.000Z' WHERE id = 'F7-4';");
        const out = validation('/', '7', '70', 'fail', 'one defect left', 'sess-70b', '[{"probe_cmd":"false","expected":"e5","observed":"o5"}]');
        assert.ok(out.includes('"findings":["F7-5"]'), 'new id after the deleted ones');
        assert.equal(q("SELECT group_concat(id, ' ') FROM (SELECT id FROM review_findings ORDER BY id);"), 'F7-1 F7-4 F7-5', 'open rows of attempt 70 replaced; attempt 50 and the fixed row kept');
        assert.equal(q('SELECT COUNT(*), feedback, subagent_session_id FROM validation_attempts WHERE attempt_n = 70;'), '1|one defect left|sess-70b', 'attempt row replaced in place');
    });
    it('a malformed findings array is invalid_findings and writes nothing', () => {
        const before_ = rows();
        for (const bad of [
            'not json',
            '{"probe_cmd":"false"}',
            '["false"]',
            '[{"probe_cmd":"","expected":"e","observed":"o"}]',
            '[{"probe_cmd":"false","expected":"  ","observed":"o"}]',
            '[{"probe_cmd":"false","expected":"e"}]',
            '[{"probe_cmd":"false","expected":"e","observed":"o","status":"fixed"}]',
            '[{"criterion_id":"","probe_cmd":"false","expected":"e","observed":"o"}]',
            '[{"probe_cmd":"false","expected":"e","observed":"o"},{"probe_cmd":"false","expected":"e","observed":7}]',
        ]) {
            assert.ok(validation('/', '7', '80', 'fail', 'bad', 'sess-80', bad).includes('"error":"invalid_findings"'), `refused: ${bad}`);
        }
        assert.equal(rows(), before_, 'no attempt or finding row written');
    });
    it('GH 1955: applies the severity verdict rules and stores severity and class', () => {
        const before_ = rows();
        const nitOnly = validation('/', '7', '90', 'fail', 'nits', 'sess-90', '[{"probe_cmd":"false","expected":"e","observed":"o","severity":"nit"}]');
        assert.ok(nitOnly.includes('"error":"findings_required"'), `fail with only a nit refused: ${nitOnly}`);
        assert.ok(nitOnly.includes('severity blocking'), 'the message names severity');
        const blockingPass = validation('/', '7', '91', 'pass', 'ok', 'sess-91', '[{"probe_cmd":"false","expected":"e","observed":"o","severity":"blocking"}]');
        assert.ok(blockingPass.includes('"error":"findings_refused"'), `pass with a blocking finding refused: ${blockingPass}`);
        for (const bad of [
            '[{"probe_cmd":"false","expected":"e","observed":"o","severity":"major"}]',
            '[{"probe_cmd":"false","expected":"e","observed":"o","severity":2}]',
            '[{"probe_cmd":"false","expected":"e","observed":"o","class":7}]',
            '[{"probe_cmd":"false","expected":"e","observed":"o","class":" "}]',
        ]) {
            assert.ok(validation('/', '7', '92', 'fail', 'bad', 'sess-92', bad).includes('"error":"invalid_findings"'), `refused: ${bad}`);
        }
        assert.equal(rows(), before_, 'nothing written by a refused call');
        const pass = validation('/', '7', '93', 'pass', 'ok with notes', 'sess-93', '[{"probe_cmd":"false","expected":"e","observed":"o","severity":"nit","class":" style "},{"probe_cmd":"false","expected":"e","observed":"o","severity":"pre_existing"}]');
        assert.ok(pass.includes('"ok":true'), `pass with a nit and a pre_existing finding recorded: ${pass}`);
        const fail = validation('/', '7', '94', 'fail', 'one defect', 'sess-94', '[{"probe_cmd":"false","expected":"e","observed":"o"},{"probe_cmd":"true","expected":"e","observed":"o","severity":"nit","class":"naming"}]');
        assert.ok(fail.includes('"ok":true'), `fail with an omitted severity and a nit recorded: ${fail}`);
        assert.equal(q("SELECT attempt_n, severity, COALESCE(class, '<null>'), status FROM review_findings WHERE attempt_n IN (93, 94) ORDER BY attempt_n, id;"), '93|nit|style|open\n93|pre_existing|<null>|open\n94|blocking|<null>|open\n94|nit|naming|open', 'severity defaults to blocking, class trimmed or NULL');
    });
    it('no .claude dir appears in either cwd', () => {
        assert.ok(!existsSync('/.claude'), '/.claude exists');
        assert.ok(!existsSync(join(wt, '.claude')), `${wt}/.claude created`);
    });
    it('nothing names a DB: db-not-found with the hint, nothing created in the cwd', () => {
        const bare = childEnv({ HOME: join(tmp, 'home'), TMB_TEST_RUN_ID: RUN_ID });
        const run = (...args) => {
            const r = runNode(['--experimental-sqlite', CLI_JS, ...args], { cwd: wt, env: bare });
            return `${r.stdout}${r.stderr}`;
        };
        let out = run('bro-sqlite-readonly', '--dry-run');
        assert.ok(out.includes('"error":"db-not-found","path":"unresolved"'), "readonly: unresolved, not the cwd's DB");
        assert.ok(out.includes('Set CLAUDE_PROJECT_DIR'), 'readonly: hint');
        out = run('validation-record-fallback', '7', '9', 'fail', 'no', 'sess-x', '[{"probe_cmd":"false","expected":"e","observed":"o"}]');
        assert.ok(out.includes('"error":"db-not-found","path":"unresolved"'), "validation: unresolved, not the cwd's DB");
        assert.ok(!existsSync(join(wt, '.claude')), `${wt}/.claude created`);
    });
});
//# sourceMappingURL=skill-fallback-db.test.js.map