/**
 * The bro-turn-usage l3 bash suite in node:test (GH 1692): the Stop gate runs
 * as `node dist/hooks.js bro-turn-usage` with CLAUDE_PROJECT_DIR pinned and PWD
 * set, against synthetic session transcripts and a schema.sql DB. The cases
 * share one DB and run in order, as the bash suite's did.
 */
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import { makeSandbox, PLUGIN_ROOT, runGate } from './hook-sandbox.js';
import { gateEnv, sql } from './git-push-guard-l3.js';
const SCHEMA = readFileSync(join(PLUGIN_ROOT, 'mcp/trajectory-server/src/schema.sql'), 'utf8');
const PLUGIN_VERSION = JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin/plugin.json'), 'utf8')).version;
const SESSION = 'sess-main';
const ROW_COLS = "COALESCE(task_id,'null'), COALESCE(issue_id,'null'), tokens_in, tokens_out, cache_read_tokens, cache_creation_tokens, tool_uses, COALESCE(model,'null'), usage_source, host, exit_reason, COALESCE(root_dir,'null')";
const T0 = Math.floor(Date.now() / 1000) * 1000 - 3_600_000;
const at = (s) => new Date(T0 + s * 1000).toISOString();
/** One assistant JSONL line whose usage is in=n, out=10n, cache_read=100n, cache_creation=1000n. */
function msg(n, s, content = '[]', model = 'claude-opus-test') {
    return `{"type":"assistant","timestamp":"${at(s)}","message":{"id":"msg_${n}","model":"${model}","usage":{"input_tokens":${n},"output_tokens":${n * 10},"cache_read_input_tokens":${n * 100},"cache_creation_input_tokens":${n * 1000}},"content":${content}}}\n`;
}
/** A tool_use block calling task_brief on task <id>. */
const touchTask = (id) => `[{"type":"tool_use","id":"tu_${id}","name":"mcp__plugin_tmb_trajectory-server__task_brief","input":{"agent":"bro","task_id":${id}}}]`;
const userLine = (s, content) => `{"type":"user","timestamp":"${at(s)}","message":{"role":"user","content":${JSON.stringify(content)}}}\n`;
function schemaDb(path) {
    mkdirSync(dirname(path), { recursive: true });
    const d = new DatabaseSync(path);
    try {
        d.exec(SCHEMA);
    }
    finally {
        d.close();
    }
    return path;
}
/** The rows of <query> on <db>, each row's columns joined by <sep> (a `sqlite3 -separator`). */
function rows(db, query, sep = '|', ...params) {
    const d = new DatabaseSync(db);
    try {
        return d.prepare(query).all(...params).map((r) => Object.values(r)
            .map((v) => (v === null ? '' : String(v)))
            .join(sep));
    }
    finally {
        d.close();
    }
}
describe('bro-turn-usage l3', () => {
    let sb;
    let db;
    let transcript;
    function run(payload, opts = {}) {
        return runGate('bro-turn-usage', {
            cwd: sb.dir,
            input: JSON.stringify(payload),
            env: { ...gateEnv(sb, sb.dir), CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, TRAJECTORY_DB_PATH: opts.db ?? db, ...opts.env },
        });
    }
    /** The gate's stdout + stderr for a Stop of <session> over <path>. */
    function runHook(path, session = SESSION, hookDb = db, env = {}) {
        const r = run({ session_id: session, transcript_path: path }, { db: hookDb, env });
        return r.stdout + r.stderr;
    }
    const sessionCount = (session = SESSION) => rows(db, "SELECT COUNT(*) FROM agent_runs WHERE agent_type='bro' AND session_id=?", '|', session)[0];
    const sessionRow = (session = SESSION) => rows(db, `SELECT ${ROW_COLS} FROM agent_runs WHERE agent_type='bro' AND session_id=?`, '|', session).join('\n');
    const file = (name, body) => {
        const p = join(sb.dir, name);
        writeFileSync(p, body);
        return p;
    };
    before(() => {
        sb = makeSandbox('bro-turn-usage');
        db = schemaDb(join(sb.dir, 'trajectory.db'));
        transcript = join(sb.dir, 'transcript.jsonl');
        sql(db, 'INSERT INTO issues (id, objective, created_at, updated_at) VALUES (1, ?, ?, ?)', 'o', at(0), at(0));
        sql(db, "INSERT INTO tasks (id, issue_id, branch_id, description, status, created_at, updated_at) VALUES (11, 1, 'fix/a', 'd', 'running', ?, ?), (12, 1, 'fix/b', 'd', 'running', ?, ?)", at(0), at(0), at(0), at(0));
        writeFileSync(transcript, userLine(0, '@bro go') +
            msg(1, 20, '[{"type":"text","text":"a"}]') +
            msg(1, 20, touchTask(11)) +
            msg(2, 30, touchTask(12)) +
            `{"type":"assistant","isSidechain":true,"timestamp":"${at(35)}","message":{"id":"msg_side","model":"claude-side","usage":{"input_tokens":999999,"output_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"content":[]}}\n` +
            msg(3, 40, touchTask(11)) +
            msg(4, 70, touchTask(12)));
    });
    after(() => sb.remove());
    it('first Stop: one session row with the main-loop sums', () => {
        assert.equal(runHook(transcript), '', 'no stderr');
        assert.equal(sessionCount(), '1', 'exactly one bro row for the session');
        assert.equal(sessionRow(), 'null|null|10|100|1000|10000|4|claude-opus-test|transcript|claude|completed|null', 'task_id/issue_id NULL; tokens_out = Σ main-loop out (split content-block lines counted once, sidechain ignored)');
        assert.equal(rows(db, "SELECT started_at, completed_at, duration_ms FROM agent_runs WHERE agent_type='bro' AND session_id=?", '|', SESSION).join('\n'), `${at(0)}|${at(70)}|70000`, 'started_at / completed_at = first / last main-loop message');
    });
    it('no per-task bro row, no zero-token closed row', () => {
        assert.equal(rows(db, "SELECT COUNT(*) FROM agent_runs WHERE agent_type='bro' AND task_id IS NOT NULL")[0], '0', 'no bro row carries a task');
        assert.equal(rows(db, "SELECT COUNT(*) FROM agent_runs WHERE agent_type='bro' AND completed_at IS NOT NULL AND tokens_out=0 AND model IS NULL")[0], '0', 'no closed bro row with 0 tokens and a NULL model');
    });
    it('second Stop: still one row, rewritten with the new totals', () => {
        appendFileSync(transcript, msg(5, 100) + msg(6, 110, touchTask(11)));
        runHook(transcript);
        assert.equal(sessionCount(), '1', 'count stays at 1');
        assert.equal(sessionRow(), 'null|null|21|210|2100|21000|5|claude-opus-test|transcript|claude|completed|null', 'absolute sums over msgs 1..6');
    });
    it('re-running the same Stop is idempotent', () => {
        runHook(transcript);
        assert.equal(sessionCount(), '1', 'count stays at 1');
        assert.equal(sessionRow(), 'null|null|21|210|2100|21000|5|claude-opus-test|transcript|claude|completed|null', 'unchanged by a re-run');
    });
    it('a parallel session writes its own row and leaves this one alone', () => {
        const other = file('other.jsonl', userLine(5, 'hi') +
            `{"type":"assistant","timestamp":"${at(20)}","message":{"id":"o1","model":"claude-other","usage":{"input_tokens":7,"output_tokens":7,"cache_read_input_tokens":7,"cache_creation_input_tokens":7},"content":[]}}\n`);
        runHook(other, 'sess-other');
        assert.equal(sessionRow('sess-other'), 'null|null|7|7|7|7|0|claude-other|transcript|claude|completed|null', 'sess-other metered from its own transcript');
        assert.equal(sessionRow(), 'null|null|21|210|2100|21000|5|claude-opus-test|transcript|claude|completed|null', 'main session untouched');
    });
    it('legacy per-task bro rows are never touched', () => {
        sql(db, "INSERT INTO agent_runs (id, task_id, issue_id, agent_type, started_at, session_id) VALUES (901, 11, 1, 'bro', ?, ?), (902, 12, 1, 'bro', ?, NULL)", at(10), SESSION, at(10));
        runHook(transcript);
        assert.deepEqual(rows(db, "SELECT id, COALESCE(session_id,'null'), COALESCE(tokens_in,'null'), COALESCE(usage_source,'null'), COALESCE(completed_at,'null'), tool_uses FROM agent_runs WHERE id IN (901, 902) ORDER BY id"), [`901|${SESSION}|null|null|null|0`, '902|null|null|null|null|0'], 'legacy rows keep their values; none is claimed');
        sql(db, 'DELETE FROM agent_runs WHERE id IN (901, 902)');
    });
    it('missing transcript_path or session_id exits silently', () => {
        run({ session_id: SESSION });
        run({ transcript_path: transcript });
        assert.equal(sessionCount(), '1', 'count unchanged');
    });
    it('TMB_DISABLE_BRO_TURN_USAGE_HOOK=1 skips all processing', () => {
        sql(db, "UPDATE agent_runs SET tokens_in = 0 WHERE agent_type='bro' AND session_id=?", SESSION);
        runHook(transcript, SESSION, db, { TMB_DISABLE_BRO_TURN_USAGE_HOOK: '1' });
        assert.equal(rows(db, "SELECT tokens_in FROM agent_runs WHERE agent_type='bro' AND session_id=?", '|', SESSION).join('\n'), '0', 'bypass env must skip the update');
    });
    it('a session with no metered message writes no row', () => {
        const empty = file('empty.jsonl', userLine(0, 'hi'));
        assert.equal(runHook(empty, 'sess-empty'), '', 'no stderr');
        assert.equal(sessionCount('sess-empty'), '0', 'no row for a session without usage');
    });
    it('a lone zero-usage <synthetic> message writes no row; a later real turn does', () => {
        const head = userLine(0, 'hi') +
            `{"type":"assistant","timestamp":"${at(10)}","message":{"id":"syn1","model":"<synthetic>","usage":{"input_tokens":0,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"content":[{"type":"text","text":"API Error"}]}}\n`;
        const synth = file('synthetic.jsonl', head);
        assert.equal(runHook(synth, 'sess-synth'), '', 'no stderr');
        assert.equal(sessionCount('sess-synth'), '0', 'no bro row for a synthetic-only session');
        appendFileSync(synth, msg(8, 20));
        runHook(synth, 'sess-synth');
        assert.equal(sessionCount('sess-synth'), '1', 'the next real turn writes the row');
        assert.equal(sessionRow('sess-synth'), 'null|null|8|80|800|8000|0|claude-opus-test|transcript|claude|completed|null', "row holds the real turn's usage and model");
        runHook(file('synthetic-only.jsonl', head), 'sess-synth');
        assert.equal(sessionRow('sess-synth'), 'null|null|8|80|800|8000|0|claude-opus-test|transcript|claude|completed|null', 'a synthetic-only Stop leaves the earlier row as it is');
    });
    it('hostile transcript values cannot reach the SQL', () => {
        const evil = file('evil.jsonl', `{"type":"user","timestamp":"${at(0)}","message":{"content":"x"}}\n` +
            `{"type":"assistant","timestamp":"${at(70)}","message":{"id":"e1","model":"x');DROP TABLE agent_runs;--","usage":{"input_tokens":"1; DROP TABLE agent_runs;--","output_tokens":4,"cache_read_input_tokens":2,"cache_creation_input_tokens":-5},"content":[]}}\n` +
            `{"type":"assistant","timestamp":"2026-01-01T00:00:00Z'); DROP TABLE agent_runs;--","message":{"id":"e2","usage":{"input_tokens":3},"content":[]}}\n` +
            '"a bare string line"\n');
        assert.equal(runHook(evil, 'sess-evil'), '', 'no SQL error on hostile input');
        assert.equal(rows(db, "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='agent_runs'")[0], '1', 'agent_runs table survives');
        assert.equal(sessionRow('sess-evil'), 'null|null|0|4|2|0|0|xDROPTABLEagent_runs--|transcript|claude|completed|null', 'non-numeric / negative usage counts as 0; a malformed timestamp is dropped; the model id is stripped');
    });
    it('model is the one with the most tokens; <synthetic> carries no model', () => {
        const line = (id, s, model, input, output) => `{"type":"assistant","timestamp":"${at(s)}","message":{"id":"${id}","model":"${model}","usage":{"input_tokens":${input},"output_tokens":${output}},"content":[]}}\n`;
        const model = file('model.jsonl', `{"type":"user","timestamp":"${at(0)}","message":{"content":"x"}}\n` +
            line('mm1', 210, 'claude-small-1', 5, 5) +
            line('mm2', 211, 'claude-small-1', 5, 5) +
            line('mm3', 212, 'claude-big-9', 500, 5) +
            line('mm4', 213, '<synthetic>', 9000, 0));
        runHook(model, 'sess-model');
        assert.equal(rows(db, "SELECT model FROM agent_runs WHERE session_id='sess-model'").join('\n'), 'claude-big-9', 'the model with the most tokens wins');
    });
    it('root_dir is the project holding the trajectory DB', () => {
        const proj = join(sb.dir, 'proj');
        const projDb = schemaDb(join(proj, '.claude/tmb/trajectory.db'));
        runHook(transcript, SESSION, projDb);
        assert.equal(rows(projDb, "SELECT root_dir FROM agent_runs WHERE agent_type='bro' AND session_id=?", '|', SESSION).join('\n'), proj, 'root_dir = project root');
    });
    it("the inserted bro row carries the manifest plugin_version; the next turn's UPDATE leaves it (GH 1884)", () => {
        assert.equal(rows(db, "SELECT plugin_version FROM agent_runs WHERE agent_type='bro' AND session_id=?", '|', SESSION).join('\n'), PLUGIN_VERSION, 'bro insert');
        const otherRoot = join(sb.dir, 'other-plugin');
        mkdirSync(join(otherRoot, '.claude-plugin'), { recursive: true });
        writeFileSync(join(otherRoot, '.claude-plugin/plugin.json'), '{"name":"tmb","version":"0.0.1-other"}\n');
        appendFileSync(transcript, msg(9, 120));
        runHook(transcript, SESSION, db, { CLAUDE_PLUGIN_ROOT: otherRoot });
        assert.equal(rows(db, "SELECT COUNT(*), MAX(tokens_in), MAX(plugin_version) FROM agent_runs WHERE agent_type='bro' AND session_id=?", '|', SESSION).join('\n'), `1|30|${PLUGIN_VERSION}`, 'the next turn rewrites the totals and keeps plugin_version');
    });
    it("the Stop records the session's per-tool result sizes in agent_run_tool_output (GH 1957)", () => {
        const tools = file('tools.jsonl', userLine(0, 'go') +
            msg(21, 10, '[{"type":"tool_use","id":"tu_r1","name":"Read","input":{}}]') +
            `{"type":"user","timestamp":"${at(11)}","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu_r1","content":"0123456789"}]}}\n` +
            msg(22, 12, '[{"type":"tool_use","id":"tu_b1","name":"Bash","input":{}}]') +
            `{"type":"user","timestamp":"${at(13)}","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu_b1","content":[{"type":"text","text":"abcde"}]}]}}\n`);
        assert.equal(runHook(tools, 'sess-tools'), '', 'no stderr');
        assert.equal(rows(db, "SELECT o.tool_name || ':' || o.calls || ':' || o.result_chars || ':' || o.est_tokens FROM agent_run_tool_output o JOIN agent_runs r ON r.id = o.run_id WHERE r.agent_type='bro' AND r.session_id='sess-tools' ORDER BY o.tool_name").join('\n'), 'Bash:1:5:2\nRead:1:10:3', "one row per tool on the session's bro row");
        runHook(tools, 'sess-tools');
        assert.equal(rows(db, "SELECT COUNT(*) FROM agent_run_tool_output o JOIN agent_runs r ON r.id = o.run_id WHERE r.session_id='sess-tools'")[0], '2', 'a re-fired Stop rewrites the rows, no duplicates');
    });
    it('a Stop whose transcript calls no tool writes the bro row, no tool-output rows, and exits 0 (GH 1957)', () => {
        const noTool = file('no-tools.jsonl', userLine(0, 'go') + msg(23, 10));
        const r = run({ session_id: 'sess-nodist', transcript_path: noTool });
        assert.equal(r.status, 0, 'exit 0');
        assert.equal(r.stdout + r.stderr, '', 'no output');
        assert.equal(rows(db, "SELECT COUNT(*), (SELECT COUNT(*) FROM agent_run_tool_output o JOIN agent_runs r ON r.id = o.run_id WHERE r.session_id='sess-nodist') FROM agent_runs WHERE session_id='sess-nodist'").join('\n'), '1|0', 'bro row written, no tool-output rows');
    });
});
//# sourceMappingURL=bro-turn-usage-l3.test.js.map