# TMB Workflows

The decision chain is **Human → bro → SWE** with two distinct gates:
- **bro is the task gate** — closes after SWE returns + verifies.
- **code-reviewer is the push gate** — reviews each task after `bro_atomic_close`; `git-push-guard` blocks a push whose task commits lack a passing review.

All consultants (architect, cto, ceo, pm, project-local) advise but never write workflow state. The full role × tool matrix lives in [`RESPONSIBILITIES.md`](RESPONSIBILITIES.md); enforcement layers in [`ENFORCEMENT.md`](../prompt-engineering/ENFORCEMENT.md); schema in [`ERD.md`](ERD.md).

## Quick index

| # | Flow | Trigger | Agents | DB tables touched | Distinguishing hooks |
|---|---|---|---|---|---|
| 1 | First contact | `onboard_state_get().first_run === true` (i.e. `plugin_config('onboarded')` absent) | bro | `plugin_config`, `repos`, `audit` | `activation-routine` (auto-fire trigger) |
| 2 | **Code-touching task** (canonical) | Code change ask | bro → swe (`task_provision` cuts branch + worktree); code-reviewer per task after `bro_atomic_close`; `integrate.sh` when the base moved | `issues`, `tasks`, `discussions`, `audit`, `agent_runs`, `verification_runs`, `validation_attempts`, `review_findings` | `agent-spawn-dispatch`, `containment-guard`, `swe-verification-gate`, `swe-atomic-close`, `git-push-guard`, `close-issue-on-merge` |
| 3 | Architectural change | New boundary/module, schema, public API, external side effects | bro records a `kind=decision` discussion + blast-radius, then standard SWE flow | + `discussions(kind='decision')` | `task_provision`'s `decision_body` (universal `decision_gate` on `task_create_batch`) |
| 4 | Agent-creator | Routing hits role not in `.claude/agents/` | bro | — (file-based outcome) | — |
| 5 | Skill creation | Recurring pattern needs encoding | bro | `cheatcodes` (skill row via `skill_register`) | — |
| 6 | Push gate / PR review | Each task after `bro_atomic_close`; `git push` of a commit with no passing review | bro → code-reviewer (one per closed task, parallel) | `validation_attempts`, `review_findings` | `code-reviewer-after-atomic-close`, `git-push-guard` |
| 7 | Scan + world-model refresh | First code-touching ask of session when the world model is EMPTY (`source='bro_auto_initial'`), `/scan` (`user_manual`), OR `post-task-close-rescan.sh` after `bro_atomic_close` (`bro_auto_post_close`) | bro (or hook in background) | `repos` (SQLite) + `wm_directories` / `wm_files` (summary preferentially from `<dir>/README.md`) + `cheatcodes` (on-disk resources, `source_url='scan_discovered'`), `audit(event_type='deep_scan_completed'\|'scan_discovered')` | `post-task-close-rescan` |
| 8 | SWE retry / escalation | A failed check of bro's four, a code-reviewer verdict='fail', or `integrate.sh` exit 2 | bro ↔ swe (↔ code-reviewer per task) | `validation_attempts` (multiple), `review_findings`, `discussions` | `task_reopen` / `task_retry` composites, `rework-limit` |
| 9 | Roundtable | Multi-consultant deliberation with AUQ ratification | bro orchestrates 2–4 consultants | `roundtables`, `roundtable_votes`, `discussions`, `audit` | `roundtable-auq-shape`, `roundtable-cleanup-postcheck` |
| 10 | Cheatcode lifecycle | bro hits a capability wall, Human says "cheatcode", OR a proactive reuse-check before building | bro (Human approves install) | `cheatcodes`, `audit` | `cheatcode-install-approval`, `prompt-intent-hints` |
| 13 | Bulk cleanup | Human pre-authorizes a bulk delete | bro (direct Bash, no SWE spawn) | — | — |
| 33 | Multi-repo path discipline | Inner repos registered in `repos`; bro indexes them | bro | `wm_directories` rows (repo-relative paths; `repo` column scopes to the right inner git repo) | — |
| **C** | Consultant invocation | Human asks for second opinion | bro → consultant | `discussions(kind='analysis'/'concern')` | — |
| **M** | Monitor PR comments | `/monitor <PR_number>` (invokes `tmb_comment-triage`) | bro → code-reviewer per actionable comment batch | `pr_review_runs`, `issues`, `tasks`, `audit` | — |

---

## 1. First contact (auto-fired `/onboard`)

Bro's `activation-routine.sh` UserPromptSubmit hook reads `plugin_config('onboarded')`. If the key is absent (or `value_json != 'true'`) it injects a `FIRST CONTACT` directive. Bro reads the directive, fires `/onboard` immediately, and runs the slash command's branched ceremony before any reply.

**Round 1** asks the project shape (local-only vs remote-tracked). **Round 2** asks the per-shape question set:

