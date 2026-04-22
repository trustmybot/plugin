---
name: code-quality
description: Shared quality criteria for design, implementation, and review. Used by Architect (design-time), SWE (implementation-time), and PR Reviewer (review-time). Covers error handling, edge cases, database safety, Python patterns, test isolation, and the self-review checklist.
---

# Code Quality Criteria

Shared reference for all agents. Each agent uses these criteria at their stage:
- **Architect** — verify the design addresses each category before writing task files
- **SWE** — verify the implementation handles each category before reporting COMPLETED
- **PR Reviewer** — verify the code satisfies each category, construct proofs for violations

---

## Error Handling

### Design-time questions (Architect)
- What happens when the database query returns no results?
- What happens when the database connection fails (timeout, pool exhausted)?
- What happens when the Claude CLI call fails (timeout, non-zero exit, missing output)?
- What happens when a file/directory doesn't exist?
- What happens when `config/settings.toml` has invalid or missing values?
- What happens when an HTTP request to fetch a JD fails?
- What happens when score parsing returns an unexpected format?
- Are errors logged with enough context to diagnose?

### Implementation rules (SWE)
- **Every async/DB/subprocess call** must have explicit error handling — try/except with specific exception types.
- **Never swallow errors silently.** At minimum, log the error with context before re-raising or returning a fallback.
- **Claude CLI calls** must handle: timeout, non-zero exit code, missing XML output tags, empty response.
- **File operations** must handle missing paths gracefully (create directories, return sensible defaults).
- **Pipeline node errors** should set appropriate status in `GanState` rather than crashing the entire pipeline.

### Review-time patterns (PR Reviewer)
- Bare `except:` or `except Exception` (catches `SystemExit`, `KeyboardInterrupt`)
- Empty except blocks (catch but do nothing, or only log without re-raising when the caller needs to know)
- Missing cleanup in error paths (DB connection opened but not returned to pool)
- `subprocess.run` without `timeout` parameter
- Claude CLI calls without checking return code or parsing output

---

## Edge Cases

### Design-time questions (Architect)
- What happens with an empty JD list? With no JDs for a specific version?
- What happens with a missing or empty rubric/prompt file?
- What happens when the database is unavailable?
- What happens with a zero-length or malformed resume?
- What happens when score parsing fails or returns non-numeric value?
- What happens when a company has no sponsorship data?
- What happens when all JDs are filtered out (too old, no sponsorship)?
- What happens at iteration boundaries (first iteration vs subsequent)?

### Implementation rules (SWE)
- **Validate before querying.** Check that inputs are valid before using them in SQL queries or API calls.
- **Handle None/empty explicitly.** Don't rely on truthy checks when None and empty string have different semantics.
- **Bound all collections.** Don't process unlimited JDs, unbounded search results, or unlimited iterations without safeguards.
- **Guard state transitions.** If a pipeline node requires specific state (e.g., "JDs must be loaded"), check the precondition and set an error status rather than crashing.

### Review-time patterns (PR Reviewer)
- `.get()` returning `None` fed into a function expecting `str`
- List operations on potentially empty lists (indexing, min/max, iteration)
- Path operations on non-existent directories without `os.makedirs` / `Path.mkdir(parents=True)`
- Dict access without `.get()` default or explicit `KeyError` handling
- `int()` / `float()` conversion without try/except on user-provided or LLM-generated values

---

## Database Safety

### Design-time questions (Architect)
- Are all queries parameterized?
- Is connection cleanup handled (context managers)?
- Are multi-statement operations wrapped in transactions?
- Are there indexes for new query patterns?
- Are upserts using `ON CONFLICT` or equivalent?
- Is test code isolated from production data?

### Implementation rules (SWE)
- **ALWAYS use parameterized queries** — use the driver's placeholder syntax, never f-strings or string concatenation.
- **Use context managers** for all connections — ensures cleanup even on error.
- **Upsert via `ON CONFLICT ... DO UPDATE`** — never check-then-insert (TOCTOU race).
- **Add indexes** for frequently queried columns and FK columns.
- **Use transactions** for multi-statement operations.
- **Best-effort writes** — DB failures in the pipeline should log warnings, not crash. The pipeline's primary output is files, not DB records.

