# Evaluation System (L5 + L6)

Two automated dogfood layers drive **real Claude Code through pre-seeded TMB workflows** and assert the result matches doctrine.

| Layer | Purpose | Scope per run | When to run |
|---|---|---|---|
| **L5** | Per-row independent unit tests. Each test starts from a fixture that pre-seeds the **cumulative state up to this row** (codebase, MCP DB, discussions, issues, tasks, audit, etc.). One row = one test. | Single bro turn (or short multi-turn) against pre-seeded state. Fast, isolated, ~$0.20/test. | Debug or regression-test a single row's contract. **First-line check after a fix** — if the L5 for that row doesn't pass, don't run L6. |
| **L6** | Single **chained integration test** that walks ALL 13 journey rows sequentially in one continuous session via `claude --session-id` / `--resume`. State carries across rows: row N's bro turn produces real DB writes that row N+1 inherits. The TODO-CLI codebase grows row by row. | Full 13-row chain in one session. Slow, ~$0.30–1/scenario × 13 rows + per-row scoring. | After all relevant L5 rows pass, run L6 to verify cross-row continuity holds end-to-end. |

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

L6 walks all 13 journey rows sequentially in **one** continuous CC session via `claude --session-id` / `--resume`. State carries across rows: row N's bro turn produces real DB writes that row N+1 inherits. The TODO CLI codebase grows row by row.

```bash
bash tests/dogfood/run-l6.sh                  # full chain, all 13 rows
bash tests/dogfood/run-l6.sh --from row-7     # resume from a specific row
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
   - Send `prompt.txt` via `claude --resume <session_id>`.
   - Score the post-state against the row's outcome bundle.
   - For 🟡 partial-test rows: inject post-AUQ pseudo-data before row N+1.
   - Write per-step log section.
3. Halt on first row failure (subsequent rows not attempted).

### Per-step log section

Every L6 run produces a per-step log so failures are debuggable without replaying the whole chain.

```
<run-id>/
├── chain-summary.md             # one-page report: row-by-row pass/fail + cost + duration
├── chain-trajectory.jsonl       # cumulative claude --resume stream-json across all turns
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
  3. **Fixture seeds the post-AUQ state** so the next row can run. `onboarding-named.sql` seeds `identity` + `plugin_config` keys + `deep_scan_completed` audit; the difficult-path fixture seeds `kind='answer'` rows for Q+A; etc.
  4. **AUQ rendering** (option labels, multi-round flow, "selected" highlighting) is **manual smoke** — `tests/manual/scenarios.md` §② onboarding + §roundtable. Not L6 territory.

  Rows that use the partial-test pattern are tagged **🟡 partial-test** in the table below.

