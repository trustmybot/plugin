import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditTools } from '../tools/audit.js';
import { bugReportTools, defaultArea, versionChannel } from '../tools/bug-report.js';
import { REDACT_RULES } from '../bug-report/redact.js';
import { tempDB } from './helpers.js';
const HOME = '/Users/alice';
const PROJECT = '/Users/alice/code/acme-api';
const pluginRoot = mkdtempSync(join(tmpdir(), 'bug-report-draft-plugin-'));
mkdirSync(join(pluginRoot, '.claude-plugin'));
writeFileSync(join(pluginRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'tmb', version: '1.2.0-dev.7' }));
after(() => rmSync(pluginRoot, { recursive: true, force: true }));
const ENV = { CLAUDE_PLUGIN_ROOT: pluginRoot, CLAUDE_PROJECT_DIR: PROJECT, SHELL: '/bin/zsh' };
function parse(result) {
    const r = result;
    return JSON.parse(r.content[0].text);
}
function isError(result) {
    return result.isError === true;
}
function setConsent(db, value) {
    db.run(`INSERT INTO plugin_config (key, value_json) VALUES ('bug_report_consent', ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`, [JSON.stringify(value)]);
}
function seedProject(db) {
    const now = new Date().toISOString();
    db.run(`INSERT INTO repos (name, path, branching_model, target_branch) VALUES ('acme-api', '.', 'gitflow', 'dev')`);
    db.run(`INSERT INTO repo_remotes (repo, name, provider, url, is_primary, sync)
     VALUES ('acme-api', 'origin', 'github', 'https://github.com/acme-corp/acme-api.git', 1, 1)`);
    db.run(`INSERT INTO issues (objective, created_at, updated_at, repo) VALUES ('Acme billing outage on checkout', ?, ?, 'acme-api')`, [now, now]);
    const issueId = db.get(`SELECT MAX(id) AS id FROM issues`).id;
    db.run(`INSERT INTO tasks (issue_id, branch_id, title, description, repo, created_at, updated_at)
     VALUES (?, 'feat/acme-login', 'Wire the acme login form', 'x', 'acme-api', ?, ?)`, [issueId, now, now]);
    return issueId;
}
const BASE_ARGS = {
    agent: 'bro',
    tool: 'task_update_status',
    error: 'SqliteError: database is locked at /Users/alice/code/acme-api/.claude/tmb/trajectory.db',
    error_class: 'internal',
    summary: 'task_update_status fails on feat/acme-login',
    what_happened: 'Expected the close to land while working on "Acme billing outage on checkout".',
    reproduce: '1. Close a task.',
    frequency: 'Every time',
    impact: 'Blocks one task, has a workaround',
};
function tools(db) {
    return bugReportTools(db, { env: ENV, home: HOME }).handlers;
}
describe('bug_report_draft (GH 2034)', () => {
    it('GH 2034 V3: refuses without consent, drafts under yes and under no + user_asked', async () => {
        const db = tempDB();
        try {
            const h = tools(db);
            for (const setup of [() => undefined, () => setConsent(db, 'no')]) {
                setup();
                for (const extra of [{}, { user_asked: false }, { user_asked: 'true' }]) {
                    const res = await h.bug_report_draft({ ...BASE_ARGS, ...extra });
                    assert.equal(isError(res), true, `expected refusal for ${JSON.stringify(extra)}`);
                    const body = parse(res);
                    assert.equal(body.reason, 'bug_report_consent_required');
                    assert.match(String(body.error), /\/onboard/);
                    assert.ok(String(body.error).includes("onboard_apply(bug_report_consent='yes')"));
                }
            }
            const asked = await h.bug_report_draft({ ...BASE_ARGS, user_asked: true });
            assert.equal(isError(asked), false, JSON.stringify(parse(asked)));
            assert.equal(parse(asked).consent, 'user_asked');
            setConsent(db, 'maybe');
            assert.equal(isError(await h.bug_report_draft(BASE_ARGS)), true);
            setConsent(db, 'yes');
            const yes = await h.bug_report_draft(BASE_ARGS);
            assert.equal(isError(yes), false, JSON.stringify(parse(yes)));
            assert.equal(parse(yes).consent, 'yes');
        }
        finally {
            db.close();
        }
    });
    it('GH 2034 V4: the draft carries every result key, each environment line and DB-sourced redactions', async () => {
        const db = tempDB();
        try {
            seedProject(db);
            setConsent(db, 'yes');
            db.run(`INSERT INTO plugin_config (key, value_json) VALUES ('sandbox_enforcement', '"yes"') ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`);
            const res = await tools(db).bug_report_draft({
                ...BASE_ARGS,
                args: { task_id: '12', branch: 'feat/acme-login', remote: 'https://github.com/acme-corp/acme-api.git' },
                doctor_violations: [{ name: 'tasks_without_review', count: 2 }],
                claude_code_version: '2.3.1',
                client: 'cli',
                session: 'worktree',
            });
            assert.equal(isError(res), false, JSON.stringify(parse(res)));
            const data = parse(res);
            assert.deepEqual(Object.keys(data).sort(), [
                'already_filed', 'body', 'consent', 'marker', 'prefill_truncated', 'prefill_url', 'redactions', 'signature', 'title',
            ]);
            assert.equal(data.already_filed, null);
            assert.equal(data.prefill_truncated, false);
            assert.match(String(data.signature), /^[0-9a-f]{12}$/);
            assert.equal(data.marker, `<!-- tmb-report v1 sig=${data.signature} -->`);
            const body = String(data.body);
            for (const line of [
                'tmb: 1.2.0-dev.7',
                'channel: dev',
                'claude-code: 2.3.1 (cli)',
                'os: ',
                'shell: zsh',
                `node: ${process.version}`,
                'project-shape: remote',
                'branching: gitflow',
                'issue-sync: off',
                'session: worktree',
                'sandbox: yes',
                'reported-by: bro',
                `signature: ${data.signature}`,
            ]) {
                assert.ok(body.includes(`\n${line}`), `environment lacks ${JSON.stringify(line)}`);
            }
            assert.ok(body.includes('tasks_without_review: 2'));
            assert.ok(body.includes('### Area\n\nTrajectory Server'));
            assert.ok(body.includes('"task_id": "12"'));
            for (const out of [body, String(data.title), decodeURIComponent(String(data.prefill_url))]) {
                for (const secret of ['/Users/alice', 'acme-corp/acme-api', 'feat/acme-login', 'Acme billing outage on checkout']) {
                    assert.ok(!out.includes(secret), `${secret} leaked`);
                }
            }
            const counts = data.redactions;
            assert.deepEqual(Object.keys(counts).sort(), [...REDACT_RULES].sort());
            assert.ok(counts.project >= 1 && counts.remote >= 1 && counts.branch >= 1 && counts.title >= 1, JSON.stringify(counts));
        }
        finally {
            db.close();
        }
    });
    it('GH 2034 V7: a bug_report_filed audit row comes back as already_filed for the same error', async () => {
        const db = tempDB();
        try {
            const issueId = seedProject(db);
            setConsent(db, 'yes');
            const h = tools(db);
            const first = parse(await h.bug_report_draft(BASE_ARGS));
            assert.equal(first.already_filed, null);
            const audit = auditTools(db).handlers;
            const url = 'https://github.com/trustmybot/plugin/issues/9999';
            const appended = await audit.audit_append({
                agent: 'bro',
                issue_id: String(issueId),
                event_type: 'bug_report_filed',
                summary: 'Filed TMB bug report',
                content_json: JSON.stringify({ signature: first.signature, url, mode: 'issue' }),
            });
            assert.equal(isError(appended), false, JSON.stringify(parse(appended)));
            const swe = await audit.audit_append({
                agent: 'swe',
                issue_id: String(issueId),
                event_type: 'bug_report_filed',
                summary: 'x',
                content_json: JSON.stringify({ signature: first.signature, url: 'nope', mode: 'issue' }),
            });
            assert.equal(parse(swe).error, 'audit_event_not_writable_by_role');
            const again = parse(await h.bug_report_draft({ ...BASE_ARGS, error: BASE_ARGS.error.replace('locked', 'locked ') }));
            assert.equal(again.signature, first.signature);
            const filed = again.already_filed;
            assert.equal(filed.url, url);
            assert.equal(filed.mode, 'issue');
            assert.equal(typeof filed.created_at, 'string');
            const other = parse(await h.bug_report_draft({ ...BASE_ARGS, error: 'TypeError: something else' }));
            assert.equal(other.already_filed, null);
        }
        finally {
            db.close();
        }
    });
    it('defaults area from the tool name and rejects bad dropdown and enum values with the allowed list', async () => {
        assert.equal(defaultArea('world_model_get'), 'World Model');
        assert.equal(defaultArea('scan_run'), 'World Model');
        assert.equal(defaultArea('cheatcode_install'), 'Cheatcode');
        assert.equal(defaultArea('hook:git-guards'), 'Hooks');
        assert.equal(defaultArea('swe-scope-fence'), 'Hooks');
        assert.equal(defaultArea('task_update_status'), 'Trajectory Server');
        assert.equal(versionChannel('1.2.0-dev.155.gh1952'), 'dev');
        assert.equal(versionChannel('1.1.0-rc.1'), 'rc');
        assert.equal(versionChannel('1.2.0'), 'stable');
        assert.equal(versionChannel(null), 'unknown');
        const db = tempDB();
        try {
            setConsent(db, 'yes');
            const h = tools(db);
            const hooks = parse(await h.bug_report_draft({ ...BASE_ARGS, tool: 'hook:git-guards' }));
            assert.ok(String(hooks.body).includes('### Area\n\nHooks'));
            for (const [name, value, allowed] of [
                ['frequency', 'Daily', 'Every time, Sometimes, Once'],
                ['impact', 'Huge', 'Blocks all TMB work'],
                ['area', 'Nope', 'Hooks, Trajectory Server, World Model'],
                ['error_class', 'boom', 'constraint, internal, server_died'],
                ['client', 'web', 'cli, desktop, ide'],
                ['session', 'cloud', 'worktree, main checkout'],
            ]) {
                const res = await h.bug_report_draft({ ...BASE_ARGS, [name]: value });
                assert.equal(isError(res), true, `${name}=${value} must be rejected`);
                assert.ok(String(parse(res).error).includes(`${name} must be one of: ${allowed}`), String(parse(res).error));
            }
            const missing = await h.bug_report_draft({ ...BASE_ARGS, summary: '' });
            assert.match(String(parse(missing).error), /Missing required arg: summary/);
            const unknown = parse(await h.bug_report_draft(BASE_ARGS));
            assert.ok(String(unknown.body).includes('\nclaude-code: unknown\n'));
            assert.ok(String(unknown.body).includes('\nsession: unknown\n'));
        }
        finally {
            db.close();
        }
    });
    it('is bro-only', async () => {
        const db = tempDB();
        try {
            setConsent(db, 'yes');
            const h = tools(db);
            for (const agent of ['swe', 'code-reviewer', 'pm']) {
                const res = await h.bug_report_draft({ ...BASE_ARGS, agent });
                assert.equal(parse(res).error, 'forbidden');
            }
        }
        finally {
            db.close();
        }
    });
});
//# sourceMappingURL=bug-report-draft.test.js.map