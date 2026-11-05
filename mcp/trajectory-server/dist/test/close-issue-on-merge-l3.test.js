/**
 * The close-issue-on-merge l3 bash suite in node:test (GH 1692): the gate runs
 * as `node dist/hooks.js close-issue-on-merge` from the sandbox, CLAUDE_PROJECT_DIR
 * pinned to it and PWD set, against a schema.sql DB, with a node `gh` stub on
 * PATH that logs every call (no network). After a successful merge the merged
 * tasks close, explicit closing refs close their issues locally unless another
 * task is live, and the remote twin closes only while issue sync is on.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import { makeSandbox, PLUGIN_ROOT, runGate } from './hook-sandbox.js';
import { gateEnv, has } from './git-push-guard-l3.js';
const SCHEMA = readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema.sql'), 'utf8');
const NOW_MINUS_2H = '2026-01-01T10:00:00.000Z';
const NOW_MINUS_1H = '2026-01-01T11:00:00.000Z';
const MERGE = 'gh pr merge feat/x --squash';
const REF_122 = { CLOSING_REFS: '122', PR_BODY: 'Closes GH #122', HEAD_REF: 'feat/x' };
/**
 * `gh` on PATH: logs each call to GH_LOG_SHARED; `pr view` prints the PR's
 * closing refs (CLOSING_REFS, a comma list), body (PR_BODY) and head branch
 * (HEAD_REF); `issue view <n>` prints $TMPDIR_SHARED/remote-<n>.state, else
 * OPEN; `issue close <n>` marks it CLOSED.
 */
