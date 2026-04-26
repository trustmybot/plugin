import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderErd } from '../renderers/erd.js';
const __dirname = dirname(fileURLToPath(import.meta.url));
const OPTS = { generatedAt: '2026-04-21', schemaSource: 'mcp/trajectory-server/src/schema.sql' };
describe('renderErd', () => {
    it('empty input produces valid doc with 0 tables and empty erDiagram', () => {
        const out = renderErd('', OPTS);
        assert.ok(out.startsWith('<!-- Generated 2026-04-21 via /tmb refresh-architecture.'));
        assert.ok(out.includes('Tables: 0'));
        assert.ok(out.includes('Relations: 0'));
        assert.ok(out.includes('erDiagram'));
    });
    it('schemaSource appears in provenance line', () => {
        const out = renderErd('', OPTS);
        assert.ok(out.includes('Source: `mcp/trajectory-server/src/schema.sql`'));
    });
    it('output starts with generated-header comment', () => {
        const out = renderErd('', OPTS);
        assert.ok(out.startsWith('<!-- Generated'));
    });
    it('malformed SQL emits no throw', () => {
        assert.doesNotThrow(() => renderErd('CREATE TABLE foo (; garbage)', OPTS));
    });
    it('simple CREATE TABLE produces correct table block', () => {
        const sql = `
      CREATE TABLE users (
        id   INTEGER PRIMARY KEY,
        name TEXT NOT NULL
      );
    `;
        const out = renderErd(sql, OPTS);
        assert.ok(out.includes('Tables: 1'));
        assert.ok(out.includes('users {'));
        assert.ok(out.includes('INTEGER id PK'));
        assert.ok(out.includes('TEXT name'));
    });
    it('FOREIGN KEY column marked FK and relation emitted', () => {
        const sql = `
      CREATE TABLE issues (
        id INTEGER PRIMARY KEY
      );
      CREATE TABLE tasks (
        id       INTEGER PRIMARY KEY,
        issue_id INTEGER NOT NULL REFERENCES issues(id)
      );
    `;
        const out = renderErd(sql, OPTS);
        assert.ok(out.includes('Tables: 2'));
        assert.ok(out.includes('Relations: 1'));
        assert.ok(out.includes('||--o{'));
        assert.ok(out.includes('issue_id'));
    });
    it('UNIQUE FK column uses one-to-one cardinality', () => {
        const sql = `
      CREATE TABLE parent (
        id INTEGER PRIMARY KEY
      );
      CREATE TABLE child (
        id        INTEGER PRIMARY KEY,
        parent_id INTEGER UNIQUE REFERENCES parent(id)
      );
    `;
        const out = renderErd(sql, OPTS);
        assert.ok(out.includes('||--o|'));
    });
    it('self-referential FK emits self relation', () => {
        const sql = `
      CREATE TABLE issues (
        id             INTEGER PRIMARY KEY,
        parent_issue_id INTEGER REFERENCES issues(id)
      );
    `;
        const out = renderErd(sql, OPTS);
        assert.ok(out.includes('issues ||--o{ issues'));
    });
    it('output is deterministic across two calls', () => {
        const sql = `
      CREATE TABLE a (id INTEGER PRIMARY KEY, b_id INTEGER REFERENCES b(id));
      CREATE TABLE b (id INTEGER PRIMARY KEY);
    `;
        const out1 = renderErd(sql, OPTS);
        const out2 = renderErd(sql, OPTS);
        assert.equal(out1, out2);
    });
    it('CREATE INDEX and PRAGMA are silently skipped', () => {
        const sql = `
      CREATE TABLE foo (id INTEGER PRIMARY KEY);
      CREATE INDEX IF NOT EXISTS idx_foo ON foo(id);
      PRAGMA foreign_keys = ON;
    `;
        assert.doesNotThrow(() => {
            const out = renderErd(sql, OPTS);
            assert.ok(out.includes('Tables: 1'));
        });
    });
    it('real schema.sql: non-zero tables with at least one relation', () => {
        const schemaPath = join(__dirname, '../schema.sql');
        const sql = readFileSync(schemaPath, 'utf8');
        const out = renderErd(sql, OPTS);
        const tablesMatch = out.match(/^Tables: (\d+)/m);
        assert.ok(tablesMatch, 'Tables line missing');
        const tableCount = parseInt(tablesMatch[1], 10);
        assert.ok(tableCount > 0, `Expected >0 tables, got ${tableCount}`);
        const relMatch = out.match(/^Relations: (\d+)/m);
        assert.ok(relMatch, 'Relations line missing');
        const relCount = parseInt(relMatch[1], 10);
        assert.ok(relCount > 0, `Expected >0 relations, got ${relCount}`);
        assert.ok(out.includes('||--o{'), 'Expected at least one ||--o{ relation');
        assert.ok(out.includes('issue_id'), 'Expected issue_id FK to appear');
        assert.ok(out.startsWith('<!-- Generated'));
        assert.ok(out.includes('Source: `mcp/trajectory-server/src/schema.sql`'));
    });
});
//# sourceMappingURL=erd.test.js.map