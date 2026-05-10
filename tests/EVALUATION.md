# L5 Evaluation System

L5 dogfood is the layer that drives **real Claude Code through pre-seeded TMB workflows** and asserts the result matches doctrine. This doc is the reference for how L5 works today, what it can and cannot catch, and where the upgrade work is heading.

The test pyramid (L0 install-smoke → L1 lint → L2 unit → L3 integration → L4 workflow-sim → L5 dogfood) lives in [`README.md`](./README.md). This doc is L5-specific.

## Why L5 exists

Layers below L5 are MCP-only — they validate handlers, protocol, and workflow contracts without involving a real LLM. That class of test catches schema drift, role enforcement, and FK violations in milliseconds, but it cannot catch the failure mode that matters most in production: **bro skipping a doctrinal step because the LLM forgot, misordered, or misinterpreted prose**.

L5 fires real `claude -p` against the plugin's source (`--plugin-dir`) and scores the resulting trajectory + DB state against per-flow assertions. If bro is supposed to call `discussion_append` during planning and silently doesn't, only L5 sees it.

## How L5 runs today

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
├── fixtures/
│   ├── empty.sql             # schema only; no identity row → first-contact path
│   ├── onboarding-named.sql  # post-onboard state (identity row present)
│   └── onboarding-anonymous.sql
└── ab-scenarios/             # A/B prompt-eval scenarios (see README.md § A/B)
```

Per-flow execution:

1. `l5_setup_scratch_project` — `mktemp -d`, `git init -b main`, identity config, `.gitignore`, `.claude/tmb/` dir.
2. `l5_seed_db <fixture>` — apply `schema.sql` then the named SQL fixture.
3. Per-flow `run.sh` does any extra setup (seed tasks, scatter files, copy templates).
4. `l5_run_claude <prompt>` — runs `claude --plugin-dir <plugin> --dangerously-skip-permissions --output-format stream-json --include-hook-events --include-partial-messages --verbose -p "$prompt"` with `TMB_HEADLESS=1` set; captures `trajectory.jsonl` + the project's `trajectory.db`.
5. `l5_score_flow` — runs every present scorer against the captured artifacts. The flow passes only when every required scorer passes.

The trajectory is preserved at `~/.claude/tmb/l5-trajectories/<flow>/<run_id>/` for post-mortem inspection regardless of pass/fail.

## Scorers (today)

| Scorer | File | Asserts |
|---|---|---|
| **outcome** | `outcome.sql` | One or more SQL queries returning a `(pass, description)` tuple per assertion. Pass is 1/0. Run against the scratch project's `.claude/tmb/trajectory.db`. |
| **trajectory_required** | `tools-required.json` | Every named tool appears at least once in the assistant's `tool_use` blocks in `trajectory.jsonl`. Used for "bro must call X". |
| **trajectory_forbidden** | `tools-forbidden.json` | None of the named tools appear in `trajectory.jsonl`. Used for "bro must NOT call X" (e.g., AskUserQuestion in the bulk-cleanup flow). |
| **cost** | `cost-budget.json` | `tokens_total` and `duration_ms` (from the `result` event in `trajectory.jsonl`) stay within `max_tokens_total` / `max_duration_ms`. Soft-warn (`fail_above_max: false`) or hard-fail per-flow. |
| **files** *(optional)* | `outcome-files.json` | Filesystem assertions: `must_exist` / `must_not_exist` / `min_bytes` per path. Used by flows that produce file-system effects (e.g., the bulk-cleanup `.DS_Store` removal flow). |

A flow passes when every scorer it ships passes. Missing optional scorers are skipped silently.

## What today's L5 catches

- **DB-write contract violations** — a planning flow that doesn't write `discussions` rows; a config-change flow that flips policy keys without an audit event; a multi-repo flow that writes workspace-rooted paths into `file_registry`.
- **Tool-call order violations** — bro calling `task_create_batch` before `issue_create`; SWE writing `file_registry_update_summaries` (bro-only); pr-reviewer paraphrasing the MCP-availability prefix.
- **Cost regressions** — a flow that used to finish in 30s now taking 300s.
- **Cold-start trajectories** — bro on a fresh DB auto-firing `/onboard` (or failing to).

## What today's L5 cannot catch

- **Multi-turn conversations.** L5 is single-shot `claude -p` with `TMB_HEADLESS=1`. AskUserQuestion is denied by the `auq-headless-deny.sh` hook so bro never has a Human in the loop. Many real doctrinal violations only manifest after bro asks a clarifying question.
- **Subjective doctrine.** "Did bro explain the trade-off before acting?" "Was the spec body adequately scoped?" SQL can't score these.
- **Empty-table omissions.** `outcome.sql` asserts what each flow author wrote. If the author forgot to assert `discussions >= 1`, a flow can pass while bro skipped recording the discussion entirely. This is the failure mode behind the 2026-05 incident where bro answered Daisy's questions and silently created a worktree from `dev` without recording any of it.
- **Cross-table coherence.** A flow can pass while bro produced a `tasks` row on `dev` directly (instead of pre-creating a feature branch). Per-flow `outcome.sql` would have to anticipate every coherence invariant; today most don't.
- **Git-state coherence.** L5 doesn't assert that the worktree HEAD is on the right branch, that `dev` didn't move during the flow, or that pushed commits descend from `origin/<pr_target>`.

## Refactor goals

The upgrade lands in three phases. Each phase is independently mergeable.

### Phase 1 — coherence + git-state scorers (deterministic)

Add two new optional scorers any flow can opt into:

- **`outcome-coherence.json`** — assertions about table shape post-flow:

  ```json
  {
    "expected_writes": {
      "issues":      ">=1",
      "tasks":       ">=1",
      "discussions": ">=1",
      "audit":       ">=2"
    }
  }
  ```

  Scorer queries `SELECT COUNT(*)` per table and checks against the operator. Catches the "empty `discussions` after a planning flow" failure mode without flow authors having to remember to write the assertion.

- **`outcome-git.json`** — assertions about git state in the scratch project:

  ```json
  {
    "worktree_head_branch":    "<task.branch_id>",   // resolved from DB
    "worktree_head_not_branch": ["dev", "main"],
    "base_branch_unchanged":    true                  // commit count on base is the same as pre-run
  }
  ```

  Catches "bro committed to `dev` directly" and "worktree on detached HEAD" without each flow having to script the git checks.

Both are pure shell + sqlite3 + git plumbing — no LLM, no judge.

### Phase 2 — multi-turn driver (simulated user)

Replace the one-shot `claude -p` with a turn loop:

- A simulated-user agent (small LLM) reads bro's response + the flow's persona spec → emits the next user message → repeat until terminal.
- Per-flow `script.json` defines the persona, terminal conditions, and any canned answers (e.g., "always pick option 2 on the first AUQ").
- AUQ is allowed in this mode (no `TMB_HEADLESS=1` deny); bro asks, sim-user answers, flow continues.
- Coherence + git-state scorers fire at terminal.

Industry pattern: see [LangWatch Scenario](https://langwatch.ai/scenario/) for a polished version. We don't need to adopt the framework — borrowing the design is enough.

Why this matters: the current L5 tests "bro's behavior given the headless fast path" — a parallel doctrine that real users never hit. Phase 2 tests bro's actual interactive trajectory. Removing the headless fast-path entirely is on the table once Phase 2 lands ([issue #2867](../docs/REFERENCE.md)).

### Phase 3 — LLM-as-judge

Add `outcome-judge.md` per flow — a markdown rubric the judge LLM evaluates against the full transcript:

```markdown
# Judge rubric

