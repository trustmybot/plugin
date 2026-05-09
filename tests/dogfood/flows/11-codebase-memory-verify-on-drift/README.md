# 11-codebase-memory-verify-on-drift

Regression test for the verify-on-drift branch in `session-start-prescan.sh hook + tmb_planning §Step 0` (#45). Pre-state simulates a populated registry that's gone stale (file modified on disk after row was written). Bro must:

1. Run the prescan
2. Detect drift (dirty tree)
3. Call `file_registry_verify` → see `mismatch` for `src/foo.py`
4. Refresh the row (update content_md5 + summary, OR mark stale via cleared summary)
5. Continue with the actual ask

## Pre-state

- `onboarding-named` fixture
- `src/foo.py` committed at SEED_HEAD
- `file_registry` has a row for `src/foo.py` with deliberately-wrong md5 (`00000000...`) + outdated summary `"returns v1"`
- `last_verified_sha` = SEED_HEAD
- `src/foo.py` then modified on disk (uncommitted) — drift induced

## Trigger

`@bro fix the bug in src/foo.py`

## Scorers

- `outcome.sql`: `src/foo.py`'s `content_md5` is no longer the seeded all-zeros (verify pass refreshed it); planning chain ran
- `tools-required.json`: `file_registry_list` + `file_registry_verify` (the verify-on-drift call); planning chain MCP tools
- `cost-budget.json`: soft

## Why this matters

Closes the loop on the verify-context doctrine: when bro inherits a stale registry (e.g. teammate did a `git pull` that brought drift), the prescan catches it and fixes it before the planning chain is tricked by stale summaries.
