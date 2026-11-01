import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compositeTools } from '../tools/composites.js';
import { GraphHolder } from '../graph.js';
import { tempDB } from './helpers.js';
const OTHER_ROWS = 8;
const dirNode = (path, parent_path, summary) => ({
    key: `app:${path}`,
    repo: 'app',
    path,
    parent_path,
    summary,
    summary_source: 'readme',
    summary_updated_at: null,
    file_count: 1,
});
const graphOf = (nodes) => GraphHolder.fixed({ allDirectoriesForRepo: () => nodes });
const populatedGraph = graphOf([
    dirNode('src/api', 'src', `api layer ${'a'.repeat(1500)}`),
    dirNode('src/api/v1', 'src/api', `v1 handlers ${'b'.repeat(1500)}`),
    dirNode('src/api/v2', 'src/api', `v2 handlers ${'c'.repeat(1500)}`),
]);
function addRow(db, kind, body, taskId, second) {
    db.run(`INSERT INTO discussions (issue_id, task_id, author, kind, body, created_at) VALUES (1, ?, 'bro', ?, ?, ?)`, [taskId, kind, body, new Date(Date.UTC(2026, 9, 1, 0, 0, second)).toISOString()]);
    return db.get('SELECT last_insert_rowid() AS id').id;
}
function seedTask(db) {
    db.run(`INSERT INTO repos (name, path) VALUES ('app', '/tmp/app')`);
    db.run(`INSERT INTO issues (id, objective, description, status, created_at, updated_at)
     VALUES (1, 'obj', 'd', 'open', datetime('now'), datetime('now'))`);
    db.run(`INSERT INTO tasks (issue_id, branch_id, title, description, status, spec_body, files, verification, commit_sha, repo, created_at, updated_at)
     VALUES (1, 'feat/1-x', 't', 'd', 'pending', 'spec', '["src/api/handler.ts"]', '["bun test"]', 'abc1234', 'app', datetime('now'), datetime('now'))`);
    return db.get('SELECT last_insert_rowid() AS id').id;
}
function seedHistory(db, taskId) {
    const kept = [
        addRow(db, 'intent', 'Human intent verbatim: "ship it"', null, 1),
        addRow(db, 'decision', 'task decision', taskId, 2),
        addRow(db, 'intent', 'task intent', taskId, 3),
        addRow(db, 'decision', 'newest issue decision', null, 4),
    ];
    const stubbed = Array.from({ length: OTHER_ROWS }, (_, i) => addRow(db, 'note', `note ${i} ${'n'.repeat(400)}`, null, 10 + i));
    return { kept, stubbed };
}
async function callBrief(db, holder, args) {
    const tools = compositeTools(db, '/tmp/.claude/tmb/trajectory.db', holder);
    return (await tools.handlers['task_brief']({ agent: 'bro', ...args }));
}
async function brief(db, holder, args) {
    const r = await callBrief(db, holder, args);
    assert.ok(!r.isError, JSON.stringify(r.content));
    return JSON.parse(r.content[0].text);
}
describe('task_brief response_format (GH 1958)', () => {
    it('rejects an unknown response_format and treats omission as concise', async () => {
        const db = tempDB();
        const id = seedTask(db);
        seedHistory(db, id);
        const bad = await callBrief(db, populatedGraph, { task_id: id, response_format: 'verbose' });
        assert.equal(bad.isError, true);
        assert.match(JSON.parse(bad.content[0].text).error, /unknown response_format "verbose".*concise, detailed/);
        for (const section of ['core', 'verification', 'scope', 'history', 'all']) {
            assert.deepEqual(await brief(db, populatedGraph, { task_id: id, section }), await brief(db, populatedGraph, { task_id: id, section, response_format: 'concise' }));
        }
        db.close();
    });
    it('detailed keeps summaries and row bodies and carries no hint', async () => {
        const db = tempDB();
        const id = seedTask(db);
        seedHistory(db, id);
        const out = await brief(db, populatedGraph, { task_id: id, response_format: 'detailed' });
        assert.equal('response_format_hint' in out, false);
        const [entry] = out['scope_world_model'];
        assert.match(entry.summary, /^api layer/);
        assert.match(entry.children[0].summary, /^v1 handlers/);
        for (const row of out['task_discussions']) {
            assert.equal(typeof row.body, 'string');
            assert.equal(typeof row.created_at, 'string');
        }
        db.close();
    });
    it('concise scope_world_model drops summary at both levels and keeps every dir and child path', async () => {
        const db = tempDB();
        const id = seedTask(db);
        const out = await brief(db, populatedGraph, { task_id: id, section: 'scope' });
        assert.deepEqual(out['scope_world_model'], [
            { dir: 'src/api', children: [{ path: 'src/api/v1' }, { path: 'src/api/v2' }] },
        ]);
        db.close();
    });
    it('concise task_discussions keeps decision and intent rows whole and stubs the others', async () => {
        const db = tempDB();
        const id = seedTask(db);
        const { kept, stubbed } = seedHistory(db, id);
        const detailed = (await brief(db, null, { task_id: id, section: 'history', response_format: 'detailed' }))['task_discussions'];
        const concise = (await brief(db, null, { task_id: id, section: 'history' }))['task_discussions'];
        assert.deepEqual(concise.map((r) => r.id), [...kept, ...stubbed]);
        for (const keptId of kept) {
            assert.deepEqual(concise.find((r) => r.id === keptId), detailed.find((r) => r.id === keptId));
        }
        for (const stubId of stubbed) {
            assert.deepEqual(concise.find((r) => r.id === stubId), { id: stubId, kind: 'note', author: 'bro' });
        }
        db.close();
    });
    it('concise is at most half of detailed for scope and all on a populated fixture', async () => {
        const db = tempDB();
        const id = seedTask(db);
        seedHistory(db, id);
        for (const section of ['scope', 'all']) {
            const concise = JSON.stringify(await brief(db, populatedGraph, { task_id: id, section }));
            const detailed = JSON.stringify(await brief(db, populatedGraph, { task_id: id, section, response_format: 'detailed' }));
            assert.ok(concise.length <= detailed.length / 2, `${section}: concise ${concise.length}, detailed ${detailed.length}`);
        }
        db.close();
    });
    it('the fields the review and planning flows read stay in concise output', async () => {
        const db = tempDB();
        const id = seedTask(db);
        seedHistory(db, id);
        const out = await brief(db, populatedGraph, { task_id: id });
        for (const key of ['spec_body', 'commit_sha', 'scope', 'verification', 'verification_run', 'completion_report', 'spawn_note', 'open_findings']) {
            assert.ok(key in out, `${key} in concise output`);
        }
        db.close();
    });
    it('response_format_hint names detailed when something was trimmed', async () => {
        const db = tempDB();
        const id = seedTask(db);
        seedHistory(db, id);
        for (const section of ['scope', 'history', 'all']) {
            const hint = (await brief(db, populatedGraph, { task_id: id, section }))['response_format_hint'];
            assert.equal(typeof hint, 'string');
            assert.match(hint, /response_format: 'detailed'/);
        }
        db.close();
    });
    it('response_format_hint is absent when nothing was trimmed', async () => {
        const db = tempDB();
        const id = seedTask(db);
        addRow(db, 'decision', 'task decision', id, 1);
        addRow(db, 'decision', 'issue decision', null, 2);
        const bare = graphOf([dirNode('src/api', 'src', null), dirNode('src/api/v1', 'src/api', null)]);
        for (const section of ['core', 'verification', 'scope', 'history', 'all']) {
            assert.equal('response_format_hint' in (await brief(db, bare, { task_id: id, section })), false, section);
        }
        const coreOfPopulated = await brief(db, populatedGraph, { task_id: id, section: 'core' });
        assert.equal('response_format_hint' in coreOfPopulated, false);
        db.close();
    });
});
//# sourceMappingURL=task-brief-concise.test.js.map