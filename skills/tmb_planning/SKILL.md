---
name: tmb_planning
description: Bro's code-touching flow — verify world model, triage the requirement (reuse vs build), propose branch, write spec, dispatch SWE, hand off to code-reviewer, atomic-close after its pass. Loaded on the first code-touching ask of a session.
allowed-tools: Bash, Read, Glob, Grep, AskUserQuestion, Task, mcp__plugin_tmb_trajectory-server
effort: high
---

# Planning — bro's code-touching flow

## 1. Verify the world model

`world_model_get(depth=2)` returns the project's directory tree with README-derived summaries. The main checkout shows only merged work — when `unmerged_work` is non-empty, those branch tips are part of the codebase too: read context from and base follow-up work on the newest relevant tip (`task_provision base=<branch_id>`). If the response carries `warning: 'world-model-empty'`, run `scan_run(source='bro_auto_initial')` to build it, then re-read.

Zoom-in: `world_model_get(path='src/api', depth=1)`. "Where does X live": `world_model_search(query='X', mode='hybrid')`. For the callers, importers, table readers and tests of a symbol, call `world_model_symbol(agent='bro', qualified_name, path, impact: 2)` first.

Use Bash, Grep or `git grep` only for what the world model cannot answer: symbols new on an unmerged branch, text in non-code files (prose, config, prompts), or a world-model miss. World-model use is under test, so record misses honestly: when it misses or answers wrong, write `discussion_append(issue_id, author='bro', kind='note', body='wm_feedback: <what it answered, missed or got wrong>')`.

When a `world_model_get`, `world_model_search` or `world_model_symbol` response carries `needs_review`, work through it: re-verify, rewrite or retire each listed concept with `world_model_concept_upsert` (a concept stays listed until you do), and check each listed README still matches its directory's code, routing any fix through swe. A README is listed once, on the response delivered to you.

## 2. Triage the requirement

With the world model in hand, before you commit to building — two quick questions (judgment, not a research project):

