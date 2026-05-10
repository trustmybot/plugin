# Evaluation System (L5 + L6)

Two automated dogfood layers drive **real Claude Code through pre-seeded TMB workflows** and assert the result matches doctrine.

| Layer | Purpose | Scope per run |
|---|---|---|
| **L5** | Per-flow targeted runner | One bro response, one user prompt, one outcome bundle. Fast iteration on a single flow. |
| **L6** | Integration / journey runner | Multi-turn, multi-flow continuous session. Asserts cumulative state across the whole user journey. |

The full pyramid (L0 install-smoke → L1 lint → L2 unit → L3 integration → L4 workflow-sim → L5 → L6) lives in [`README.md`](./README.md). This doc is the reference for how L5 + L6 work, what each catches, and the refactor plan.

---

## Why these two layers

Layers below L5 are MCP-only — they validate handlers, protocol, and workflow contracts without involving a real LLM. That class of test catches schema drift, role enforcement, and FK violations in milliseconds, but it cannot catch the failure mode that matters most in production: **bro skipping a doctrinal step because the LLM forgot, misordered, or misinterpreted prose**.

L5 catches single-flow drift. L6 catches drift that only emerges across multiple turns / flows — cross-flow state continuity, cumulative contract violations, regressions that need real session length to surface.

The two layers share scorer types, fixtures, and shell helpers; they differ only in what they wrap.

---

## L5 — per-flow runner (today)

L5 fires `claude -p` against the plugin source once, captures the trajectory, scores it. Run a single flow by name substring:

```bash
bash tests/dogfood/run-l5.sh 32-team-config        # ~30-60s
bash tests/dogfood/run-l5.sh                        # all 19 flows, ~30-50 min
```

When to use L5: testing one skill change, debugging one flow, regression-tracing.

### File layout

```
tests/dogfood/
├── run-l5.sh                 # orchestrator — picks up CLAUDE_CODE_OAUTH_TOKEN, iterates flows
├── lib/
│   ├── flow-helpers.sh       # l5_setup_scratch_project, l5_seed_db, l5_run_claude, l5_score_flow
│   ├── scorers.sh            # outcome / trajectory / cost scorer impls
│   ├── smoke-helpers.sh      # pre-flight substrate health (MCP spawn + auth + plugin-load)
│   └── timeout-shim.sh       # cross-platform timeout wrapper
├── flows/<name>/
│   ├── run.sh                # per-flow setup + l5_run_claude + l5_score_flow
│   ├── prompt.txt            # the user prompt fed to claude -p
│   ├── outcome.sql           # SQL assertions against trajectory.db
│   ├── tools-required.json   # MCP tools that MUST appear in trajectory.jsonl
│   ├── tools-forbidden.json  # MCP tools that MUST NOT appear
│   ├── cost-budget.json      # max tokens / max duration_ms (soft-warn or hard-fail)
│   ├── outcome-files.json    # (optional) filesystem-state assertions
│   └── README.md             # human description of what the flow tests
├── fixtures/                 # SQL fixtures (empty / onboarding-named / onboarding-anonymous)
└── ab-scenarios/             # A/B prompt-eval scenarios (see README.md § A/B)
```

### Per-flow execution

1. `l5_setup_scratch_project` — `mktemp -d`, `git init -b main`, identity config, `.gitignore`, `.claude/tmb/` dir.
2. `l5_seed_db <fixture>` — apply `schema.sql` then the named SQL fixture.
3. Per-flow `run.sh` does any extra setup (seed tasks, scatter files, copy templates).
4. `l5_run_claude <prompt>` — runs `claude --plugin-dir <plugin> --dangerously-skip-permissions --output-format stream-json --include-hook-events --include-partial-messages --verbose -p "$prompt"` with `TMB_HEADLESS=1`; captures `trajectory.jsonl` + the project's `trajectory.db`.
5. `l5_score_flow` — runs every present scorer against the captured artifacts. The flow passes only when every required scorer passes.

The trajectory is preserved at `~/.claude/tmb/l5-trajectories/<flow>/<run_id>/` regardless of pass/fail.

### Scorers (today)

