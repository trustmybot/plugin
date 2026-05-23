import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tempDB } from './helpers.js';
import { worldModelTools } from '../tools/world-model.js';
function parse(r) {
    const first = r.content[0];
    return JSON.parse(String(first?.text ?? '{}'));
}
function seedDirs(db) {
    // Root + a couple of children + a grandchild.
    db.run("INSERT INTO directories (repo, path, parent_path, summary, summary_source, summary_updated_at, file_count) VALUES ('app', '', NULL, 'Root of the app repo — main entrypoint lives here.', 'readme', datetime('now'), 2)");
    db.run("INSERT INTO directories (repo, path, parent_path, summary, summary_source, summary_updated_at, file_count) VALUES ('app', 'src', '', 'Application source — request handlers + business logic.', 'readme', datetime('now'), 5)");
    db.run("INSERT INTO directories (repo, path, parent_path, summary, summary_source, summary_updated_at, file_count) VALUES ('app', 'src/api', 'src', 'HTTP API handlers — REST endpoints for the auth service.', 'readme', datetime('now'), 4)");
    db.run("INSERT INTO directories (repo, path, parent_path, summary, summary_source, summary_updated_at, file_count) VALUES ('app', 'tests', '', NULL, 'llm', NULL, 8)");
    db.run("INSERT INTO plugin_config (key, value_json) VALUES ('tmb_default_repo', '\"app\"')");
}
describe('world_model_get', () => {
    it('returns world-model-empty warning when no directories rows exist', async () => {
        const db = tempDB();
        const tools = worldModelTools(db, null);
        const r = await tools.handlers['world_model_get']({ agent: 'bro' });
        const out = parse(r);
        assert.equal(out['warning'], 'world-model-empty');
        assert.equal(out['root'], null);
    });
    it('returns root with one level of children at default depth=2', async () => {
        const db = tempDB();
        seedDirs(db);
        const tools = worldModelTools(db, null);
        const r = await tools.handlers['world_model_get']({ agent: 'bro' });
        const out = parse(r);
        assert.equal(out.repo, 'app');
        assert.equal(out.root.path, '');
        const childPaths = out.root.children.map((c) => c.path).sort();
        assert.deepEqual(childPaths, ['src', 'tests']);
        // depth=2 means root + immediate children, so src's children should also load
        const src = out.root.children.find((c) => c.path === 'src');
        assert.ok(src);
        const srcChildren = src.children.map((c) => c.path);
        assert.deepEqual(srcChildren, ['src/api']);
    });
    it('depth=0 returns only the requested directory, no children', async () => {
        const db = tempDB();
        seedDirs(db);
        const tools = worldModelTools(db, null);
        const r = await tools.handlers['world_model_get']({ agent: 'bro', depth: 0 });
        const out = parse(r);
        assert.equal(out.root.children.length, 0);
    });
    it('depth=null returns the full subtree', async () => {
        const db = tempDB();
        seedDirs(db);
        const tools = worldModelTools(db, null);
        const r = await tools.handlers['world_model_get']({ agent: 'bro', depth: null });
        const out = parse(r);
        const src = out.root.children.find((c) => c.path === 'src');
        assert.ok(src);
        assert.equal(src.children[0].path, 'src/api');
    });
    it('path scoping returns the named subtree as root', async () => {
        const db = tempDB();
        seedDirs(db);
        const tools = worldModelTools(db, null);
        const r = await tools.handlers['world_model_get']({ agent: 'bro', path: 'src' });
        const out = parse(r);
        assert.equal(out.root.path, 'src');
        assert.deepEqual(out.root.children.map((c) => c.path), ['src/api']);
    });
    it('unknown path returns warning, not an error', async () => {
        const db = tempDB();
        seedDirs(db);
        const tools = worldModelTools(db, null);
        const r = await tools.handlers['world_model_get']({ agent: 'bro', path: 'nope/missing' });
        const out = parse(r);
        assert.equal(out['warning'], 'path-not-found');
    });
});
describe('world_model_search', () => {
    it('keyword mode returns ranked hits by bm25', async () => {
        const db = tempDB();
        seedDirs(db);
        const tools = worldModelTools(db, null);
        const r = await tools.handlers['world_model_search']({
            agent: 'bro',
            query: 'auth',
            mode: 'keyword',
        });
        const out = parse(r);
        assert.equal(out.mode, 'keyword');
        assert.ok(out.results.length >= 1);
        assert.equal(out.results[0].path, 'src/api');
    });
    it('hybrid mode falls back gracefully when no embeddings are present', async () => {
        const db = tempDB();
        seedDirs(db);
        const tools = worldModelTools(db, null);
        const r = await tools.handlers['world_model_search']({
            agent: 'bro',
            query: 'entrypoint',
            mode: 'hybrid',
        });
        const out = parse(r);
        // No embeddings = warning surfaces, FTS still returns results
        assert.equal(out['warning'], 'semantic_unavailable');
        assert.ok(out.results.length >= 1);
    });
    it('semantic mode with no embeddings returns explicit warning', async () => {
        const db = tempDB();
        seedDirs(db);
        const tools = worldModelTools(db, null);
        const r = await tools.handlers['world_model_search']({
            agent: 'bro',
            query: 'http handlers',
            mode: 'semantic',
        });
        const out = parse(r);
        assert.equal(out.mode, 'semantic');
        assert.equal(out['warning'], 'semantic_unavailable');
        assert.equal(out.results.length, 0);
    });
});
//# sourceMappingURL=world-model.test.js.map