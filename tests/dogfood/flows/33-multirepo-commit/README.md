# 33-multirepo-commit

**Flow under test:** path discipline in a multi-repo workspace — `tasks.repo` / `tmb_default_repo` consult + repo-relative storage in `file_registry`.

**Pre-state**: `onboarding-named` fixture + workspace fixture with **two sibling inner git repos**:

```
PROJECT/
├── .claude/tmb/trajectory.db   ← workspace-rooted (MCP DB lives here)
├── api/                         ← inner git repo (tmb_default_repo='api')
│   ├── handler.py
│   └── utils.py
└── app/                         ← sibling repo bro must NOT index
    └── src/index.ts
```

`tmb_default_repo` is set to `"api"` via `INSERT OR REPLACE`.

**Trigger**: `@bro index the source files in the default repo (api/) into file_registry. Use repo-relative paths.`

**Expected behavior**:
1. Bro reads `tmb_default_repo` from `plugin_config`.
2. Bro globs / reads files in `api/`.
3. Bro inserts `file_registry` rows with **repo-relative** paths (`handler.py`, `utils.py`) — NOT workspace-rooted (`api/handler.py`).
4. Bro does not touch `app/`.

## Why this flow exists

Surfaced during #181 MR review: bro repeatedly mis-prefixes paths in multi-repo setups (e.g., commits with `plugin/skills/foo.md` instead of `skills/foo.md` + `git -C plugin`). Each prior "fix" was doctrine in a skill body; the model forgets between turns.

This flow catches the failure at the storage layer, where `file_registry.path` is supposed to be repo-relative.

## Scorers

| Scorer | What it asserts |
|---|---|
| `outcome.sql` | (1) ≥2 rows for `handler.py` + `utils.py`. (2) ZERO rows with `api/` or `app/` prefix. (3) ZERO rows with `index.ts` (proves no leak from sibling repo). |
| `tools-required.json` | `file_registry_upsert` |
| `tools-forbidden.json` | `task_create_batch`, `validation_record` (this is read-and-index, not code work) |
| `cost-budget.json` | Soft 50K / 90s |

## Related issues

- #2867 — replace headless fast-path with simulated-user (also exercises this turf)
- Path-discipline root-cause analysis (in #181 review thread) — proposes hook-level + MCP-tool-level enforcement; this flow is the test that catches regressions for whichever fix lands.