| Scorer | File | Asserts |
|---|---|---|
| **outcome** | `outcome.sql` | One or more SQL queries returning a `(pass, description)` tuple per assertion. Run against the scratch project's `.claude/tmb/trajectory.db`. |
| **trajectory_required** | `tools-required.json` | Every named tool appears at least once in the assistant's `tool_use` blocks in `trajectory.jsonl`. |
| **trajectory_forbidden** | `tools-forbidden.json` | None of the named tools appear in `trajectory.jsonl`. |
| **cost** | `cost-budget.json` | `tokens_total` and `duration_ms` (from the `result` event) stay within the budgets. Soft-warn or hard-fail per-flow. |
| **files** *(optional)* | `outcome-files.json` | Filesystem assertions: `must_exist` / `must_not_exist` / `min_bytes` per path. |

A flow passes when every scorer it ships passes. Missing optional scorers are skipped silently.

### What today's L5 catches

- **DB-write contract violations** — a planning flow that doesn't write `discussions` rows; a config-change flow that flips policy keys without an audit event; a multi-repo flow that writes workspace-rooted paths into `file_registry`.
- **Tool-call order violations** — bro calling `task_create_batch` before `issue_create`; SWE writing `file_registry_update_summaries` (bro-only); pr-reviewer paraphrasing the MCP-availability prefix.
- **Cost regressions** — a flow that used to finish in 30s now taking 300s.
- **Cold-start trajectories** — bro on a fresh DB auto-firing `/onboard` (or failing to).

### What today's L5 cannot catch

