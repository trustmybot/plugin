---
name: python-dev
description: Python pipeline development rules for SWE agents working in src/ and tests/.
---

# Python Pipeline Development

## Environment

- Package manager: `uv` only. Never pip. Use `uv add`, `uv sync`, `uv run`.
- Runtime: Python 3.12+
- Stack: LangGraph, Click CLI, psycopg3, Claude AI
- Config: `config/settings.toml` for app settings. Never hardcode DB URLs.
- DB URL: `DATABASE_URL` env var only. No fallbacks, no settings.toml DB config.

## Verification (mandatory before COMPLETED)

```bash
uv run ruff check src/ tests/
uv run pytest tests/ -v          # uses test DB on port 5432
```

## Naming

- Files, modules, variables, functions, params: `snake_case`
- Classes: `PascalCase`
- Constants: `UPPER_SNAKE_CASE`
- Private: leading underscore (`_parse_response()`)
- TypedDict fields: `snake_case`
- Test files: `test_<module>.py`
- CLI commands: `kebab-case` (`run-all`, `fetch-jds`)
- CLI options: `--kebab-case` (`--max-iterations`)

## Patterns

- State: `TypedDict` for pipeline state (`GanState`)
- DB driver: psycopg3 with connection pool
- Connection: always `with pool.connection() as conn:`
- Queries: always parameterized `%s` placeholders. Never f-strings or concatenation.
- JSONB: wrap dicts in `psycopg.types.json.Jsonb()` for `%s` placeholders
- Transactions: `with conn.transaction():` for multi-statement ops
- Upserts: `ON CONFLICT ... DO UPDATE`. Never check-then-insert.
- Best-effort DB: pipeline DB writes log warnings, never crash the pipeline
- File paths: `pathlib.Path` or `os.path.join`. Never string concatenation.
- Subprocess: always include `timeout` parameter
- Context managers: `with` for all file/connection/cursor handling
- Datetimes: `datetime.now(timezone.utc)`. Never `datetime.utcnow()` (naive).
- Type hints: `from __future__ import annotations` in new files

## Prohibited

- Bare `except:` or `except Exception` (catches SystemExit, KeyboardInterrupt)
- Mutable default arguments (`def f(items=[])`) — use `None` + conditional
- `as Any` type ignoring
- TODO/FIXME/HACK comments in committed code
- `pip install` anything
- `datetime.utcnow()` or naive datetimes
- SQL via f-strings or string concatenation
- Hardcoded DB connection strings
- `shell=True` in subprocess calls with user input

## Testing

- Test DB: `gan_cv_test` on port 5432 (same Homebrew postgres). Never touch `gan_cv` (prod) or `gan_cv_dev`.
- Fixtures clean up after themselves. No leftover data between runs.
- External services (Claude API, HTTP, JobSpy): mock or fixture. Never real calls.
- Filesystem: use `tmp_path` fixture. Never real project directories.
- `from __future__ import annotations` in test files too.

## CLI (Click)

- Entry point: `cli.py`
- Commands: kebab-case names
- Options: `--kebab-case` with short flags where useful (`-r` for role)
- All commands respect `config/settings.toml` for defaults
