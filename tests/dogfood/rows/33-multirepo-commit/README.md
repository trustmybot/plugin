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

`tmb_default_repo` is set to `"api"` via `setup-l5.sh`.

**Trigger**: `@bro this is a multi-repo workspace. Index the default code repo's source files into file_registry...`

**Expected behavior**:
1. Bro reads `tmb_default_repo` → `"api"`
2. Indexes `handler.py` and `utils.py` with REPO-RELATIVE paths (no `api/` prefix)
3. Does NOT touch `app/` files

**L5 mode**: `setup-l5.sh` builds the two sibling repos + configures `tmb_default_repo`.
**L6 mode**: standalone row, not in chain.

## Scorers

| Scorer | What it asserts |
|---|---|
| `outcome.sql` | ≥2 file_registry rows for api files; 0 rows with workspace-rooted paths; 0 rows for app files |
| `tools-required.json` | `file_registry_upsert` |
| `tools-forbidden.json` | `task_create_batch`, `validation_record` |
| `cost-budget.json` | 50K / 90s soft |