/**
 * The swe-boundary l3 bash suite in node:test (GH 1692): rule (h), an
 * Edit/Write to a path a PreToolUse Bash gate denied a write to earlier in the
 * session is allowed with one hook_block_bypassed audit row and the record
 * removed; and the schema-mismatch fail-safe (L1, #596), where a stale legacy
 * DB up-tree never stands in for the live one.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import { pathDigest } from '../hooks/lib/target-task.js';
import { PLUGIN_ROOT, runGate, without } from './hook-sandbox.js';
import { DENY, editWithTranscript, has, hasNot, makeFixture, runSwe } from './swe-boundary-l3.js';
const QUERY_TASK = join(PLUGIN_ROOT, 'scripts/hooks/lib/query-task.sh');
const SESSION = 'sess-bypass';
function makeDb(path, ddl) {
    mkdirSync(join(path, '..'), { recursive: true });
    const d = new DatabaseSync(path);
    try {
        d.exec(ddl);
    }
    finally {
        d.close();
    }
}
/** <script> run by bash with query-task.sh sourced as $1 and <args> as $2…, its stdout trimmed. */
function queryTask(script, args, opts) {
    const r = spawnSync('bash', ['-c', `. "$1"; ${script}`, 'bash', QUERY_TASK, ...args], { cwd: opts.cwd, env: opts.env, encoding: 'utf8' });
    if (r.error)
        throw r.error;
    return r.stdout.trim();
}
describe('swe-boundary l3: bypass audit and DB resolution', () => {
    let f;
    before(() => {
        f = makeFixture('swe-boundary-bypass');
    });
    after(() => f.remove());
    describe('(h) Edit/Write after a Bash deny on the same path', () => {
        let recordDir;
        let x;
        let y;
        before(() => {
            f.sql('ALTER TABLE issues ADD COLUMN repo TEXT');
            f.sql(`CREATE TABLE audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        issue_id INTEGER NOT NULL DEFAULT -1,
        branch_id TEXT,
        from_node TEXT NOT NULL DEFAULT 'bro',
        event_type TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        content_json TEXT NOT NULL DEFAULT '{}',
        repo TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
            recordDir = join(f.sb.dir, 'locks/boundary-denies', SESSION);
            x = join(f.worktree, 'src/x.txt');
            y = join(f.worktree, 'src/y.txt');
        });
        /** A fresh record dir holding git-guards' deny of a write to <path>, <ageS> seconds old. */
        function record(path, ageS = 0) {
            rmSync(recordDir, { recursive: true, force: true });
            mkdirSync(recordDir, { recursive: true });
            writeFileSync(join(recordDir, pathDigest(path)), `git-guards\n${Math.floor(Date.now() / 1000) - ageS}\n`);
        }
        const bypassWrite = (tool, path, session = SESSION) => ({
            tool_name: tool,
            agent_type: 'swe',
            session_id: session,
            tool_input: { file_path: path },
        });
        function rows() {
            const d = new DatabaseSync(f.db);
            try {
                return d.prepare("SELECT from_node, issue_id, summary, content_json FROM audit WHERE event_type = 'hook_block_bypassed' ORDER BY id").all();
            }
            finally {
                d.close();
            }
        }
        it('(h) Write to a path after a fresh Bash-deny record: ALLOWED, one row with all fields, record removed', () => {
            record(x);
            const out = runSwe(f, bypassWrite('Write', x));
            hasNot(out, DENY, 'the write stays allowed');
            has(out, 'recorded as hook_block_bypassed', 'additionalContext names the event');
            has(out, 'report it to bro', 'additionalContext tells the swe to report');
            const r = rows();
            assert.equal(r.length, 1, 'one audit row');
            assert.equal(`${r[0].from_node}|${r[0].issue_id}|${r[0].summary}`, 'hook:swe-boundary|1|Write to src/x.txt after git-guards denied a Bash write to it', 'from_node, issue, summary');
            const c = JSON.parse(r[0].content_json);
            assert.equal([c.tool, c.path, c.denied_gate, c.session_id, c.task_id, typeof c.denied_at].join(' '), `Write ${x} git-guards ${SESSION} 10 number`, 'content carries the six fields');
            assert.equal(existsSync(join(recordDir, pathDigest(x))), false, 'the record is removed');
        });
        it('(h) a second Write to the same path: no further row', () => {
            hasNot(runSwe(f, bypassWrite('Write', x)), 'hook_block_bypassed', 'no output without a record');
            assert.equal(rows().length, 1, 'still one row');
        });
        it('(h) Write to another path: no row', () => {
            record(x);
            hasNot(runSwe(f, bypassWrite('Write', y)), 'hook_block_bypassed', 'no output');
            assert.equal(rows().length, 1, 'no new row');
        });
        it('(h) record older than the window: no row', () => {
            record(x, 700);
            hasNot(runSwe(f, bypassWrite('Edit', x)), 'hook_block_bypassed', 'no output');
            assert.equal(rows().length, 1, 'no new row');
            hasNot(runSwe(f, bypassWrite('Edit', x), { TMB_BYPASS_WINDOW_MIN: '20' }), 'hook_block_bypassed', 'the stale record was removed');
        });
        it('(h) record inside a widened window: one row', () => {
            record(x, 700);
            has(runSwe(f, bypassWrite('Edit', x), { TMB_BYPASS_WINDOW_MIN: '20' }), 'recorded as hook_block_bypassed', 'TMB_BYPASS_WINDOW_MIN widens the window');
            assert.equal(rows().length, 2, 'second row');
        });
        it("(h) another session's record: no row", () => {
            record(x);
            hasNot(runSwe(f, bypassWrite('Write', x, 'other-session')), 'hook_block_bypassed', 'no output');
            assert.equal(rows().length, 2, 'no new row');
            rmSync(recordDir, { recursive: true, force: true });
        });
    });
    describe('(L1) schema-mismatch fail-safe (#596)', () => {
        let schemaHome;
        let liveWs;
        let liveWtPrompt;
        /** The sandbox env with no DB, project or test-run pointer: only the cwd walk-up resolves the DB. */
        let walkEnv;
        before(() => {
            schemaHome = join(f.sb.dir, 'schema-home');
            makeDb(join(schemaHome, '.claude/tmb/trajectory.db'), `CREATE TABLE tasks (
          id INTEGER PRIMARY KEY,
          issue_id INTEGER NOT NULL,
          branch_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          spec_body TEXT NOT NULL DEFAULT ''
        );
        INSERT INTO tasks VALUES (10, 1, 'feat/prompt-task', 'pending', '');`);
            liveWs = join(schemaHome, 'project');
            makeDb(join(liveWs, '.claude/tmb/trajectory.db'), `CREATE TABLE tasks (
          id INTEGER PRIMARY KEY,
          issue_id INTEGER NOT NULL,
          branch_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          spec_body TEXT NOT NULL DEFAULT '',
          prompt_bearing INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO tasks VALUES (10, 1, 'feat/prompt-task', 'pending', '', 1);
        ALTER TABLE tasks ADD COLUMN repo TEXT;
        CREATE TABLE repos (name TEXT PRIMARY KEY, path TEXT);
        INSERT INTO repos VALUES ('project', '${liveWs}');`);
            liveWtPrompt = join(liveWs, '.claude/worktrees/prompt-task');
            mkdirSync(join(liveWtPrompt, 'agents'), { recursive: true });
            walkEnv = (home, cwd) => ({
                ...without(f.sb.env, 'TRAJECTORY_DB_PATH', 'CLAUDE_PROJECT_DIR', 'TMB_TEST_RUN_ID', 'TMB_FORBID_LIVE_SYNC'),
                HOME: home,
                PWD: cwd,
            });
        });
        it('(L1) stale legacy DB up-tree, live DB at workspace: prompt_bearing=1 edit ALLOWED', () => {
            const input = editWithTranscript(f, 'swe', join(liveWtPrompt, 'agents/swe.md'), 10);
            const r = runGate('swe-boundary', { cwd: liveWtPrompt, input: `${JSON.stringify(input)}\n`, env: walkEnv(schemaHome, liveWtPrompt) });
            hasNot(r.stdout + r.stderr, DENY, 'live current-schema DB should be resolved, prompt edit allowed');
        });
        const probe = (db) => queryTask('if tmb_db_schema_current "$2"; then echo current; else echo stale; fi', [db], { cwd: f.sb.dir, env: f.sb.env });
        it('(L1) schema probe: rejects legacy DB', () => {
            assert.equal(probe(join(schemaHome, '.claude/tmb/trajectory.db')), 'stale', 'legacy DB (no prompt_bearing) probed as stale');
        });
        it('(L1) schema probe: accepts current-schema DB', () => {
            assert.equal(probe(join(liveWs, '.claude/tmb/trajectory.db')), 'current', 'current-schema DB probed as current');
        });
        it('(L1) a home-level workspace pointer is never adopted by tmb_db_path', () => {
            const home = join(f.sb.dir, 'sentinel-stale-home');
            makeDb(join(home, '.claude/tmb/trajectory.db'), 'CREATE TABLE tasks (id INTEGER PRIMARY KEY, branch_id TEXT, status TEXT);');
            writeFileSync(join(home, '.claude/tmb-active-workspace'), `${home}\n`);
            assert.equal(queryTask('tmb_db_path || true', [], { cwd: home, env: walkEnv(home, home) }), '', 'home-level pointer must be treated as unresolved');
        });
    });
});
//# sourceMappingURL=swe-boundary-l3-bypass.test.js.map