---
name: sql-dev
description: PostgreSQL and migration development rules for SWE agents working with database code.
---

# SQL and PostgreSQL Development

## Database

PostgreSQL 18 runs locally via Homebrew (NOT Docker). All databases on port **5432**.

| Database | Purpose |
|----------|---------|
| `gan_cv` | Primary (production-ready) |
| `gan_cv_dev` | Dev experiments |
| `gan_cv_test` | pytest only -- `conftest.py` configures this |

Test code must NEVER connect to `gan_cv` (production data).

## Connection (Python -- psycopg3)

- Always use the connection pool: `with pool.connection() as conn:`
- Transactions for multi-statement ops: `with conn.transaction():`
- DATABASE_URL env var is the only way to configure the database. No hardcoded strings.

## Parameterized Queries (CRITICAL)

```python
# CORRECT
cursor.execute("SELECT * FROM jobs WHERE role_id = %s", (role_id,))

# WRONG -- SQL injection risk
cursor.execute(f"SELECT * FROM jobs WHERE role_id = {role_id}")
```

- Python (psycopg): `%s` placeholders, pass tuple of values
- TypeScript (Drizzle): query builder only, never raw SQL strings
- f-strings or string concatenation in SQL is always a Critical finding

## JSONB

Wrap Python dicts in `psycopg.types.json.Jsonb()` when passing to `%s` placeholders:
```python
cursor.execute("INSERT INTO logs (data) VALUES (%s)", (Jsonb({"key": "val"}),))
```

## Migrations

- Location: `src/pipelines/gan_cv/db/migrations/`
- Naming: `NNN_description.sql` (sequential: `001_initial.sql`, `002_add_rankings.sql`)
- Run: `uv run python -m gan_cv.db.migrate`
- After migration: sync Drizzle schema with `cd web/api && bunx drizzle-kit pull`

## Schema Conventions

- Table names: `snake_case`, plural (`jobs`, `pipeline_runs`, `prompt_modules`)
- Column names: `snake_case` (`run_id`, `posted_at`, `weighted_rank`)
- Indexes: `idx_<table>_<columns>` (`idx_job_rankings_role_weighted`)
- Constraints: `<table>_<columns>_<type>` (`jobs_role_id_url_key`)
- Timestamps: always `timestamptz`, never `timestamp` or `date` without timezone

## Query Patterns

- Upsert: `ON CONFLICT ... DO UPDATE` -- never check-then-insert (TOCTOU race)
- Use `RETURNING` when inserted/updated row data is needed
- No `SELECT *` -- select specific columns
- Add indexes on FK columns and common WHERE clauses
- Bound queries with `LIMIT` to prevent resource exhaustion

## Test Isolation

- Tests create their own data in setup, clean up in teardown
- No leftover data between test runs
- Test fixtures in `tests/conftest.py` handle connection setup to port 5434
- Never depend on dev data existing

## Drizzle (TypeScript side)

- Schema is read-only and introspected: `bunx drizzle-kit pull`
- Migrations are Python-owned -- TS never writes migrations
- Use Drizzle query builder for all queries
- Check `rows[0] === undefined` for empty results

## Prohibited

- No hardcoded connection strings anywhere
- No `timestamp` without timezone -- always `timestamptz`
- No raw SQL in TypeScript -- use Drizzle query builder
- No Docker-managed named volumes -- bind-mount to `.pgdata/`
