# 33-multirepo-commit

**Flow under test:** path discipline in a multi-repo workspace — path-keyed repo resolution (each inner repo registered by path in the `repos` table; see [`docs/architecture/REPO_RESOLUTION.md`](../../../../docs/architecture/REPO_RESOLUTION.md)) + repo-relative indexing in the kuzu world model (graph DB per ADR 0002).

**Pre-state**: `onboarding-named` fixture + workspace fixture with **two sibling inner git repos**, each with a top-level `README.md` so `/scan` produces author-curated dir summaries in the kuzu graph:

```
PROJECT/
├── .claude/tmb/trajectory.db   ← workspace-rooted (MCP DB lives here)
├── api/                         ← inner git repo (registered in repos by path)
│   ├── README.md
│   ├── handler.py
│   └── utils.py
└── app/                         ← sibling repo (also registered by path)
    ├── README.md
    └── src/index.ts
```

Both inner repos are registered by path in the `repos` table via `setup-l5.sh` — `api` carries a per-repo `protected_branches=["main"]` (authoritative), `app` omits it (falls back to the global config).

**Trigger**: `@bro this is a multi-repo workspace. Run /scan and confirm the world model has the api repo indexed correctly.`

**Expected behavior**:
1. Each operation resolves to its repo by path against `repos.path` — no global default-repo name
2. Bro runs `scan_run` which populates the kuzu graph with Directory nodes for both inner repos
3. Repo-relative paths land as kuzu node keys (no `api/` or `app/` prefix)
4. Each node's `repo` field correctly distinguishes which inner repo it belongs to

**L5 mode**: `setup-l5.sh` builds the two sibling repos + registers both by path in the `repos` table.
**L6 mode**: standalone row, not in chain.

## Scorers

| Scorer | What it asserts |
|---|---|
| `outcome.sql` | `repos` table has both inner repos registered by path (`api` + `app`); `deep_scan_completed` audit row exists |
| `tools-required.json` | `scan_run` |
| `tools-forbidden.json` | `task_create_batch`, `validation_record` |
| `cost-budget.json` | 50K / 90s soft |
