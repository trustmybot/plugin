import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tempDB } from './helpers.js';
import { discussionTools } from '../tools/discussions.js';
import { auditTools } from '../tools/audit.js';
import { fileRegistryTools } from '../tools/file-registry.js';
function parseOk(result) {
    return JSON.parse(result.content[0].text);
}
describe('discussion_search', () => {
    it('returns matching snippets for a simple query', async () => {
        const db = tempDB();
        db.run(`INSERT INTO issues (id, objective, description, status, created_at, updated_at)
       VALUES (1, 'test issue', '', 'open', '2026-01-01', '2026-01-01')`);
        db.run(`INSERT INTO discussions (issue_id, author, kind, body, created_at)
       VALUES (1, 'bro', 'note', 'authentication flow implemented with JWT tokens', '2026-01-01T00:00:00Z')`);
        db.run(`INSERT INTO discussions (issue_id, author, kind, body, created_at)
       VALUES (1, 'swe', 'decision', 'decided to use postgres for the database', '2026-01-02T00:00:00Z')`);
        db.run(`INSERT INTO discussions_fts(rowid, body)
       SELECT id, body FROM discussions`);
        const { handlers } = discussionTools(db);
        const result = await handlers['discussion_search']({ agent: 'bro', query: 'authentication' });
        const data = parseOk(result);
        assert.ok(data.results.length >= 1, 'should return at least one result');
        assert.ok(data.results[0].snippet.includes('[authentication]') ||
            data.results[0].snippet.includes('authentication'), 'snippet should highlight the matched term');
        assert.equal(data.total_matched, 1);
        db.close();
    });
    it('filters by issue_id', async () => {
        const db = tempDB();
        db.run(`INSERT INTO issues (id, objective, description, status, created_at, updated_at)
       VALUES (1, 'issue one', '', 'open', '2026-01-01', '2026-01-01')`);
        db.run(`INSERT INTO issues (id, objective, description, status, created_at, updated_at)
       VALUES (2, 'issue two', '', 'open', '2026-01-01', '2026-01-01')`);
        db.run(`INSERT INTO discussions (issue_id, author, kind, body, created_at)
       VALUES (1, 'bro', 'note', 'search term alpha in issue one', '2026-01-01T00:00:00Z')`);
        db.run(`INSERT INTO discussions (issue_id, author, kind, body, created_at)
       VALUES (2, 'bro', 'note', 'search term alpha in issue two', '2026-01-02T00:00:00Z')`);
        db.run(`INSERT INTO discussions_fts(rowid, body) SELECT id, body FROM discussions`);
        const { handlers } = discussionTools(db);
        const result = await handlers['discussion_search']({
            agent: 'bro',
            query: 'alpha',
            issue_id: '1',
        });
        const data = parseOk(result);
        assert.equal(data.total_matched, 1);
        assert.equal(data.results[0].issue_id, 1);
        db.close();
    });
    it('filters by kind', async () => {
        const db = tempDB();
        db.run(`INSERT INTO issues (id, objective, description, status, created_at, updated_at)
       VALUES (1, 'test', '', 'open', '2026-01-01', '2026-01-01')`);
        db.run(`INSERT INTO discussions (issue_id, author, kind, body, created_at)
       VALUES (1, 'bro', 'decision', 'decided to refactor the search module', '2026-01-01T00:00:00Z')`);
        db.run(`INSERT INTO discussions (issue_id, author, kind, body, created_at)
       VALUES (1, 'bro', 'note', 'note about search module refactor', '2026-01-02T00:00:00Z')`);
        db.run(`INSERT INTO discussions_fts(rowid, body) SELECT id, body FROM discussions`);
        const { handlers } = discussionTools(db);
        const result = await handlers['discussion_search']({
            agent: 'bro',
            query: 'refactor',
            kind: 'decision',
        });
        const data = parseOk(result);
        assert.equal(data.total_matched, 1);
        assert.equal(data.results[0].kind, 'decision');
        db.close();
    });
    it('respects k limit', async () => {
        const db = tempDB();
        db.run(`INSERT INTO issues (id, objective, description, status, created_at, updated_at)
       VALUES (1, 'test', '', 'open', '2026-01-01', '2026-01-01')`);
        for (let i = 1; i <= 10; i++) {
            db.run(`INSERT INTO discussions (issue_id, author, kind, body, created_at)
         VALUES (1, 'bro', 'note', 'keyword appears in discussion number ${i}', '2026-01-0${i < 10 ? '0' : ''}${i}T00:00:00Z')`);
        }
        db.run(`INSERT INTO discussions_fts(rowid, body) SELECT id, body FROM discussions`);
        const { handlers } = discussionTools(db);
        const result = await handlers['discussion_search']({
            agent: 'bro',
            query: 'keyword',
            k: 3,
        });
        const data = parseOk(result);
        assert.equal(data.results.length, 3, 'k=3 should return exactly 3 results');
        assert.equal(data.total_matched, 10);
        db.close();
    });
    it('recency_alpha=1 ranks newer rows first', async () => {
        const db = tempDB();
        db.run(`INSERT INTO issues (id, objective, description, status, created_at, updated_at)
       VALUES (1, 'test', '', 'open', '2026-01-01', '2026-01-01')`);
        db.run(`INSERT INTO discussions (issue_id, author, kind, body, created_at)
       VALUES (1, 'bro', 'note', 'recency test old entry', '2020-01-01T00:00:00Z')`);
        db.run(`INSERT INTO discussions (issue_id, author, kind, body, created_at)
       VALUES (1, 'swe', 'note', 'recency test new entry', '2026-05-01T00:00:00Z')`);
        db.run(`INSERT INTO discussions_fts(rowid, body) SELECT id, body FROM discussions`);
        const { handlers } = discussionTools(db);
        const result = await handlers['discussion_search']({
            agent: 'bro',
            query: 'recency',
            recency_alpha: 1,
        });
        const data = parseOk(result);
        assert.ok(data.results.length >= 2, 'should return both results');
        assert.ok(data.results[0].created_at > data.results[1].created_at, 'newer entry should rank first with recency_alpha=1');
        db.close();
    });
    it('sync trigger fires on INSERT and makes row searchable', async () => {
        const db = tempDB();
        db.run(`INSERT INTO issues (id, objective, description, status, created_at, updated_at)
       VALUES (1, 'trigger test', '', 'open', '2026-01-01', '2026-01-01')`);
        db.run(`INSERT INTO discussions (issue_id, author, kind, body, created_at)
       VALUES (1, 'bro', 'note', 'trigger inserted text about workflow', '2026-01-01T00:00:00Z')`);
        const { handlers } = discussionTools(db);
        const result = await handlers['discussion_search']({ agent: 'bro', query: 'workflow' });
        const data = parseOk(result);
        assert.ok(data.results.length >= 1, 'trigger should have indexed the new row');
        db.close();
    });
});
describe('audit_search', () => {
    it('returns matching snippets from summary and content_json', async () => {
        const db = tempDB();
        db.run(`INSERT INTO issues (id, objective, description, status, created_at, updated_at)
       VALUES (1, 'test', '', 'open', '2026-01-01', '2026-01-01')`);
        db.run(`INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
       VALUES (1, 'feat/x', 'bro', 'planning_complete', 'planning complete for authentication module', '{}', '2026-01-01T00:00:00Z')`);
        db.run(`INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
       VALUES (1, 'feat/x', 'swe', 'swe_complete', 'SWE committed database migration', '{}', '2026-01-02T00:00:00Z')`);
        db.run(`INSERT INTO audit_fts(rowid, summary, content_json) SELECT id, summary, content_json FROM audit`);
        const { handlers } = auditTools(db);
        const result = await handlers['audit_search']({ agent: 'bro', query: 'authentication' });
        const data = parseOk(result);
        assert.equal(data.total_matched, 1);
        assert.equal(data.results[0].event_type, 'planning_complete');
        db.close();
    });
    it('filters by event_types', async () => {
        const db = tempDB();
        db.run(`INSERT INTO issues (id, objective, description, status, created_at, updated_at)
       VALUES (1, 'test', '', 'open', '2026-01-01', '2026-01-01')`);
        db.run(`INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
       VALUES (1, 'feat/x', 'bro', 'planning_complete', 'deploy plan complete', '{}', '2026-01-01T00:00:00Z')`);
        db.run(`INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
       VALUES (1, 'feat/x', 'swe', 'swe_complete', 'deploy implementation complete', '{}', '2026-01-02T00:00:00Z')`);
        db.run(`INSERT INTO audit_fts(rowid, summary, content_json) SELECT id, summary, content_json FROM audit WHERE id > 1`);
        const { handlers } = auditTools(db);
        const result = await handlers['audit_search']({
            agent: 'bro',
            query: 'deploy',
            event_types: ['swe_complete'],
        });
        const data = parseOk(result);
        assert.equal(data.total_matched, 1);
        assert.equal(data.results[0].event_type, 'swe_complete');
        db.close();
    });
    it('sync trigger fires on INSERT into audit', async () => {
        const db = tempDB();
        db.run(`INSERT INTO issues (id, objective, description, status, created_at, updated_at)
       VALUES (1, 'trigger test', '', 'open', '2026-01-01', '2026-01-01')`);
        db.run(`INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
       VALUES (1, null, 'bro', 'trigger_test', 'trigger indexed audit entry with unique phrase xyzzy123', '{}', '2026-01-01T00:00:00Z')`);
        const { handlers } = auditTools(db);
        const result = await handlers['audit_search']({ agent: 'bro', query: 'xyzzy123' });
        const data = parseOk(result);
        assert.ok(data.results.length >= 1, 'trigger should have indexed the new audit row');
        db.close();
    });
});
describe('file_registry_search', () => {
    it('returns matching files for a query', async () => {
        const db = tempDB();
        db.run(`INSERT INTO file_registry (repo, path, type, summary)
       VALUES ('plugin', 'src/auth/jwt.ts', 'source', 'JWT authentication handler for API tokens')`);
        db.run(`INSERT INTO file_registry (repo, path, type, summary)
       VALUES ('plugin', 'src/db/migration.ts', 'source', 'Database migration utilities')`);
        db.run(`INSERT INTO file_registry_fts(rowid, summary, path)
       SELECT rowid, summary, path FROM file_registry WHERE summary IS NOT NULL`);
        const { handlers } = fileRegistryTools(db);
        const result = await handlers['file_registry_search']({ agent: 'bro', query: 'authentication' });
        const data = parseOk(result);
        assert.equal(data.total_matched, 1);
        assert.ok(data.results[0].path.includes('jwt'), 'should return the auth-related file');
        db.close();
    });
    it('path_prefix shortcut bypasses FTS5', async () => {
        const db = tempDB();
        db.run(`INSERT INTO file_registry (repo, path, type, summary)
       VALUES ('plugin', 'src/auth/jwt.ts', 'source', 'JWT handler')`);
        db.run(`INSERT INTO file_registry (repo, path, type, summary)
       VALUES ('plugin', 'src/db/schema.ts', 'source', 'Schema definitions')`);
        const { handlers } = fileRegistryTools(db);
        const result = await handlers['file_registry_search']({
            agent: 'bro',
            query: 'anything',
            path_prefix: 'src/auth',
        });
        const data = parseOk(result);
        assert.equal(data.results.length, 1);
        assert.ok(data.results[0].path.startsWith('src/auth'));
        db.close();
    });
    it('sync trigger fires on INSERT into file_registry', async () => {
        const db = tempDB();
        db.run(`INSERT INTO file_registry (repo, path, type, summary)
       VALUES ('plugin', 'src/search/fts5.ts', 'source', 'FTS5 search infrastructure with porter stemming')`);
        const { handlers } = fileRegistryTools(db);
        const result = await handlers['file_registry_search']({ agent: 'bro', query: 'stemming' });
        const data = parseOk(result);
        assert.ok(data.results.length >= 1, 'trigger should have indexed the new file_registry row');
        db.close();
    });
});
describe('discussion_list cursor pagination', () => {
    it('returns all rows when limit is not provided', async () => {
        const db = tempDB();
        db.run(`INSERT INTO issues (id, objective, description, status, created_at, updated_at)
       VALUES (1, 'test', '', 'open', '2026-01-01', '2026-01-01')`);
        for (let i = 1; i <= 5; i++) {
            db.run(`INSERT INTO discussions (issue_id, author, kind, body, created_at)
         VALUES (1, 'bro', 'note', 'body ${i}', '2026-01-0${i}T00:00:00Z')`);
        }
        const { handlers } = discussionTools(db);
        const result = await handlers['discussion_list']({ agent: 'bro', issue_id: '1' });
        const data = parseOk(result);
        assert.ok(Array.isArray(data), 'without limit, returns plain array for back-compat');
        assert.equal(data.length, 5);
        db.close();
    });
    it('returns next_cursor when limit is provided and more rows exist', async () => {
        const db = tempDB();
        db.run(`INSERT INTO issues (id, objective, description, status, created_at, updated_at)
       VALUES (1, 'test', '', 'open', '2026-01-01', '2026-01-01')`);
        for (let i = 1; i <= 5; i++) {
            db.run(`INSERT INTO discussions (issue_id, author, kind, body, created_at)
         VALUES (1, 'bro', 'note', 'body ${i}', '2026-01-0${i}T00:00:00Z')`);
        }
        const { handlers } = discussionTools(db);
        const result = await handlers['discussion_list']({ agent: 'bro', issue_id: '1', limit: 3 });
        const data = parseOk(result);
        assert.equal(data.rows.length, 3);
        assert.ok(typeof data.next_cursor === 'string', 'next_cursor should be present');
        const result2 = await handlers['discussion_list']({
            agent: 'bro',
            issue_id: '1',
            limit: 3,
            cursor: data.next_cursor,
        });
        const data2 = parseOk(result2);
        assert.equal(data2.rows.length, 2);
        assert.equal(data2.next_cursor, undefined, 'no more pages after last page');
        db.close();
    });
});
describe('audit_log_list cursor pagination', () => {
    it('returns plain array when limit is not provided (back-compat)', async () => {
        const db = tempDB();
        db.run(`INSERT INTO issues (id, objective, description, status, created_at, updated_at)
       VALUES (1, 'test', '', 'open', '2026-01-01', '2026-01-01')`);
        db.run(`INSERT INTO audit (issue_id, from_node, event_type, summary, content_json, created_at)
       VALUES (1, 'bro', 'planning_complete', 'done', '{}', '2026-01-01T00:00:00Z')`);
        const { handlers } = auditTools(db);
        const result = await handlers['audit_log_list']({ agent: 'bro', issue_id: '1' });
        const data = parseOk(result);
        assert.ok(Array.isArray(data), 'without limit, returns plain array for back-compat');
        db.close();
    });
    it('returns next_cursor when limit is provided', async () => {
        const db = tempDB();
        db.run(`INSERT INTO issues (id, objective, description, status, created_at, updated_at)
       VALUES (1, 'test', '', 'open', '2026-01-01', '2026-01-01')`);
        for (let i = 1; i <= 4; i++) {
            db.run(`INSERT INTO audit (issue_id, from_node, event_type, summary, content_json, created_at)
         VALUES (1, 'bro', 'ev_${i}', 'summary ${i}', '{}', '2026-01-0${i}T00:00:00Z')`);
        }
        const { handlers } = auditTools(db);
        const result = await handlers['audit_log_list']({ agent: 'bro', issue_id: '1', limit: 2 });
        const data = parseOk(result);
        assert.equal(data.rows.length, 2);
        assert.ok(typeof data.next_cursor === 'string');
        const result2 = await handlers['audit_log_list']({
            agent: 'bro',
            issue_id: '1',
            limit: 2,
            cursor: data.next_cursor,
        });
        const data2 = parseOk(result2);
        assert.equal(data2.rows.length, 2);
        assert.equal(data2.next_cursor, undefined);
        db.close();
    });
});
//# sourceMappingURL=search.test.js.map