// L1 lint: schema.sql keeps the RAG tables and indexes (discussions/audit FTS5 tables, embeddings tables and their model indexes) outside comments.
import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCHEMA = join(ROOT, 'mcp', 'trajectory-server', 'src', 'schema.sql');
const INVARIANTS = [
  ['discussions FTS5 virtual table', 'CREATE VIRTUAL TABLE IF NOT EXISTS discussions_fts USING fts5'],
  ['audit FTS5 virtual table', 'CREATE VIRTUAL TABLE IF NOT EXISTS audit_fts USING fts5'],
  ['discussions_embeddings table', 'CREATE TABLE IF NOT EXISTS discussions_embeddings'],
  ['audit_embeddings table', 'CREATE TABLE IF NOT EXISTS audit_embeddings'],
  ['idx_discussions_embeddings_model', 'CREATE INDEX IF NOT EXISTS idx_discussions_embeddings_model'],
  ['idx_audit_embeddings_model', 'CREATE INDEX IF NOT EXISTS idx_audit_embeddings_model'],
];

export function missingInvariants(sql) {
  const code = sql.split('\n').filter((line) => !/^\s*--/.test(line));
  return INVARIANTS.filter(([, pattern]) => !code.some((line) => line.includes(pattern))).map(
    ([label, pattern]) => `rag-schema-invariants: MISSING — ${label}\n  expected: ${pattern}`,
  );
}

test('a schema missing an invariant, or holding it only in a comment, is caught', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rag-schema-invariants-'));
  try {
    const full = INVARIANTS.map(([, pattern]) => `${pattern} (x);`).join('\n');
    const broken = full.replace('CREATE TABLE IF NOT EXISTS audit_embeddings', '  -- CREATE TABLE IF NOT EXISTS audit_embeddings');
    writeFileSync(join(dir, 'schema.sql'), broken);
    assert.deepEqual(missingInvariants(full), []);
    assert.deepEqual(missingInvariants(readFileSync(join(dir, 'schema.sql'), 'utf8')), [
      'rag-schema-invariants: MISSING — audit_embeddings table\n  expected: CREATE TABLE IF NOT EXISTS audit_embeddings',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('schema.sql holds every RAG schema invariant', () => {
  assert.ok(existsSync(SCHEMA), `rag-schema-invariants: schema.sql not found at ${SCHEMA}`);
  const missing = missingInvariants(readFileSync(SCHEMA, 'utf8'));
  assert.deepEqual(missing, [], `${missing.join('\n')}\n\nrag-schema-invariants: FAIL`);
});
