/**
 * The async bro-turn-usage gate (GH 1692, decision 937): overlapping Stop runs
 * of one session on a temp trajectory DB. A run holding an older transcript
 * read never overwrites a newer one's agent_runs row or agent_run_tool_output
 * rows, an equal completed_at still writes, and first runs leave one row.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { broTurnUsage, turnUsage, usageSql } from '../hooks/bro-turn-usage.js';
import { dbWrite } from '../hooks/lib/audit.js';
const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCHEMA = readFileSync(join(SERVER_ROOT, 'src/schema.sql'), 'utf8');
const SESSION = 'sess-overlap';
const STARTED = '2026-10-26T10:00:00.000Z';
const OLDER = '2026-10-26T10:01:00.000Z';
const NEWER = '2026-10-26T10:02:00.000Z';
const OLDER_MS = 60_000;
const NEWER_MS = 120_000;
const OLDER_TURN = { at: OLDER, tokensOut: 5, tool: 'Read' };
const NEWER_TURN = { at: NEWER, tokensOut: 50, tool: 'Bash' };
let sandbox;
let seq = 0;
function freshDb() {
    seq += 1;
    const db = join(sandbox, `case-${seq}/.claude/tmb/trajectory.db`);
    mkdirSync(dirname(db), { recursive: true });
    const d = new DatabaseSync(db);
    d.exec(SCHEMA);
    d.close();
    return { db, env: { PATH: process.env.PATH, HOME: join(sandbox, 'home'), TRAJECTORY_DB_PATH: db } };
}
function transcriptText({ at, tokensOut, tool }) {
    const lines = [
        {
            timestamp: STARTED,
            type: 'assistant',
            message: {
                id: 'msg_1',
                model: 'claude-x',
                usage: { input_tokens: 1, output_tokens: 1 },
                content: tool === undefined ? [] : [{ type: 'tool_use', id: 'tu_1', name: tool, input: {} }],
            },
        },
        { timestamp: at, type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'x' }] } },
        {
            timestamp: at,
            type: 'assistant',
            message: { id: 'msg_2', model: 'claude-x', usage: { input_tokens: 1, output_tokens: tokensOut - 1 }, content: [] },
        },
    ];
    return `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`;
}
function run(env, turn) {
    const transcript = join(sandbox, `transcript-${seq}-${turn.at}.jsonl`);
    writeFileSync(transcript, transcriptText(turn));
    assert.deepEqual(broTurnUsage(JSON.stringify({ session_id: SESSION, transcript_path: transcript }), env), { stdout: '', code: 0 });
}
function query(db, sql) {
    const d = new DatabaseSync(db, { readOnly: true });
    try {
        return d.prepare(sql).all().map((row) => ({ ...row }));
    }
    finally {
        d.close();
    }
}
const usageRows = (db) => query(db, "SELECT tokens_out, started_at, completed_at, duration_ms FROM agent_runs WHERE agent_type = 'bro'");
const toolRows = (db) => query(db, 'SELECT tool_name FROM agent_run_tool_output ORDER BY tool_name');
const NEWER_ROW = { tokens_out: 50, started_at: STARTED, completed_at: NEWER, duration_ms: NEWER_MS };
before(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'tmb-btu-overlap-'));
});
after(() => {
    rmSync(sandbox, { recursive: true, force: true });
});
describe('bro-turn-usage overlapping runs', () => {
    it('a run with an older read leaves the newer tokens, completed_at and duration_ms', () => {
        const { db, env } = freshDb();
        run(env, NEWER_TURN);
        run(env, OLDER_TURN);
        assert.deepEqual(usageRows(db), [NEWER_ROW]);
    });
    it('the newer run still lands after the older one', () => {
        const { db, env } = freshDb();
        run(env, OLDER_TURN);
        assert.deepEqual(usageRows(db), [{ tokens_out: 5, started_at: STARTED, completed_at: OLDER, duration_ms: OLDER_MS }]);
        run(env, NEWER_TURN);
        assert.deepEqual(usageRows(db), [NEWER_ROW]);
    });
    it('a run with an equal completed_at still writes', () => {
        const { db, env } = freshDb();
        run(env, NEWER_TURN);
        run(env, { ...NEWER_TURN, tokensOut: 77 });
        assert.deepEqual(usageRows(db), [{ ...NEWER_ROW, tokens_out: 77 }]);
        run(env, { ...NEWER_TURN, tokensOut: 77 });
        assert.deepEqual(usageRows(db), [{ ...NEWER_ROW, tokens_out: 77 }]);
    });
    it('a stored completed_at without milliseconds is compared as a time', () => {
        const { db, env } = freshDb();
        run(env, OLDER_TURN);
        const d = new DatabaseSync(db);
        d.exec("UPDATE agent_runs SET completed_at = '2026-10-26T10:01:30Z'");
        d.close();
        run(env, OLDER_TURN);
        assert.equal(usageRows(db)[0].completed_at, '2026-10-26T10:01:30Z');
        run(env, NEWER_TURN);
        assert.deepEqual(usageRows(db), [NEWER_ROW]);
    });
    it('a row with no completed_at takes the write', () => {
        const { db, env } = freshDb();
        run(env, OLDER_TURN);
        const d = new DatabaseSync(db);
        d.exec('UPDATE agent_runs SET completed_at = NULL');
        d.close();
        run(env, OLDER_TURN);
        assert.equal(usageRows(db)[0].completed_at, OLDER);
    });
    it('a run with an older read leaves the tool-output rows of the newer one', () => {
        const { db, env } = freshDb();
        run(env, NEWER_TURN);
        assert.deepEqual(toolRows(db), [{ tool_name: 'Bash' }]);
        run(env, OLDER_TURN);
        assert.deepEqual(toolRows(db), [{ tool_name: 'Bash' }]);
    });
    it('the newer tool-output rows replace the older ones, and an empty stale read deletes nothing', () => {
        const { db, env } = freshDb();
        run(env, OLDER_TURN);
        assert.deepEqual(toolRows(db), [{ tool_name: 'Read' }]);
        run(env, NEWER_TURN);
        assert.deepEqual(toolRows(db), [{ tool_name: 'Bash' }]);
        const transcript = join(sandbox, `empty-tools-${seq}.jsonl`);
        writeFileSync(transcript, `${JSON.stringify({ timestamp: OLDER, type: 'assistant', message: { id: 'm', model: 'claude-x', usage: { input_tokens: 1, output_tokens: 1 }, content: [] } })}\n`);
        broTurnUsage(JSON.stringify({ session_id: SESSION, transcript_path: transcript }), env);
        assert.deepEqual(toolRows(db), [{ tool_name: 'Bash' }]);
    });
});
describe('bro-turn-usage first runs and transaction', () => {
    it('two sequential first runs leave one agent_runs row', () => {
        const { db, env } = freshDb();
        run(env, OLDER_TURN);
        run(env, OLDER_TURN);
        assert.equal(usageRows(db).length, 1);
    });
    it('UPDATE and INSERT share one transaction: a failing INSERT undoes the UPDATE', () => {
        const { db, env } = freshDb();
        run(env, OLDER_TURN);
        const d = new DatabaseSync(db);
        d.exec(`
      CREATE TRIGGER vanish_after_update AFTER UPDATE ON agent_runs
      BEGIN DELETE FROM agent_runs WHERE id = NEW.id; END;
      CREATE TRIGGER refuse_insert BEFORE INSERT ON agent_runs
      BEGIN SELECT RAISE(ABORT, 'refused'); END;
    `);
        d.close();
        const usage = turnUsage(transcriptText(NEWER_TURN));
        assert.ok(usage !== null);
        const r = dbWrite(db, usageSql(db, SESSION, usage, env), { env, caller: 'test' });
        assert.equal(r.ok, false);
        assert.match(r.error, /refused/);
        assert.deepEqual(usageRows(db), [{ tokens_out: 5, started_at: STARTED, completed_at: OLDER, duration_ms: OLDER_MS }]);
    });
});
//# sourceMappingURL=bro-turn-usage-overlap.test.js.map