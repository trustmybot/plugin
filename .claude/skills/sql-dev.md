---
name: sql-dev
description: SQLite development rules for SWE agents working with database code.
---

# SQL and SQLite Development

## Connection Setup

Always configure SQLite with these pragmas on every new connection:

```python
import sqlite3

def get_connection(db_path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=5000")
    conn.row_factory = sqlite3.Row
    return conn
```

- `journal_mode=WAL`: allows concurrent reads during writes.
- `foreign_keys=ON`: SQLite does NOT enforce FK constraints by default — always set this.
- `busy_timeout=5000`: wait up to 5 s before raising `OperationalError: database is locked`.

Always use a context manager so connections are closed even on error:

```python
with get_connection(db_path) as conn:
    conn.execute("INSERT INTO items (name) VALUES (?)", (name,))
```

## Parameterized Queries (CRITICAL)

```python
# CORRECT
conn.execute("SELECT * FROM items WHERE id = ?", (item_id,))

# WRONG — SQL injection risk
conn.execute(f"SELECT * FROM items WHERE id = {item_id}")
```

- Use `?` placeholders. Pass values as a tuple.
- f-strings or string concatenation in SQL is always a Critical finding.

## Migrations

- Write migrations as plain `.sql` files: `NNN_description.sql` (e.g., `001_initial.sql`).
- Every migration must be idempotent: use `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`.
- Never drop or rename columns without an explicit review — SQLite's `ALTER TABLE` support is limited.
- Run migrations in order; track applied migrations in a `schema_migrations` table.

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

## Schema Conventions

- Table names: `snake_case`, plural (`items`, `pipeline_runs`)
- Column names: `snake_case` (`run_id`, `created_at`)
- Primary keys: `id INTEGER PRIMARY KEY` (SQLite auto-assigns rowid alias)
- Foreign keys: `<table>_id` (`user_id REFERENCES users(id)`)
- Indexes: `idx_<table>_<cols>` (`idx_items_status`)
- Timestamps: ISO-8601 text (`datetime('now')`) or Unix integer — pick one per project and be consistent.

## Query Patterns

- Upsert: `INSERT OR REPLACE` or `INSERT ... ON CONFLICT ... DO UPDATE` — never check-then-insert (TOCTOU race).
- No `SELECT *` — select specific columns.
- Add indexes on FK columns and common `WHERE` / `ORDER BY` columns.
- Bound queries with `LIMIT` to prevent resource exhaustion.
- Use `BEGIN` / `COMMIT` explicitly for multi-statement operations, or rely on the context manager's implicit transaction.

## Test Isolation

- Tests use an in-memory database (`sqlite3.connect(":memory:")`) or a temp file via `tmp_path`.
- Never connect to the project's real database file in tests.
- Each test creates its own schema and cleans up on teardown.

## Prohibited

- No hardcoded file paths for the database — use an env var or config.
- No `SELECT *` in production queries.
- No raw SQL built from f-strings or string concatenation.
- No missing `foreign_keys=ON` pragma — omitting it silently disables FK enforcement.
- No destructive migrations (`DROP TABLE`, `DROP COLUMN`) without explicit architect review.