- **Multi-turn conversations.** L5 is single-shot `claude -p` with `TMB_HEADLESS=1`. AskUserQuestion is denied by `auq-headless-deny.sh` so bro never has a Human in the loop. Many real doctrinal violations only manifest after bro asks a clarifying question.
- **Subjective doctrine.** "Did bro explain the trade-off before acting?" "Was the spec body adequately scoped?" SQL can't score these.
- **Empty-table omissions.** `outcome.sql` asserts what each flow author wrote. If the author forgot to assert `discussions >= 1`, a flow can pass while bro skipped recording the discussion entirely. (Failure mode behind the 2026-05 incident: bro answered Daisy's questions and silently created a worktree from `dev` without recording any of it.)
- **Cross-table coherence.** A flow can pass while bro produced a `tasks` row on `dev` directly (instead of pre-creating a feature branch). Per-flow `outcome.sql` would have to anticipate every coherence invariant; today most don't.
- **Git-state coherence.** L5 doesn't assert that the worktree HEAD is on the right branch, that `dev` didn't move during the flow, or that pushed commits descend from `origin/<pr_target>`.
- **Cross-flow continuity.** "Onboard then a code task then a push" — three flows that need to share state. L5's scratch project resets per flow; can't test journeys.

---

## L6 — integration runner (proposed)

L6 chains multiple flows or turns into one continuous session and scores the cumulative state. Right tool when:

- Testing a user journey that spans flows (onboard → first task → push gate → retry).
- Asserting cross-flow state continuity (a task closed in one turn is reopenable later via `issue_resume`).
- Catching regressions that only emerge after several bro turns.

```bash
bash tests/dogfood/run-l6.sh onboard-then-first-task    # one journey, ~5 min
bash tests/dogfood/run-l6.sh                             # all journeys
```

When to use L6: end-to-end coverage of a real user workflow. When NOT: anything a single L5 flow can express — L5 is faster and tighter.

### File layout

L6 reuses L5's lib + fixtures + scorer types. New directory:

```
tests/dogfood/integration/
└── scenarios/<name>/
    ├── README.md             # what journey this exercises
    ├── script.json           # multi-turn user persona + canned answers + terminal conditions
    ├── outcome.sql           # cumulative DB state assertions
    ├── outcome-coherence.json  # cross-table shape (Phase 1)
    ├── outcome-git.json        # final git state (Phase 1)
    └── outcome-judge.md        # (Phase 3) end-of-journey rubric
```

### Driver semantics

1. `l6_setup_scratch_project` — same as L5 (single project, one fixture seed).
2. `l6_run_session` — multi-turn loop:
   - Fire bro with the first user message from `script.json`.
   - On bro response: simulated-user agent reads the response + persona spec → emits next user message OR signals terminal.
   - Repeat until terminal condition (max turns, persona "satisfied", or terminal regex match).
3. `l6_score_session` — runs scorers against the cumulative trajectory + final DB state.

The same flow file format works for L5 single-shot AND for individual turns inside an L6 session, so authors don't learn two systems.

---

## Refactor plan — three phases, sequential MRs

| Order | MR | Adds | Validates |
|---|---|---|---|
| 1 | Phase 1 — coherence + git-state scorers | `outcome-coherence.json` and `outcome-git.json` scorer types in `scorers.sh`. Integration into `l5_score_flow`. | L5 catches the empty-table + git-violation failure modes from the 2026-05 incident. |
| 2 | Coherence backfill | Add coherence scorers to existing 19 L5 flows where applicable. | Empty-table audit you already see in `trajectory.db`. |
| 3 | Phase 2 — multi-turn driver | Simulated-user loop in `l5_run_claude_interactive` (opt-in via flow's `script.json`). | One L5 flow (probably `32-team-config`) migrated to multi-turn — proof of concept. |
| 4 | L6 layer | `tests/dogfood/integration/` directory. `run-l6.sh` wraps Phase 2's loop with cumulative scoring. First scenario: `onboard-then-first-task`. | Integration tests live; cross-flow continuity testable. |
| 5 | Headless fast-path retirement | Delete `auq-headless-deny.sh` + `tmb_recovery §A` headless block + skill `Headless fast path` sections. ([Issue !2867](#).) | Parallel doctrine retired; L5 + L6 test the production path. |
| 6 | Phase 3 — LLM-as-judge | `outcome-judge.md` scorer type in `scorers.sh`. Applies to L5 and L6. | Subjective doctrine ("did bro explain the trade-off?") scored. |

Each MR is independently mergeable and brings a clear win. Sequence matches the "no parallel work, every issue gets a feature branch" rule.

---

## Phase 1 design (immediate)

### `outcome-coherence.json`

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

Scorer queries `SELECT COUNT(*) FROM <table> [WHERE <suffix>]` and checks against the operator (`>=N` / `<=N` / `=N` / `0`). The key supports a `WHERE <suffix>` so flow authors can target specific shape ("at least one task whose branch_id isn't dev").

### `outcome-git.json`

```json
{
  "worktree_head_branch":      "<task.branch_id>",
  "worktree_head_not_branch":  ["dev", "main", "develop"],
  "base_branch_unchanged":     true,
  "uncommitted_in_worktree":   false
}
```

Scorer:
- `worktree_head_branch`: resolves `<task.branch_id>` from the most recent `tasks` row in DB; runs `git -C .claude/worktrees/<slug> rev-parse --abbrev-ref HEAD` and asserts equals.
- `worktree_head_not_branch`: same probe, asserts NOT equals any in the list.
- `base_branch_unchanged`: counts commits on `<pr_target>` before flow vs after; asserts equal.
- `uncommitted_in_worktree`: asserts `git status --porcelain` empty.

### Integration

`l5_score_flow` gets two new optional scorers wired in alongside the existing five. Missing files = scorer skipped (backward-compat with all 19 existing flows). New scorer files are pure JSON; pure shell + sqlite3 + git plumbing. No new dependencies.

---

## Adding a new test

| Goal | Where | Pattern |
|---|---|---|
| New L5 flow (single-shot) | `tests/dogfood/flows/<NN>-<name>/` | scaffold per L5 layout above |
| New L6 scenario (multi-turn journey) | `tests/dogfood/integration/scenarios/<name>/` | scaffold per L6 layout above |
| New scorer type | `tests/dogfood/lib/scorers.sh` | add a function `score_<name>`; register it in `l5_score_flow` / `l6_score_session` |

## Open questions / non-goals

- **Run-anywhere assertions.** Current scorers assume a fresh scratch project; running against a Human's real project would clobber state. L5 + L6 are fixture-only by design.
- **Per-flow flake tolerance.** A flow that passes 90/100 runs is still useful, but today's runner is binary pass/fail. Statistical tolerance lives in the A/B framework, not in `run-l5.sh` / `run-l6.sh`.
- **Cross-test ordering.** Each L5 flow / L6 scenario gets its own scratch project. Tests that exercise cross-test continuity (e.g., "what happens when bro picks up an issue from a prior session") are out of scope; that's what real-world dogfood + manual smoke cover.

---

## End-to-end journey: TODO CLI app

A canonical journey that exercises every actor, every gate, and every hook from cold start to PR merge. Each row is a **self-contained L6 scenario** (runs in isolation under `tests/dogfood/integration/scenarios/<name>/`); rows compose left-to-right into a real-world dev process **without** conflicting setups, so a developer adding `feat 1 → feat 2 → refactor → consult → push` reads naturally.

Rules:

- **One row = one scenario.** Each row is testable in isolation against a fresh fixture.
- **Multiple rows = one full test.** Read top-to-bottom for the journey shape; nothing in row N+1 invalidates state from row N.
- **Cells without an actor write `—`.** Empty cells make it explicit which actors are dormant in that step.
- **Outcome assertions cite DB tables / files / audit events** — what the L6 scorer would check.

| # | Step / sub-flow | User input | Bro reaction | MCP / Hook | SWE | pr-reviewer | Consultant | Asserted outcome |
|---|---|---|---|---|---|---|---|---|
| 1 | **Cold start** | (fresh CC session, types `@bro hi`) | Auto-fires `/onboard` (identity row absent → first_run=true) | `activation-routine.sh` injects `onboarded=no` context; `onboard_state_get` returns `first_run=true` | — | — | — | `first_run=true` reported; bro started AUQ chain |
| 2 | **Onboard — local shape** | Picks **Local**, no remote, branch=`main` | Walks AUQ rounds, calls `onboard_apply(shape='local', branching_model='github-flow')` | `onboard_apply` writes 1 transactional batch: `identity` row + `plugin_config` keys (`branching_model`, `pr_target='main'`, `protected_branches=["main"]`, `remotes=[]`, `issue_sync='off'`) | — | — | — | `identity` row=1; `plugin_config[branching_model]='"github-flow"'`; `plugin_config[remotes]='[]'` |
| 3 | **Reonboard — change to remote (gitflow + GitLab)** | `/onboard` (typed); user picks **Remote → GitLab → gitflow** | Re-runs AUQ rounds; calls `onboard_apply(shape='remote', branching_model='gitflow')` | `onboard_apply` derives `pr_target='dev'` + `protected_branches=["main","dev"]`; sets `remotes=[{name:'origin',provider:'gitlab'}]`, `issue_sync='auto'` | — | — | — | `branching_model='"gitflow"'`; `pr_target='"dev"'`; `remotes` length=1 |
| 4 | **First task hits registry-cold gate; bro recovers via `scan_run`** | `@bro implement an `add` command for the TODO CLI in src/cli.py` | Calls `task_create_batch` → server returns `registry_cold_violation` → bro reads error, calls `scan_run` (auto-fire path per `commands/scan.md`) → re-tries `task_create_batch` (now passes) → spawns SWE | `tasks.ts` registry-cold gate rejects on first call; `scan_run` forks `scripts/scan.sh`, bulk-upserts `repos` + `file_registry`, emits `audit(event_type='deep_scan_completed')`, sets `tmb_default_repo`; gate clears on retry | Picks up via `task_get`, edits `src/cli.py` in worktree, commits, calls `task_update_status(completed, commit_sha)` | — | — | ≥1 `deep_scan_completed` audit; `repos` row count > 0; `file_registry` populated; ≥2 `discussions` rows (`intent` + `note: Triage: simple`); `tasks` row at `branch_id='feat/todo-add'`; SWE commit lands |
| 5 | **SWE atomic-close + bro V1/V2/V3** | (no input; bro continues from row 4) | Verifies V1 (files match spec), V2 (verification commands pass), V3 (success criteria visibly met); writes `file_registry_update_summaries` for touched paths; calls `bro_atomic_close` | `bro_atomic_close` writes audit + summaries + flips task to `closed` + closes issue if last task — one transaction; `swe-atomic-close.sh` SubagentStop hook writes `agent_runs` row | Was running in row 4; SubagentStop fires here | — | — | `agent_runs` row count ≥1 with `task_id` set; task `status='closed'`; `file_registry` row at `cli.py` has non-null summary |
| 6 | **Post-close auto-rescan + worktree cleanup** | (no input; hooks fire automatically) | — (passive; both hooks run after `bro_atomic_close`) | `post-task-close-rescan.sh` PostToolUse on `bro_atomic_close` backgrounds `scripts/maintenance/run-scan.mjs` (md5-driven drift; summary cleared on changed files). `cleanup-worktree-on-task-close.sh` PostToolUse on `task_update_status(closed)` removes `.claude/worktrees/<slug>/`. Architecture-doc auto-update is folded in via #2881. | — | — | — | ≥2 `deep_scan_completed` audit rows; `.claude/worktrees/feat-todo-add/` directory does NOT exist post-hook; (post-#2881) `regen_state` updated when scan detected structural change |
| 7 | **Push gate — pr-reviewer on the FEATURE branch (NOT in worktree)** | `@bro push it` | Tries `git push` → `git-push-guard.sh` denies (no `validation_attempts` for unsigned commits); spawns pr-reviewer via `Agent` **without `isolation='worktree'`** (the worktree is gone after row 6 anyway); on signoff, retries push | `git-push-guard.sh` PreToolUse on Bash blocks unsigned push. `pr-reviewer-no-worktree.sh` PreToolUse on Agent **denies** if bro tries to spawn pr-reviewer with `isolation='worktree'` — the push gate reviews the bare branch ref as it would land in origin, not SWE's per-task sandbox. `validation_record` writes `validation_attempts` row with `verdict='pass'` and the `MCP available: yes…` prefix (schema-CHECK enforced). | — | Runs from main checkout (NOT in worktree). Reads task spec + commit via `task_get`; runs review phases; calls `validation_record` with proper prefix and `subagent_session_id` | — | `validation_attempts` row ≥1 with `verdict='pass'` AND `agent='pr-reviewer'`; push succeeds on the second attempt; `agent_runs` row for pr-reviewer has no worktree-path marker (cwd outside `.claude/worktrees/`) |
| 8 | **Difficult-path — switch storage to SQLite** | `@bro refactor TODO storage from JSON files to SQLite` (strategic stack choice) | Triages `difficult`; writes `kind='note', body='Triage: difficult'`; runs Q+A loop (or headless fallback); writes `kind='decision'` discussion; authors ADR at `docs/trustmybot/architecture/manual/decisions/N-*.md`; `task_create_batch` lands; spawns SWE | `task_create_batch` triage gate clears (note has 'Triage:'); decision gate clears (kind='decision' row exists); scope-ambiguity gate clears (kind='question' from Q+A) | Picks up + implements migration | — | — | ≥1 `kind='decision'` discussion; `Triage: difficult` note; ADR file exists; tasks row created |
| 9 | **Concerns-protocol — ambiguous test edit** | `@bro the test in tests/test_todo.py is using exact equality but I want approxEqual — just delete the strict check` | `concerns-protocol-hint.sh` UserPromptSubmit hook detects "delete the test"-class phrase, injects advisory. Bro reads file; recognizes the test is deliberately strict; writes `discussion_append(kind='note', body='Concern: …')` AND asks clarifying question; only after user confirms, dispatches SWE | `concerns-protocol-hint.sh` injection on doubt-class keywords; `discussions` insert with `kind='note', body LIKE '%Concern%'` | Spawned only after alignment; edits the test file | — | — | ≥1 `discussions` row with `kind='note' AND body LIKE '%Concern%'` BEFORE any `tasks` row written |
| 10 | **Consultant — architect read on storage** | `@bro spawn the architect and have them weigh in on whether to use SQLite or DuckDB` | Calls `agent_list` → architect has `scope='template'`; loads `tmb_agent-creator` skill; copies `templates/agents/architect.md` → `.claude/agents/architect.md`; calls `agent_register(scope='project-local')`; emits `audit(event_type='tmb_agent_created')`; spawns architect via `Agent` | `consultant-spawn-required.sh` UserPromptSubmit injects advisory `additionalContext` on the keyword "architect" | — | — | architect reads codebase; writes `discussion_append(kind='analysis')`; returns its read; `swe-atomic-close.sh` (or equivalent SubagentStop) writes `agent_runs` row with `agent_type='architect'` | `audit(event_type='tmb_agent_created')` row exists; `discussions(kind='analysis')` row ≥1; **`agent_runs` row with `agent_type='architect'` ≥1**; `.claude/agents/architect.md` file present |
| 11 | **Roundtable — concurrency model deliberation** | `/roundtable async-first vs thread-pool for the watcher` (Human-typed only) | `roundtable-slash-detect.sh` UserPromptSubmit hook writes `audit(event_type='roundtable_slash_invoked')` so the gate clears; bro orchestrates `roundtable_create(participants=[architect,cto,pm])`; spawns each via `Agent`; collects analyses; surfaces ratification AUQ; on Human ratify, calls `roundtable_close + roundtable_finalize_decisions` | `roundtable_create` slash-invoke gate clears via the audit row; `roundtable-auq-shape.sh` PreToolUse enforces ratification AUQ shape; `roundtable-cleanup-postcheck.sh` PostToolUse on `roundtable_close` checks captured surfaces | — | — | architect/cto/pm each spawn; each calls `discussion_append(kind='analysis')`; each calls `roundtable_vote` | `roundtables.state='closed'`; `roundtable_votes` row count =3; ≥3 `discussions(kind='analysis')` rows |
| 12 | **Issue resume across sessions** | (new CC session) `@bro keep going on issue 1 — dispatch SWE for task 1` (where issue 1 has `planning_complete` audit + `pending` task) | Reads existing state via `issue_resume`; dispatches SWE for task 1; does NOT replan | `task_first_actionable` returns the pending task | Picks up + finishes | — | — | exactly 1 `issues` row (no duplicate); exactly 1 `tasks` row (no replan); `Agent` (SWE) called |
| 13 | **PR comment review (`/monitor`)** | `/monitor 123` (after MR opens upstream) | Reads comments via `pr_comments_get(pr_number=123)`; spawns pr-reviewer to triage; on actionable feedback, opens new tasks | `pr_comments_get` updates `pr_review_runs` row; bot-pattern filter excludes auto-comments | — | Runs from main checkout (NOT in worktree). Reads comments; classifies each as ack / actionable / noise; writes `discussion_append(kind='note')` per comment | — | `pr_review_runs` row count ≥1; `comments_processed > 0`; possibly new `tasks` rows for actionable feedback |

### How to read this as a journey

Rows 1–3 are bootstrap (cold → onboarded → remote-onboarded). Rows 4–7 are the canonical happy-path code-touching loop (first task hits the gate + recovery → SWE close → post-close cleanup → push). Rows 8–11 are the four advanced patterns bro must support without bypassing doctrine (difficult path, concerns-protocol, consultant invocation, roundtable). Rows 12–13 cover the post-merge / cross-session edges (resume, PR comments).

Run **one row** to debug a specific gate or actor; run **all rows in order** as the integration smoke before any release. The pre-state of row N+1 is exactly the post-state of row N.

### What was dropped (and why)

| Original row | Disposition |
|---|---|
| Explicit `/scan` on cold registry (was row 4) | **Merged into row 4.** /scan should run implicitly when bro hits the registry-cold gate; an explicit user-typed /scan as a separate journey step is redundant. |
| Reonboard-redirect (was row 14) | **Removed.** Edge-case routing-table doctrine; covered by standalone L6 scenario `04-reonboard-redirect`. Doesn't fit the canonical "build TODO CLI" journey. |
| Explicit "Architecture refresh" (was row 15) | **Removed.** Architecture updates should follow naturally from structural changes detected during scan, not from an explicit user `/refresh-arch` action. Tracked by [#2881](https://gitlab.com/trustmybot/plugin/-/issues/2881) — merge `architecture_regen` into `scan_run` + add `fired_by` tracking on the `deep_scan_completed` audit. |
