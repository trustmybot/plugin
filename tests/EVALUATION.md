# Evaluation System (L5 + L6)

Two automated dogfood layers drive **real Claude Code through pre-seeded TMB workflows** and assert the result matches doctrine.

| Layer | Purpose | Scope per run | When to run |
|---|---|---|---|
| **L5** | Per-row independent unit tests. Each test starts from a fixture that pre-seeds the **cumulative state up to this row** (codebase, MCP DB, discussions, issues, tasks, audit, etc.). One row = one test. | Single bro turn (or short multi-turn) against pre-seeded state. Fast, isolated, ~$0.20/test. | Debug or regression-test a single row's contract. **First-line check after a fix** — if the L5 for that row doesn't pass, don't run L6. |
| **L6** | Single **chained integration test** that walks ALL 14 journey rows sequentially against ONE cumulative trajectory DB. Each row fires a fresh `claude -p` invocation; continuity is **DB-driven** (via bro's `tmb_recovery` + state-aware MCPs like `issue_state_get` / `task_first_actionable`), NOT LLM-session-driven. Row N's bro turn produces real DB writes that row N+1 inherits. The TODO-CLI codebase grows row by row. | Full 14-row chain. Slow, ~$0.30–1/scenario × 14 rows + per-row scoring. | After all relevant L5 rows pass, run L6 to verify cross-row DB continuity holds end-to-end. |

The full pyramid (L0 install-smoke → L1 lint → L2 unit → L3 integration → L4 workflow-sim → L5 → L6) lives in [`README.md`](./README.md). This doc is the reference for how L5 + L6 work and what each catches.

---

## Why these two layers

Layers below L5 are MCP-only — they validate handlers, protocol, and workflow contracts without involving a real LLM. That class of test catches schema drift, role enforcement, and FK violations in milliseconds, but it cannot catch the failure mode that matters most in production: **bro skipping a doctrinal step because the LLM forgot, misordered, or misinterpreted prose**.

**L5 catches per-row contract drift.** Each row is tested in isolation against a pre-seeded fixture, so a regression in (say) the registry-cold gate fails the L5 for row 4 cleanly without touching rows 5+. Fast iteration. The fixture pre-seeds the cumulative DB state — codebase + MCP DB rows for issues / tasks / discussions / audit / file_registry — that prior rows would have produced.

**L6 catches cross-row continuity drift.** Rows 1–14 chain in one CC session. Row 5 (SWE close) needs the task that row 4 (gate + recovery) produced; row 7 (push gate) needs the closed task + commit_sha from row 5; row 11 (roundtable) deliberates on the actual TODO CLI work from rows 4–10. L6 verifies the workflow doesn't break across the seam between rows.

**1:1 mapping** — every L5 chain row has a corresponding L6 chain step and vice versa. If you add a row to the journey table, you add an L5 fixture + scorer for it, and the L6 chain manifest gains an entry. They're sibling artifacts. Standalone rows (32+, consultant-ad-hoc, misc-*) are L5-only.

> Implementation tracking: [#2882](https://gitlab.com/trustmybot/plugin/-/issues/2882) is the L6 chain runner; [#2932](https://gitlab.com/trustmybot/plugin/-/issues/2932) merged L5 + L6 into one canonical `rows/` tree.

**Workflow when something fails:**

```
L6 chain fails at row 7 (push gate)
        ↓
Fix the bug (probably in tools/composites.ts or a hook)
        ↓
Run L5 row-7 alone against its fixture (~$0.20, ~30 sec)
        ↓ pass
Re-run L6 from scratch (~$5–10, ~10 min)
        ↓ pass
Done.
```

L6 reuses L5's fixtures, scorers, and shell helpers — they differ only in whether the runner replays the chain or stops at one row.

---

## Single canonical row tree

All rows live in **`tests/dogfood/rows/`**. Every row is usable in both L5 (isolated) and L6 (chained) mode via the same prompt + scorer set. The difference between modes:

| Aspect | L5 mode | L6 chain mode |
|---|---|---|
| Runner | `tests/dogfood/run-l5.sh` | `tests/dogfood/run-l6-chain.sh` |
| Pre-seed | `fixture.txt` seeds DB; `setup-l5.sh` (if present) adds env state | `fixture.txt` applied ONLY at chain step 1; subsequent steps inherit cumulative DB |
| `setup-l5.sh` | Runs (simulates prior-step state for isolation) | NOT run (chain state carries from prior step) |
| State threading | None — each row starts fresh | DB-driven across steps |

### Row layout

```
tests/dogfood/rows/<row-name>/
  prompt.txt              # shared by L5 + L6 — the user prompt fed to claude -p
  README.md               # scenario description for both L5 and L6 modes
  script.json             # max_turns, user_after_bro[], terminal_pattern
  fixture.txt             # named SQL fixture (e.g. onboarding-named) — applied in L5 always; L6 only at step 1
  setup-l5.sh             # L5-ONLY: pre-seeds env state that L6 inherits from prior chain step
  outcome.sql             # SQL assertions against trajectory.db (shared L5/L6)
  outcome-coherence.json  # cross-table row-count shape (shared)
  outcome-git.json        # git-state assertions (shared)
  outcome-files.json      # filesystem assertions (optional, shared)
  tools-required.json     # MCP / built-in tools that MUST appear in trajectory.jsonl (shared)
  tools-forbidden.json    # tools that MUST NOT appear (shared)
  cost-budget.json        # max tokens / max duration_ms (shared)
```

### `setup-l5.sh` convention

`setup-l5.sh` simulates the **state** that a prior chain step would have left behind. It receives two arguments:

```bash
bash setup-l5.sh <PROJECT_DIR> <SCENARIO_DIR>
```

It may create files in `$PROJECT`, run git commits in `$PROJECT`, or execute SQL against `$PROJECT/.claude/tmb/trajectory.db`. It MUST NOT modify `$SCENARIO_DIR` (read-only row dir).

Rows that need no extra state (e.g., `01-cold-start`, trivial standalone rows) still ship a `setup-l5.sh` containing only `:` — this makes the runner's `[ -f setup-l5.sh ]` check universally safe.

---

## Rows in the tree

### Chain rows (steps 1–14 — appear in `l6-chain/chain-manifest.json`)

| Step | Row | Notes |
|---|---|---|
| 1 | `01-cold-start` | First turn from clean state — bro auto-fires onboarding |
| 2 | `02-reonboard-implicit-from-local` | Local commits present, no remote — reonboard path |
| 3 | `03-reonboard-remote` | Remote already configured — reonboard remote path |
| 4 | `04-first-task-hits-gate` | First task request, scan gate fires |
| 5 | `05-swe-atomic-close` | SWE dispatched, atomic close |
| 6 | `06-post-close-cleanup` | Post-close branch/worktree cleanup |
| 7 | `07-push-gate` | Push gate with pseudo-remote |
| 8 | `08-architectural-change` | Mid-flow architectural decision |
| 9 | `09-concerns-protocol` | Concerns raised and resolved |
| 10 | `10-consultant` | Two-phase: `/tmb:agent-create cto` (Branch B template-copy) then cto evaluates `src/auth.py` |
| 11 | `11-roundtable` | Roundtable deliberation |
| 12 | `12-issue-resume` | Paused issue resumed |
| 13 | `13-pr-comment-review` | PR comments reviewed |
| 14 | `14-skill-invocation-recorded` | Skill invoked and recorded in trajectory |

### Standalone rows (L5 only — not in chain manifest)

| Row | What it tests |
|---|---|
| `15-simple-task` | Simple task triage + dispatch |
| `16-difficult-task` | Difficult task triage |
| `17-agent-creator` | Agent-creator specialist spawned |
| `18-skill-creation` | Skill-creation workflow |
| `19-swe-retry` | SWE retry after failed attempt |
| `20-codebase-memory-cold-start` | Codebase memory on cold start |
| `21-codebase-memory-verify-on-drift` | Codebase memory drift detection |
| `22-source-edit-attempt` | Source edit routing through SWE |
| `23-bulk-cleanup` | Bulk cleanup of scattered artifacts |
| `32-team-config` | Team config change (gitflow switch) |
| `33-multirepo-commit` | Multi-repo workspace path discipline |
| `92-base-branch` | pr_target respected in task creation |
| `95-anonymous-cold-restart` | Anonymous session cold-restart regression |
| `96-halt-on-error` | Halt-on-error doctrine |
| `consultant-ad-hoc` | Ad-hoc consultant (architect) ask |
| `misc-reonboard-redirect` | Reonboard routing redirect |
| `misc-roundtable-routing-redirect` | Roundtable routing redirect |
| `misc-skill-register-on-creation` | Skill auto-register on creation |

---

## L5 — per-row runner

L5 fires `claude -p` against a pre-seeded fixture once per row, captures the trajectory, scores it.

```bash
bash tests/dogfood/run-l5.sh 07-push-gate           # one row by substring, ~30-60s
bash tests/dogfood/run-l5.sh                        # all rows
```

When to use L5: debugging one row, regression-tracing after a fix, pre-flight before re-running L6.

### Per-row execution

1. Set up a fresh scratch project (`mktemp -d`, `git init -b main`, identity config, `.gitignore`, `.claude/tmb/` dir).
2. Seed the DB: apply `schema.sql` then the row's `fixture.txt` SQL fixture.
3. Run `setup-l5.sh "$PROJECT" "$ROW_DIR"` for extra pre-state (seed tasks, scatter files, copy templates).
4. Run claude via `l6c_run_step` with `script.json` config (max_turns, user_after_bro, terminal_pattern); capture `trajectory.jsonl` + `trajectory.db`.
5. Run every present scorer against the captured artifacts. The row passes only when every required scorer passes.

The trajectory is preserved at `~/.claude/tmb/l5-trajectories/<row>/<run_id>/` regardless of pass/fail.

### FILTER argument

```bash
bash tests/dogfood/run-l5.sh <SUBSTRING>
```

Runs only rows whose directory name contains `<SUBSTRING>`. Examples:
- `bash tests/dogfood/run-l5.sh 14` → runs `14-skill-invocation-recorded`
- `bash tests/dogfood/run-l5.sh consultant` → runs `consultant-ad-hoc`
- `bash tests/dogfood/run-l5.sh misc` → runs all three `misc-*` rows

---

## L6 — chained integration runner

L6 walks all 14 journey rows sequentially against ONE cumulative trajectory DB. Each row fires a fresh `claude -p` invocation — **continuity is DB-driven**, not LLM-session-driven.

```bash
bash tests/dogfood/run-l6-chain.sh                  # full chain, all 14 rows
bash tests/dogfood/run-l6-chain.sh --from 7         # resume from a specific row
bash tests/dogfood/run-l6-chain.sh --halt-on-fail 0 # don't stop at first fail
bash tests/dogfood/run-l6-chain.sh --fresh          # force fresh from row 1
```

When to use L6: integration smoke before any release; verifying cross-row continuity after fixes that span multiple rows.

### Driver semantics

1. Single project, single DB, single git repo — initialised once at chain start.
2. `fixture.txt` from row 1 (`01-cold-start`) applied at chain start only.
3. For each row in `l6-chain/chain-manifest.json`:
   - Apply `seed_before` SQL (if present) — between-row state bridge.
   - **Do NOT run `setup-l5.sh`** — L5 isolation setups are not applied in chain mode.
   - Send `prompt.txt` via a fresh `claude -p` invocation (no `--resume`).
   - Score the post-state against the row's outcome bundle.
   - For partial-test rows: inject `seed_after` SQL before row N+1.
   - Write per-step log section.
4. Halt on first row failure with `halt_on_fail: true` (subsequent rows not attempted).

### File layout

```
tests/dogfood/
├── run-l5.sh                 # orchestrator — iterates rows/ tree
├── run-l6-chain.sh           # chain runner — manifest-driven
├── lib/
│   ├── flow-helpers.sh       # row-level setup + run + score helpers
│   ├── l6-chain-helpers.sh   # l6c_run_step, l6c_score_step, l6c_snapshot_db, etc.
│   ├── scorers.sh            # outcome / coherence / git / trajectory / cost scorer impls
│   ├── smoke-helpers.sh      # pre-flight substrate health (MCP spawn + auth + plugin-load)
│   └── timeout-shim.sh       # cross-platform timeout wrapper
├── rows/<row-name>/          # canonical row layout (used by both L5 + L6)
│   ├── README.md
│   ├── fixture.txt
│   ├── setup-l5.sh
│   ├── script.json
│   ├── prompt.txt
│   ├── outcome.sql
│   ├── outcome-coherence.json
│   ├── outcome-git.json
│   ├── tools-required.json
│   ├── tools-forbidden.json
│   └── cost-budget.json
├── l6-chain/
│   ├── chain-manifest.json   # ordered list of chain rows + seed bridges
│   └── seeds/                # between-row SQL seeds (after-NN-name.sql)
└── fixtures/                 # SQL fixtures (empty / onboarding-named / onboarding-anonymous / …)
```

### Per-step log section

Every L6 run produces a per-step log so failures are debuggable without replaying the whole chain.

```
<run-id>/
├── chain-summary.md             # one-page report: row-by-row pass/fail + cost + duration
├── chain-trajectory.jsonl       # cumulative stream-json concatenated across all per-row claude -p turns
├── step-01-cold-start/
│   ├── pre-state.sql            # DB snapshot before this row fires
│   ├── user-input.txt           # the user prompt sent this turn
│   ├── bro-response.txt         # bro's text output (extracted from trajectory)
│   ├── tool-uses.jsonl          # MCP + built-in tool calls bro made this turn
│   ├── post-state.sql           # DB snapshot after this row's turn
│   ├── post-state.diff          # delta vs pre-state (rows added/changed)
│   ├── scorers.json             # per-scorer pass/fail
│   └── seed-applied.sql         # if partial-test, the post-AUQ pseudo-data injected before row N+1
├── step-02-reonboard-implicit-from-local/
│   └── …
…
└── step-14-skill-invocation-recorded/
    └── …
```

---

## Scorers

| Scorer | File | Asserts |
|---|---|---|
| **outcome** | `outcome.sql` | One or more SQL queries returning a `(pass, description)` tuple per assertion. Run against `.claude/tmb/trajectory.db`. |
| **outcome-coherence** | `outcome-coherence.json` | Cross-table row-count shape: `{"<table> [WHERE <clause>]": ">=N" / "<=N" / "=N" / "!=N"}`. Catches empty-table omissions. |
| **outcome-git** | `outcome-git.json` | Final git state: `base_branch_unchanged` / `worktree_head_branch` / etc. Catches workflow-violating commits on the wrong branch. |
| **trajectory_required** | `tools-required.json` | Every named tool appears at least once in `trajectory.jsonl`. |
| **trajectory_forbidden** | `tools-forbidden.json` | None of the named tools appear in `trajectory.jsonl`. |
| **cost** | `cost-budget.json` | `tokens_total` and `duration_ms` stay within budgets. Soft-warn or hard-fail per-row. |
| **files** *(optional)* | `outcome-files.json` | Filesystem assertions: `must_exist` / `must_not_exist` / `min_bytes` per path. |

A row passes when every scorer it ships passes. Missing optional scorers are skipped silently.

#### `outcome-coherence.json` shape

```json
{
  "expected_writes": {
    "issues":              ">=1",
    "tasks":               ">=1",
    "discussions":         ">=1",
    "audit":               ">=2",
    "validation_attempts": "0",
    "tasks WHERE branch_id != 'dev'": ">=1"
  }
}
```

#### `outcome-git.json` shape

```json
{
  "worktree_head_branch":      "<task.branch_id>",
  "worktree_head_not_branch":  ["dev", "main", "develop"],
  "base_branch_unchanged":     true,
  "uncommitted_in_worktree":   false
}
```

---

## Adding a new test

| Goal | Where | Pattern |
|---|---|---|
| New standalone L5 row | `tests/dogfood/rows/<name>/` | scaffold per canonical layout; chain manifest unchanged |
| New L6 chain step | `tests/dogfood/rows/<NN>-<name>/` + `l6-chain/chain-manifest.json` | add row dir; append entry to manifest with `step`, `id`, `row_dir`, `seed_before`/`seed_after` |
| New scorer type | `tests/dogfood/lib/scorers.sh` | add `score_<name>`; register in `l5_score_flow` / `l6c_score_step` |

## Non-goals

- **Code quality.** L5 + L6 verify the **workflow** runs programmatically — bro hits the right gates, writes the right rows, dispatches the right subagents in the right order. They do NOT lint the SWE-produced code, score architectural quality, or assert specific implementation choices. Code-quality enforcement is the user's project's responsibility (their CI, their reviewers); TMB's tests cover only the orchestration layer.