| # | Step / sub-flow | User input | Bro reaction | MCP / Hook | SWE | pr-reviewer | Consultant | Asserted outcome |
|---|---|---|---|---|---|---|---|---|
| 1 🟡 | **Cold start (partial-test)** | (fresh CC session, types `@bro hi`) | Auto-fires `/onboard` chain — calls `onboard_state_get` (sees `first_run=true`) → loads `commands/onboard.md` body → calls `onboard_get_questions` to start the AUQ rounds | `activation-routine.sh` injects `onboarded=no` context | — | — | — | `tools-required` includes `onboard_state_get` AND `onboard_get_questions` (= "bro initiated AUQ"). Test ends here. **No outcome.sql for `identity` row** — that lands via fixture seed before row 2. |
| 2 🟡 | **Onboard — local shape (partial-test)** | `@bro I want to make this project available on GitHub.` | bro calls `onboard_state_get`, sees current state is local-shape, and **asks** "want me to run `/onboard` again?" — does NOT call `onboard_apply` or rewrite config. Test ends at the question; the actual reonboard ceremony lives in row 3 where the user types `/onboard` explicitly. | (state injected by fixture script) | — | — | — | `tools-required` includes `onboard_state_get`; `tools-forbidden` blocks `onboard_apply` + code-work tools; bro's response mentions `/onboard` / reonboard (terminal_pattern); fixture-seeded local-shape values intact. |
| 3 🟡 | **Reonboard — change to remote (gitflow + GitLab) (partial-test)** | `/onboard` (typed); user picks **Remote → GitLab → gitflow** | Calls `onboard_state_get` (sees `first_run=false`) → `onboard_get_questions(shape='remote')` → would render AUQ for branching_model + remote provider | `roundtable-slash-detect.sh` doesn't fire (different slash); `onboard_apply` would persist if AUQ answers existed | — | — | — | `tools-required` includes `onboard_state_get` AND `onboard_get_questions(shape='remote' or default)`. Test ends. Pseudo-data flips `branching_model='"gitflow"'`, `pr_target='"dev"'`, `remotes` length=1 for downstream rows. |
| 4 | **First task hits registry-cold gate; bro recovers via `scan_run`** | `@bro build an add command for the TODO CLI — src/cli.py, appends to ~/.todos.` | Calls `task_create_batch` → server returns `registry_cold_violation` → bro reads error, calls `scan_run` (auto-fire path per `commands/scan.md`) → re-tries `task_create_batch` (now passes) → spawns SWE | `tasks.ts` registry-cold gate rejects on first call; `scan_run` forks `scripts/scan.sh`, bulk-upserts `repos` + `file_registry`, emits `audit(event_type='deep_scan_completed')`, sets `tmb_default_repo`; gate clears on retry | Picks up via `task_get`, edits `src/cli.py` in worktree, commits, calls `task_update_status(completed, commit_sha)` | — | — | ≥1 `deep_scan_completed` audit; `repos` row count > 0; `file_registry` populated; ≥2 `discussions` rows (`intent` + `note: Triage: simple`); `tasks` row at `branch_id='feat/todo-add'`; SWE commit lands |
| 5 | **SWE atomic-close + bro V1/V2/V3** | (no input; bro continues from row 4) | Verifies V1 (files match spec), V2 (verification commands pass), V3 (success criteria visibly met); writes `file_registry_update_summaries` for touched paths; calls `bro_atomic_close` | `bro_atomic_close` writes audit + summaries + flips task to `closed` + closes issue if last task — one transaction; `swe-atomic-close.sh` SubagentStop hook writes `agent_runs` row | Was running in row 4; SubagentStop fires here | — | — | `agent_runs` row count ≥1 with `task_id` set; task `status='closed'`; `file_registry` row at `cli.py` has non-null summary |
| 6 | **Post-close auto-rescan + worktree cleanup** | (no input; hooks fire automatically) | — (passive; both hooks run after `bro_atomic_close`) | `post-task-close-rescan.sh` PostToolUse on `bro_atomic_close` backgrounds `scripts/maintenance/run-scan.mjs` (md5-driven drift; summary cleared on changed files). `cleanup-worktree-on-task-close.sh` PostToolUse on `task_update_status(closed)` removes `.claude/worktrees/<slug>/`. Architecture-doc auto-update is folded in via #2881. | — | — | — | ≥2 `deep_scan_completed` audit rows; `.claude/worktrees/feat-todo-add/` directory does NOT exist post-hook; (post-#2881) `regen_state` updated when scan detected structural change |
| 7 | **Push gate — pr-reviewer on the FEATURE branch (NOT in worktree)** | `@bro git push` | Tries `git push` → `git-push-guard.sh` denies (no `validation_attempts` for unsigned commits); spawns pr-reviewer via `Agent` **without `isolation='worktree'`** (the worktree is gone after row 6 anyway); on signoff, retries push | `git-push-guard.sh` PreToolUse on Bash blocks unsigned push. `pr-reviewer-no-worktree.sh` PreToolUse on Agent **denies** if bro tries to spawn pr-reviewer with `isolation='worktree'` — the push gate reviews the bare branch ref as it would land in origin, not SWE's per-task sandbox. `validation_record` writes `validation_attempts` row with `verdict='pass'` and the `MCP available: yes…` prefix (schema-CHECK enforced). | — | Runs from main checkout (NOT in worktree). Reads task spec + commit via `task_get`; runs review phases; calls `validation_record` with proper prefix and `subagent_session_id` | — | `validation_attempts` row ≥1 with `verdict='pass'` AND `agent='pr-reviewer'`; push succeeds on the second attempt; `agent_runs` row for pr-reviewer has no worktree-path marker (cwd outside `.claude/worktrees/`) |
| 8 🟡 | **Difficult-path — switch auth to Clerk (partial-test)** | `@bro let's switch to Clerk for auth.` | Triages `difficult`; writes `kind='note', body='Triage: difficult'`; would render AUQ Q+A loop (storage backend, library choice, file layout per `tmb_planning` Step 3); pseudo-data injects `kind='question'` + `kind='answer'` rows; bro continues with `kind='decision'` write + ADR + `task_create_batch` + SWE spawn | `task_create_batch` triage gate clears (note has 'Triage:'); decision gate clears (kind='decision' row exists); scope-ambiguity gate clears (kind='question' from injected Q+A) | Picks up + implements migration | — | — | `Triage: difficult` note; ≥1 `kind='question'` row (fixture-injected); ≥1 `kind='answer'` row (fixture-injected); ≥1 `kind='decision'` discussion (bro-written); ADR file exists; tasks row created |
| 9 | **Concerns-protocol — ambiguous test edit** | `@bro tests/test_calculator.py is using exact equality, switch it to approxEqual with tolerance 0.001.` | `concerns-protocol-hint.sh` UserPromptSubmit hook detects "delete the test"-class phrase, injects advisory. Bro reads file; recognizes the test is deliberately strict; writes `discussion_append(kind='note', body='Concern: …')` AND asks clarifying question; only after user confirms, dispatches SWE | `concerns-protocol-hint.sh` injection on doubt-class keywords; `discussions` insert with `kind='note', body LIKE '%Concern%'` | Spawned only after alignment; edits the test file | — | — | ≥1 `discussions` row with `kind='note' AND body LIKE '%Concern%'` BEFORE any `tasks` row written |
| 10 | **Consultant — cto read on architecture** | `@bro let cto weigh in on monolith vs microservices for auth.` | Calls `agent_list` → architect has `scope='template'`; loads `tmb_agent-creator` skill; copies `templates/agents/architect.md` → `.claude/agents/architect.md`; calls `agent_register(scope='project-local')`; emits `audit(event_type='tmb_agent_created')`; spawns architect via `Agent` | `consultant-spawn-required.sh` UserPromptSubmit injects advisory `additionalContext` on the keyword "architect" | — | — | architect reads codebase; writes `discussion_append(kind='analysis')`; returns its read; `swe-atomic-close.sh` (or equivalent SubagentStop) writes `agent_runs` row with `agent_type='architect'` | `audit(event_type='tmb_agent_created')` row exists; `discussions(kind='analysis')` row ≥1; **`agent_runs` row with `agent_type='architect'` ≥1**; `.claude/agents/architect.md` file present |
| 11 🟡 | **Roundtable — concurrency model for the TODO CLI watcher (partial-test)** | `/roundtable should the TODO CLI's file watcher be async-first or thread-pooled?` (Human-typed only) | `roundtable-slash-detect.sh` UserPromptSubmit hook writes `audit(event_type='roundtable_slash_invoked')` so the gate clears; bro orchestrates `roundtable_create(participants=[architect,cto,pm])` with the prior-rows context attached as the `topic`; spawns each via `Agent`; collects analyses (each consultant cites real files/decisions from the chain); would surface **ratification AUQ** at end; pseudo-data injects ratify=true and the human's ratification `roundtable_vote`; bro calls `roundtable_close + roundtable_finalize_decisions` | `roundtable_create` slash-invoke gate clears via the audit row; `roundtable-auq-shape.sh` PreToolUse enforces ratification AUQ shape (would fire if AUQ rendered); `roundtable-cleanup-postcheck.sh` PostToolUse on `roundtable_close` checks captured surfaces | — | — | architect/cto/pm each spawn; each reads from the actual codebase (TODO CLI from rows 4–10) + DB (decisions from row 8) before writing `discussion_append(kind='analysis')`; each calls `roundtable_vote` | `roundtables.state='closed'`; `roundtable_topic` references SQLite + watcher from prior rows; `roundtable_votes` row count =3 (or 4 with human ratification injected); ≥3 `discussions(kind='analysis')` rows; at least one `kind='analysis'` body cites `cli.py` or the SQLite decision audit |
| 12 | **Issue resume across sessions** | `@bro let's keep going on the CLI entry-point work.` (the pre-seeded resume issue has `planning_complete` audit + `pending` task) | Reads existing state via `issue_resume`; dispatches SWE for task 1; does NOT replan | `task_first_actionable` returns the pending task | Picks up + finishes | — | — | exactly 1 `issues` row (no duplicate); exactly 1 `tasks` row (no replan); `Agent` (SWE) called |
| 13 | **PR comment review (`/monitor`)** | `/monitor 123` (after MR opens upstream) | Reads comments via `pr_comments_get(pr_number=123)`; spawns pr-reviewer to triage; on actionable feedback, opens new tasks | `pr_comments_get` updates `pr_review_runs` row; bot-pattern filter excludes auto-comments | — | Runs from main checkout (NOT in worktree). Reads comments; classifies each as ack / actionable / noise; writes `discussion_append(kind='note')` per comment | — | `pr_review_runs` row count ≥1; `comments_processed > 0`; possibly new `tasks` rows for actionable feedback |

