#!/usr/bin/env bash
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"
SCHEMA="$PLUGIN_ROOT/mcp/trajectory-server/src/schema.sql"

if [ ! -f "$SCHEMA" ]; then
  printf 'rag-schema-invariants: schema.sql not found at %s\n' "$SCHEMA" >&2
  exit 1
fi

FAIL=0

check() {
  local label="$1"
  local pattern="$2"
  if ! grep -v '^\s*--' "$SCHEMA" | grep -qF "$pattern"; then
    printf 'rag-schema-invariants: MISSING — %s\n  expected: %s\n' "$label" "$pattern" >&2
    FAIL=1
  fi
}

check 'discussions FTS5 virtual table'    'CREATE VIRTUAL TABLE IF NOT EXISTS discussions_fts USING fts5'
check 'audit FTS5 virtual table'          'CREATE VIRTUAL TABLE IF NOT EXISTS audit_fts USING fts5'
check 'directories FTS5 virtual table'    'CREATE VIRTUAL TABLE IF NOT EXISTS directories_fts USING fts5'
check 'discussions_embeddings table'      'CREATE TABLE IF NOT EXISTS discussions_embeddings'
check 'audit_embeddings table'            'CREATE TABLE IF NOT EXISTS audit_embeddings'
check 'directories_embeddings table'      'CREATE TABLE IF NOT EXISTS directories_embeddings'
check 'idx_discussions_embeddings_model'  'CREATE INDEX IF NOT EXISTS idx_discussions_embeddings_model'
check 'idx_audit_embeddings_model'        'CREATE INDEX IF NOT EXISTS idx_audit_embeddings_model'
check 'idx_directories_embeddings_model'  'CREATE INDEX IF NOT EXISTS idx_directories_embeddings_model'

if [ "$FAIL" -ne 0 ]; then
  printf '\nrag-schema-invariants: FAIL\n' >&2
  exit 1
fi

printf 'rag-schema-invariants: PASS\n'