| Shape | Round 2 questions | Persisted |
|---|---|---|
| Local-only | (none — github-flow defaulted silently) | global `plugin_config('onboarded')` + `issue_sync='off'`; per-repo `repos` rows get `branching_model`, derived `target_branch`, `protected_branches`; each repo's `repo_remotes` rows are cleared |
| Remote-tracked | Branching, PR target, Remote (multiSelect) | + each repo's `repo_remotes` rows replaced with its git remotes (`upsertRepoRemotes`: one row per remote, `provider` from the URL host, `origin` primary), one remote per chosen provider marked `sync` (`setRemoteSync`), then a Round 3 for the global `issue_sync` |

A **silent probe** (origin URL, gh/glab installed/authed) pre-selects defaults so most questions become 1-tap confirms. Local re-onboard adds the Branching question with a `Keep` option so the user can change models without first switching shape.

```mermaid
sequenceDiagram
    participant H as Human
    participant G as Bro
    participant DB as SQLite

    Note over G,DB: activation-routine.sh injects "onboarded=no — FIRST CONTACT"

    G->>G: silent probe (git remote -v, gh/glab auth)
    G->>H: AUQ Round 1 — Local-only or Remote-tracked?
    H-->>G: shape

    alt Local-only
        H-->>G: (Round 2 skipped on first-run)
        G->>DB: onboard_apply(shape='local')
    else Remote-tracked
        G->>H: AUQ Round 2 — Branching + PR target + Remote
        H-->>G: answers
        G->>H: AUQ Round 3 — issue_sync auto/off
        H-->>G: answer
        G->>DB: onboard_apply(shape='remote', ...)
    end

    G->>H: "Done. Settings updated: ..."
```

`/onboard` re-runs on demand for later changes — same flow with `Keep "<current>"` pre-selects. Identity is a pure onboarded marker (no name or other fields stored).

---

## 2. Code-touching task (canonical chain)

This section is the standard for the code-touching workflow. Other docs and the brand workflow hero cite its step ids (`S1`..`S22`, `S4′`) and loop ids (`L1`..`L5`), each anchored as `FLOWS.md#<id>`; a change to the flow updates these tables first.

Bro is both planner AND task gate: a task closes as soon as SWE returns and bro verifies it. code-reviewer then reviews each closed task, and `git-push-guard` holds any push whose task commits lack a passing review. `composites.ts`, `issues.ts`, `tasks.ts`, `validation.ts` and `scan.ts` below live in `mcp/trajectory-server/src/tools/`.

### Steps

