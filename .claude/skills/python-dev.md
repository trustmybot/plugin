---
name: python-dev
description: Python development rules for SWE agents working in src/ and tests/.
---

# Python Development

## Environment

- Package manager: `uv` only. Never pip. Use `uv add`, `uv sync`, `uv run`.
- Runtime: Python 3.12+
- Config: project-specific settings file (e.g., `config/settings.toml`). Never hardcode DB URLs.
- DB URL: `DATABASE_URL` env var only. No fallbacks, no settings file DB config.

## Verification (mandatory before COMPLETED)

```bash
uv run ruff check src/ tests/
uv run pytest tests/ -v
```

## Naming

- Files, modules, variables, functions, params: `snake_case`
- Classes: `PascalCase`
- Constants: `UPPER_SNAKE_CASE`
- Private: leading underscore (`_parse_response()`)
- TypedDict fields: `snake_case`
- Test files: `test_<module>.py`
- CLI commands: `kebab-case` (`run-all`, `fetch-items`)
- CLI options: `--kebab-case` (`--max-iterations`)

## Patterns

- State: `TypedDict` for pipeline state
- Connection: always `with pool.connection() as conn:` or equivalent context manager
- Queries: always parameterized placeholders. Never f-strings or concatenation.
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

- Test code must never connect to production services or touch production data.
- Projects must configure a separate test DB via env var or `conftest.py` — never rely on the default DB URL.
- Fixtures clean up after themselves. No leftover data between runs.
- External services (HTTP, AI APIs): mock or fixture. Never real calls.
- Filesystem: use `tmp_path` fixture. Never real project directories.
- `from __future__ import annotations` in test files too.

## CLI (Click)

- Entry point: `cli.py`
- Commands: kebab-case names
- Options: `--kebab-case` with short flags where useful
- All commands respect the project config file for defaults
