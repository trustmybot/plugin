import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDB } from './helpers.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { SCHEMA_V28_SQL } from './fixtures/schema-v28.js';
import { DATA_CONTRACTS, DATA_CONTRACTS_SCHEMA_VERSION, NULLABLE_COLUMNS, dataContractsJson, isSqlContract } from '../data-contracts.js';
import { AUDIT_EVENT_TYPES } from '../audit-events.js';
import { checkTrajectoryDbFile, runDataContracts, trajectoryDbReader, trajectoryDoctorTools } from '../tools/trajectory-doctor.js';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();
const DB_CONTRACTS = DATA_CONTRACTS.filter(isSqlContract);
function contract(id) {
    const c = DB_CONTRACTS.find((k) => k.id === id);
    assert.ok(c, `contract ${id} exists`);
    return c;
}
function violated(db, id) {
    const report = runDataContracts(trajectoryDbReader(db), [contract(id)], { env: {} });
    assert.deepEqual(report.skipped, [], `${id} ran without error`);
    return report.violations.some((v) => v.id === id);
}
function seedIssue(db, status = 'open') {
    db.run(`INSERT INTO issues (objective, status, created_at, updated_at) VALUES ('doctor', ?, ?, ?)`, [status, iso(), iso()]);
    return db.get('SELECT MAX(id) AS id FROM issues').id;
}
function seedTask(db, issueId, status, updatedAt = iso()) {
    db.run(`INSERT INTO tasks (issue_id, branch_id, description, status, created_at, updated_at)
     VALUES (?, ?, 'd', ?, ?, ?)`, [issueId, `feat/t-${Math.random().toString(36).slice(2)}`, status, iso(), updatedAt]);
    return db.get('SELECT MAX(id) AS id FROM tasks').id;
}
function seedAudit(db, eventType, content = {}, createdAt = iso(), fromNode = 'bro') {
    db.run(`INSERT INTO audit (issue_id, from_node, event_type, summary, content_json, created_at) VALUES (-1, ?, ?, 's', ?, ?)`, [fromNode, eventType, JSON.stringify(content), createdAt]);
}
function seedVerifiedClose(db, sha, updatedAt = iso(), verification = '["npm test"]') {
    const id = seedTask(db, seedIssue(db), 'closed', updatedAt);
    db.run('UPDATE tasks SET commit_sha = ?, verification = ? WHERE id = ?', [sha, verification, id]);
    return id;
}
function seedVerificationRun(db, taskId, sha) {
    db.run(`INSERT INTO verification_runs (task_id, commit_sha, source, started_at, finished_at, exit_code, budget_s)
     VALUES (?, ?, 'gate', ?, ?, 0, 900)`, [taskId, sha, iso(-HOUR), iso()]);
}
function seedRun(db, o = {}) {
    const completedAt = o.completedAt === undefined ? iso() : o.completedAt;
    const tokens = o.tokens === undefined ? 100 : o.tokens;
    db.run(`INSERT INTO agent_runs (task_id, agent_type, tokens_in, tokens_out, cache_read_tokens, cache_creation_tokens,
       started_at, completed_at, session_id, usage_source, model, host, root_dir, exit_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        o.taskId ?? null,
        o.agentType ?? 'swe',
        tokens,
        tokens,
        tokens,
        tokens,
        iso(-HOUR),
        completedAt,
        o.sessionId === undefined ? 'sess' : o.sessionId,
        o.usageSource === undefined ? (completedAt ? 'subagent_stop' : null) : o.usageSource,
        o.model === undefined ? 'claude-opus' : o.model,
        o.host === undefined ? 'claude' : o.host,
        o.rootDir === undefined ? '/w' : o.rootDir,
        o.exitReason === undefined ? (completedAt ? 'completed' : null) : o.exitReason,
    ]);
}
// One violating and one passing fixture per contract id.
// populated_tasks_prompt_bearing has no violating row: the column is NOT NULL,
// so its violation is shown through a reader that reports a drifted DB.
const FIXTURES = {
    fk_check_empty: {
        violate: (db) => {
            db.run('PRAGMA foreign_keys = OFF');
            db.run(`INSERT INTO tasks (issue_id, branch_id, description, created_at, updated_at) VALUES (9999, 'b', 'd', ?, ?)`, [iso(), iso()]);
            db.run('PRAGMA foreign_keys = ON');
        },
        pass: (db) => {
            seedTask(db, seedIssue(db), 'pending');
        },
    },
    event_type_documented: {
        violate: (db) => seedAudit(db, 'made_up_event'),
        pass: (db) => seedAudit(db, 'planning_complete'),
    },
    swe_runs_metered: {
        violate: (db) => seedRun(db, { tokens: 0, usageSource: 'subagent_stop' }),
        pass: (db) => {
            seedRun(db, { tokens: 0, usageSource: 'unmeasured' });
            seedRun(db, { tokens: 0, usageSource: 'subagent_stop', completedAt: iso(-8 * DAY) });
            seedRun(db, { agentType: 'bro', tokens: 0, usageSource: 'transcript' });
            seedRun(db, { tokens: 5 });
        },
    },
    closed_tasks_reviewed: {
        violate: (db) => {
            seedTask(db, seedIssue(db), 'closed', iso(-25 * HOUR));
        },
        pass: (db) => {
            const issue = seedIssue(db);
            seedTask(db, issue, 'closed', iso(-HOUR));
            const reviewed = seedTask(db, issue, 'closed', iso(-25 * HOUR));
            db.run(`INSERT INTO validation_attempts (task_id, attempt_n, verdict, mcp_available, created_at) VALUES (?, 1, 'pass', 1, ?)`, [reviewed, iso()]);
            const bypassed = seedTask(db, issue, 'closed', iso(-25 * HOUR));
            seedAudit(db, 'review_gate_bypassed', { task_id: bypassed, commit_sha: 'abc1234' });
            const waived = seedTask(db, issue, 'closed', iso(-25 * HOUR));
            seedAudit(db, 'review_gate_waived', { task_id: waived });
            const mergeBypassed = seedTask(db, issue, 'closed', iso(-25 * HOUR));
            seedAudit(db, 'review_gate_bypassed', { task_id: mergeBypassed }, iso(), 'hook:close-issue-on-merge');
            seedTask(db, issue, 'closed', iso(-31 * DAY));
        },
    },
    no_stale_running: {
        violate: (db) => {
            seedTask(db, seedIssue(db), 'running', iso(-7 * HOUR));
        },
        pass: (db) => {
            const issue = seedIssue(db);
            seedTask(db, issue, 'running', iso(-HOUR));
            const live = seedTask(db, issue, 'running', iso(-7 * HOUR));
            seedRun(db, { taskId: live, completedAt: null });
        },
    },
    scan_fresh: {
        violate: (db) => {
            db.run(`INSERT INTO repos (name, path, last_scanned_at) VALUES ('r', '/r', ?)`, [iso(-8 * DAY)]);
        },
        pass: (db) => {
            db.run(`INSERT INTO repos (name, path, last_scanned_at) VALUES ('r', '/r', ?)`, [iso(-8 * DAY)]);
            db.run(`INSERT INTO repos (name, path, last_scanned_at) VALUES ('s', '/s', ?)`, [iso(-DAY)]);
        },
    },
    waiver_not_duplicated: {
        violate: (db) => {
            seedAudit(db, 'verification_gate_waived', { task_id: 7, waiver_reason: 'flaky network test' });
            seedAudit(db, 'verification_gate_waived', { task_id: 7, waiver_reason: 'flaky network test' });
        },
        pass: (db) => {
            seedAudit(db, 'verification_gate_waived', { task_id: 7, commit_sha: 'aaa1111' });
            seedAudit(db, 'verification_gate_waived', { task_id: 7, commit_sha: 'bbb2222' });
            seedAudit(db, 'verification_gate_waived', { task_id: 8 });
        },
    },
    verification_recorded_for_closed_tasks: {
        violate: (db) => {
            seedVerifiedClose(db, 'abc1234');
        },
        pass: (db) => {
            const recorded = seedVerifiedClose(db, 'abc1234');
            seedVerificationRun(db, recorded, 'abc1234' + 'f'.repeat(33));
            seedVerifiedClose(db, 'def5678', iso(-8 * DAY));
            seedVerifiedClose(db, 'aaa0000', iso(), '[]');
            const waived = seedVerifiedClose(db, 'bbb1111');
            seedAudit(db, 'verification_gate_waived', { task_id: waived, commit_sha: 'bbb1111' });
            seedTask(db, seedIssue(db), 'closed');
        },
    },
    embeddings_not_degraded: {
        violate: (db) => {
            seedAudit(db, 'embeddings_degraded', { reason: 'model load failed', consecutive_failures: 1 }, iso(-2 * HOUR));
            seedAudit(db, 'embeddings_recovered', { retries: 1 }, iso(-HOUR));
            seedAudit(db, 'embeddings_degraded', { reason: '5 consecutive embed failures', consecutive_failures: 5 });
        },
        pass: (db) => {
            seedAudit(db, 'embeddings_degraded', { reason: 'model load failed', consecutive_failures: 1 }, iso(-2 * DAY));
            seedAudit(db, 'embeddings_degraded', { reason: 'model load failed', consecutive_failures: 1 }, iso(-2 * HOUR));
            seedAudit(db, 'embeddings_recovered', { retries: 1 }, iso(-HOUR));
        },
    },
    populated_agent_runs_session_id: {
        violate: (db) => seedRun(db, { sessionId: null }),
        pass: (db) => {
            for (let i = 0; i < 9; i++)
                seedRun(db);
            seedRun(db, { sessionId: null });
        },
    },
    populated_agent_runs_usage_source: {
        violate: (db) => seedRun(db, { usageSource: null }),
        pass: (db) => {
            seedRun(db);
            seedRun(db, { completedAt: null });
        },
    },
    populated_agent_runs_model: {
        violate: (db) => seedRun(db, { model: null }),
        pass: (db) => {
            seedRun(db);
            seedRun(db, { model: null, usageSource: 'unmeasured', tokens: null });
        },
    },
    populated_agent_runs_host: {
        violate: (db) => seedRun(db, { host: null }),
        pass: (db) => seedRun(db),
    },
    populated_agent_runs_root_dir: {
        violate: (db) => seedRun(db, { rootDir: null }),
        pass: (db) => seedRun(db),
    },
    populated_agent_runs_exit_reason: {
        violate: (db) => seedRun(db, { exitReason: null }),
        pass: (db) => {
            seedRun(db);
            seedRun(db, { completedAt: null });
        },
    },
    populated_tasks_prompt_bearing: {
        pass: (db) => {
            seedTask(db, seedIssue(db), 'pending');
        },
    },
    issues_closed_no_live_tasks: {
        violate: (db) => {
            seedTask(db, seedIssue(db, 'closed'), 'completed');
        },
        pass: (db) => {
            seedTask(db, seedIssue(db, 'closed'), 'closed');
            seedTask(db, seedIssue(db, 'closed'), 'escalated');
            seedTask(db, seedIssue(db, 'open'), 'running');
        },
    },
};
describe('data contracts', () => {
    it('a fresh DB is healthy with no violations', () => {
        const db = tempDB();
        const report = runDataContracts(trajectoryDbReader(db), DB_CONTRACTS, { env: {} });
        assert.deepEqual(report.violations, []);
        assert.deepEqual(report.skipped, []);
        assert.equal(report.healthy, true);
    });
    it('every DB contract has a violating and a passing fixture', () => {
        assert.deepEqual(Object.keys(FIXTURES).sort(), DB_CONTRACTS.map((c) => c.id).sort());
    });
    for (const c of DB_CONTRACTS) {
        it(`${c.id}: violating fixture fails, passing fixture holds`, () => {
            const fx = FIXTURES[c.id];
            if (!fx.violate) {
                const db = tempDB();
                seedTask(db, seedIssue(db), 'pending');
                const nullReader = {
                    get: (sql, params) => (sql === c.sql ? { rate: 1 } : trajectoryDbReader(db).get(sql, params)),
                    all: () => [],
                };
                const report = runDataContracts(nullReader, [c], { env: {} });
                assert.equal(report.violations[0]?.id, c.id);
            }
            else {
                const bad = tempDB();
                fx.violate(bad);
                assert.equal(violated(bad, c.id), true, `${c.id} should be violated`);
            }
            const good = tempDB();
            fx.pass(good);
            assert.equal(violated(good, c.id), false, `${c.id} should hold`);
        });
    }
    it('closed_tasks_reviewed does not count a review_gate_waived row bro did not write', () => {
        const db = tempDB();
        const task = seedTask(db, seedIssue(db), 'closed', iso(-25 * HOUR));
        seedAudit(db, 'review_gate_waived', { task_id: task }, iso(), 'pr-reviewer');
        assert.equal(violated(db, 'closed_tasks_reviewed'), true);
    });
    it('closed_tasks_reviewed does not count a review_gate_bypassed row from another hook', () => {
        const db = tempDB();
        const task = seedTask(db, seedIssue(db), 'closed', iso(-25 * HOUR));
        seedAudit(db, 'review_gate_bypassed', { task_id: task }, iso(), 'hook:other-hook');
        assert.equal(violated(db, 'closed_tasks_reviewed'), true);
    });
    it('no_stale_running reads TMB_STALE_RUNNING_HOURS', () => {
        const db = tempDB();
        seedTask(db, seedIssue(db), 'running', iso(-7 * HOUR));
        const c = contract('no_stale_running');
        assert.equal(runDataContracts(trajectoryDbReader(db), [c], { env: { TMB_STALE_RUNNING_HOURS: '8' } }).violations.length, 0);
        assert.equal(runDataContracts(trajectoryDbReader(db), [c], { env: {} }).violations.length, 1);
    });
    it('compares legacy `YYYY-MM-DD HH:MM:SS` timestamps by time', () => {
        const db = tempDB();
        const legacy = (offsetMs) => iso(offsetMs).replace('T', ' ').slice(0, 19);
        seedTask(db, seedIssue(db), 'running', legacy(-HOUR));
        assert.equal(violated(db, 'no_stale_running'), false);
        seedTask(db, seedIssue(db), 'running', legacy(-7 * HOUR));
        assert.equal(violated(db, 'no_stale_running'), true);
    });
    it('closed_tasks_reviewed waits TMB_REVIEW_GRACE_HOURS (default 24) after the close for a review', () => {
        const db = tempDB();
        seedTask(db, seedIssue(db), 'closed', iso(-20 * HOUR));
        const c = contract('closed_tasks_reviewed');
        assert.equal(runDataContracts(trajectoryDbReader(db), [c], { env: {} }).violations.length, 0);
        assert.equal(runDataContracts(trajectoryDbReader(db), [c], { env: { TMB_REVIEW_GRACE_HOURS: '12' } }).violations.length, 1);
    });
    it('skips contracts that need a newer schema than the DB has, and the error ones make it unhealthy', () => {
        const db = tempDB();
        db.run('UPDATE plugin_meta SET schema_version = 29 WHERE id = 1');
        const report = runDataContracts(trajectoryDbReader(db), DB_CONTRACTS, { env: {} });
        const skipped = new Set(report.skipped.map((s) => s.id));
        assert.deepEqual(report.schema, { stored: 29, required: DATA_CONTRACTS_SCHEMA_VERSION, current: false });
        for (const c of DB_CONTRACTS)
            assert.equal(skipped.has(c.id), (c.min_schema ?? 0) > 29, c.id);
        assert.match(report.skipped[0].reason, /^schema v29 < v3\d — start the trajectory server to migrate$/);
        assert.equal(report.healthy, false, 'swe_runs_metered (error) could not run');
    });
    it('checks a v28 DB file without migrating it', () => {
        const dir = mkdtempSync(join(tmpdir(), 'tmb-doctor-'));
        try {
            const path = join(dir, 'trajectory.db');
            const seed = new DatabaseSync(path);
            seed.exec(SCHEMA_V28_SQL);
            seed.exec('PRAGMA user_version = 28');
            seed.close();
            const report = checkTrajectoryDbFile(path, DATA_CONTRACTS, { env: {} });
            assert.equal(report.schema.stored, 28);
            assert.equal(report.schema.current, false);
            assert.ok(report.skipped.some((s) => s.id === 'swe_runs_metered' && s.reason.startsWith('schema v28 <')));
            const after = new DatabaseSync(path, { readOnly: true });
            const meta = after.prepare('SELECT schema_version FROM plugin_meta').get();
            const uv = after.prepare('PRAGMA user_version').get();
            const cols = after.prepare(`SELECT name FROM pragma_table_info('agent_runs')`).all().map((r) => r.name);
            after.close();
            assert.equal(meta.schema_version, 28);
            assert.equal(uv.user_version, 28);
            assert.equal(cols.includes('usage_source'), false, 'no v30 column appeared');
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
    it('a violation carries actual, expected, severity and a sample', () => {
        const db = tempDB();
        seedTask(db, seedIssue(db, 'closed'), 'running');
        const report = runDataContracts(trajectoryDbReader(db), [contract('issues_closed_no_live_tasks')], { env: {} });
        const v = report.violations[0];
        assert.equal(v.actual, 1);
        assert.deepEqual(v.expected, { op: '=', value: 0 });
        assert.equal(v.severity, 'error');
        assert.equal(v.sample.length, 1);
        assert.equal(report.healthy, false);
    });
    it('warn-severity violations leave the report healthy', () => {
        const db = tempDB();
        seedRun(db, { host: null });
        const report = runDataContracts(trajectoryDbReader(db), DATA_CONTRACTS, { env: {} });
        assert.deepEqual(report.violations.map((v) => v.id), ['populated_agent_runs_host']);
        assert.equal(report.healthy, true);
    });
    it('an error-severity contract that errors is skipped and the report is unhealthy', () => {
        const throwing = {
            get: () => {
                throw new Error('database is locked');
            },
            all: () => [],
        };
        const report = runDataContracts(throwing, [contract('fk_check_empty')], { env: {} });
        assert.deepEqual(report.violations, []);
        assert.equal(report.skipped[0]?.id, 'fk_check_empty');
        assert.match(report.skipped[0].reason, /database is locked/);
        assert.equal(report.healthy, false);
    });
    it('an error-severity contract past the statement timeout is skipped and the report is unhealthy', () => {
        const db = tempDB();
        let t = 0;
        const report = runDataContracts(trajectoryDbReader(db), [contract('fk_check_empty'), contract('scan_fresh')], {
            env: {},
            statementTimeoutMs: 50,
            now: () => (t += 100),
        });
        assert.deepEqual(report.skipped.map((s) => s.id), ['fk_check_empty', 'scan_fresh']);
        assert.match(report.skipped[0].reason, /^timeout/);
        assert.equal(report.healthy, false);
    });
    it('a warn-severity skip alone keeps the report healthy', () => {
        const throwing = {
            get: () => {
                throw new Error('no such column');
            },
            all: () => [],
        };
        assert.equal(runDataContracts(throwing, [contract('scan_fresh')], { env: {} }).healthy, true);
    });
    it('declares the nullable v29–v33 columns with a reason and gives them no contract', () => {
        const ids = new Set(DATA_CONTRACTS.map((c) => c.id));
        assert.ok(NULLABLE_COLUMNS.some((n) => n.table === 'discussions' && n.column === 'remote_comment_id'));
        for (const n of NULLABLE_COLUMNS) {
            assert.ok(n.reason.length > 0);
            assert.equal(ids.has(`populated_${n.table}_${n.column}`), false);
        }
    });
    it('event_type_documented checks against every AUDIT_EVENT_TYPES entry', () => {
        const sql = contract('event_type_documented').sql;
        for (const e of AUDIT_EVENT_TYPES)
            assert.ok(sql.includes(`'${e.type}'`), e.type);
        assert.ok(AUDIT_EVENT_TYPES.some((e) => e.type === 'trajectory_doctor_run'));
    });
    it('scripts/hooks/lib/data-contracts.json is generated from DATA_CONTRACTS and fresh', () => {
        const here = dirname(fileURLToPath(import.meta.url));
        const committed = readFileSync(join(here, '..', '..', '..', '..', 'scripts', 'hooks', 'lib', 'data-contracts.json'), 'utf8');
        assert.equal(committed, dataContractsJson(), 'stale — run: node scripts/maintenance/emit-data-contracts.mjs');
        const ids = JSON.parse(committed).contracts.map((c) => c.id);
        assert.deepEqual(ids, DB_CONTRACTS.map((c) => c.id), 'the hook copy holds the DB contracts only');
    });
});
describe('single_tmb_plugin_enabled', () => {
    const fileContract = DATA_CONTRACTS.find((c) => c.id === 'single_tmb_plugin_enabled');
    const entry = (scope, version, projectPath) => ({
        scope,
        version,
        installPath: `/cache/${version}`,
        ...(projectPath ? { projectPath } : {}),
    });
    function fixture(plugins, settings) {
        const dir = mkdtempSync(join(tmpdir(), 'tmb-dup-'));
        const project = join(dir, 'project');
        const home = join(dir, 'home');
        mkdirSync(join(project, '.claude'), { recursive: true });
        mkdirSync(join(home, '.claude'), { recursive: true });
        writeFileSync(join(dir, 'installed_plugins.json'), JSON.stringify({ version: 2, plugins }));
        if (settings.local)
            writeFileSync(join(project, '.claude', 'settings.local.json'), JSON.stringify({ enabledPlugins: settings.local }));
        if (settings.project)
            writeFileSync(join(project, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: settings.project }));
        if (settings.user)
            writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: settings.user }));
        return { env: { CLAUDE_PROJECT_DIR: project, HOME: home, TMB_INSTALLED_JSON: join(dir, 'installed_plugins.json') }, project, dir };
    }
    function run(env) {
        return runDataContracts(trajectoryDbReader(tempDB()), [fileContract], { env });
    }
    it('is an error-severity file contract', () => {
        assert.equal(fileContract.severity, 'error');
        assert.equal(fileContract.source, 'files');
    });
    it('one enabled copy holds', () => {
        const fx = fixture({ 'tmb@trustmybot-dev': [entry('user', '1.0.2')] }, { user: { 'tmb@trustmybot-dev': true } });
        try {
            const report = run(fx.env);
            assert.deepEqual(report.violations, []);
            assert.deepEqual(report.skipped, []);
            assert.equal(report.healthy, true);
        }
        finally {
            rmSync(fx.dir, { recursive: true, force: true });
        }
    });
    it('two enabled copies for the project are an error naming both', () => {
        const fx = fixture({ 'tmb@trustmybot-dev': [entry('user', '1.0.2')], 'tmb@trustmybot-rc': [] }, { user: { 'tmb@trustmybot-dev': true }, local: { 'tmb@trustmybot-rc': true } });
        try {
            writeFileSync(fx.env['TMB_INSTALLED_JSON'], JSON.stringify({ plugins: { 'tmb@trustmybot-dev': [entry('user', '1.0.2')], 'tmb@trustmybot-rc': [entry('local', '1.0.3-rc.1', fx.project)] } }));
            const report = run(fx.env);
            assert.equal(report.healthy, false);
            const v = report.violations[0];
            assert.equal(v.id, 'single_tmb_plugin_enabled');
            assert.equal(v.actual, 2);
            assert.deepEqual(v.sample.map((s) => `${s['marketplace']}@${s['version']}`), ['trustmybot-dev@1.0.2', 'trustmybot-rc@1.0.3-rc.1']);
        }
        finally {
            rmSync(fx.dir, { recursive: true, force: true });
        }
    });
    it('a copy disabled in settings.local.json does not count', () => {
        const fx = fixture({ 'tmb@trustmybot-dev': [entry('user', '1.0.2')], 'tmb@trustmybot-rc': [entry('user', '1.0.3')] }, { user: { 'tmb@trustmybot-dev': true, 'tmb@trustmybot-rc': true }, local: { 'tmb@trustmybot-rc': false } });
        try {
            assert.deepEqual(run(fx.env).violations, []);
        }
        finally {
            rmSync(fx.dir, { recursive: true, force: true });
        }
    });
    it('a user-scope and a project-scope entry of one marketplace are one copy', () => {
        const fx = fixture({}, { project: { 'tmb@trustmybot-dev': true } });
        try {
            writeFileSync(fx.env['TMB_INSTALLED_JSON'], JSON.stringify({ plugins: { 'tmb@trustmybot-dev': [entry('user', '1.0.1'), entry('project', '1.0.2', fx.project)] } }));
            assert.deepEqual(run(fx.env).violations, []);
        }
        finally {
            rmSync(fx.dir, { recursive: true, force: true });
        }
    });
    it('a project entry for another project does not count', () => {
        const fx = fixture({ 'tmb@trustmybot-dev': [entry('user', '1.0.2')], 'tmb@trustmybot-rc': [entry('local', '1.0.3', '/elsewhere')] }, { user: { 'tmb@trustmybot-dev': true, 'tmb@trustmybot-rc': true } });
        try {
            assert.deepEqual(run(fx.env).violations, []);
        }
        finally {
            rmSync(fx.dir, { recursive: true, force: true });
        }
    });
    it('is skipped with a reason, healthy, when CLAUDE_PROJECT_DIR is unset', () => {
        const report = run({});
        assert.deepEqual(report.skipped, [{ id: 'single_tmb_plugin_enabled', reason: 'CLAUDE_PROJECT_DIR is unset' }]);
        assert.equal(report.healthy, true);
    });
    it('is skipped with a reason when installed_plugins.json is unreadable', () => {
        const dir = mkdtempSync(join(tmpdir(), 'tmb-dup-'));
        try {
            const missing = join(dir, 'missing.json');
            const report = run({ CLAUDE_PROJECT_DIR: dir, TMB_INSTALLED_JSON: missing });
            assert.deepEqual(report.skipped, [{ id: 'single_tmb_plugin_enabled', reason: `cannot read ${missing}` }]);
            assert.deepEqual(report.violations, []);
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
describe('trajectory_doctor tool', () => {
    let projectDir;
    before(() => {
        projectDir = process.env['CLAUDE_PROJECT_DIR'];
        delete process.env['CLAUDE_PROJECT_DIR'];
    });
    after(() => {
        if (projectDir !== undefined)
            process.env['CLAUDE_PROJECT_DIR'] = projectDir;
    });
    async function call(db, args) {
        return (await trajectoryDoctorTools(db).handlers['trajectory_doctor'](args));
    }
    const auditCount = (db) => db.get('SELECT COUNT(*) AS n FROM audit').n;
    it('is bro-only', async () => {
        const db = tempDB();
        for (const agent of ['swe', 'pr-reviewer', 'architect']) {
            const res = await call(db, { agent });
            assert.equal(res.isError, true);
            assert.equal(JSON.parse(res.content[0].text).error, 'forbidden');
        }
    });
    it('record:false (the default) writes nothing', async () => {
        const db = tempDB();
        seedTask(db, seedIssue(db, 'closed'), 'pending');
        const before = auditCount(db);
        const body = JSON.parse((await call(db, { agent: 'bro' })).content[0].text);
        assert.equal(body.healthy, false);
        assert.equal(typeof body.checked_at, 'string');
        assert.deepEqual(body.violations.map((v) => v.id), ['issues_closed_no_live_tasks']);
        assert.equal(auditCount(db), before);
        await call(db, { agent: 'bro', record: false });
        assert.equal(auditCount(db), before);
    });
    it('record:true writes exactly one trajectory_doctor_run audit row on the system issue', async () => {
        const db = tempDB();
        const before = auditCount(db);
        const body = JSON.parse((await call(db, { agent: 'bro', record: true })).content[0].text);
        assert.equal(auditCount(db), before + 1);
        const row = db.get(`SELECT id, issue_id, event_type, content_json FROM audit ORDER BY id DESC LIMIT 1`);
        assert.equal(row.id, body.audit_id);
        assert.equal(row.issue_id, -1);
        assert.equal(row.event_type, 'trajectory_doctor_run');
        assert.equal(JSON.parse(row.content_json).healthy, true);
        const again = JSON.parse((await call(db, { agent: 'bro' })).content[0].text);
        assert.deepEqual(again.violations, [], 'a recorded run is itself a documented event');
    });
    it('carries the live embedding model status', async () => {
        const db = tempDB();
        const body = JSON.parse((await call(db, { agent: 'bro' })).content[0].text);
        assert.ok(['ready', 'degraded', 'loading', 'disabled'].includes(body.embeddings.state));
        assert.equal(typeof body.embeddings.consecutive_failures, 'number');
    });
    it('ids runs only the named subset', async () => {
        const db = tempDB();
        seedTask(db, seedIssue(db, 'closed'), 'pending');
        seedAudit(db, 'made_up_event');
        const body = JSON.parse((await call(db, { agent: 'bro', ids: ['event_type_documented'] })).content[0].text);
        assert.deepEqual(body.violations.map((v) => v.id), ['event_type_documented']);
    });
    it('rejects unknown ids', async () => {
        const db = tempDB();
        const res = await call(db, { agent: 'bro', ids: ['nope'] });
        assert.equal(res.isError, true);
        assert.match(JSON.parse(res.content[0].text).error, /unknown contract id\(s\): nope/);
    });
});
//# sourceMappingURL=trajectory-doctor.test.js.map