### Journey shape

Rows 1–3 are bootstrap (cold → onboarded → remote-onboarded). Rows 4–7 are the happy-path code-touching loop (first task hits the gate + recovery → SWE close → post-close cleanup → push). Rows 8–11 are the four advanced patterns bro must support without bypassing doctrine (difficult path, concerns-protocol, consultant invocation, roundtable). Rows 12–13 cover the post-merge / cross-session edges (resume, PR comments).

L5 runs each row alone against its fixture. L6 walks all 13 in a single chained CC session, with state carrying across rows and per-step logs written under `tests/dogfood/l6-chain/runs/<run-id>/` (format spec is in the L6 section above).

For the 🟡 partial-test rows, between-row seeds bridge the AUQ gap:

| Row | Post-AUQ seed |
|---|---|
| 1 Cold start | (nothing — test asserts AUQ intent and ends; row 2's seed fills in) |
| 2 Onboard local | `onboarding-named.sql` → `identity` + `plugin_config` (branching_model='github-flow', pr_target='main', protected_branches=["main"], remotes=[], issue_sync='off') + `deep_scan_completed` audit |
| 3 Reonboard remote | extension flipping `branching_model='gitflow'`, `pr_target='dev'`, `remotes=[{name:'origin',provider:'gitlab'}]` |
| 8 Difficult-path Q+A | injects `kind='question'` + `kind='answer'` rows |
| 11 Roundtable ratification | injects ratify=true + human's `roundtable_vote` row |

The full AUQ ceremony (rendering, option labels, multi-round flow, "selected" highlighting) is covered by manual smoke — `tests/manual/scenarios.md` §② onboarding + §roundtable.
