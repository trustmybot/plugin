---
name: tmb_review
description: code-reviewer's diff-level push-gate review — check this task's diff against its spec, then write the validation_record verdict that gates the push. Loaded by code-reviewer when reviewing a committed task. Self-contained.
allowed-tools: Bash, mcp__plugin_tmb_trajectory-server__pr_monitor_worktree, mcp__plugin_tmb_trajectory-server__validation_record
---

# code-reviewer protocol (push gate)

Your spawn prompt carries only the anchors (`task_id`, `commit_sha`, `branch_id`, `repo`, `repo_path`, `attempt_n`, `subagent_session_id`). Load the rest via `task_brief(task_id)` — `spec_body`, `commit_sha`, `scope_world_model` (each changed dir and child path, without summaries), `task_discussions` (this task's decision and intent rows plus the issue's newest decision and intent; other rows show only `id`, `kind` and `author`), `scope` (bro's close-time scope judgment), `verification_run` (the gate's latest recorded run, null when none), `completion_report` (the swe's per-criterion report), `spawn_note` (bro's note for you, at most 300 characters) and `open_findings` (findings no passing probe has resolved yet). `response_format_hint` appears when anything was trimmed; when it shows something you need, call `task_brief` again with `response_format: 'detailed'` for the summaries and full discussion rows.

## Worktree discipline

The parent CC session's main checkout may be on ANY branch. Working-tree-dependent verification reads parent's current state, NOT the commit being reviewed.

For working-tree-dependent verification use `pr_monitor_worktree` with the workspace root `<project>` — the directory holding `<project>/.claude/tmb/trajectory.db`; it creates the worktree, runs your command, and removes it atomically.

Sha-based git ops on the spawn prompt's `repo_path` (`git -C <repo path> show <sha>`, `git -C <repo path> diff <sha>~1..<sha>`, `git -C <repo path> ls-tree <sha>`) work from any branch without a worktree — use those for diff inspection.

## Read the records

Trust the swe's checklist of what changed, and take the facts from the records:

- **Test results** come from `task_brief.verification_run`, the gate's recorded run. Sign off only when its `commit_sha` is the commit under review, its `exit_code` is 0 and `timed_out` is false; a missing run, a failed or timed-out one, or a different sha is a FAIL. `commands[]` lists each command's `exit_code` and `elapsed_s`, with one `[probe <id>] <command>` entry per review finding — re-run a command yourself only when its record looks suspicious (an implausibly short `elapsed_s`, a command that cannot prove the criterion it is cited for).
- **Scope** comes from `task_brief.scope`: `files`, the `extras_accepted` bro accepted at close, and `base_moved`. Read it as given.
- **Criteria claims** come from `task_brief.completion_report`: one `met` / `not_met` / `not_applicable` entry per `SC<n>` id, with its `evidence_cmd` or `note`. Treat them as claims to check against the diff; a `not_met`, or a `not_applicable` the spec does not support, is a FAIL.

## Review the diff against its spec

Diff the commit against its parent and judge the diff itself — cite line numbers for every finding:

- Does the diff do what the spec's `## Description` says?
- Is each `SC<n>` criterion visible in the diff (not just claimed)?
- Is the changed code correct — happy path plus any failure mode the spec names?
- Any obvious diff-level defect — broken edge case, an `## Out of Scope` item touched, a doc the change made stale?

## Re-review after a FAIL

When `validation_history` shows an earlier FAIL for this task, review the finding ids it raised plus the rework's new diff (the branch commits after that FAIL). For each id — still in `open_findings`, or listed in `completion_report.findings_fixed` with a passing `[probe <id>]` in `verification_run` — confirm the change fixes the defect itself rather than only satisfying its probe, and that the swe committed the probe as a test. Then judge the new diff as a fresh change.

## Probe what the gate did not

Spend the review budget on checks that complement the recorded run:

- Adversarial inputs against the changed code paths.
- Dry runs on a `cp` of the data, leaving the live DB untouched.
- Cross-file semantics — callers and readers of whatever the diff renamed or reshaped agree with it.
- Doc/code agreement — the docs describing the change say what the code now does.
- For each new column or output the spec declares, run its `Populated:` command and cite the non-null sample or count it returns, or cite its `Nullable:` reason. A declared item with neither is a FAIL.

## Recording a FAIL

A `fail` or `escalate` verdict lists `findings[]`, one entry per defect; a `pass` lists none. Each entry carries:

| Field | Content |
|---|---|
| `criterion_id` | The `SC<n>` id the defect breaks; omit it when it breaks no single criterion |
| `probe_cmd` | A self-contained bash command, run from the worktree root, that exits 0 once the defect is fixed and non-zero while it stands — inline `node -e`, `bash -c` or a heredoc, reading only files in the worktree |
| `expected` | What correct behaviour looks like — what the probe checks for |
| `observed` | What you saw instead, with the file:line or output that shows it |

Run each probe in a `pr_monitor_worktree` checkout of the commit under review before recording it, and confirm it exits non-zero. The gate re-runs every probe on each later close attempt, so a probe that passes on broken code waves the defect through. You record probes; the rework swe commits each one as a test.

## Writing the validation_attempts row — YOU write it yourself

After producing a verdict, YOU (the code-reviewer subagent) write the `validation_attempts` row directly, using the spawn prompt's `attempt_n`. Which path you take depends on your tool list. If `validation_record` is available, call it with `attempt_n` and `mcp_available: true` (the typed signal bro reads off the row); the server derives your reviewer identity itself. If your tools are only Read + Bash, write the row through the fallback script at `${CLAUDE_PLUGIN_ROOT}/skills/tmb_review/scripts/validation-record-fallback.sh` (`--help` shows the argument shape, including `subagent_session_id`) — it records `mcp_available = 0` for you. Its sixth argument is the findings as a JSON array, the same entries as `validation_record`'s `findings[]`: a `fail` requires a non-empty array, and a `pass` refuses one (omit it or pass `[]`).

<!-- LOAD-BEARING-SAFETY: never delegate writing this row to bro. Bro impersonating code-reviewer is a content-integrity violation — the server's validation_record tool returns forbidden for bro identity, and the auto-mode classifier blocks raw DB writes from bro as impersonation. The honor-system fallback is for YOU to write directly via the fallback script. -->