| Id | Actor | Tool or hook | Reads → writes | Source |
|---|---|---|---|---|
| S1 | <a id="S1"></a>Human → bro | Chat message, then the `UserPromptSubmit` hooks (`user-prompt-persona`, `activation-routine`, `prompt-intent-hints`) | `plugin_config`, the open issue → none (the hooks inject bro's persona and the open issue) | `hooks/hooks.json` (UserPromptSubmit) |
| S2 | <a id="S2"></a>bro | `world_model_get(depth=2)`, `world_model_search(query, mode='hybrid')`, `world_model_symbol` | `wm_directories`, `wm_files`, `wm_symbols` → none | `skills/tmb_planning/SKILL.md:11-13` |
| S3 | <a id="S3"></a>bro → Human | `AskUserQuestion`: which base branch; PreToolUse `askuserquestion-length-lint` | none → none (the answer stays in the transcript) | `skills/tmb_planning/SKILL.md:36`; `scripts/hooks/askuserquestion-length-lint.sh` |
| S4 | <a id="S4"></a>bro → Human | `branch_id_propose`, AUQ "Proceed with branch_id X?", then `intent_start` | the Human's intent → `issues` row, `discussions` kind=intent and the planning note in one transaction; audit `branch_id_proposed` | `skills/tmb_planning/SKILL.md:38`; `composites.ts:746,813` |
| S4′ | <a id="S4′"></a>bro (GitHub path) | `issue_create` adopts an existing GitHub issue in place of S4's `intent_start` | the GitHub issue → `issues` row with `gh_iid`; audit `issue_adopted` | `issues.ts:614` |
| S5 | <a id="S5"></a>bro | Triage: is it actionable, reuse or build; the call rides in `task_provision`'s `decision_body` | world model → `discussions` kind=decision (written at S6) | `skills/tmb_planning/SKILL.md:30,84` |
| S6 | <a id="S6"></a>bro | `task_provision(issue_id, branch_id, decision_body, task, base?)`; the task carries `spec_body` (Description, Success Criteria `SC<n>`, Out of Scope, Commit), typed `files[]`, `verification[]` and `effort` | `issues`, the base branch → `discussions` kind=decision, `tasks` row, git branch and worktree; audit `planning_complete` | `skills/tmb_planning/SKILL.md:100`; `composites.ts:975` |
| S7 | <a id="S7"></a>bro → swe | `Agent(subagent_type=swe, effort, prompt "task_id=<N>")`; PreToolUse `agent-spawn-dispatch` runs its nine gates (`require-task-spec`, `require-spawn-effort`, …, `rework-limit`), then `ensure-swe-worktree.sh` and `record-swe-spawn.sh` | `tasks` → task pending → running; `agent_runs` row opened | `skills/tmb_planning/SKILL.md:104-111`; `hooks/hooks.json` (PreToolUse Agent); `scripts/hooks/agent-spawn-dispatch.sh` |
| S8 | <a id="S8"></a>swe | `task_brief(task_id)`; `swe-brief-gate` denies Edit/Write and every other trajectory tool until it is fetched | `tasks`, `discussions`, `review_findings`, `verification_runs` → audit `swe_brief_fetched` | `agents/swe.md`; `scripts/hooks/swe-brief-gate.sh`; `composites.ts:1122` |
| S9 | <a id="S9"></a>swe | Edits, tests and commits in the worktree; PreToolUse `containment-guard` denies a write outside it (L1) | worktree files → commits on the task branch; audit `containment_denied` + `hook_denied` on a deny | `agents/swe.md`; `scripts/hooks/containment-guard.sh` |
| S10 | <a id="S10"></a>swe | `task_update_status(completed, commit_sha, report)`; PreToolUse `swe-verification-gate` runs `verification[]` and every open finding's probe in the worktree (L2) | `tasks.verification`, `review_findings` → `verification_runs` + `verification_run_commands`, `tasks.commit_sha`, `tasks.completion_report` | `tasks.ts:453`; `scripts/hooks/swe-verification-gate.sh`; `scripts/hooks/lib/registrations.sh` (trajectory-gates chain) |
| S11 | <a id="S11"></a>hook | `SubagentStop` → `swe-atomic-close.sh`: auto-completes a still-running task that has commits, and meters the run | the swe transcript → `agent_runs` completed (tokens, duration, `stop_cause`) | `hooks/hooks.json` (SubagentStop); `scripts/hooks/swe-atomic-close.sh` |
| S12 | <a id="S12"></a>bro | Verify: `task_brief` + `git diff` of the commit, judged on the four checks: scope vs `files[]`, `verification_run` exit 0, the report covers every `SC<n>`, `world_model_get` on the changed directory | `tasks`, `verification_runs`, world model → none (`bro_verification_fail_record` on a failed check) | `skills/tmb_planning/SKILL.md:117-126` |
| S13 | <a id="S13"></a>bro | `bro_atomic_close(task_id, …, spawn_note?)` | `tasks`, `verification_runs` → task closed; audit `bro_verification_pass` | `composites.ts:895`; `skills/tmb_planning/SKILL.md:124` |
| S14 | <a id="S14"></a>hook | PostToolUse `bro_atomic_close` → `post-atomic-close-readme.sh` + `post-task-close-rescan.sh` (background `run-scan.mjs`) | the repo tree → `wm_*` rows upserted; audit `readme_staleness_surfaced`, `deep_scan_completed` | `scripts/hooks/post-atomic-close-readme.sh`; `scripts/hooks/post-task-close-rescan.sh`; `scan.ts:1003` |
| S15 | <a id="S15"></a>bro → code-reviewer | `Agent(subagent_type=code-reviewer, effort=reviewer_effort)`, the prompt carrying anchors only (`task_id= commit_sha= branch_id= repo= repo_path= attempt_n= subagent_session_id=`); the `agent-spawn-dispatch` gates include `code-reviewer-after-atomic-close` (the task must be closed) | `tasks` → `agent_runs` row opened | `skills/tmb_push-gate/SKILL.md:15-19,36`; `scripts/hooks/agent-spawn-dispatch.sh` |
| S16 | <a id="S16"></a>code-reviewer | `task_brief`, `git show <sha>`, `pr_monitor_worktree` probes, then `validation_record(verdict, findings[], mcp_available)`; PreToolUse `reviewer-identity-observe` stamps the reviewer | spec, diff → `validation_attempts` (+ `review_findings` on FAIL) | `agents/code-reviewer.md`; `skills/tmb_review/SKILL.md`; `validation.ts:168`; `scripts/hooks/reviewer-identity-observe.sh` |
| S17 | <a id="S17"></a>bro | `validation_history`: the verdict comes from the row, never from the reply text | `validation_attempts` → none | `skills/tmb_push-gate/SKILL.md:38` |
| S18 | <a id="S18"></a>bro | Base moved → `integrate.sh <task_id> <base>` rebases in a temporary worktree and reruns `verification[]` (L4 on exit 2); an unmoved base skips this step | `tasks`, `validation_attempts` → `verification_runs` source=manual on the rebased SHA; the task branch moved to it | `skills/tmb_planning/SKILL.md:130-136`; `skills/tmb_planning/scripts/integrate.sh:284` |
| S19 | <a id="S19"></a>bro | `git push origin <feature>`; PreToolUse `git-push-guard` allows it only when each pushed task commit has a passing review (a rebased commit also needs a passing run for its exact SHA) | `validation_attempts`, `verification_runs` → the remote branch | `skills/tmb_push-gate/SKILL.md:46`; `scripts/hooks/git-push-guard.sh` |
| S20 | <a id="S20"></a>bro | `gh pr create --base <pr_target>` (`glab mr create` on GitLab) | none → the PR | `skills/tmb_push-gate/SKILL.md:46` |
| S21 | <a id="S21"></a>Human | Merges the PR; once it reports `MERGED`, bro runs the post-merge cleanup. **Planned (GH 2026):** bro asks with an AUQ, merge by bro (CI and the local tests pass) or merge by the Human (the PR meets a human-review condition); not shipped. | GitHub → the merged PR | `skills/tmb_push-gate/SKILL.md:50-52` |
| S22 | <a id="S22"></a>hook | PostToolUse Bash after a successful in-session `gh pr merge` / `glab mr merge`: `close-issue-on-merge.sh` closes the branch's live tasks and each issue the PR closes by an explicit closing-ref; `clean-merged-branch.sh` removes the merged branch and its worktree. A merge made on GitHub fires neither. | `tasks`, `validation_attempts` → tasks and issue closed; audit `issue_auto_closed_on_merge` (+ `review_gate_bypassed` for a task with no passing review) | `hooks/hooks.json` (PostToolUse Bash); `scripts/hooks/close-issue-on-merge.sh`; `scripts/hooks/clean-merged-branch.sh` |

### Loops

| Id | Loop | Trigger | What happens | Source |
|---|---|---|---|---|
| L1 | <a id="L1"></a>Hook block → rerun | A PreToolUse hook denies a swe call, e.g. `containment-guard` on a write outside the worktree | swe reruns in the form the deny names. When the deny names none or says it is policy, swe closes `failed` with no report and quotes the hook. Returns to S9. | `agents/swe.md`; `scripts/hooks/containment-guard.sh` |
| L2 | <a id="L2"></a>Gate deny → fix | swe calls `task_update_status(completed)` but a `verification[]` command or an open finding's probe fails | `swe-verification-gate` denies the call, naming the command and its timing; swe fixes it and calls again. Returns to S9. | `scripts/hooks/swe-verification-gate.sh` |
| L3 | <a id="L3"></a>Review FAIL → rework → re-review | code-reviewer records `fail` with findings `F<task>-<n>` | bro surfaces the FAIL and holds the push, then `task_reopen(task_id, reason, effort='high', spawn_note)` naming the finding ids; swe fixes each, commits its probe as a test, the gate re-runs every probe, and code-reviewer reviews the next attempt. Returns to S7. | `skills/tmb_planning/SKILL.md:64,140`; `skills/tmb_push-gate/SKILL.md:47`; `validation.ts:168` |
| L4 | <a id="L4"></a>Integrate conflict → retry | The base moved and `integrate.sh` exits 2 (conflict or patch drift) | bro records the failure (`bro_verification_fail_record`), then `task_retry` cuts a fresh task, branch and worktree from the current base with a spec that points at the reviewed commit; it goes through verify and review again. Exit 1 (`verification[]` failed on the rebased commit) reworks as L3. Returns to S7. | `skills/tmb_planning/SKILL.md:130-136`; `composites.ts:766,832` |
| L5 | <a id="L5"></a>Rework limit | Two review FAILs since the last pass | The `rework-limit` spawn gate denies a third swe spawn on the task until a newer `kind='decision'` row names the change of approach, or the Human comments on the issue. bro picks `task_retry` with a redesigned spec, a split, or escalation; `task_retry` itself refuses a fourth retry in one lineage. Returns to S5. | `skills/tmb_planning/SKILL.md:141`; `mcp/trajectory-server/src/hooks/rework-limit.ts`; `composites.ts` (`task_retry` retry cap) |

```mermaid
flowchart TD
    S1["S1 Human ask"] --> S2["S2 world model"] --> S3["S3 base branch AUQ"]
    S3 --> S4["S4 branch_id_propose + intent_start"] --> S5["S5 triage: reuse or build"]
    S3 -.->|GitHub issue| S4p["S4′ issue_create adopts it"] --> S5
    S5 --> S6["S6 task_provision"] --> S7["S7 spawn swe"] --> S8["S8 task_brief"]
    S8 --> S9["S9 edit + test in worktree"] --> S10["S10 task_update_status + swe-verification-gate"]
    S10 --> S11["S11 SubagentStop swe-atomic-close"] --> S12["S12 bro: the four checks"] --> S13["S13 bro_atomic_close"]
    S13 --> S14["S14 rescan + README check"]
    S13 --> S15["S15 spawn code-reviewer"] --> S16["S16 validation_record"] --> S17["S17 validation_history"]
    S17 -->|pass| S18["S18 integrate.sh if the base moved"] --> S19["S19 git push"] --> S20["S20 gh pr create"]
    S20 --> S21["S21 Human merges"] --> S22["S22 close-issue-on-merge"]
    S9 -.->|L1 hook block| S9
    S10 -.->|L2 gate deny| S9
    S17 -.->|L3 FAIL: task_reopen| S7
    S18 -.->|L4 exit 2: task_retry| S7
    S17 -.->|L5 second FAIL: new decision| S5
```

**Notes**
- `require-task-spec.sh` blocks SWE spawn unless the `tasks` row is `pending`, or `running` with no open swe `agent_runs` row, AND has a non-empty `spec_body`. A spec that adds a column, field, tool, table or migration also needs `Writer:` + `Populated:` lines or a `Nullable:` line, unless a `spec_shape_gate_waived` row from `bro` names the task (`content_json.task_id`); `task_create_batch` / `task_provision` with `waive_spec_shape` write that row for each task they create, so no second write is needed.
- `no-worktree-branch-create.sh` blocks `-b/-B/--create-branch/--detach` — `task_provision` creates the branch and the worktree; the worktree attaches to the branch directly.
- `git-push-guard.sh` blocks the eventual push if any pushed commit's task lacks a passing `validation_attempts` row.
- `swe-verification-gate.sh` fires on SWE's `task_update_status(completed)`: it runs the task's typed `verification[]` commands in the task worktree, records the run in `verification_runs` / `verification_run_commands`, and denies if any fail, naming the command and its timing. A passing run for the same task, worktree HEAD and `verification[]` recorded within the hour is reused instead of re-run, and on a rework commit a command whose declared inputs (`.config/tmb/verification-inputs.json`) the rework did not touch is recorded as carried from the last passing run (GH 1950); bro and code-reviewer read the latest run from `task_brief.verification_run`. When the task worktree does not resolve, it does NOT fail open — it denies, naming the expected `<repoRoot>/.claude/worktrees/<slug>` path (#156). An empty `verification[]` skips the gate with a warning; a `waive_verification_gate_reason` (≥10 chars) waives it with an audit row.
- `bro_atomic_close` refuses with `verification_run_missing` when the task has a non-empty `verification[]` and neither a passing `verification_runs` row for the closing commit whose commands match the current `verification[]` nor a `verification_gate_waived` row for that commit (GH 1672). This covers the closes the swe gate never saw: a `swe-atomic-close` SubagentStop auto-complete, and a `task_update_spec` that changed `verification[]` after the run. To get a run, the swe calls `task_update_status(completed)` again on the commit; to waive, it adds `waive_verification_gate_reason` to that call.

---

## 3. Architectural change (Δ vs flow 2)

Same chain as flow 2, plus: in `task_provision`'s `decision_body` (S6), bro records a `kind=decision` discussion and applies the blast-radius checklist. The universal decision gate requires a `kind='decision'` row regardless of flow.

- Skills: `tmb_planning` triggers the architectural ceremony when the change introduces a new boundary/module, touches schema or public API, or has external side effects (see SKILL.md §"Architectural changes").
- For human-driven deliberation, the user enters Claude Code's native plan mode (Shift+Tab) — bro doesn't run a bespoke Q+A loop. The `kind='decision'` row captures the outcome.
- Bro's four checks after SWE returns (S12) are unchanged — never skipped, even for architectural changes.

---

## 4. Agent-creator

```mermaid
flowchart TD
    A[Human asks for role X] --> B{Role X exists in<br/>.claude/agents/?}
    B -->|yes| C[Route to existing agent]
    B -->|no| D[Bro runs /tmb:agent-create]
    D --> E[Skill: ≤3 clarifying Qs]
    E --> F[Skill: draft tailored prompt]
    F --> G[Show prompt to Human]
    G --> H{Human approves?}
    H -->|no| F
    H -->|yes| I[Write .claude/agents/x.md + agent_register]
    I --> J[Subsequent sessions: bro routes to X]
```

Reserved names — `bro`, `architect`, `swe`, `code-reviewer` — are refused. New agent files commit to the project; every dev gets it on next pull.

---

## 5. Skill creation

Same shape as flow 4 — bro drafts via `tmb_skill-creator`, Human approves, file lands at `<project>/.claude/skills/<name>/SKILL.md`. Bro never edits agent body files; instead writes a project-local override agent file that extends `skills:`.

---

## 6. Push gate / PR review

```mermaid
sequenceDiagram
    participant H as Human
    participant B as Bro
    participant P as code-reviewer (subagents — parallel)
    participant DB as SQLite

    Note over B,DB: flow 2 S13: bro_atomic_close closes the task
    par one code-reviewer per closed task (S15)
        B->>P: Agent(code-reviewer, anchors only: task_id= commit_sha= …)
        P->>DB: task_brief(task_id=N) — spec, completion report, open findings
        P->>P: git show <sha>; pr_monitor_worktree probes
        P->>DB: validation_record(verdict='pass'|'fail', findings[], mcp_available)
    end
    B->>DB: validation_history — read each verdict off its row (S17)

    alt all pass
        B->>B: integrate.sh <task_id> <base> when the base moved (S18)
        B->>B: git push (git-push-guard allows the reviewed SHAs, S19)
        B-->>H: gh pr create → PR URL (S20)
    else any fail
        B-->>H: surface failures verbatim → AUQ: spawn SWE to fix (flow 2 L3) or abort the push
    end
```

A push made before review (by bro or the Human) hits `git-push-guard.sh`, which denies it while any pushed task commit lacks a passing `validation_attempts` row.

`validation_record` carries a typed `mcp_available` boolean (required for code-reviewer; written to the `validation_attempts.mcp_available` column). The push-gate reads it from the row — `1` = MCP-backed review, `0` = honor-system fallback (a subagent that lacks MCP access reviews via the sqlite3 fallback path and records `mcp_available: false`). `feedback` is free-prose rationale. The reviewer's identity comes from the newest unconsumed `reviewer_identity_observed` row for `(task_id, attempt_n)` (written by the `reviewer-identity-observe` hook with the call's `tool_use_id` and `observed_at`) observed within the last 600 s; an older row is never consumed — the call fails `subagent_session_unavailable` naming the row's age, and the reviewer calls again so the hook writes a fresh row. When a row is consumed, every older unconsumed row for the same `(task_id, attempt_n)` (left by a failed or retried call) is marked superseded with the consumed row's audit id, so a routine retry leaves no orphan for `trajectory_doctor` to warn on. An honor-system call (`mcp_available: false`) may only fill an attempt with no verified row: it never overwrites an `mcp_available = 1` verdict (`verified_verdict_exists`), while a verified call may still replace a verified row.

---

## 7. Scan + world-model refresh

`scan_run` is the single scan-side MCP tool. It forks the deterministic `scripts/scan.sh`, then writes the **world-model graph**: a `Directory` node per tracked directory (summary preferentially from `<dir>/README.md`, else a structural fallback over file/subdir names; plus a file count), linked to its parent by a `CONTAINS` edge. See [`WORLD_MODEL.md`](./WORLD_MODEL.md); inner-repo path scoping is in [`REPO_RESOLUTION.md`](./REPO_RESOLUTION.md).

Triggered five ways (the `source` value is verified against `scan.ts`):

| Trigger | `source` value | Who fires |
|---|---|---|
| First code-touching ask when the world model is EMPTY | `bro_auto_initial` | Default when no `source` is passed; bro hits the `world-model-empty` gate (`tmb_planning` §1) and remediates |
| User typed `/scan` | `user_manual` | The slash command body passes it |
| `post-task-close-rescan.sh` hook on `bro_atomic_close` | `bro_auto_post_close` | Hook runs `scripts/maintenance/run-scan.mjs` in background; it imports the bundled `mcp/trajectory-server/dist/run-scan.js`, which inlines web-tree-sitter, so symbols index in a plugin cache without devDependencies (GH 1878) |
| Bro decides to rescan mid-session | `bro_auto_post_change` | Bro passes it explicitly |
| trajectory-server connects (`startStartupCatchup`) | `startup_catchup` | The server runs `scripts/maintenance/run-scan.mjs` detached, with the source as its second argument |

`scan_run`'s `deep_scan_completed` audit row carries `content_json` with:

- `source` (one of the five values above)
- `structural_change` — true if the repos set OR top-level dir set differs from the previous scan
- `repos_seen[]`, `top_dirs[]` — current snapshot of the project shape

**Resource discovery (#124/#846).** The same scan ALSO reconciles on-disk capabilities into the `cheatcodes` table: project-local skills (`.claude/skills/<name>/SKILL.md`), enabled plugins (`claude plugin list`), and configured MCP servers (`claude mcp list`). Each resource not already tracked (matched on name+kind) is inserted as `origin='installed'`, `status='installed'`, `source_url='scan_discovered'` (distinguishing it from a pipeline install) and emits a `scan_discovered` audit row — so a cheatcode added out-of-band still becomes visible to the lifecycle flow below.


---

## 8. SWE retry / escalation

Triggered when one of bro's four checks fails (flow 2 S12), code-reviewer records verdict='fail' (L3), or `integrate.sh` exits 2 (L4). More work on the same task goes through `task_reopen`, which moves it back to `running` and recreates its worktree when missing. A wrong approach or an integrate conflict goes through the `task_retry` MCP composite — one transaction appends the retry rationale, creates a new `tasks` row, cuts its branch and worktree like `task_provision`, copies the failed task's open review findings onto it, and writes an `audit(event_type='task_retry_attempted')` row. Then bro spawns SWE on it.

Two FAILs since the last pass trip the rework limit (L5). `task_retry` refuses a fourth retry in one lineage (`retry limit reached (3) — escalate to Human`).

---

## 9. Roundtable

Multi-consultant deliberation. Bro orchestrates 2–4 consultants on a topic, then renders an AUQ for Human ratification.

- `roundtable_create` opens the table.
- Bro spawns each consultant via `Agent` with the shared topic; consultants write `discussion_append(kind='analysis'|'concern')`.
- Each consultant `roundtable_vote(participant=<role>, vote, rationale)`.
- `roundtable_close` flips state to `awaiting_human` + emits a `discussion_append(kind='decision', body=summary)`.
- `roundtable-auq-shape.sh` validates the ratification AUQ structure.
- After Human picks: `roundtable_finalize_decisions` + `roundtable_summarize`.
- `roundtable-cleanup-postcheck.sh` verifies the capture surface (audit + discussion rows) actually landed.

---

## 10. Cheatcode lifecycle

Bro acquires a capability (skill, MCP toolkit, or plugin) on demand instead of grinding it out by hand. The mechanical pipeline is deterministic tools + hooks; only the judgments stay prose — "do I lack a capability this task needs?", "is this candidate trustworthy?", and "which agent consumes it?". Architecture-of-record: [`CHEATCODES.md`](./CHEATCODES.md). This is the full lifecycle.

```mermaid
flowchart TD
  T{{Trigger}} -->|capability wall / Human says cheatcode / proactive reuse-check| SEARCH[cheatcode_search\nranked candidates + audit]
  SEARCH -->|none fit| BUILD[Build it instead:\ntmb_skill-creator or write from scratch]
  SEARCH -->|candidate| VET[cheatcode_vet\ntrust_tier + capabilities; never decides]
  VET --> APPROVE{cheatcode_approve\nHuman AUQ}
  APPROVE -->|rejected| STOP[Stop: no install]
  APPROVE -->|approved — PreToolUse gate now open| TARGET{Decide consuming agent}
  TARGET -->|Human named it| HAST[target = named agent]
  TARGET -->|infer by domain| INFER[coding/test/refactor/debug → swe\nreview/quality → code-reviewer\norchestration/routing → bro\nconsultant-domain → that consultant]
  TARGET -->|ambiguous| ASK[AskUserQuestion: which agent?]
  TARGET -->|pure MCP/plugin server tool,\nno agent surface| NOTGT[no target needed — registration IS attachment]
  HAST --> INSTALL
  INFER --> INSTALL
  ASK --> INSTALL
  NOTGT --> INSTALL
  INSTALL[cheatcode_install\nmarketplace/MCP path, no seed/copy\nidempotent on name+source_url\none txn: cheatcodes row + attachments + audit]
  INSTALL -->|kind=skill or skill-contributing plugin, target set| MAT{Materialize / attach — LEGO}
  INSTALL -->|kind=mcp/pure-server plugin| AUTOATT[registration IS attachment\nscript attachment rows recorded — never an orphan]
  INSTALL -->|kind=skill, NO target| UNATT[hard-rejected (#883) — no resolved target,\nno install; orphan can't occur]
  MAT -->|target=bro| CMD[copy → project .claude/CLAUDE.md reference]
  MAT -->|target=other| AMD[copy global agents/&lt;target&gt;.md → .claude/agents/&lt;target&gt;.md if absent\n+ add name to skills: header — idempotent]
  CMD --> ACT
  AMD --> ACT
  AUTOATT --> ACT
  ACT{cheatcode_activate}
  ACT -->|skill| LIVE[usable in-session — activated]
  ACT -->|mcp/plugin| RESTART[restart_required — loads next cold start]
  LIVE --> USE[Consuming agent carries the skill in its header → invokes it]
  RESTART --> USE
  USE --> HEALTH[server start + cheatcode_reconcile\nreconcile status vs runtime; audit on drift]
  HEALTH --> SCANP[scan_run also discovers on-disk resources\n→ cheatcodes table, source_url='scan_discovered']
  USE -.unused.-> UNINST{cheatcode_uninstall\nHuman-confirmed AUQ}
  UNINST -->|teardown removed| REV[reverse via marketplace/MCP path\n+ DELETE cheatcodes & attachment rows\n+ de-materialize the skills: header entry\n+ audit]
  UNINST -->|teardown failed — honesty gate #114| BROKEN[keep row, status → broken, audit;\nreport uninstalled:false]
  UNINST -->|absent / partial| NOOP[idempotent no-op]
```

**Phase by phase:**
- **Trigger** — bro hits a capability wall, the Human says "cheatcode" (`prompt-intent-hints.sh` nudges), or a proactive reuse-check before building from scratch.
- **Search** — `cheatcode_search` (forks `scripts/cheatcode-search.sh`) returns ranked candidates + an audit row. No candidate fits → build it (`tmb_skill-creator` or from scratch).
- **Vet** — `cheatcode_vet` gathers reputation/security signals + a deterministic `trust_tier` and `capabilities[]`; it reports, never decides.
- **Approve** — `cheatcode_approve` records the per-candidate Human approval; `cheatcode-install-approval.sh` (PreToolUse) fails closed without it. Rejected → stop.
- **Decide consuming agent** — `target` is optional as an *input* (the Human may not name one), but for a skill it is **mandatory as an output**: a skill install MUST end attached to ≥1 agent's markdown, or it is an **orphan** — installed but bound to nothing, hence unusable. So deciding the consuming agent is mandatory for skills: if the Human named the agent, use it; otherwise bro **resolves one before install** — infer from the cheatcode's domain (coding/test/refactor/debug → `swe`; code-review/quality → `code-reviewer`; orchestration/routing → `bro`; a consultant domain → that consultant), and ask via AskUserQuestion only when genuinely ambiguous. Exception: a kind=mcp server (or a pure-server plugin) needs no target — its `claude mcp add` registration **is** its attachment, its tools are callable by any agent, so it carries no `skills:` header entry and is **not** an orphan. The mandatory-output-attachment rule applies specifically to skills and skill-contributing plugins.
- **Install** — `cheatcode_install` installs via the marketplace/MCP path (no seed/copy), idempotent on (name, source_url); one transaction records the `cheatcodes` row + every `cheatcode_attachments` row + the `cheatcode_install`/`cheatcode_installed` audit rows. `scope` defaults to project-local. A live kind=mcp install fails closed: the candidate carries only `name` and `source_url`, and a source URL is not a run command, so it returns `installed:false` without calling `claude mcp add` (GH 1885; run-command resolution is GH 1899).
- **Materialize / attach (LEGO)** — for a skill or skill-contributing plugin, the install writes the consuming agent's prompt surface IN THE USER PROJECT (never the plugin repo): `target=bro` → a `.claude/CLAUDE.md` reference; any other target → copy the global `agents/<target>.md` into `.claude/agents/<target>.md` (if absent) and add the cheatcode name to its `skills:` frontmatter array — idempotent, the Lego edit. This attachment is mandatory output: a skill with no target lands as an **orphan** — installed but unattached, and not usable until a target is resolved (a defect to eliminate, not a supported path). A kind=mcp server (or pure-server plugin) is exempt: its registration is its attachment, so it needs no `skills:` entry and is never an orphan.
- **Activate** — `cheatcode_activate`: a skill is usable in-session; an MCP/plugin returns `restart_required` (loads on the next cold start).
- **Use** — the consuming agent now carries the cheatcode in its `skills:` header and invokes it like any skill.
- **Reconcile** — the trajectory-server (at every start, and on demand through bro's `cheatcode_reconcile` tool) checks each active/broken row's `status` against the real runtime (skill file on disk, MCP/plugin present + enabled) and audits drift. Startup always checks skill rows. It runs the `claude mcp list` / `claude plugin list --json` listings only when an active/broken mcp or plugin row exists, and then only if the CLI config fingerprint changed (a sha256 over the `mcpServers` maps, `.mcp.json`, `enabledPlugins` and `installed_plugins.json`) or `.claude/tmb/cheatcode-probe.json` is missing, corrupt or older than 24 h. `cheatcode_reconcile` always probes and refreshes that cache. `scan_run` (flow 7) discovers on-disk resources into the table (`source_url='scan_discovered'`).
- **Uninstall** — `cheatcode_uninstall` (Human-confirmed AUQ; not PreToolUse-gated) reverses each attachment via the marketplace/MCP path, de-materializes the `skills:` header entry, and deletes the `cheatcodes` + `cheatcode_attachments` rows in one transaction. The honesty gate (#114) keeps the row and flips `status → broken` (reporting `uninstalled:false`) when a teardown fails rather than claiming a clean removal. Absent/partial → idempotent no-op.

**Enforcement (#883):** (1) a skill install is **hard-rejected** without a resolved target — no orphan can land (the mcp/pure-server registration-is-attachment path needs no target and is exempt); (2) `cheatcode_uninstall` de-materializes the `skills:` header entry so no dangling reference remains. Both are enforced.

---

## 13. Bulk cleanup (pre-authorized destructive ops)

When the Human's prompt names what to delete (branches, temp files, etc.), bro executes in one Bash call with no AUQ and no re-confirmation. Defensive checks (which files match? any active worktrees?) belong *before* the Human authorizes. Re-asking treats a standing directive as a question — wastes time and ignores intent.

---

## 33. Multi-repo path discipline

When a workspace has multiple inner git repos (siblings or submodules), each is identified by its `repos` row (path-keyed resolution; an operation matches its path against `repos.path`, or a task names its repo via `tasks.repo`). Directory node `path` properties are stored repo-relative — `scan_run` does NOT prepend the inner repo directory when writing nodes. See [`REPO_RESOLUTION.md`](./REPO_RESOLUTION.md).

The L5 row `tests/l5-l6/rows/33-multirepo-commit/` catches regressions at the storage layer: a Cypher `MATCH (d:Directory) WHERE d.path STARTS WITH 'api/' OR d.path STARTS WITH 'app/'` returns ≥1 node only on a workspace-rooted path leak.

Registration also scopes the `no-source-edit-from-main.sh` guard: Rule 1 only protects registered repo subtrees, so absolute edits to unregistered sibling repos are allowed. See `docs/architecture/RESPONSIBILITIES.md` (#592).

---

## C. Consultant invocation

Human types `/tmb:agent-create <ask>` OR a naturalistic question matching `/tmb:agent-create`'s description. Either path loads the skill, which calls `agent_resolve` to classify the role (collision, template-copy or from-scratch) and registers a newly written consultant with `agent_register`, then spawns the consultant via `Agent`. Consultant writes its analysis as `discussion_append(kind='analysis')`. Bro reports to Human; **the Human decides** — never the consultant.

`prompt-intent-hints.sh` UserPromptSubmit hook detects domain-keyword prompts and injects a routing hint (advisory; bro decides whether to spawn).

---

## M. Monitor PR comments

`/monitor <PR_number>` slash command. Bro fetches the PR's review comments via `pr_monitor_comments_get`, triages actionable ones, files them as new `issues` + `tasks`, and dispatches SWE per ratified comment batch. Run state lives in `pr_review_runs` so re-runs of the same PR start from the last fetched comment ID. The server persists every fetched comment as a `note` discussion on the issue of the task that owns the PR, deduped by `discussions.remote_comment_id`; the result's `persisted` and `duplicates` count new and already-stored comments.