1. **Is it actionable?** Well-defined, testable, in scope? If it's vague hand-waving, surface the gap via `tmb_concerns-protocol` (or an AUQ) and pin it down *before* authoring a spec.
2. **Reuse or build?** Once the requirement is real and we'd build something, prefer reuse over reinventing — check two distinct axes before committing to from-scratch code:
   - **Feature reuse** (a code dependency): does a public codebase / package / module / library already cover the work? Prefer depending on a maintained one over hand-rolling it. This is still a **build** — it flows on to step 3 — but the spec leans on the package (name it in the spec's Assumptions) instead of reimplementing it.
   - **Cheatcode reuse** (an agent capability): would a reputable published skill / MCP / plugin provide the *capability* itself? Prefer grabbing it via the cheatcode flow over building that capability — load `tmb_cheatcode`, which runs the full search→vet→recommend→Human-approve→install lifecycle (`cheatcode_search` alone skips the vet/approve/install steps).
   - **Codify** a repeatable in-house **behavior** worth keeping (a convention or checklist) → `tmb_skill-creator`, not a build spec.
   - **From scratch**: none of the above fits → genuine build, continue to step 3.

   The distinction is inside vs on the agent: a package is a dependency inside the code; a cheatcode is a capability added to an agent's toolkit.

A reported defect gets reproduced on the target branch tip before you file or dispatch it. Record what you saw (reproduced, or already fixed and at which commit) in the issue with `discussion_append`.

Record the reuse-vs-build call with `discussion_append(issue_id, author='bro', kind='decision', body='<reuse X / build because …>')`. Both records go on the issue: on an existing issue now; for new work, which has no issue until §3's `intent_start` creates it, right after that call.

Cheatcode reuse and codify take their own path — the `tmb_cheatcode` lifecycle or `tmb_skill-creator` — and do **not** proceed through the branch+spec+swe steps below. Feature reuse and from-scratch are both builds: they flow on to steps 3–6.

## 3. Propose a branch

You pick the base and the name yourself, because the environment is your layer. Base the new branch on the configured `pr_target`, or on the unmerged branch tip the task stacks on (§1), passed as `task_provision`'s `base`.

Get a name from `branch_id_propose` (pass the Human's verbatim intent and a short objective) and use the `branch_id` it proposes, then let the `intent_start` composite create the issue, log the intent, and record the planning note in one transaction; then append §2's records to the new issue. `task_provision` (§5) creates the git branch — don't create it here.

## 4. Author the spec

Before each `task_provision`, `task_reopen`, `task_retry` or `task_update_spec` that writes a spec, invoke the `tmb_spec-authoring` skill with the issue or task id as its argument; its `effort: high` raises that turn to high.

When the work comes from an existing issue, read it with `issue_get_with_discussions`: its newest `kind='decision'` supersedes the issue description, and the spec follows that decision.

The plan for a multi-task issue goes in the issue description and the spec in `task_provision`; scratch holds throwaway scripts, logs and data dumps only.

Pick conservative defaults; name them in `## Description` Assumptions bullets. The repo wins: match the project's dependencies, test runner, storage pattern and module layout before reaching for anything new, and assume the simplest runtime that satisfies the requirement.

Before building `files[]`, call `scope_suggest(agent='bro', objective, anchors)` (or `world_model_symbol` on each anchor symbol), and build `files[]` from what it returns plus your own judgment. The `task_provision` hook denies the call unless this session recently read the world model on code that covers one of the task's `files[]`: the path itself, or a directory above or below it.

Pass the typed machine contract on each swe-executed task:

- `files: string[]` — the surfaces the task is expected to touch, at directory granularity and in the project's own layout: its source tree, its hooks or scripts, its tests, its docs, its changelog fragments where it keeps them. The swe may edit other paths inside its worktree and reports each one with a reason; you judge them at close.
- `verification: string[]` — the gate's list: runnable bash commands, one per entry, commands only; what a command proves goes in `## Description`. The project's verification defaults (`.config/tmb/verification-defaults.json`) apply automatically on provision, retry, reopen and spec update, so verification[] lists only the task-specific checks. Dry-run each command before `task_provision` and prefer the repo's own test scripts or runner. Keep commands portable across BSD and GNU tools. List the tests for the paths the task touches, plus the repo's type check or lint where it has one. When the repo's CI workflows run the full suite before merge, swe's world-model caller check stands in for it locally: CI only confirms, so a CI failure is a leak (§6). A repo with no such CI keeps its full suite in verification[].
- `effort` — the swe's effort level, by this rule:

| Effort | When |
|---|---|
| `medium` | Default |
| `high` | The task changes enforcement logic (a hook, guard or permission gate that can deny), a schema or migration, or is prompt-bearing (`prompt_bearing: 1`) |
| `high` | Any rework spawn after a reviewer FAIL: the FAIL raises the task to `high` itself, so spawn with `high`; a retry passes `task_retry(..., effort='high')` |
| `low` | Consultants and lookups |

Editing a DB-layer, write-handler or hook file without changing what it admits or denies stays `medium`.

swe executes a spec bro already pinned, so medium is the executor default; high is for surfaces where a miss fails open.

The `spec_body` markdown carries the prose bro and swe reason from. Its sections are `## Intent, ## Description, ## Success Criteria, ## Out of Scope, ## Commit` — split into multiple tasks linked by `parent_branch_id` when it passes any of: 8 `files[]` entries, 8 `verification[]` commands, 5 `SC` ids or about 5000 characters, so each task fits one swe run:

- `## Intent` — the Human's goal in one or two sentences
- `## Description` — ≤3 sentences, file paths with line refs, Assumptions bullets
- `## Success Criteria` — 2–5 testable assertions, each a top-level bullet opening with a unique id (`- SC1: …`, `- SC2: …`); nested `Writer:` / `Populated:` lines carry none. The swe reports against these ids, and a blocking code-reviewer finding cites its basis: an SC id, a spec line or base behaviour.
- `## Out of Scope`
- `## Commit` — `<emoji> <type>(<scope>): <msg>`

Ground the spec in its sources, because code-reviewer judges from the task's `spec_body` through `task_brief`, not from the issue's discussion:

- Each `SC<n>` names its source in its bullet: the Human's words, quoted, or `decision #<discussion id>`. A criterion with neither is an assumption: move it to the Assumptions bullets or ask the Human.
- Every factual claim about the code cites its source: `file:line`, or the query or command that shows it.
- Before `task_provision`, re-read the goal (the issue and its newest decision) against the finished spec: each part of the goal maps to an `SC<n>` or an `## Out of Scope` line, and no criterion reaches past the goal.

A prompt-bearing spec cites, in `## Success Criteria`, the rubric ids its prompt lines must meet, taken from the rubric `tmb_doc-review` step 1 loads, so swe and code-reviewer grade against the same list. On a no-code change you author yourself, run `tmb_doc-review` steps 1–4 on it and fix every blocking result before you ask for review.

When the task adds a column, field, enum value, tool-result key or file output, `## Success Criteria` names each one with its own `Writer: <tool, hook or function that sets it>` line and a `Populated: <verification[] command proving a non-null sample or a count above zero>` line, or a `Nullable: <reason>` line when empty is correct. The spawn gate checks schema-touching specs for these lines.

A spec for a guard or gate (a hook, permission check or validator) states in `## Description` whether it is allowlist-based. A denylist design needs a recorded decision (in `decision_body`) naming why an allowlist does not fit, because it fails open on input it did not foresee.

A dry run or smoke test is a `verification[]` command that exits non-zero when its expectation fails, run against a `cp` of reference data so the live DB stays untouched: `node --experimental-sqlite "${CLAUDE_PLUGIN_ROOT}/mcp/trajectory-server/dist/cli.js" assert-sql <db-copy> "<sql>" <expected>`.

The chosen approach rides into `task_provision` as `decision_body` (§5) — it writes the `kind='decision'` discussion atomically with the task, so the approach needs no separate `discussion_append`; the reuse-vs-build call is already on the issue (§2).

### Architectural changes

When the change does any of the following, capture the decision + rationale in the `task_provision` `decision_body` (§5) and apply the blast-radius check. The trajectory is the record; there's no separate document to author:

- Introduces a new service boundary or top-level module
- Modifies a public API surface
- Commits to a strategic stack choice (auth provider, production DB, retention policy)
- Names multiple unrelated surfaces in one task
- Has external side effects (network, billing, message-sending, writes outside the worktree)

Blast-radius (external side effects only): default config is the safe state (opt-in); the task's own `verification[]` must prove zero external mutations before the change can merge.

## 5. Spawn SWE

Call `task_provision(issue_id, branch_id, decision_body, task, base?)` — it atomically writes the `kind='decision'` discussion, creates the task (with the typed `files[]` + `verification[]` and the planning-complete event), creates the git branch, and creates the worktree. It returns the spawn-ready shape `{task_id, branch_id, worktree_path, ...}` — branch and worktree already exist.

Then spawn SWE with the `task_id` it returned. The swe runs the tests for what it touched while it works; the gate runs `verification[]` once, when the swe closes, and records the run for that commit. Independent tasks run concurrently: provision every one of them, then spawn one swe per task in the same turn — one Agent call each, all in one message. A task waits only when it needs another task's merged output, and its `decision_body` names that dependency. Each spec names the sibling tasks running alongside it and their `files[]`. You prepare the environment: `task_provision` hands swe four things, a clean worktree on its branch, the base commit it was cut from (the up-to-date base), a passing build of that base (its environment gate runs the repo's worktree setup and refuses with `env_gate_failed` when it fails), and the world-model commit indexed at that base; a rework spawn gets the same. swe uses them as given: on a broken base it closes `failed` with the environment named as wrong rather than repairing it, so fix the environment, then `task_reopen` and spawn again.

### Spawning SWE

The Agent PreToolUse gates enforce a spawn contract:

- The spawn prompt MUST contain the literal `task_id=<N>` from the `task_provision` response — a bare `task_id 5` without `=` fails the gate.
- The Agent call carries `effort` equal to the task's effort; the spawn gate denies a mismatch.
- The task must be `pending` (or `running` with no live SWE run) with a non-empty `spec_body` — `task_provision` guarantees this.
- The branch and worktree are created by `task_provision` — don't pre-create the branch or `EnterWorktree` manually.

## 6. Hand off to code-reviewer on SWE return, close after the pass

Hand off, review and close each task as it returns; a task's close waits on nothing but its own review. The order is swe returns → `review_handoff` → code-reviewer → `bro_atomic_close`. Code owns the checks: you re-run no checks and re-review no diff. Your own judgment covers two things only:

1. **Scope extras.** Every changed path outside `files[]` is one the swe reported with a reason you accept. `review_handoff` records them with swe's reasons in `task_brief.scope.extras`, so code-reviewer reads them too; at the close, `bro_atomic_close` refuses and lists the extras grouped by surface, and closes on a retry with `waive_scope_gate: true` and a `scope_waiver_reason` of at least 10 characters, after which `task_brief.scope` carries `extras_accepted` and `base_moved`.
2. **Architecture fit.** Whether the change fits the design and the spec's intent, judged from `task_brief` and the commit's changed paths (`git -C <repo path> show --stat <commit_sha>`, the repo path from `repos_list`). A misfit goes back to your spec: record it with `bro_verification_fail_record` (name the misfit and why; it changes no status), amend the spec with `task_update_spec`, then move the task back to `running` with `task_reopen` and spawn swe; the new commit takes a new `review_handoff`. A misfit that needs a redesign moves the task to `escalated` with `task_update_status` first, because `task_retry` takes only a failed or escalated task.

- **Hand off.** After SWE returns `status=completed`, call `review_handoff(task_id, session_id)` on the completed task. It refuses without a completion report covering every `SC<n>` id or without a passing verification run for the task's `commit_sha` (the gate reuses a passing run for the same task and commit), and a refusal goes back to swe. It records the review anchor and the reviewer effort, leaves the status `completed`, and returns `reviewer_spawn`. Spawn code-reviewer with that `reviewer_spawn` as is — the anchors only, which the spawn-shape hook enforces; the spawn gate denies a code-reviewer spawn on a completed task with no handoff for its commit. Context the reviewer cannot read from `task_brief` goes in `review_handoff`'s `spawn_note` (300 characters max).
- **Close after a PASS.** Call `bro_atomic_close` (`close_issue_if_last_task=true` when it's the last task); it refuses with `review_pass_missing` until a passing verdict follows the handoff of the task's current commit, and keeps the scope gate on the extras. The world model indexes the merged `pr_target`, so a closed task's change reaches it once its PR merges, through the fetch a world-model read makes or the reindex that follows the target branch moving. When the closed task was an architectural change (the cases listed under "Architectural changes" above — a new top-level module, dir, or service boundary), also call `scan_run` yourself once that task's PR merges, so the world model indexes the new structure before the next read.
- **Rework after a FAIL.** The FAIL already reopened the task at `high` with a `spawn_note`; surface it, hold the push, and spawn swe (below); the reworked commit takes a new `review_handoff`.

### Integrate after the review pass

When code-reviewer passes the task and the base has not moved, push the reviewed commit as is. When the base has moved, run `node --experimental-sqlite "${CLAUDE_PLUGIN_ROOT}/mcp/trajectory-server/dist/cli.js" integrate <task_id> <base>`. It rebases the reviewed commit in a temporary worktree and carries the review pass to the rebased SHA only when all three hold: (a) the patch-ids are identical, (b) verification re-passes on the rebased commit, and (c) the base commits it moved over touch none of the diff's files or their world-model dependents. Commits the rebase drops because the base already holds them are not drift. Its exit code says what to do next:

- **Exit 0** — rebased, re-verified and the pass carried, and the task now records the SHA it prints; push it. The Human may still ask for a head review. A base that had not moved prints the reviewed SHA unchanged; push it as is.
- **Exit 1** — `verification[]`, a close lint or the worktree setup failed on the rebased commit, and the branch is unmoved. A failed check goes back to swe: `task_reopen` moves the closed task back to `running` (it refuses once the task's issue is closed; track the rework under an open issue then), and you spawn swe on it (rework below).
- **Exit 2** — a conflict or patch drift; move the closed task to `escalated` with `task_update_status`, then `task_retry` on a fresh branch from the current base, with a spec that points at the reviewed commit. The retry goes through verify and review again. When stderr says the task's patch is already in the base, there is nothing to integrate or push.
- **Exit 3** — the task has no passing review for its recorded SHA (a head needs its own review only when no carried pass covers it); spawn code-reviewer first.
- **Exit 4** — a precondition failed: the arguments were wrong, the base fetch failed or timed out, the task has no `verification[]`, the branch is checked out in another worktree or sits at a commit that is neither the reviewed one nor a verified rebase of it, or the task row could not record the rebased SHA. Surface its stderr and fix the cause before re-running; in the last case the branch has moved, so re-run review on the new SHA. When stderr says `<branch> is checked out at <path>`, such as a worktree a session adopted, release the branch there (`git -C <path> switch --detach`, or remove that worktree), then rerun integrate.
- **Exit 5** — rebased, verified and the branch moved, but the pass does not carry, because condition (c) failed (stderr names the reason and up to 10 overlapping paths) or the world model could not answer. The task records the printed SHA, and the push guard denies it until a review covers it. Spawn exactly one new code-reviewer pass on that SHA before the push, with no swe rework unless that review fails; its FAIL reopens the task like any other.
- **Exit 130 or 143** — integrate was interrupted (INT or TERM) and finished its open verification run with that code; rerun it.

### Rework and spec changes

- **Branch already exists.** `task_provision` reuses a `branch_id` only when it sits at or behind the base; a diverged one comes back as `branch_exists_diverged` with its distance and any open PR. Pick a fresh name with `branch_id_propose`, or pass `reuse_existing: true` when that branch holds the work you mean to continue.
- **Same task, more work** (a failed or escalated run): `task_reopen(task_id, reason, files_add?, verification_add?, effort?, spawn_note?, session_id?)` moves it back to `running`, widens its fences, and recreates its worktree when missing; pass `effort='high'` to raise the task's stored effort, then spawn SWE on it again with that same `effort`. A review FAIL already reopened the task at `high` with a `spawn_note` naming each finding id to fix (`F<task>-<n>`) with its `class`, so the swe sweeps every sibling of that class; the swe reads them, with their probes, from `task_brief.open_findings`. After a FAIL, call `task_reopen` only to widen the fences, add to the `spawn_note`, or recreate a missing worktree.
- **Red CI on the PR:** a required CI check that fails on the task's PR is a failed check, so it goes back to swe on the same task: `task_reopen` with the failing check named in `spawn_note`, then spawn swe; the reworked commit takes a new `review_handoff`. CI confirms rather than discovers, so the failure is also a leak: record the cheap check it caught in the layer that owns it, the project's verification defaults (`.config/tmb/verification-defaults.json`) or the swe checklist, so the next task catches it before review.
- **Rework limits:** the spawn gate denies a further swe spawn or resume of a task at two review FAILs on it since its last passing review. Debug the root cause, the inputs first (spec, world model, reviewer, environment), then swe's execution; record it with `task_rework_analysis` and make the change it names: spec_update with `task_update_spec`, or world_model_fix with `scan_run`, `world_model_concept_upsert` or an `Area: World Model` issue. The first FAIL already raised the task to `high`, so effort_raise is not available here. That analysis plus its proven change admits the next run. A shared approach cause or root_cause `design_drift` takes `task_retry` (after moving the task to `escalated`) or a split instead: a new task with a redesigned spec, and a `design_drift` analysis ends the drifted task's swe runs. Nothing here waits on the Human.
- **Wrong approach:** `task_retry` starts a fresh task on a new branch with a corrected spec. It takes only a failed or escalated task, so move any other task to `escalated` with `task_update_status` first.
- **Spec fix on a live task** (a typo, a missing path or command): `task_update_spec(task_id, reason, files?, verification?, spec_body?)`.
- **Resume the same swe** for in-scope rework (same spec, findings within `files[]`) when the task's effort is unchanged since its run, such as already `high`: once the task is `running` again, `SendMessage(to=<its agent id from the spawn result>)` naming the finding ids; `swe-resume-gate` judges it like a spawn. When the FAIL raised the effort or the agent id is gone, spawn a fresh swe at the task's effort. code-reviewer is always spawned fresh.

Escalate to the Human only spec ambiguity, architecture or scope questions, and Human-owned decisions such as merging, unless the project's merge policy delegates it; a failed check, a review finding or a design misfit returns to its owner without waiting on the Human.

When the hook alerts that a task has run past 60 minutes, decide whether to continue, redesign the spec or split the task, record the decision, and inform the Human once, with its attempt count and its current blocker, without waiting.

The worktree stays in place through review and rework, so rework continues where SWE left off, and is removed when `bro_atomic_close` closes the task after code-reviewer's pass.