### Review-time patterns (all agents)
- SQL via f-strings or string concatenation (injection risk) — **always Critical**
- Missing `ON CONFLICT` for unique-constrained inserts
- Connection not properly closed (must use `with` context manager)
- Missing transaction boundaries for multi-statement operations
- `SELECT *` when only specific columns needed
- Missing indexes on FK columns or common WHERE clauses
- **Test code connecting to production database** — tests MUST use isolated test DB

---

## Test Isolation (CRITICAL)

### Rules
- Tests **must never** read from or write to the production database.
- Test database is a separate database (configured in `conftest.py` or env var override — never the default production URL).
- Test fixtures must clean up after themselves — no leftover data between test runs.
- If a test needs seed data, it creates it in setup and removes it in teardown.
- Tests must not depend on external services (Claude API, JobSpy, HTTP fetches) — use mocks or fixtures.
- Any test that touches the filesystem must use `tmp_path` fixture, not real project directories.

### Review-time patterns (PR Reviewer)
- Hardcoded production database URL in test code
- Missing cleanup in test fixtures (data persists between runs)
- Tests calling real external APIs without mocking
- Tests writing to real project directories instead of tmp_path

---

## Security

### Design-time questions (Architect)
- Is user input sanitized before use in queries?
- Are sensitive values (API keys, DB credentials) kept out of logs and error messages?
- Are bulk operations bounded to prevent resource exhaustion?
- Are subprocess calls safe from injection (no shell=True with user input)?

### Review-time patterns (PR Reviewer)
- SQL injection via f-strings (always Critical)
- Sensitive data (passwords, API keys, tokens) in logs or error responses
- `subprocess.run` with `shell=True` and user-controllable input
- Unbounded queries without LIMIT
- Hardcoded credentials (should be in env vars or config)

---

## Python-Specific Patterns

### Implementation rules (SWE)
- No bare `except:` or `except Exception` — catch specific exceptions
- No mutable default arguments (`def f(items=[])`) — use `None` + conditional
- `datetime.utcnow()` is naive — use `datetime.now(timezone.utc)` for aware datetimes
- No `as Any` type ignoring
- Use `from __future__ import annotations` for modern type hints in new files
- Use `with` for all file/connection/cursor handling
- Subprocess calls must have `timeout` parameter

### Review-time patterns (PR Reviewer)
- Bare `except:` or `except Exception` (catches `SystemExit`, `KeyboardInterrupt`)
- Mutable default arguments
- `datetime.utcnow()` or naive datetimes mixed with aware ones
- Missing `with` for file/connection handling
- `subprocess.run` without `timeout`
- String concatenation for building file paths (use `pathlib.Path` or `os.path.join`)

---

## Self-Review Checklist (SWE use)

Run before reporting COMPLETED. If any item fails, fix it.

### Correctness
- [ ] Every error state from the task's **Error Handling** section is implemented
- [ ] Every scenario from the task's **Edge Cases** section is handled
- [ ] No bare except blocks
- [ ] No mutable default arguments
- [ ] No TODO/FIXME/HACK comments left in code
- [ ] No SQL via f-strings or string concatenation

### Consistency
- [ ] New code follows the same patterns as adjacent existing code
- [ ] Error handling uses the same approach as the rest of the module
- [ ] Naming matches snake_case convention throughout
- [ ] Imports follow the module's existing style

### Safety
- [ ] All SQL uses parameterized queries (`%s` placeholders)
- [ ] DB connections properly managed (pool context manager)
- [ ] File operations handle missing paths
- [ ] subprocess calls have timeouts
- [ ] Tests use isolated test database (never prod)
- [ ] No sensitive data in logs or error messages

### Verification (MANDATORY — must actually run, not skip)
- [ ] Run the project's lint command (e.g., `uv run ruff check src/ tests/` for Python)
- [ ] Run the relevant test suite (e.g., `uv run pytest tests/ -v` for Python changes)
- [ ] Build if applicable (check the project's build command)
- [ ] **Manual smoke test**: if the change affects runtime behavior, run the actual command and verify end-to-end. Do NOT report COMPLETED based on lint/build alone.
- [ ] Success criteria commands from the task file all pass

> Stack-specific verification commands live in per-stack skills (e.g., `python-dev/SKILL.md`). Check those for your language.

**CRITICAL: Every code change must be tested before reporting COMPLETED.** Untested code is rejected. Lint/build passing is necessary but NOT sufficient — you must run the corresponding unit tests and, for behavioral changes, verify the actual runtime behavior. If tests don't exist for the changed code, note that in your report.

> Common review findings: `skills/review-findings/SKILL.md`
