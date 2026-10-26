import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorldModelGraph, GraphHolder } from '../graph.js';
import { scanTools } from '../tools/scan.js';
import { worldModelTools } from '../tools/world_model.js';
import { resetEmbeddingModelForTests } from '../embeddings/model.js';
import { pinScanEnv, tempDB } from './helpers.js';
const scanPin = pinScanEnv();
after(() => scanPin.restore());
resetEmbeddingModelForTests(async () => {
    throw new Error('no model in tests');
});
after(() => resetEmbeddingModelForTests());
const CONTENT_KEYS = ['tool', 'agent', 'task_id', 'args', 'result_count', 'empty', 'error', 'warning', 'match', 'derived', 'latency_ms'];
function text(r) {
    return r.content[0].text;
}
function parse(r) {
    assert.ok(!r.isError, text(r));
    return JSON.parse(text(r));
}
function callCount(db) {
    return db.get(`SELECT COUNT(*) AS n FROM audit WHERE event_type = 'wm_tool_called'`).n;
}
function lastCall(db) {
    const row = db.get(`SELECT issue_id, branch_id, from_node, summary, content_json FROM audit
      WHERE event_type = 'wm_tool_called' ORDER BY id DESC LIMIT 1`);
    return { ...row, content: JSON.parse(row.content_json) };
}
function treeNodes(node) {
    const children = node['children'] ?? [];
    const files = node['files'] ?? [];
    return 1 + files.length + children.reduce((n, c) => n + treeNodes(c), 0);
}
const ISSUE = 500;
const TASK = 501;
describe('world-model tool call log (GH 1836)', () => {
    let ws;
    let db;
    let wm;
    let broken;
    let conceptId;
    let symbolId;
    before(async () => {
        ws = mkdtempSync(join(tmpdir(), 'wm-calls-'));
        const repoRoot = join(ws, 'app');
        const files = {
            'README.md': '# App\n\nFixture application.\n',
            'src/a.ts': '// Parses inbound webhook payloads.\n',
            'src/b.ts': 'export const b = 1;\n',
            'lib/README.md': '# lib\n\nShared helpers.\n',
            'lib/zeta.ts': '// Quokka handshake negotiator.\n',
        };
        for (const [p, body] of Object.entries(files)) {
            mkdirSync(join(repoRoot, p, '..'), { recursive: true });
            writeFileSync(join(repoRoot, p), body);
        }
        for (const args of [
            ['init', '-q', '-b', 'main'],
            ['config', 'user.email', 't@t.io'],
            ['config', 'user.name', 't'],
            ['add', '.'],
            ['commit', '-qm', 'init'],
        ]) {
            execFileSync('git', args, { cwd: repoRoot });
        }
        db = tempDB();
        const holder = GraphHolder.fixed(new WorldModelGraph(db));
        const scan = (await scanTools(db, holder, ':memory:').handlers['scan_run']({ agent: 'bro', session_dir: ws }));
        assert.ok(!scan.isError, text(scan));
        wm = worldModelTools(db, holder).handlers;
        broken = worldModelTools(db, {
            ensureGraph: () => {
                throw new Error('graph down');
            },
        }).handlers;
        conceptId = parse(await wm['world_model_concept_upsert']({
            agent: 'bro',
            name: 'quokka handshake',
            body: 'How the quokka handshake is negotiated.',
            steps: [{ path: 'lib/zeta.ts', description: 'Negotiates the quokka handshake.' }],
        }))['id'];
        symbolId = db.get(`SELECT id FROM wm_symbols WHERE path = 'src/b.ts' AND qualified_name = 'b'`).id;
        db.run(`INSERT INTO issues (id, objective, status, created_at, updated_at, repo)
       VALUES (?, 'o', 'open', '2026-10-26T09:00:00.000Z', '2026-10-26T09:00:00.000Z', 'app')`, [ISSUE]);
        db.run(`INSERT INTO tasks (id, issue_id, branch_id, description, status, repo, created_at, updated_at)
       VALUES (?, ?, 'feat/1836-x', 'd', 'running', 'app', '2026-10-26T09:00:00.000Z', '2026-10-26T09:00:00.000Z')`, [TASK, ISSUE]);
    });
    after(() => {
        db.close();
        rmSync(ws, { recursive: true, force: true });
    });
    const calls = [
        { tool: 'world_model_get', ok: () => [wm, { agent: 'bro', repo: 'app' }], error: () => [broken, { agent: 'bro', repo: 'app' }] },
        {
            tool: 'world_model_search',
            ok: () => [wm, { agent: 'swe', query: 'quokka', mode: 'keyword' }],
            error: () => [wm, { agent: 'swe' }],
        },
        { tool: 'world_model_symbol', ok: () => [wm, { agent: 'swe', id: symbolId }], error: () => [wm, { agent: 'swe', id: 999999 }] },
        { tool: 'world_model_concepts', ok: () => [wm, { agent: 'bro', query: 'quokka' }], error: () => [wm, { agent: 'bro' }] },
        {
            tool: 'world_model_concept_get',
            ok: () => [wm, { agent: 'code-reviewer', id: conceptId }],
            error: () => [wm, { agent: 'code-reviewer', id: 999999 }],
        },
        {
            tool: 'world_model_concept_upsert',
            ok: () => [
                wm,
                { agent: 'bro', name: 'webhook parse', steps: [{ path: 'src/a.ts', description: 'Parses inbound webhook payloads.' }] },
            ],
            error: () => [wm, { agent: 'bro', steps: [] }],
        },
    ];
    for (const c of calls) {
        it(`GH 1836: ${c.tool} writes exactly one wm_tool_called row on success and on an error result`, async () => {
            for (const [mode, pick] of [['ok', c.ok], ['error', c.error]]) {
                const [handlers, args] = pick();
                const before = callCount(db);
                const r = await handlers[c.tool](args);
                assert.equal(r.isError === true, mode === 'error', `${c.tool} ${mode}: ${text(r)}`);
                assert.equal(callCount(db), before + 1, `${c.tool} ${mode}`);
                const row = lastCall(db);
                assert.deepEqual(Object.keys(row.content).sort(), [...CONTENT_KEYS].sort());
                assert.equal(row.content['tool'], c.tool);
                assert.equal(row.content['agent'], args['agent']);
                assert.equal(row.from_node, args['agent']);
                assert.equal(row.content['error'], mode === 'error');
                assert.ok(Number.isInteger(row.content['latency_ms']));
                assert.equal(row.summary, `${c.tool} by ${String(args['agent'])}: ${String(row.content['result_count'])} result(s)`);
                if (mode === 'error') {
                    assert.equal(row.content['result_count'], 0);
                    assert.equal(row.content['empty'], true);
                }
            }
        });
    }
    it('GH 1836: result_count is tool-specific and args keeps only the listed keys', async () => {
        const zoom = parse(await wm['world_model_get']({ agent: 'bro', repo: 'app', path: 'src', depth: 1, source: true }));
        assert.equal(lastCall(db).content['result_count'], 3);
        assert.equal(treeNodes(zoom['root']), 3);
        assert.deepEqual(lastCall(db).content.args, { repo: 'app', path: 'src', depth: 1 });
        const root = parse(await wm['world_model_get']({ agent: 'bro', repo: 'app' }));
        assert.equal(lastCall(db).content['result_count'], treeNodes(root['root']));
        parse(await wm['world_model_get']({ agent: 'bro', repo: 'app', path: 'no/such/dir' }));
        assert.equal(lastCall(db).content['result_count'], 0);
        assert.equal(lastCall(db).content['warning'], 'path-not-found');
        const hits = parse(await wm['world_model_search']({ agent: 'swe', query: 'quokka', mode: 'keyword', k: 3 }));
        const searched = lastCall(db).content;
        assert.equal(searched['result_count'], hits['results'].length);
        assert.ok(searched['result_count'] > 0);
        assert.equal(searched['empty'], false);
        assert.equal(searched['match'], hits['match']);
        assert.equal(searched['warning'], null);
        assert.deepEqual(searched.args, { query: 'quokka', mode: 'keyword', k: 3 });
        parse(await wm['world_model_search']({ agent: 'swe', query: 'xylophonezzq', mode: 'keyword' }));
        assert.equal(lastCall(db).content['result_count'], 0);
        assert.equal(lastCall(db).content['empty'], true);
        parse(await wm['world_model_symbol']({ agent: 'swe', qualified_name: 'b', path: 'src/b.ts' }));
        assert.equal(lastCall(db).content['result_count'], 1);
        const concepts = parse(await wm['world_model_concepts']({ agent: 'bro', query: 'quokka' }));
        assert.equal(lastCall(db).content['result_count'], concepts['concepts'].length + (concepts['derived'] ? 1 : 0));
        assert.ok(lastCall(db).content['result_count'] >= 1);
        assert.equal(lastCall(db).content['derived'], concepts['derived'] != null);
        parse(await wm['world_model_concept_get']({ agent: 'bro', id: conceptId }));
        assert.equal(lastCall(db).content['result_count'], 1);
        assert.deepEqual(lastCall(db).content.args, { id: conceptId });
        parse(await wm['world_model_concept_upsert']({ agent: 'bro', name: 'quokka handshake', steps: [{ path: 'lib/zeta.ts', description: 'Negotiates it.' }] }));
        assert.equal(lastCall(db).content['result_count'], 1);
        assert.deepEqual(lastCall(db).content.args, { name: 'quokka handshake' });
    });
    it('GH 1986: world_model_symbol logs impact and source as passed, and neither when absent', async () => {
        parse(await wm['world_model_symbol']({ agent: 'swe', id: symbolId, impact: 2 }));
        assert.deepEqual(lastCall(db).content.args, { id: symbolId, impact: 2 });
        assert.equal(lastCall(db).content.args['impact'], 2);
        parse(await wm['world_model_symbol']({ agent: 'swe', id: symbolId, impact: true, source: true }));
        assert.deepEqual(lastCall(db).content.args, { id: symbolId, impact: true, source: true });
        assert.equal(lastCall(db).content.args['source'], true);
        parse(await wm['world_model_symbol']({ agent: 'swe', id: symbolId }));
        assert.deepEqual(lastCall(db).content.args, { id: symbolId });
        assert.ok(!('impact' in lastCall(db).content.args));
        assert.ok(!('source' in lastCall(db).content.args));
    });
    it('GH 1836: task_id comes from the single open agent_runs row for the caller role', async () => {
        const openRun = () => {
            db.run(`INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at) VALUES (?, ?, 'swe', '2026-10-26T09:05:00.000Z')`, [TASK, ISSUE]);
        };
        const search = async (agent) => {
            parse(await wm['world_model_search']({ agent, query: 'quokka', mode: 'keyword' }));
            return lastCall(db);
        };
        try {
            openRun();
            const one = await search('swe');
            assert.equal(one.content['task_id'], TASK);
            assert.equal(one.issue_id, ISSUE);
            assert.equal(one.branch_id, 'feat/1836-x');
            const otherRole = await search('bro');
            assert.equal(otherRole.content['task_id'], null);
            assert.equal(otherRole.issue_id, -1);
            openRun();
            const two = await search('swe');
            assert.equal(two.content['task_id'], null);
            assert.equal(two.issue_id, -1);
            db.run(`UPDATE agent_runs SET completed_at = '2026-10-26T10:00:00.000Z' WHERE agent_type = 'swe'`);
            const none = await search('swe');
            assert.equal(none.content['task_id'], null);
            assert.equal(none.issue_id, -1);
            assert.equal(none.branch_id, null);
        }
        finally {
            db.run(`DELETE FROM agent_runs`);
        }
    });
    it('GH 1836: the acceptance query reports calls, empty rate per tool and calls per task', async () => {
        db.run(`DELETE FROM audit WHERE event_type = 'wm_tool_called'`);
        db.run(`INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at) VALUES (?, ?, 'swe', '2026-10-26T09:05:00.000Z')`, [TASK, ISSUE]);
        try {
            await wm['world_model_search']({ agent: 'swe', query: 'quokka', mode: 'keyword' });
            await wm['world_model_search']({ agent: 'swe', query: 'xylophonezzq', mode: 'keyword' });
            await wm['world_model_get']({ agent: 'bro', repo: 'app' });
        }
        finally {
            db.run(`DELETE FROM agent_runs`);
        }
        const perTool = db.all(`SELECT json_extract(content_json, '$.tool') AS tool,
              COUNT(*) AS calls,
              AVG(json_extract(content_json, '$.empty')) AS empty_rate
         FROM audit
        WHERE event_type = 'wm_tool_called'
        GROUP BY tool
        ORDER BY tool`);
        assert.deepEqual(perTool.map((r) => ({ ...r })), [
            { tool: 'world_model_get', calls: 1, empty_rate: 0 },
            { tool: 'world_model_search', calls: 2, empty_rate: 0.5 },
        ]);
        const perTask = db.all(`SELECT json_extract(content_json, '$.task_id') AS task_id, COUNT(*) AS calls
         FROM audit
        WHERE event_type = 'wm_tool_called'
        GROUP BY task_id
        ORDER BY task_id`);
        assert.deepEqual(perTask.map((r) => ({ ...r })), [
            { task_id: null, calls: 1 },
            { task_id: TASK, calls: 2 },
        ]);
    });
});
describe('world-model tool call log fails open (GH 1836)', () => {
    it('GH 1836: a failing audit insert leaves the tool result unchanged', async () => {
        const clean = tempDB();
        const failing = tempDB();
        failing.run(`CREATE TRIGGER wm_call_log_fails BEFORE INSERT ON audit WHEN NEW.event_type = 'wm_tool_called'
       BEGIN SELECT RAISE(ABORT, 'audit insert refused'); END`);
        const errors = [];
        const original = console.error;
        console.error = (...a) => {
            errors.push(a);
        };
        try {
            const args = { agent: 'swe', query: 'anything', mode: 'keyword' };
            const expected = await worldModelTools(clean, GraphHolder.fixed(null)).handlers['world_model_search'](args);
            const got = await worldModelTools(failing, GraphHolder.fixed(null)).handlers['world_model_search'](args);
            assert.notEqual(got.isError, true);
            assert.deepEqual(got, expected);
            assert.equal(callCount(failing), 0);
            assert.equal(callCount(clean), 1);
            const logFailures = errors.filter((a) => /call log failed/.test(String(a[0])));
            assert.equal(logFailures.length, 1);
            assert.match(String(logFailures[0][0]), /world_model_search call log failed: audit insert refused/);
        }
        finally {
            console.error = original;
            clean.close();
            failing.close();
        }
    });
});
//# sourceMappingURL=world-model-tool-calls.test.js.map