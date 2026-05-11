# Evaluation System (L5 + L6)

Two automated dogfood layers drive **real Claude Code through pre-seeded TMB workflows** and assert the result matches doctrine.

| Layer | Purpose | Scope per run | When to run |
|---|---|---|---|
| **L5** | Per-row independent unit tests. Each test starts from a fixture that pre-seeds the **cumulative state up to this row** (codebase, MCP DB, discussions, issues, tasks, audit, etc.). One row = one test. | Single bro turn (or short multi-turn) against pre-seeded state. Fast, isolated, ~$0.20/test. | Debug or regression-test a single row's contract. **First-line check after a fix** — if the L5 for that row doesn't pass, don't run L6. |
| **L6** | Single **chained integration test** that walks ALL 13 journey rows sequentially against ONE cumulative trajectory DB. Each row fires a fresh `claude -p` invocation; continuity is **DB-driven** (via bro's `tmb_recovery` + state-aware MCPs like `issue_state_get` / `task_first_actionable`), NOT LLM-session-driven. Row N's bro turn produces real DB writes that row N+1 inherits. The TODO-CLI codebase grows row by row. | Full 13-row chain. Slow, ~$0.30–1/scenario × 13 rows + per-row scoring. | After all relevant L5 rows pass, run L6 to verify cross-row DB continuity holds end-to-end. |

The full pyramid (L0 install-smoke → L1 lint → L2 unit → L3 integration → L4 workflow-sim → L5 → L6) lives in [`README.md`](./README.md). This doc is the reference for how L5 + L6 work and what each catches.

---

## Why these two layers

Layers below L5 are MCP-only — they validate handlers, protocol, and workflow contracts without involving a real LLM. That class of test catches schema drift, role enforcement, and FK violations in milliseconds, but it cannot catch the failure mode that matters most in production: **bro skipping a doctrinal step because the LLM forgot, misordered, or misinterpreted prose**.

**L5 catches per-row contract drift.** Each row is tested in isolation against a pre-seeded fixture, so a regression in (say) the registry-cold gate fails the L5 for row 4 cleanly without touching rows 5+. Fast iteration. The fixture pre-seeds the cumulative DB state — codebase + MCP DB rows for issues / tasks / discussions / audit / file_registry — that prior rows would have produced.

**L6 catches cross-row continuity drift.** Rows 1–13 chain in one CC session. Row 5 (SWE close) needs the task that row 4 (gate + recovery) produced; row 7 (push gate) needs the closed task + commit_sha from row 5; row 11 (roundtable) deliberates on the actual TODO CLI work from rows 4–10. L6 verifies the workflow doesn't break across the seam between rows.

**1:1 mapping** — every L5 row has a corresponding L6 chain step and vice versa. If you add a row to the journey table, you add an L5 fixture + scorer for it, and the L6 chain manifest gains an entry. They're sibling artifacts.

> Implementation tracking: [#2882](https://gitlab.com/trustmybot/plugin/-/issues/2882) is the L6 chain runner; [#2883](https://gitlab.com/trustmybot/plugin/-/issues/2883) migrates the existing scenarios to the per-row L5 layout.

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

## L5 — per-row runner

L5 fires `claude -p` against a pre-seeded fixture once per row, captures the trajectory, scores it. Each row's fixture seeds the cumulative state up to that row (codebase + MCP DB rows for issues / tasks / discussions / audit / file_registry), so any single row is testable in isolation.

```bash
bash tests/dogfood/run-l5.sh 07-push-gate           # one row, ~30-60s
bash tests/dogfood/run-l5.sh                        # all rows
```

When to use L5: debugging one row, regression-tracing after a fix, pre-flight before re-running L6.

### File layout

```
tests/dogfood/
├── run-l5.sh                 # orchestrator — iterates rows
├── lib/
│   ├── flow-helpers.sh       # row-level setup + run + score helpers
│   ├── scorers.sh            # outcome / coherence / git / trajectory / cost scorer impls
│   ├── smoke-helpers.sh      # pre-flight substrate health (MCP spawn + auth + plugin-load)
│   └── timeout-shim.sh       # cross-platform timeout wrapper
├── l5-rows/<NN>-<name>/
│   ├── README.md             # what this row tests
│   ├── fixture.txt           # named SQL fixture seeded before the row fires
│   ├── setup.sh              # extra pre-state injection (rows + files) on top of the fixture
│   ├── prompt.txt            # the user prompt fed to claude -p
│   ├── outcome.sql           # SQL assertions against trajectory.db
│   ├── outcome-coherence.json  # cross-table row-count shape
│   ├── outcome-git.json      # final git state assertions
│   ├── tools-required.json   # MCP / built-in tools that MUST appear in trajectory.jsonl
│   ├── tools-forbidden.json  # tools that MUST NOT appear
│   └── cost-budget.json      # max tokens / max duration_ms
├── fixtures/                 # SQL fixtures (empty / onboarding-named / onboarding-anonymous / …)
└── ab-scenarios/             # A/B prompt-eval scenarios (see README.md § A/B)
```

### Per-row execution

1. Set up a fresh scratch project (`mktemp -d`, `git init -b main`, identity config, `.gitignore`, `.claude/tmb/` dir).
2. Seed the DB: apply `schema.sql` then the row's `fixture.txt` SQL fixture.
3. Run the row's `setup.sh` for extra pre-state (seed tasks, scatter files, copy templates).
4. Run claude: `claude --plugin-dir <plugin> --dangerously-skip-permissions --output-format stream-json --include-hook-events --include-partial-messages --verbose -p "$prompt"` with the test-mode AUQ-suppression prefix prepended; capture `trajectory.jsonl` + `trajectory.db`.
5. Run every present scorer against the captured artifacts. The row passes only when every required scorer passes.

The trajectory is preserved at `~/.claude/tmb/l5-trajectories/<row>/<run_id>/` regardless of pass/fail.

### Scorers

| Scorer | File | Asserts |
|---|---|---|
| **outcome** | `outcome.sql` | One or more SQL queries returning a `(pass, description)` tuple per assertion. Run against the scratch project's `.claude/tmb/trajectory.db`. |
| **outcome-coherence** | `outcome-coherence.json` | Cross-table row-count shape: `{"<table> [WHERE <clause>]": ">=N" / "<=N" / "=N" / "!=N"}`. Catches empty-table omissions where per-row `outcome.sql` is incomplete. |
| **outcome-git** | `outcome-git.json` | Final git state: `worktree_head_branch` / `worktree_head_not_branch` / `base_branch_unchanged` / `uncommitted_in_worktree`. Catches workflow-violating commits on the wrong branch. |
| **trajectory_required** | `tools-required.json` | Every named tool appears at least once in the assistant's `tool_use` blocks in `trajectory.jsonl`. |
| **trajectory_forbidden** | `tools-forbidden.json` | None of the named tools appear in `trajectory.jsonl`. |
| **cost** | `cost-budget.json` | `tokens_total` and `duration_ms` (from the `result` event) stay within the budgets. Soft-warn or hard-fail per-row. |
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

Scorer runs `SELECT COUNT(*) FROM <table> [WHERE <suffix>]` per key and checks against the operator (`>=N` / `<=N` / `=N` / `!=N` / bare `N`). The optional `WHERE <suffix>` lets row authors target specific shape ("at least one task whose branch_id isn't dev").

#### `outcome-git.json` shape

```json
{
  "worktree_head_branch":      "<task.branch_id>",
  "worktree_head_not_branch":  ["dev", "main", "develop"],
  "base_branch_unchanged":     true,
  "uncommitted_in_worktree":   false
}
```

- `worktree_head_branch`: resolves `<task.branch_id>` from the most recent `tasks` row in DB; runs `git -C .claude/worktrees/<slug> rev-parse --abbrev-ref HEAD` and asserts equals.
- `worktree_head_not_branch`: same probe, asserts NOT equals any in the list.
- `base_branch_unchanged`: counts commits on `<pr_target>` before vs after; asserts equal (snapshot-based).
- `uncommitted_in_worktree`: asserts `git status --porcelain` empty.

### What L5 catches

- **DB-write contract violations** — a planning row that doesn't write `discussions`; a config-change row that flips policy keys without an audit event; a multi-repo row that writes workspace-rooted paths into `file_registry`.
- **Tool-call order violations** — bro calling `task_create_batch` before `issue_create`; SWE writing `file_registry_update_summaries` (bro-only); pr-reviewer paraphrasing the MCP-availability prefix.
- **Cross-table coherence** — empty-table omissions, missing planning audits, unsigned commits sneaking past the push gate.
- **Git-state coherence** — worktree HEAD on the wrong branch, base branch advancing during a flow, uncommitted edits at row close.
- **Cost regressions** — a row that used to finish in 30s now taking 300s.
- **Cold-start trajectories** — bro on a fresh DB auto-firing `/onboard` (or failing to).

### What L5 cannot catch

- **Cross-row continuity.** Each L5 row resets state to its fixture; can't catch regressions that only emerge after several bro turns sharing one DB. That's L6's job.
- **Subjective doctrine.** "Did bro explain the trade-off before acting?" "Was the spec body adequately scoped?" SQL can't score these — covered by the LLM-as-judge scorer (see [#2882](https://gitlab.com/trustmybot/plugin/-/issues/2882)) when implemented.
- **Multi-turn AUQ ceremonies.** AUQ is suppressed in test mode (the runner injects a "do not call AskUserQuestion" prefix). Rows whose production behaviour is "bro renders AUQ rounds" use the partial-test pattern (see TODO-CLI journey below); the full AUQ ceremony lives in manual smoke.

---

## L6 — chained integration runner

L6 walks all 13 journey rows sequentially against ONE cumulative trajectory DB. Each row fires a fresh `claude -p` invocation — **continuity is DB-driven**, not LLM-session-driven. Bro's `tmb_recovery` skill + state-aware MCPs (`issue_state_get`, `task_first_actionable`, `issue_resume`, etc.) pick up real cross-session state from the DB. Row N's bro turn writes to the DB; row N+1's fresh bro reads those writes on startup. This mirrors how cross-session resume actually works in production. The TODO CLI codebase grows row by row.

```bash
bash tests/dogfood/run-l6-chain.sh                  # full chain, all 13 rows
bash tests/dogfood/run-l6-chain.sh --from 7         # resume from a specific row
bash tests/dogfood/run-l6-chain.sh --halt-on-fail 0 # don't stop at first fail
```

Per-row standalone (L5 per-row layer, despite the historical filename):

```bash
bash tests/dogfood/run-l6.sh 07-push-gate     # one row by substring
bash tests/dogfood/run-l6.sh                  # all rows independently
```

When to use L6: integration smoke before any release; verifying cross-row continuity after fixes that span multiple rows.

### File layout

L6 reuses L5's per-row outcome bundles; the chain manifest just lists rows in order plus the seed bridges between them.

```
tests/dogfood/
├── l5-rows/<NN>-<name>/        # per-row outcome bundle (also runs as L5 unit)
│   ├── README.md
│   ├── fixture.txt
│   ├── setup.sh
│   ├── prompt.txt              # user prompt for this row
│   ├── outcome.sql
│   ├── outcome-coherence.json
│   ├── outcome-git.json
│   ├── tools-required.json
│   ├── tools-forbidden.json
│   └── cost-budget.json
└── l6-chain/
    ├── chain-manifest.json     # ordered list of rows + post-AUQ seeds
    └── runs/<run-id>/          # per-step logs (see below)
```

### Driver semantics

1. `l6_setup_scratch_project` — single project, single DB, single git repo. Initialised once at chain start.
2. For each row in `chain-manifest.json`:
   - Apply pre-state seed (fixture or prior-row carry-forward).
   - Send `prompt.txt` via a fresh `claude -p` invocation (no `--resume`).
   - Score the post-state against the row's outcome bundle.
   - For 🟡 partial-test rows: inject post-AUQ pseudo-data before row N+1.
   - Write per-step log section.
3. Halt on first row failure (subsequent rows not attempted).

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
│   └── seed-applied.sql         # if 🟡 partial-test, the post-AUQ pseudo-data injected before row N+1
├── step-02-onboard-local/
│   └── …
…
└── step-13-pr-comment-review/
    └── …
```

`chain-summary.md` example:

```
| #  | Row                              | Status | Tokens  | Duration | Notes                                  |
|----|----------------------------------|--------|---------|----------|----------------------------------------|
| 1  | Cold start                       | ✅ pass | 320     | 4.2s     | onboard intent: state_get + questions  |
| 2  | Onboard local (partial-test)     | ✅ pass | (seed)  | 0.0s     | identity + plugin_config seeded        |
| 3  | Reonboard remote (partial-test)  | ✅ pass | 290     | 3.8s     | state_get + questions(shape='remote')  |
| 4  | First task hits gate             | ❌ FAIL | 4,210   | 89s      | scorer 'tasks ≥1' got 0 — gate didn't  |
                                                                          clear after scan_run                   │
…
```

When a row fails: read its `scorers.json`, diff `pre-state.sql` ↔ `post-state.sql`, fix the bug, run the L5 unit for that row alone, then rerun L6.

---

## Adding a new test

| Goal | Where | Pattern |
|---|---|---|
| New L5 row | `tests/dogfood/l5-rows/<NN>-<name>/` | scaffold per L5 layout above |
| New L6 chain step | `tests/dogfood/l6-chain/chain-manifest.json` | append entry pointing at the L5 row's outcome bundle + post-AUQ seed if partial-test |
| New scorer type | `tests/dogfood/lib/scorers.sh` | add a function `score_<name>`; register it in `l5_score_row` / the L6 chain step scorer |

## Non-goals

- **Code quality.** L5 + L6 verify the **workflow** runs programmatically — bro hits the right gates, writes the right rows, dispatches the right subagents in the right order. They do NOT lint the SWE-produced code, score architectural quality, or assert specific implementation choices. Code-quality enforcement is the user's project's responsibility (their CI, their reviewers); TMB's tests cover only the orchestration layer.
- **Flake tolerance.** Tests must be deterministic. There is no "passes 90/100 runs is still useful" allowance — a single failure means a real workflow regression that compounds in production (e.g. if bro skips `/scan` once, every subsequent task pays the cost of re-reading the whole codebase). If a row is flaky, the underlying bug is real and must be fixed at the deterministic-layer level (server gate, hook, schema CHECK) per `docs/architecture/DETERMINISM.md` — not papered over with a retry loop.

---

## End-to-end journey: TODO CLI app

A canonical journey that exercises every actor, every gate, and every hook from cold start to PR merge. Each row is a **self-contained L5 unit** (one row, one fixture, one scorer bundle) that doubles as a step in the L6 chain. Reading the table top-to-bottom is the L6 chain order; reading any single row is the L5 unit definition.

Rules:

- **One row = one L5 unit + one L6 chain step.**
- **Cells without an actor write `—`.** Empty cells make it explicit which actors are dormant in that step.
- **Outcome assertions cite DB tables / files / audit events** — what the scorers check.
- **Partial-test pattern** for AUQ-bearing rows. The L5/L6 runner injects `[TEST MODE] Do not call AskUserQuestion. Apply documented defaults from skills/CLAUDE.md and continue.` so AUQ rarely fires. For rows whose production behaviour is "bro renders AUQ rounds" (e.g. onboard, branch-id confirm, difficult Q+A loop), the test cannot drive AUQ. The pattern is:
  1. **Success criterion = bro initiates the AUQ chain.** Observable via the MCP calls bro makes BEFORE rendering AUQ — for onboard, that's `onboard_state_get` and/or `onboard_get_questions`. Asserted via `tools-required.json`.
  2. **Stop the test.** The scenario terminates after the intent signal.
  3. **Fixture seeds the post-AUQ state** so the next row can run. `onboarding-named.sql` seeds `identity` + `plugin_config` keys + `deep_scan_completed` audit; etc.
  4. **AUQ rendering** (option labels, multi-round flow, "selected" highlighting) is **manual smoke** — `tests/manual/scenarios.md` §② onboarding + §roundtable. Not L6 territory.

  Rows that use the partial-test pattern are tagged **🟡 partial-test** in the table below.

| # | Step / sub-flow | User input | Bro reaction | MCP / Hook | SWE | pr-reviewer | Consultant | Asserted outcome |
|---|---|---|---|---|---|---|---|---|
| 1 🟡 | **Cold start (partial-test)** | `@bro hi\n\nDon't ask questions.` | Auto-routes to onboard via `activation-routine.sh` (`onboarded=no` context). Calls `onboard_state_get` to confirm first-run; in headless mode applies documented defaults. | `activation-routine.sh` injects `onboarded=no` | — | — | — | `tools-required` includes `onboard_state_get`. Identity may or may not land in the same turn (bro varies); row 2's seed locks in cumulative state for downstream. |
| 2 🟡 | **Onboard — local shape (partial-test)** | `@bro I want to make this project available on GitLab.\n\nDon't ask questions.` | bro calls `onboard_state_get`. Either path is acceptable: (a) auto-apply via `onboard_apply(shape='remote', remote=['gitlab'], …)` or (b) recommend `/onboard` in text and stop. The `reonboard-intent-hint.sh` hook nudges either way. | hint fires on "available on gitlab" pattern | — | — | — | `tools-required` includes `onboard_state_get`; `tools-forbidden` blocks task/issue/Agent only (no code work); outcome.sql verifies identity intact + scan audit intact. |
| 3 🟡 | **Reonboard — change to remote (gitflow + GitLab) (partial-test)** | `/onboard\n\nDon't ask questions.` | Bro calls `onboard_state_get` (sees `first_run=false`), then applies documented remote-shape defaults in headless mode. | The onboard slash handler routes to bro | — | — | — | `tools-required` includes `onboard_state_get`. After this row a chain seed flips `branching_model='"gitflow"'`, `pr_target='"dev"'`, `remotes` length=1 for downstream. |
| 4 | **First task hits registry-cold gate; bro recovers via `scan_run`** | `@bro make a todo CLI in Python.\n\nDon't ask questions.` | Calls `task_create_batch` → server returns `registry_cold_violation` → bro reads error, calls `scan_run` (auto-fire path per `commands/scan.md`) → writes `kind='decision'` (universal decision gate) → re-tries `task_create_batch` (now passes) → spawns SWE. Filenames are bro's choice. | `tasks.ts` registry-cold + decision gates both clear on retry; `scan_run` forks `scripts/scan.sh`, bulk-upserts `repos` + `file_registry`, emits `audit(event_type='deep_scan_completed')`, sets `tmb_default_repo` | Picks up via `task_get`, scaffolds the CLI, commits, calls `task_update_status(completed, commit_sha)` | — | — | ≥1 `deep_scan_completed` audit; `repos` row count > 0; `file_registry` populated; ≥1 `kind='decision'` discussion; `tasks` row created; SWE commit lands |
| 5 | **SWE atomic-close + bro V1/V2/V3** | (no input; bro continues from row 4) | Verifies V1 (files match spec), V2 (verification commands pass), V3 (success criteria visibly met); writes `file_registry_update_summaries` for touched paths; calls `bro_atomic_close` | `bro_atomic_close` writes audit + summaries + flips task to `closed` + closes issue if last task — one transaction; `swe-atomic-close.sh` SubagentStop hook writes `agent_runs` row | Was running in row 4; SubagentStop fires here | — | — | `agent_runs` row count ≥1 with `task_id` set; task `status='closed'`; `file_registry` row at `cli.py` has non-null summary |
| 6 | **Post-close auto-rescan + worktree cleanup** | (no input; hooks fire automatically) | — (passive; both hooks run after `bro_atomic_close`) | `post-task-close-rescan.sh` PostToolUse on `bro_atomic_close` backgrounds `scripts/maintenance/run-scan.mjs` (md5-driven drift; summary cleared on changed files). `cleanup-worktree-on-task-close.sh` PostToolUse on `task_update_status(closed)` removes `.claude/worktrees/<slug>/`. Architecture-doc auto-update is folded in via #2881. | — | — | — | ≥2 `deep_scan_completed` audit rows; `.claude/worktrees/feat-todo-add/` directory does NOT exist post-hook; (post-#2881) `regen_state` updated when scan detected structural change |
| 7 | **Push gate — pr-reviewer on the FEATURE branch (NOT in worktree)** | `@bro git push\n\nDon't ask questions.` | `push-intent-hint.sh` UserPromptSubmit hook detects "git push" and injects context listing pending validation tasks on the current branch. Bro spawns pr-reviewer via `Agent` **without `isolation='worktree'`**; on signoff, retries the push. | `push-intent-hint.sh` UserPromptSubmit injects task list. `git-push-guard.sh` PreToolUse on Bash blocks unsigned push. `pr-reviewer-no-worktree.sh` PreToolUse on Agent denies `isolation='worktree'`. `validation_record` writes `validation_attempts` with the `MCP available: yes…` prefix (schema-CHECK enforced). | — | Runs from main checkout. Reads task spec + commit via `task_get`; calls `validation_record` with proper prefix. | — | `validation_attempts` row ≥1 with `verdict='pass'` AND `agent='pr-reviewer'`; push succeeds on the retry; `agent_runs` row for pr-reviewer has no worktree-path marker |
| 8 | **Architectural change — switch auth to Clerk** | `@bro let's switch to Clerk for auth.\n\nDon't ask questions.` | `adr-required-hint.sh` UserPromptSubmit detects the architectural intent and injects an advisory. Bro writes `kind='decision'` (universal decision gate), co-authors an ADR at `docs/trustmybot/architecture/manual/decisions/N-*.md`, then `task_create_batch` + SWE spawn. Single turn — bro applies conservative defaults instead of running an AUQ Q+A loop (CC plan mode replaces it when humans want deliberation). | `adr-required-hint.sh` advisory + universal decision gate enforces the `kind='decision'` row | Picks up + implements migration | — | — | ≥1 `kind='decision'` discussion; tasks row created; SWE commit lands |
| 9 | **Concerns-protocol — ambiguous test edit** | `@bro tests/test_calculator.py is using exact equality, switch it to approxEqual with tolerance 0.001.\n\nDon't ask questions.` | `concerns-protocol-hint.sh` detects "switch to approxEqual / with tolerance" pattern, injects concerns advisory. Bro writes `discussion_append` with body containing "Concern" (markdown bold OK — outcome scorer is case-insensitive), then applies the change since the prompt forbids asking. Single turn. | `concerns-protocol-hint.sh` injection on test-loosening keywords | Spawned after concern is recorded; edits the test file | — | — | ≥1 `discussions` row with `LOWER(body) LIKE '%concern%'`; ≥1 `tasks` row (SWE dispatched) |
| 10 | **Consultant — cto read on architecture** | `@bro let cto weigh in on monolith vs microservices for auth.\n\nDon't ask questions.` | Calls `agent_list` → cto has `scope='template'`; loads `tmb_agent-creator` skill; copies `templates/agents/cto.md` → `.claude/agents/cto.md`; calls `agent_register(scope='project-local')`; emits `audit(event_type='tmb_agent_created')`; spawns cto via `Agent`. | `consultant-spawn-required.sh` UserPromptSubmit injects advisory on consultant keywords | — | — | cto reads codebase; writes `discussion_append(kind='analysis')`; SubagentStop writes `agent_runs` row | `audit(event_type='tmb_agent_created')` row exists; `.claude/agents/cto.md` present |
| 11 🟡 | **Roundtable — concurrency model for the TODO CLI watcher (partial-test)** | `/roundtable should the TODO CLI's file watcher be async-first or thread-pooled?\n\nDon't ask questions.` (Human-typed only) | bro orchestrates `roundtable_create(participants=[architect,cto,pm])`; spawns each via `Agent`; each writes `discussion_append(kind='analysis')` and `roundtable_vote`. Note: `roundtable-slash-detect.sh` doesn't fire from the expanded slash in this code path — `claude` rewrites `/roundtable` before UserPromptSubmit hooks see it. The substantive checks live in outcome.sql/coherence, not the audit row. | `roundtable-cleanup-postcheck.sh` PostToolUse on `roundtable_close` checks captured surfaces | — | — | architect/cto/pm each spawn; each reads codebase before writing `discussion_append(kind='analysis')` and `roundtable_vote` | `roundtables` row ≥1; ≥1 `discussions(kind='analysis')` row |
| 12 | **Issue resume across sessions** | `@bro let's keep going on the CLI entry-point work.\n\nDon't ask questions.` | `resume-intent-hint.sh` hook detects "keep going" + finds the pending task with `planning_complete` audit + injects context with the specific `task_id` and `branch_id`. Bro calls `task_get` + spawns SWE; does NOT call `issue_create` or `task_create_batch`. | `resume-intent-hint.sh` UserPromptSubmit injection | Picks up + finishes | — | — | resume issue exists exactly once (by `objective`); resume task on `feat/seed-cli` exists exactly once (no replan) |
| 13 | **PR comment review (`/monitor`)** | `/monitor 123\n\nDon't ask questions.` (after MR opens upstream) | Routes to `tmb_pr-review-handler` skill; attempts `pr_comments_get(pr_number=123)`. In the L5/L6 sandbox there's no real upstream PR, so the call fails gracefully — substantive checks degrade to "skill router worked + pre-seeded closed task preserved." | `pr_comments_get` would update `pr_review_runs` in a real environment | — | Would read comments and classify ack / actionable / noise; out of scope for the sandbox | — | pre-seeded closed task on `feat/todo-add` intact; row passes trivially in the L6 chain (acts as a soft terminator) |

### Journey shape

Rows 1–3 are bootstrap (cold → onboarded → remote-onboarded). Rows 4–7 are the happy-path code-touching loop (first task hits the gate + recovery → SWE close → post-close cleanup → push). Rows 8–11 are the four advanced patterns bro must support without bypassing doctrine (architectural change, concerns-protocol, consultant invocation, roundtable). Rows 12–13 cover the post-merge / cross-session edges (resume, PR comments).

L5 runs each row alone against its fixture. L6 walks all 13 against a single cumulative trajectory DB — each row fires a fresh `claude -p` invocation, and bro's `tmb_recovery` + state-aware MCPs pick up real cross-session state from the DB. Per-step logs written under `~/.claude/tmb/l6-chain-runs/<run-id>/` (format spec is in the L6 section above).

For the 🟡 partial-test rows, between-row seeds bridge the AUQ gap:

| Row | Post-AUQ seed |
|---|---|
| 1 Cold start | `after-01-cold-start.sql` → seeds `identity` + `plugin_config` defaults + `deep_scan_completed` audit, in case bro didn't fully complete onboard in his one turn |
| 2 Onboard local | `onboarding-named.sql` → `identity` + `plugin_config` (branching_model='github-flow', pr_target='main', protected_branches=["main"], remotes=[], issue_sync='off') + `deep_scan_completed` audit |
| 3 Reonboard remote | extension flipping `branching_model='gitflow'`, `pr_target='dev'`, `remotes=[{name:'origin',provider:'gitlab'}]` |
| 8 Architectural-change Q+A | `after-08-architectural-change.sql` injects `kind='question'` + `kind='answer'` rows on the architectural issue for narrative continuity |
| 11 Roundtable ratification | `after-11-roundtable.sql` injects ratify=true + human's `roundtable_vote` row |

The full AUQ ceremony (rendering, option labels, multi-round flow, "selected" highlighting) is covered by manual smoke — `tests/manual/scenarios.md` §② onboarding + §roundtable.
