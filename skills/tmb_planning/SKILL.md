---
name: tmb_planning
description: Bro's code-touching flow — verify world model, triage the requirement (reuse vs build), propose branch, write spec, dispatch SWE, verify on return, atomic-close. Loaded on the first code-touching ask of a session.
allowed-tools: Bash, Read, Glob, Grep, AskUserQuestion, Task, mcp__plugin_tmb_trajectory-server
---

# Planning — bro's code-touching flow

## 1. Verify the world model

`world_model_get(depth=2)` returns the project's directory tree with README-derived summaries. The main checkout shows only merged work — when `unmerged_work` is non-empty, those branch tips are part of the codebase too: read context from and base follow-up work on the newest relevant tip (`task_provision base=<branch_id>`). If the response carries `warning: 'world-model-empty'`, run `scan_run(source='bro_auto_initial')` to build it, then re-read.

Zoom-in: `world_model_get(path='src/api', depth=1)`. "Where does X live": `world_model_search(query='X', mode='hybrid')`.

## 2. Triage the requirement

With the world model in hand, before you commit to building — two quick questions (judgment, not a research project):

1. **Is it actionable?** Well-defined, testable, in scope? If it's vague hand-waving, surface the gap via `tmb_concerns-protocol` (or an AUQ) and pin it down *before* authoring a spec.
2. **Reuse or build?** Once the requirement is real and we'd build something, prefer reuse over reinventing — check two distinct axes before committing to from-scratch code:
   - **Feature reuse** (a code dependency): does a public codebase / package / module / library already cover the work? Prefer depending on a maintained one over hand-rolling it. This is still a **build** — it flows on to step 3 — but the spec leans on the package (name it in the spec's Assumptions) instead of reimplementing it.
   - **Cheatcode reuse** (an agent capability): would a reputable published skill / MCP / plugin provide the *capability* itself? Prefer grabbing it via the cheatcode flow over building that capability — load `tmb_cheatcode`, which runs the full search→vet→recommend→Human-approve→install lifecycle (`cheatcode_search` alone skips the vet/approve/install steps).
   - **Codify** a repeatable in-house **behavior** worth keeping (a convention or checklist) → `tmb_skill-creator`, not a build spec.
   - **From scratch**: none of the above fits → genuine build, continue to step 3.

   The distinction is INSIDE vs ON the agent: a package is a dependency inside the code; a cheatcode is a capability added to an agent's toolkit.

A reported defect gets reproduced on the target branch tip before you file or dispatch it. Record what you saw (reproduced, or already fixed and at which commit) in the issue with `discussion_append`.

Record the reuse-vs-build call with `discussion_append(issue_id, author='bro', kind='decision', body='<reuse X / build because …>')`.

Cheatcode reuse and codify take their own path — the `tmb_cheatcode` lifecycle or `tmb_skill-creator` — and do **not** proceed through the branch+spec+swe steps below. Feature reuse and from-scratch are both builds: they flow on to steps 3–6.

## 3. Propose a branch

When a remote is configured, ask the Human which branch to base the new feature branch on — offer the configured `pr_target`, the current branch, and 1–3 prominent local branches. Choosing `pr_target` means check it out and bring it up to date with the remote; any other choice means switch and leave it as-is.

Get a name from `branch_id_propose` (pass the Human's verbatim intent and a short objective), confirm it with the Human ("Proceed with branch_id X?"), then let the `intent_start` composite create the issue, log the intent, and record the planning note in one transaction. `task_provision` (§5) creates the git branch — don't create it here.

## 4. Author the spec

When the work comes from an existing issue, read it with `issue_get_with_discussions`: its newest `kind='decision'` supersedes the issue description, and the spec follows that decision.

Pick conservative defaults; name them in `## Description` Assumptions bullets. The repo wins: match what the project already uses before reaching for anything new.

| Dimension | Principle |
|---|---|
| Dependencies | Prefer the project's existing conventions and the language's standard library over adding a new dependency |
| Test runner | Match the repo's existing test runner and layout; don't introduce a second one |
| Storage / IO | Match the project's established pattern (location, format, lifecycle); pick the smallest thing that fits |
| File layout | Single file until it grows enough to warrant splitting; follow the repo's module structure |
| Scope of execution | Assume the simplest runtime that satisfies the requirement (e.g. single-user, single-process) unless the spec says otherwise |

Pass the typed machine contract on each swe-executed task:

- `files: string[]` — the surfaces the task is expected to touch, at directory granularity and in the project's own layout: its source tree, its hooks or scripts, its tests, its docs, its changelog fragments where it keeps them. The swe may edit other paths inside its worktree and reports each one with a reason; you judge them at close.
- `verification: string[]` — the gate's list: runnable bash commands, one per entry, commands only. Each entry holds a command and nothing else — reasoning about what the command proves lives in `## Description`. Dry-run each command before `task_provision` and prefer the repo's own test scripts or runner. Keep commands portable across BSD and GNU tools: `grep -c` on one file prints a bare count and exits 1 on zero matches, and BSD `wc -l` pads its count with spaces, so compare counts numerically with `test`.
- `effort` — the swe's effort level, by this rule:

| Effort | When |
|---|---|
| `medium` | Default |
| `high` | The task changes enforcement logic (a hook, guard or permission gate that can deny), a schema or migration, or is prompt-bearing (`prompt_bearing: 1`) |
| `high` | Any rework spawn after a reviewer FAIL: raise it first with `task_reopen(task_id, reason, effort='high')` or `task_retry(..., effort='high')`, then spawn with the same value |
| `low` | Consultants and lookups |

Editing a DB-layer, write-handler or hook file without changing what it admits or denies stays `medium`.

swe executes a spec bro already pinned, so medium is the executor default; high is for surfaces where a miss fails open.

The `spec_body` markdown carries the prose bro and swe reason from. Its sections are `## Description, ## Success Criteria, ## Out of Scope, ## Commit` — split into multiple tasks linked by `parent_branch_id` when it passes any of: 8 `files[]` entries, 8 `verification[]` commands, 5 `SC` ids or about 5000 characters, so each task fits one swe run:

- `## Description` — ≤3 sentences, file paths with line refs, Assumptions bullets
- `## Success Criteria` — 2–5 testable assertions, each a top-level bullet opening with a unique id (`- SC1: …`, `- SC2: …`); nested `Writer:` / `Populated:` lines carry none. The swe reports against these ids, and code-reviewer findings cite them.
- `## Out of Scope`
- `## Commit` — `<emoji> <type>(<scope>): <msg>`

When the task adds a column, field, enum value, tool-result key or file output, `## Success Criteria` names each one with its own `Writer: <tool, hook or function that sets it>` line and a `Populated: <verification[] command proving a non-null sample or a count above zero>` line, or a `Nullable: <reason>` line when empty is correct. The spawn gate checks schema-touching specs for these lines.

A spec for a guard or gate (a hook, permission check or validator) states in `## Description` whether it is allowlist-based: it admits what it can prove safe and denies the rest. A denylist design, which blocks known-bad input and admits everything else, fails open on whatever it did not foresee, so it needs a recorded decision (in `decision_body`) naming why an allowlist does not fit.

A dry run or smoke test is a `verification[]` command that exits non-zero when its expectation fails, run against a `cp` of reference data so the live DB stays untouched. The one-line form is `bash "${CLAUDE_PLUGIN_ROOT}/skills/tmb_planning/scripts/assert-sql.sh" <db-copy> "<sql>" <expected>`. The swe report then cites that command's pass/fail rather than the numbers it saw.

The chosen approach rides into `task_provision` as `decision_body` (§5) — it writes the `kind='decision'` discussion atomically with the task, so there's no separate `discussion_append` here.

### Architectural changes

When the change does any of the following, capture the decision + rationale in the `task_provision` `decision_body` (§5) and apply the blast-radius check. The trajectory IS the record; there's no separate document to author:

- Introduces a new service boundary or top-level module
- Modifies a public API surface
- Commits to a strategic stack choice (auth provider, production DB, retention policy)
- Names multiple unrelated surfaces in one task
- Has external side effects (network, billing, message-sending, writes outside the worktree)

Blast-radius (external side effects only): default config is the safe state (opt-in); the task's own `verification[]` must prove zero external mutations before the change can merge.

## 5. Spawn SWE

Call `task_provision(issue_id, branch_id, decision_body, task, base?)` — it atomically writes the `kind='decision'` discussion, creates the task (with the typed `files[]` + `verification[]` and the planning-complete event), creates the git branch, and creates the worktree. It returns the spawn-ready shape `{task_id, branch_id, worktree_path, ...}` — branch and worktree already exist.

Then spawn SWE with the `task_id` it returned. The swe runs the tests for what it touched while it works; the gate runs `verification[]` once, when the swe closes, and records the run for that commit. Independent tasks run concurrently: provision every one of them, then spawn one swe per task in the same turn — one Agent call each, all in one message. A task waits only when it needs another task's merged output, and its `decision_body` names that dependency. Each spec names the sibling tasks running alongside it and their `files[]`. You prepare everything: `task_provision` gives swe a ready-to-work branch and worktree cut from the up-to-date base, and a rework spawn gets the same.

### Spawning SWE

The Agent PreToolUse gates enforce a spawn contract:

- The spawn prompt MUST contain the literal `task_id=<N>` from the `task_provision` response — a bare `task_id 5` without `=` fails the gate.
- The Agent call carries `effort` equal to the task's effort; the spawn gate denies a mismatch.
- The task must be `pending` (or `running` with no live SWE run) with a non-empty `spec_body` — `task_provision` guarantees this.
- The branch and worktree are created by `task_provision` — don't pre-create the branch or `EnterWorktree` manually.

## 6. Verify on SWE return + atomic close

Verify, close and review each task as it returns; a task's close waits on nothing but its own review.

After SWE returns `status=completed`, pull the work (`task_brief` plus a `git -C <repo path> diff` of the commit, the repo path from `repos_list`) and judge it against the spec on four counts:

1. Every changed path outside `files[]` is one the swe reported with a reason you accept. `bro_atomic_close` refuses the close and lists the extras grouped by surface; it closes on a retry with `waive_scope_gate: true` and a `scope_waiver_reason` of at least 10 characters, and afterwards `task_brief.scope` carries `extras_accepted` and `base_moved`.
2. `task_brief.verification_run` holds the gate's recorded run for this `commit_sha` with `exit_code` 0 and `timed_out` false. The gate reuses a passing run for the same task and commit, so a reused run is normal.
3. `task_brief.completion_report` covers every `SC<n>` id, and the diff bears out each claim: a `met` shows in the diff, a `not_applicable` carries a reason you accept, and a `not_met` fails this check. The changelog entry lands the way the repo records changes (its fragment directory or CHANGELOG section), where it keeps one.
4. `world_model_get` on the changed directory confirms the change landed where expected.

All four pass → close with the `bro_atomic_close` composite (`close_issue_if_last_task=true` when it's the last task); the post-close hook re-scans so the world model refreshes. When the closed task was an architectural change (the cases listed under "Architectural changes" above — a new top-level module, dir, or service boundary), also call `scan_run` yourself right after `bro_atomic_close` so the world model reflects the new structure within this session; the background post-close rescan stays the safety net for ordinary changes. Then spawn code-reviewer for the push gate with the anchors only — the spawn-shape hook enforces them. Context the reviewer cannot read from `task_brief` goes in `bro_atomic_close`'s `spawn_note` (300 characters max). On a reviewer FAIL: surface it, hold the push, and rework the task (below).

If any of the four checks fails, record it with `bro_verification_fail_record` (name which check and why), leave the task open, and either retry via `task_retry` or escalate.

### Integrate after the review pass

When code-reviewer passes the task and the base has not moved, push the reviewed commit as is. When the base has moved, run `bash "${CLAUDE_PLUGIN_ROOT}/skills/tmb_planning/scripts/integrate.sh" <task_id> <base>`:

- **Exit 0** — rebased and re-verified; push the SHA it prints.
- **Exit 1** — `verification[]` failed on the rebased commit; surface the failure and rework the task (below).
- **Exit 2** — conflict or patch drift; `task_retry` on a fresh branch from the current base, with a spec that points at the reviewed commit. The retry goes through verify and review again.
- **Exit 3** — the task has no passing review; spawn code-reviewer first.

### Rework and spec changes

- **Branch already exists.** `task_provision` reuses a `branch_id` only when it sits at or behind the base; a diverged one comes back as `branch_exists_diverged` with its distance and any open PR. Pick a fresh name with `branch_id_propose`, or pass `reuse_existing: true` when that branch holds the work you mean to continue.
- **Same task, more work** (a review FAIL, a failed or escalated run): `task_reopen(task_id, reason, files_add?, verification_add?, effort?, spawn_note?, session_id?)` moves it back to `running`, widens its fences, and recreates its worktree when missing; pass `effort='high'` to raise the task's stored effort, then spawn SWE on it again with that same `effort`. After a FAIL, the `spawn_note` names the finding ids to fix (`F<task>-<n>`); the swe reads them, with their probes, from `task_brief.open_findings`.
- **Rework limits:** the spawn gate denies a further swe spawn or resume of a task at two review FAILs on it since its last pass, at six swe runs of it (budget handbacks aside), or at four FAILs across its issue's tasks, which also stops a `task_retry` or split task. Each counts since the Human's latest waiver, and only the Human lifts one, by typing `waive task <N>`; no row you write does. When one trips, stop and report the task, its findings and your proposed redesign or split to the Human.
- **Wrong approach:** `task_retry` starts a fresh task on a new branch with a corrected spec.
- **Spec fix on a live task** (a typo, a missing path or command): `task_update_spec(task_id, reason, files?, verification?, spec_body?)`.

When the hook alerts that a task has run past 60 minutes, relay it to the Human once, with its attempt count and its current blocker, and decide together whether to continue, redesign the spec or split the task.

The worktree stays in place through `bro_atomic_close` and is removed once code-reviewer passes the task, so rework continues where SWE left off.
