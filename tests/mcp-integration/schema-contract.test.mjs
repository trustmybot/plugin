import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { startClient, listTools, call } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_SQL = path.resolve(HERE, '../../mcp/trajectory-server/src/schema.sql');

const EXPECTED_PATTERN = '^[a-z][a-z0-9_-]*$';

function freshDB() {
  const db = new DatabaseSync(':memory:');
  const sql = readFileSync(SCHEMA_SQL, 'utf8');
  db.exec(sql);
  return db;
}

test('every MCP tool exposes the `agent` parameter in its inputSchema', async (t) => {
  const { client, close } = await startClient();
  t.after(async () => { await close(); });

  const tools = await listTools(client);
  assert.ok(tools.length > 20, 'expected >20 tools, got ' + tools.length);

  const missing = [];
  const badSchema = [];
  for (const tool of tools) {
    const props = tool.inputSchema?.properties ?? {};
    if (!('agent' in props)) {
      missing.push(tool.name);
      continue;
    }
    const agentProp = props.agent;
    if (agentProp.type !== 'string') {
      badSchema.push(tool.name + ': type=' + agentProp.type);
    }
    if (agentProp.pattern !== EXPECTED_PATTERN) {
      badSchema.push(tool.name + ': pattern=' + JSON.stringify(agentProp.pattern));
    }
  }

  assert.deepEqual(missing, [], 'tools missing `agent` in schema: ' + missing.join(', '));
  assert.deepEqual(badSchema, [], 'tools with bad `agent` schema: ' + badSchema.join('; '));
});

test('FTS5 virtual tables are queryable on fresh schema', () => {
  const db = freshDB();

  assert.doesNotThrow(
    () => db.prepare('SELECT * FROM discussions_fts WHERE discussions_fts MATCH ? LIMIT 1').all('test'),
    'discussions_fts: FTS5 MATCH query must not throw on fresh schema',
  );

  assert.doesNotThrow(
    () => db.prepare('SELECT * FROM audit_fts WHERE audit_fts MATCH ? LIMIT 1').all('test'),
    'audit_fts: FTS5 MATCH query must not throw on fresh schema',
  );

  assert.doesNotThrow(
    () => db.prepare('SELECT * FROM file_registry_fts WHERE file_registry_fts MATCH ? LIMIT 1').all('test'),
    'file_registry_fts: FTS5 MATCH query must not throw on fresh schema',
  );

  db.close();
});

test('embedding tables accept inserts after parent row created', () => {
  const db = freshDB();

  db.exec(
    "INSERT INTO issues (id, objective, description, status, created_at, updated_at)" +
    " VALUES (1, 'embedding-contract-test', '', 'open', '2026-01-01', '2026-01-01')",
  );
  db.exec(
    "INSERT INTO discussions (id, issue_id, author, kind, body, created_at)" +
    " VALUES (1, 1, 'bro', 'note', 'embedding insert contract test', '2026-01-01T00:00:00Z')",
  );
  db.exec(
    "INSERT INTO audit (id, issue_id, branch_id, from_node, event_type, summary, content_json, created_at)" +
    " VALUES (1, 1, null, 'bro', 'embedding_contract_test', 'audit row for embedding test', '{}', '2026-01-01T00:00:00Z')",
  );
  db.exec(
    "INSERT INTO file_registry (repo, path, type, summary)" +
    " VALUES ('plugin', 'src/test/contract.ts', 'source', 'embedding contract test file')",
  );

  const now = new Date().toISOString();
  const dummyEmbedding = Buffer.alloc(16);

  assert.doesNotThrow(() => {
    db.prepare(
      'INSERT INTO discussions_embeddings (discussion_id, embedding, model_id, embedded_at) VALUES (?, ?, ?, ?)',
    ).run(1, dummyEmbedding, 'test-model', now);
  }, 'discussions_embeddings must accept insert after parent discussion exists');

  assert.doesNotThrow(() => {
    db.prepare(
      'INSERT INTO audit_embeddings (audit_id, embedding, model_id, embedded_at) VALUES (?, ?, ?, ?)',
    ).run(1, dummyEmbedding, 'test-model', now);
  }, 'audit_embeddings must accept insert after parent audit row exists');

  const fileRow = db.prepare(
    "SELECT rowid FROM file_registry WHERE path = 'src/test/contract.ts'",
  ).get();
  assert.ok(fileRow, 'file_registry row must exist');

  assert.doesNotThrow(() => {
    db.prepare(
      'INSERT INTO file_registry_embeddings (file_registry_id, embedding, model_id, embedded_at) VALUES (?, ?, ?, ?)',
    ).run(fileRow.rowid, dummyEmbedding, 'test-model', now);
  }, 'file_registry_embeddings must accept insert after parent file_registry row exists');

  db.close();
});

test('FTS5 sync triggers exist — at least 6 INSERT/DELETE sync triggers across fts tables', () => {
  const db = freshDB();

  const rows = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'trigger'" +
    " AND (name LIKE 'discussions_%' OR name LIKE 'audit_%' OR name LIKE 'file_registry_%')",
  ).all();

  const names = rows.map((r) => r.name).join(', ');
  assert.ok(
    rows.length >= 6,
    'expected at least 6 FTS sync triggers (INSERT + DELETE per fts table), found ' + rows.length + ': ' + names,
  );

  db.close();
});
