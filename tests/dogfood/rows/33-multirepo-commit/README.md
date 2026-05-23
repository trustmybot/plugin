# 33-multirepo-commit

**Flow under test:** path discipline in a multi-repo workspace — `tasks.repo` / `tmb_default_repo` consult + repo-relative storage in `directories` (world model substrate per ADR 0001).

**Pre-state**: `onboarding-named` fixture + workspace fixture with **two sibling inner git repos**, each with a top-level `README.md` so `/scan` produces author-curated dir summaries:

```
PROJECT/
├── .claude/tmb/trajectory.db   ← workspace-rooted (MCP DB lives here)
├── api/                         ← inner git repo (tmb_default_repo='api')
│   ├── README.md
│   ├── handler.py
│   └── utils.py
└── app/                         ← sibling repo
    ├── README.md
    └── src/index.ts
```

`tmb_default_repo` is set to `"api"` via `setup-l5.sh`.

**Trigger**: `@bro this is a multi-repo workspace. Run /scan and confirm the world model has the api repo indexed correctly.`

**Expected behavior**:
1. Bro reads `tmb_default_repo` → `"api"`
2. Runs `scan_run` which populates `directories` for both inner repos
3. Repo-relative paths land in `directories.path` (no `api/` or `app/` prefix in `path`)
4. `directories.repo` correctly distinguishes which inner repo each row belongs to

**L5 mode**: `setup-l5.sh` builds the two sibling repos + configures `tmb_default_repo`.
**L6 mode**: standalone row, not in chain.

## Scorers

| Scorer | What it asserts |
|---|---|
| `outcome.sql` | ≥1 `directories` row with `repo='api'`; 0 rows with workspace-rooted paths; 0 cross-repo leaks |
| `tools-required.json` | `scan_run` |
| `tools-forbidden.json` | `task_create_batch`, `validation_record` |
| `cost-budget.json` | 50K / 90s soft |