const GH_STUB = `#!${process.execPath}
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
const env = process.env;
appendFileSync(env.GH_LOG_SHARED, args.join(' ') + '\\n');
const state = (n) => env.TMPDIR_SHARED + '/remote-' + n + '.state';
switch (args[0] + ' ' + args[1]) {
  case 'pr view': {
    const refs = (env.CLOSING_REFS || '').split(',').filter((r) => r !== '').map((r) => '{"number":' + r + '}');
    process.stdout.write('{"closingIssuesReferences":[' + refs.join(',') + '],"body":' + JSON.stringify(env.PR_BODY || '') + ',"headRefName":' + JSON.stringify(env.HEAD_REF || '') + '}');
    break;
  }
  case 'issue view':
    process.stdout.write(existsSync(state(args[2])) ? readFileSync(state(args[2]), 'utf8') : 'OPEN\\n');
    break;
  case 'issue close':
    writeFileSync(state(args[2]), 'CLOSED\\n');
    break;
}
`;
describe('close-issue-on-merge l3', () => {
    let sb;
    let db;
    let ghLog;
    let stubDir;
    /** The DB as the sqlite3 CLI opens it: foreign keys off (audit rows carry issue_id 0). */
    const open = () => new DatabaseSync(db, { enableForeignKeyConstraints: false });
    function sql(statement, ...params) {
        const d = open();
        try {
            d.prepare(statement).run(...params);
        }
        finally {
            d.close();
        }
    }
    function seedDb(sync = 'auto') {
        for (const f of [db, `${db}-wal`, `${db}-shm`])
            rmSync(f, { force: true });
        const d = open();
        try {
            d.exec(SCHEMA);
            d.prepare("UPDATE plugin_config SET value_json = ? WHERE key = 'issue_sync'").run(JSON.stringify(sync));
        }
        finally {
            d.close();
        }
    }
    function q(statement, ...params) {
        const d = open();
        try {
            return d.prepare(statement).all(...params)
                .map((row) => Object.values(row).map((v) => (v === null ? '' : String(v))).join('|'))
                .join('\n');
        }
        finally {
            d.close();
        }
    }
    const addIssue = (id, ghIid, status = 'open') => sql("INSERT INTO issues (id, objective, status, created_at, updated_at, gh_iid) VALUES (?, 'o', ?, ?, ?, ?)", id, status, NOW_MINUS_2H, NOW_MINUS_2H, ghIid);
    const addTask = (id, issue, branch, status, commit = 'abc1234') => sql(`INSERT INTO tasks (id, issue_id, branch_id, description, status, commit_sha, created_at, updated_at, completed_at)
         VALUES (?, ?, ?, 'd', ?, ?, ?, ?, ?)`, id, issue, branch, status, commit, NOW_MINUS_2H, NOW_MINUS_2H, NOW_MINUS_2H);
    const addRun = (task) => sql("INSERT INTO agent_runs (task_id, agent_type, started_at) VALUES (?, 'swe', ?)", task, NOW_MINUS_2H);
    const addVerification = (task, commit, at) => sql("INSERT INTO audit (issue_id, from_node, event_type, summary, content_json, created_at) VALUES (0, 'bro', 'bro_verification_pass', 'ok', ?, ?)", JSON.stringify({ task_id: task, commit_sha: commit }), at);
    const addVerdict = (task, at) => sql(`INSERT INTO validation_attempts (task_id, attempt_n, agent, verdict, mcp_available, created_at)
         VALUES (?, (SELECT COUNT(*) + 1 FROM validation_attempts WHERE task_id = ?), 'code-reviewer', 'pass', 1, ?)`, task, task, at);
    /** bro verifies the commit, then code-reviewer passes it. */
    function addPass(task, commit = 'abc1234') {
        addVerification(task, commit, NOW_MINUS_2H);
        addVerdict(task, NOW_MINUS_1H);
    }
    const addSkip = (eventType, fromNode, task, commit = 'abc1234') => sql("INSERT INTO audit (issue_id, from_node, event_type, summary, content_json, created_at) VALUES (5, ?, ?, 'skip', ?, ?)", fromNode, eventType, JSON.stringify({ task_id: task, commit_sha: commit }), NOW_MINUS_1H);
    /** A PostToolUse(Bash) payload. */
    const input = (command, response = '✓ Merged pull request') => ({ tool_name: 'Bash', tool_input: { command }, tool_response: response, cwd: '/tmp' });
    function runHook(payload, extra = {}) {
        const env = gateEnv(sb, sb.dir);
        const r = runGate('close-issue-on-merge', {
            cwd: sb.dir,
            input: JSON.stringify(payload),
            env: { ...env, PATH: `${stubDir}${delimiter}${env.PATH}`, TRAJECTORY_DB_PATH: db, TMPDIR_SHARED: sb.dir, GH_LOG_SHARED: ghLog, ...extra },
        });
        return { out: r.stdout + r.stderr, status: r.status };
    }
    const resetLog = () => writeFileSync(ghLog, '');
    const log = () => readFileSync(ghLog, 'utf8').replace(/\n+$/, '');
    const issueStatus = (id) => q('SELECT status FROM issues WHERE id = ?', id);
    const taskStatus = (id) => q('SELECT status FROM tasks WHERE id = ?', id);
    const auditCount = (event, issue) => issue === undefined
        ? q('SELECT COUNT(*) FROM audit WHERE event_type = ?', event)
        : q('SELECT COUNT(*) FROM audit WHERE event_type = ? AND issue_id = ?', event, issue);
    const ghIssueCalls = () => String(readFileSync(ghLog, 'utf8').split('\n').filter((l) => l.startsWith('issue ')).length);
    before(() => {
        sb = makeSandbox('close-issue-on-merge');
        const pluginTop = spawnSync('git', ['-C', PLUGIN_ROOT, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).stdout.trim();
        const top = spawnSync('git', ['-C', sb.dir, 'rev-parse', '--show-toplevel'], { env: sb.env, encoding: 'utf8' }).stdout.trim();
        assert.ok(top === '' || top !== pluginTop, `test cwd is the plugin repo root (${top}) — sandbox isolation breach`);
        db = join(sb.dir, '.claude/tmb/trajectory.db');
        ghLog = join(sb.dir, 'gh.log');
        stubDir = join(sb.dir, 'bin');
        mkdirSync(dirname(db), { recursive: true });
        mkdirSync(stubDir);
        writeFileSync(join(stubDir, 'gh'), GH_STUB, { mode: 0o755 });
    });
    after(() => sb.remove());
    it('(a) explicit closing-ref → local closed + remote gh close attempted', () => {
        seedDb();
        addIssue(5, 122);
        resetLog();
        runHook(input(MERGE), REF_122);
        assert.equal(issueStatus(5), 'closed', 'local issue 5 closed');
        assert.equal(auditCount('issue_auto_closed_on_merge', 5), '1', 'audit row emitted');
        has(log(), 'issue close 122', 'remote gh issue close attempted');
    });
    it("(a') closing-ref via body parse only (no closingIssuesReferences)", () => {
        seedDb();
        addIssue(7, 200);
        resetLog();
        runHook(input('glab mr merge feat/y'), { CLOSING_REFS: '', PR_BODY: 'Fixes #200', HEAD_REF: 'feat/y' });
        assert.equal(issueStatus(7), 'closed', 'body-parsed ref closes local issue 7');
        has(log(), 'issue close 200', 'remote close attempted for body ref');
    });
    it("(a'') local-id closing-ref (no gh_iid match) maps directly to issues.id", () => {
        seedDb();
        addIssue(9, 999);
        resetLog();
        runHook(input('gh pr merge feat/z --squash'), { CLOSING_REFS: '9', PR_BODY: 'Closes #9', HEAD_REF: 'feat/z' });
        assert.equal(issueStatus(9), 'closed', 'direct local-id 9 closed');
    });
    it('(b) no closing-ref → issue untouched, no remote close', () => {
        seedDb();
        addIssue(5, 122);
        resetLog();
        runHook(input(MERGE), { CLOSING_REFS: '', PR_BODY: 'merge with no closing keyword', HEAD_REF: 'feat/x' });
        assert.equal(issueStatus(5), 'open', 'issue stays open with no closing-ref');
        assert.equal(ghIssueCalls(), '0', 'no remote issue call');
    });
    it('(c) already-closed → idempotent no-op (no second audit row)', () => {
        seedDb();
        addIssue(5, 122, 'closed');
        resetLog();
        runHook(input(MERGE), REF_122);
        assert.equal(issueStatus(5), 'closed', 'stays closed');
        assert.equal(auditCount('issue_auto_closed_on_merge', 5), '0', 'no audit row for already-closed issue');
        assert.equal(ghIssueCalls(), '0', 'no remote call for already-closed issue');
    });
    it('(d) non-merge command → no-op (silent)', () => {
        seedDb();
        addIssue(5, 122);
        resetLog();
        const { out } = runHook(input('git status'), REF_122);
        assert.equal(issueStatus(5), 'open', 'non-merge command closes nothing');
        assert.equal(out, '', 'non-merge command is silent');
        assert.equal(log(), '', 'non-merge command spawns no gh');
    });
    it('(e) no DB present → fail-open, exit 0', () => {
        rmSync(db, { force: true });
        assert.equal(runHook(input(MERGE), REF_122).status, 0, 'fail-open exits 0 with no DB');
    });
    it('(f) failed-merge response → no-op', () => {
        seedDb();
        addIssue(5, 122);
        runHook(input(MERGE, 'GraphQL: Pull request is not mergeable'), REF_122);
        assert.equal(issueStatus(5), 'open', 'failed merge closes nothing');
    });
    it('(g) TMB_DISABLE_CLOSE_ISSUE_ON_MERGE=1 bypass → no-op', () => {
        seedDb();
        addIssue(5, 122);
        runHook(input(MERGE), { ...REF_122, TMB_DISABLE_CLOSE_ISSUE_ON_MERGE: '1' });
        assert.equal(issueStatus(5), 'open', 'bypass closes nothing');
    });
    it('(h) issue_sync off → local close, no gh issue call, remote-skipped audit', () => {
        seedDb('off');
        addIssue(5, 122);
        resetLog();
        runHook(input(MERGE), REF_122);
        assert.equal(issueStatus(5), 'closed', 'local close still happens');
        assert.equal(ghIssueCalls(), '0', 'no gh issue view/close with sync off');
        assert.equal(auditCount('issue_auto_close_remote_skipped', 5), '1', 'remote-skipped audit row');
    });
    it("(h') TMB_DISABLE_REMOTE_SYNC=1 → no gh issue call, remote-skipped audit", () => {
        seedDb();
        addIssue(5, 122);
        resetLog();
        runHook(input(MERGE), { ...REF_122, TMB_DISABLE_REMOTE_SYNC: '1' });
        assert.equal(issueStatus(5), 'closed', 'local close still happens');
        assert.equal(ghIssueCalls(), '0', 'no gh issue call with the kill-switch set');
        assert.equal(auditCount('issue_auto_close_remote_skipped', 5), '1', 'remote-skipped audit row');
    });
    it("(i) compound command 'cd x && gh pr merge 12' fires", () => {
        seedDb();
        addIssue(5, 122);
        resetLog();
        runHook(input('cd x && gh pr merge 12 --squash; git pull'), REF_122);
        assert.equal(issueStatus(5), 'closed', 'compound merge closes the issue');
        has(log(), 'pr view 12 ', "the merge statement's own ref is used");
    });
    it("(j) heredoc or quoted text containing 'gh pr merge' does not fire", () => {
        seedDb();
        addIssue(5, 122);
        resetLog();
        runHook(input('cat > notes.md <<EOF\ngh pr merge 12 --squash\nEOF'), REF_122);
        runHook(input('echo "next: gh pr merge 12"'), REF_122);
        assert.equal(issueStatus(5), 'open', 'heredoc / quoted text closes nothing');
        assert.equal(log(), '', 'no gh spawned');
    });
    it('(k) another live task on the issue → deferred, issue stays open', () => {
        seedDb();
        addIssue(5, 122);
        addTask(1, 5, 'feat/x', 'completed');
        addTask(2, 5, 'feat/other', 'running');
        addPass(1);
        resetLog();
        runHook(input(MERGE), REF_122);
        assert.equal(issueStatus(5), 'open', 'issue stays open over a live task');
        assert.equal(taskStatus(1), 'closed', 'merged task closed');
        assert.equal(taskStatus(2), 'running', 'other task untouched');
        assert.equal(auditCount('issue_auto_close_deferred', 5), '1', 'deferred audit row');
        assert.equal(q("SELECT json_extract(content_json, '$.blocking_task_ids') FROM audit WHERE event_type='issue_auto_close_deferred'"), '[2]', 'blocking task ids named');
        assert.equal(auditCount('issue_auto_closed_on_merge', 5), '0', 'no close audit');
        assert.equal(ghIssueCalls(), '0', 'no remote close for a deferred issue');
    });
    it("(l) merged task closes, its open runs close 'completed', issue closes", () => {
        seedDb();
        addIssue(5, 122);
        addTask(1, 5, 'feat/x', 'completed');
        addRun(1);
        sql("INSERT INTO agent_runs (task_id, agent_type, started_at, tokens_in, tokens_out, usage_source) VALUES (1, 'code-reviewer', ?, 30, 3, 'subagent_stop')", NOW_MINUS_2H);
        addPass(1);
        runHook(input(MERGE), REF_122);
        assert.equal(taskStatus(1), 'closed', 'merged task closed');
        assert.equal(q("SELECT exit_reason, usage_source FROM agent_runs WHERE task_id=1 AND agent_type='swe'"), 'completed|unmeasured', 'the run without usage closes completed and unmeasured (GH 1673)');
        assert.equal(q("SELECT exit_reason, usage_source, tokens_in FROM agent_runs WHERE task_id=1 AND agent_type='code-reviewer'"), 'completed|subagent_stop|30', 'a metered run keeps its source and tokens');
        assert.equal(q('SELECT COUNT(*) FROM agent_runs WHERE completed_at IS NULL'), '0', 'no open run left');
        assert.equal(issueStatus(5), 'closed', 'issue closed once its last task merged');
        assert.equal(auditCount('review_gate_bypassed'), '0', 'a passing review writes no bypass row');
    });
    it('(m) merged task without a pass → closed + one review_gate_bypassed row', () => {
        seedDb();
        addIssue(5, 122);
        addTask(1, 5, 'feat/x', 'completed');
        runHook(input(MERGE), REF_122);
        assert.equal(taskStatus(1), 'closed', 'merged task closed anyway');
        assert.equal(auditCount('review_gate_bypassed', 5), '1', 'bypass row written');
        assert.equal(q("SELECT content_json FROM audit WHERE event_type='review_gate_bypassed'"), '{"task_id":1,"commit_sha":"abc1234","closed_by":"close-issue-on-merge"}', 'bypass content');
        assert.equal(q("SELECT from_node FROM audit WHERE event_type='review_gate_bypassed'"), 'hook:close-issue-on-merge', 'written by the hook');
        runHook(input(MERGE), REF_122);
        assert.equal(auditCount('review_gate_bypassed', 5), '1', 'a re-run records no second bypass');
    });
    it('(n) a pass with no bro_verification_pass for the commit is no pass', () => {
        seedDb();
        addIssue(5, 122);
        addTask(1, 5, 'feat/x', 'completed');
        addVerdict(1, NOW_MINUS_1H);
        runHook(input(MERGE), REF_122);
        assert.equal(auditCount('review_gate_bypassed', 5), '1', 'completed_at anchors nothing');
    });
    it('(o) a pass of an older commit never covers the merged commit', () => {
        seedDb();
        addIssue(5, 122);
        addTask(1, 5, 'feat/x', 'completed', 'def5678');
        addVerification(1, 'abc1234', '2026-01-01T09:00:00.000Z');
        addVerdict(1, '2026-01-01T09:30:00.000Z');
        addVerification(1, 'def5678', NOW_MINUS_2H);
        runHook(input(MERGE), REF_122);
        assert.equal(q("SELECT content_json FROM audit WHERE event_type='review_gate_bypassed'"), '{"task_id":1,"commit_sha":"def5678","closed_by":"close-issue-on-merge"}', 'bypass names the merged commit');
    });
    it('(p) a waiver or bypass row not authored by bro does not count as a recorded skip', () => {
        for (const [event, from] of [
            ['review_gate_waived', 'code-reviewer'],
            ['review_gate_bypassed', 'code-reviewer'],
            ['review_gate_waived', 'architect'],
            ['review_gate_waived', 'hook:close-issue-on-merge'],
        ]) {
            seedDb();
            addIssue(5, 122);
            addTask(1, 5, 'feat/x', 'completed');
            addSkip(event, from, 1);
            runHook(input(MERGE), REF_122);
            assert.equal(q("SELECT COUNT(*) FROM audit WHERE event_type='review_gate_bypassed' AND from_node='hook:close-issue-on-merge'"), '1', `(${event} ${from}) the hook still records its bypass`);
        }
    });
    it('(q) a bro-authored waiver for the merged commit is the recorded skip', () => {
        seedDb();
        addIssue(5, 122);
        addTask(1, 5, 'feat/x', 'completed');
        addSkip('review_gate_waived', 'bro', 1);
        runHook(input(MERGE), REF_122);
        assert.equal(auditCount('review_gate_bypassed'), '0', 'no bypass over a bro waiver');
    });
});
//# sourceMappingURL=close-issue-on-merge-l3.test.js.map