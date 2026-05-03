# 10-codebase-memory-cold-start

Regression test for the Hybrid D' cold-start branch in `tmb_project-prescan` (#45). Existing repo has tracked files; `file_registry` is empty; `tmb_first-run-onboarding` is no longer needed (identity is seeded). Bro must:

1. Run the prescan
2. Detect "files exist + registry empty" (cold start)
3. Try `AskUserQuestion` ("deep scan or lazy?")
4. Fail in headless → invoke `tmb_headless-fallback` → default = lazy → log `headless_fallback` audit event
5. Continue with the actual ask (planning chain → issue_create → task_create_batch)

## Pre-state

- `onboarding-named` fixture (Test User identity, schema-seeded config)
- One source file (`src/existing.py`) committed to git
- Empty `file_registry`

## Trigger

`@bro implement a hello world function in src/hello.py`

## Scorers

- `outcome.sql`: headless_fallback event present + mentions cold-start scope; deep_scan_completed NOT present (default = lazy); issues + tasks created (planning chain ran)
- `tools-required.json`: file_registry_list (prescan check), audit_log + discussion_append (fallback audit), issue_create + task_create_batch (planning)
- `cost-budget.json`: soft

## Why this matters

Tests two doctrines together: (a) cold-start AskUserQuestion lives in `tmb_project-prescan`, (b) headless fallback to lazy is the documented default and is auditable.