Pass criteria (all must hold):
- Bro explained the trade-off between gitflow and github-flow before recommending one.
- Bro mentioned the implication for the `pr_target` config.
- Bro did not invent capabilities the project doesn't have.

Fail signals (any disqualifies):
- Bro hallucinated a feature.
- Bro recommended an action without naming the affected files.
```

Judge returns `{ pass: bool, reasoning: string }`. The reasoning lands in the trajectory archive for post-mortem.

## Adding a new flow

```
tests/dogfood/flows/<NN>-<short-name>/
├── run.sh                   # see below
├── prompt.txt               # the user prompt
├── outcome.sql              # at least one SQL assertion
├── tools-required.json      # array of MCP tool names
├── tools-forbidden.json     # array of MCP tool names
├── cost-budget.json         # max_tokens_total + max_duration_ms
├── outcome-files.json       # (optional) filesystem assertions
├── outcome-coherence.json   # (Phase 1, optional) table-shape assertions
├── outcome-git.json         # (Phase 1, optional) git-state assertions
├── script.json              # (Phase 2, optional) multi-turn persona
├── outcome-judge.md         # (Phase 3, optional) LLM-judge rubric
└── README.md                # what this flow tests + why
```

Minimal `run.sh` skeleton:

```bash
#!/usr/bin/env bash
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/flow-helpers.sh"

FLOW_NAME="$(basename "$HERE")"
RUN_ID="${RUN_ID:-$(date +%s)-$RANDOM}"
PROMPT=$(cat "$HERE/prompt.txt")

PROJECT=$(l5_setup_scratch_project)
trap 'l5_cleanup_project "$PROJECT"' EXIT

l5_seed_db "$PROJECT" "onboarding-named"
# ... any extra per-flow setup (seed tasks, scatter files, etc.)

l5_run_claude "$PROJECT" "$PROMPT"
l5_score_flow "$PROJECT" "$FLOW_NAME" "$HERE" "$RUN_ID"
```

## Open questions / non-goals

- **Run-anywhere assertions.** Current scorers assume a fresh scratch project; running L5 against a Human's real project would clobber state. L5 is fixture-only by design.
- **Per-flow flake tolerance.** A flow that passes 90/100 runs is still useful, but today's runner is binary pass/fail. Statistical tolerance lives in the A/B framework, not in `run-l5.sh`.
- **Cross-flow ordering.** Each flow gets its own scratch project. Tests that exercise cross-flow continuity (e.g., "what happens when bro picks up an issue from a prior session") are out of scope; that's what real-world dogfood + manual smoke cover.
