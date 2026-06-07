# 33-multirepo-commit

**Flow under test:** path discipline in a multi-repo workspace — `tasks.repo` / `tmb_default_repo` consult + repo-relative indexing in the kuzu world model (graph DB per ADR 0002).

**Pre-state**: `onboarding-named` fixture + workspace fixture with **two sibling inner git repos**, each with a top-level `README.md` so `/scan` produces author-curated dir summaries in the kuzu graph:

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
2. Runs `scan_run` which populates the kuzu graph with Directory nodes for both inner repos
3. Repo-relative paths land as kuzu node keys (no `api/` or `app/` prefix)
4. Each node's `repo` field correctly distinguishes which inner repo it belongs to

**L5 mode**: `setup-l5.sh` builds the two sibling repos + configures `tmb_default_repo`.
**L6 mode**: standalone row, not in chain.

## Scorers

| Scorer | What it asserts |
|---|---|
| `outcome.sql` | `repos` table has ≥1 row with `name='api'`; `deep_scan_completed` audit row exists |
| `tools-required.json` | `scan_run` |
| `tools-forbidden.json` | `task_create_batch`, `validation_record` |
| `cost-budget.json` | 50K / 90s soft |
