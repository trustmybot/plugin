/**
 * `cli.js bro-sqlite-readonly` (src/cli/) against the current schema (GH 1678,
 * GH 1692). The DB is built by the trajectory-server's own migration path
 * (TrajectoryDB), never a hand-written schema, so a column the fallback
 * queries that the schema drops fails here. Every read subcommand exits 0 with
 * non-empty JSON and leaves the DB unchanged; a failed query names the
 * subcommand and the sqlite error on stderr.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { TrajectoryDB } from '../db.js';
import { resetEmbeddingModelForTests } from '../embeddings/model.js';
import { CLI_JS, childEnv, runNode, sandboxDir, sqlExec } from './db-test-fixtures.js';
const dbSum = (db) => createHash('sha256').update(readFileSync(db)).digest('hex');
/** The output parses to a non-empty, non-null value with no top-level "error". */
function jsonOk(out) {
    let v;
    try {
        v = JSON.parse(out);
    }
    catch {
        return false;
    }
    if (v === null)
        return false;
    if (Array.isArray(v))
        return v.length > 0;
    if (typeof v === 'object')
        return Object.keys(v).length > 0 && !('error' in v);
    return true;
}
describe('bro-sqlite-readonly: every read subcommand on a freshly migrated DB (GH 1678)', () => {
    let tmp;
    let db;
    let issueId;
    let taskId;
    let idleId;
    let before_;
    const runRo = (dbPath, ...args) => runNode(['--experimental-sqlite', CLI_JS, 'bro-sqlite-readonly', ...args], {
        cwd: tmp,
        env: childEnv({ HOME: join(tmp, 'home'), TRAJECTORY_DB_PATH: dbPath }),
    });
    before(() => {
        tmp = sandboxDir('bro-sqlite-readonly');
        db = join(tmp, 'project/.claude/tmb/trajectory.db');
        resetEmbeddingModelForTests(() => new Promise(() => { }));
        mkdirSync(join(tmp, 'project/.claude/tmb'), { recursive: true });
        const t = new TrajectoryDB(db);
        const now = new Date().toISOString();
        t.run('INSERT INTO issues (objective, description, status, created_at, updated_at, remote_kind, gh_iid, gl_iid) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
            'fallback objective',
            'fallback description',
            'open',
            now,
            now,
            'github',
            1678,
            77,
        ]);
        issueId = t.get('SELECT MAX(id) AS id FROM issues').id;
        t.run('INSERT INTO tasks (issue_id, branch_id, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [issueId, 'fix/fallback', 'fallback task', 'pending', now, now]);
        taskId = t.get('SELECT MAX(id) AS id FROM tasks').id;
        t.run('INSERT INTO issues (objective, status, created_at, updated_at) VALUES (?, ?, ?, ?)', ['no tasks', 'open', now, now]);
        idleId = t.get('SELECT MAX(id) AS id FROM issues').id;
        t.run('INSERT OR REPLACE INTO plugin_config (key, value_json) VALUES (?, ?)', ['sentinel', JSON.stringify('fallback-value')]);
        t.close();
        resetEmbeddingModelForTests();
        before_ = dbSum(db);
    });
    after(() => rmSync(tmp, { recursive: true, force: true }));
    for (const [tool, label, args] of [
        ['issue_resume', '{"issue_id":<issue>}', () => `{"issue_id":${issueId}}`],
        ['issue_get', '{"issue_id":<issue>}', () => `{"issue_id":${issueId}}`],
        ['issue_get', '{"issue_id":<issue>,"include_description":true}', () => `{"issue_id":${issueId},"include_description":true}`],
        ['issue_get_phase', '{"issue_id":<issue>}', () => `{"issue_id":${issueId}}`],
        ['task_get', '{"task_id":<task>}', () => `{"task_id":${taskId}}`],
        ['task_first_actionable', '{"issue_id":<issue>}', () => `{"issue_id":${issueId}}`],
        ['config_get', '{"key":"sentinel"}', () => '{"key":"sentinel"}'],
        ['config_list', '{}', () => '{}'],
    ]) {
        it(`${tool} ${label} on a freshly migrated DB exits 0 with non-empty JSON`, () => {
            const r = runRo(db, tool, args());
            assert.equal(r.code, 0, `${tool} exit (stderr: ${r.stderr})`);
            assert.ok(jsonOk(r.stdout), `${tool} output is not non-empty JSON: <${r.stdout}>`);
        });
    }
    it('issue reads carry gh_iid and gl_iid', () => {
        let out = runRo(db, 'issue_get', `{"issue_id":${issueId}}`).stdout;
        assert.ok(out.includes('"gh_iid": 1678'), 'issue_get gh_iid');
        assert.ok(out.includes('"gl_iid": 77'), 'issue_get gl_iid');
        out = runRo(db, 'issue_resume', `{"issue_id":${issueId}}`).stdout;
        assert.ok(out.includes('"gh_iid": 1678'), 'issue_resume gh_iid');
        assert.ok(out.includes('"gl_iid": 77'), 'issue_resume gl_iid');
        assert.ok(out.includes('"branch_id": "fix/fallback"'), 'issue_resume next_task');
    });
    it('config_get returns the stored value', () => {
        assert.equal(runRo(db, 'config_get', '{"key":"sentinel"}').stdout.trim(), '"fallback-value"');
    });
    it('issue_resume with no actionable task returns next_task null', () => {
        assert.ok(runRo(db, 'issue_resume', `{"issue_id":${idleId}}`).stdout.includes('"next_task": null'));
    });
    it('issue_get on a missing issue reports Not found', () => {
        const r = runRo(db, 'issue_get', '{"issue_id":999999}');
        assert.equal(r.code, 1, 'issue_get exit');
        assert.ok(`${r.stdout}${r.stderr}`.includes('Not found: 999999'), 'missing issue reported');
    });
    it('reads never modify the DB', () => {
        assert.equal(dbSum(db), before_, 'DB checksum');
    });
    for (const [table, tool, args] of [
        ['tasks', 'task_get', () => `{"task_id":${taskId}}`],
        ['plugin_config', 'config_get', () => '{"key":"sentinel"}'],
    ]) {
        it(`${tool} on a DB missing ${table} fails loudly`, () => {
            const broken = join(tmp, `broken-${table}.db`);
            copyFileSync(db, broken);
            sqlExec(broken, `PRAGMA foreign_keys=OFF; DROP TABLE ${table};`);
            const r = runRo(broken, tool, args());
            assert.notEqual(r.code, 0, `${tool} exited 0 on a DB missing ${table}`);
            assert.ok(r.stderr.includes(`bro-sqlite-readonly: ${tool} failed:`), 'stderr names the subcommand');
            assert.ok(r.stderr.includes(`no such table: ${table}`), 'stderr carries the sqlite error');
            assert.equal(r.stdout, '', 'stdout');
        });
    }
});
//# sourceMappingURL=bro-sqlite-readonly.test.js.map