---
name: tmb_planning-difficult
description: Bro's planning protocol when the request touches docs/trustmybot/architecture/, introduces a new service boundary, modifies a public API, or commits to a strategic technology choice. Loaded when triage = difficult; the simple-path defaults table cannot pick for these. Use this whenever bro's triage flags difficult, or when an architecture-level decision is implicit in the ask.
allowed-tools: Read, Glob, Grep, Bash, Task, AskUserQuestion, mcp__plugin_tmb_trajectory-server
---

# Planning — Difficult Triage

## When this loads

After `tmb_swe-spawn-workflow` triages a request as **difficult** (architecture-touching, cross-cutting, or strategic). Bro lands here with: the user's request in conversation context; a pre-scan run (see `tmb_project-prescan`) — project stack available via `project_metadata_get(agent='bro')`; a branch_id proposed (see `tmb_branch-id-proposal`).

Sibling: `tmb_planning-simple` handles the no-architecture path; downgrade whenever triage was wrong.

L5 smoke tests: `tests/dogfood/flows/03-difficult-task/` (this skill's happy path), `02-simple-task/` (sibling).

## Glossary

- **Q+A pair**: a `kind='question'` row + `kind='answer'` row in the `discussions` table (one per scope choice). Persisted via `discussion_append`.
- **Decision row**: a `kind='decision'` row in `discussions` capturing the architectural plan. The MCP scope-ambiguity gate refuses `task_create_batch` if no preceding `kind='question'` exists.
- **AskUserQuestion modes**: `radio` / `radio + preview` / `checkbox` / `tabbed` — see `docs/architecture/UI.md`. This skill uses **radio** for single picks, **tabbed** when 2-4 related decisions stack.
- **`spec_body`**: markdown spec passed to `task_create_batch`. Hard cap 8000 chars.
- **`parent_branch_id`**: links sibling tasks within an issue. Used when a difficult-path issue splits into multiple tasks.

Architecture-touching, cross-cutting, or strategic. Every material choice needs a Q+A pair and a `kind='decision'` row before any task is created. `task_create_batch` rejects `spec_body` >8000 chars — cite existing code, don't restate; split into multiple tasks linked by `parent_branch_id` if needed.

## 1. Confirm + probe

Confirm: does the request touch `docs/trustmybot/architecture/`, introduce a new boundary, change a public API, or commit to a strategic stack choice? If none → downgrade and load `tmb_planning-simple`.

Read the project stack via `project_metadata_get(agent='bro')`. If it returns null, the prescan didn't run — load `tmb_project-prescan` first.

```
discussion_append(kind='note', body='Triage: difficult (confirmed). Stack: <findings>.')
```

## 2. Q+A loop until aligned

Use `AskUserQuestion`. Ground every option in what you probed — never list a tool as `(Recommended)` unless installed AND fits. Max 3-4 questions per round. Persist verbatim:

```
AskUserQuestion({ ... })
discussion_append(kind='question', body=<verbatim>)
discussion_append(kind='answer', author='human', body=<verbatim>)
```

Topics that ALWAYS need Q+A here: storage backend, library choice, command surface, feature scope, persistence location, runtime target, file layout.

## 3. Scope-ambiguity gate

`task_create_batch` returns `forbidden` if the issue has zero `kind='question'` rows. Auto-mode does not waive this. If reasoning includes "defaulting to X since you didn't specify" — halt and ask. Healthy trajectory: `note(triage) → note(probe) → question → answer → ... → decision`. A `decision` with no preceding `question` means revert: don't create tasks, ask the missing question, persist Q+A, re-decide.

## 4. Capture the decision

```
discussion_append(kind='decision', body='<plan: changes, why, trade-offs, risks>')
```

Co-author an ADR at `docs/trustmybot/architecture/manual/decisions/N-*.md` when the change warrants a durable record.

## 5. Author the spec body

Use the template at `templates/spec.md`. Stay under 8000 chars; cite existing code paths.

**Blast-radius check** — if the feature has external side effects (network, real API mutations, billing, message-sending, writes outside the worktree): default config MUST be the safe state (opt-in); tests MUST NOT hit live services on the default `:memory:` DB; spec MUST require a pre-merge `bash tests/run-all.sh` yielding zero external mutations. Any miss → spec back for revision.

## 6. Atomic handoff (server-side closing event)

The closing `planning_complete` audit event is now emitted server-side as part of `task_create_batch`'s transaction. Pass `emit_planning_complete=true`; the audit row lands atomically with the task INSERT. There's nothing for the LLM to remember to call afterward.

```
task_create_batch(
  agent='bro',
  spec_body=...,
  emit_planning_complete=true,
  planning_complete_summary='<one-line summary>',
)
```

Then spawn SWE in the next response (or same, if branch_id flow allows):

```
Task(subagent_type='swe', prompt='task_id=<N>', isolation='worktree')
```

For multiple parallel tasks in one issue, fan out `Task(swe)` spawns where `parent_branch_id` permits.

## 7. Verify before close — Pull / Check / Close

After SWE returns `completed`:

**Pull**: `task_get(N)` + `git diff <commit_sha>~1..<commit_sha>`.

**Check** all three:

- Files changed match the spec's `## Files`.
- Spec's `## Verification` commands pass inside the SWE worktree (run BEFORE close — cleanup hook removes the worktree on close).
- Every `## Success Criteria` bullet visible in the diff.

**Close** — all three pass, batch in ONE response:

```
audit_log(kind='event', event_type='bro_verification_pass', ...)
file_registry_update_summaries(updates=[<one per touched path>], advance_verified_sha=<sha>)
task_update_status(closed, commit_sha=<sha>)
issue_close(issue_id) IF all tasks on the issue are closed
```

A PreToolUse hook denies `task_update_status(closed)` without fresh `file_registry` summaries. Bro never calls `validation_record` — pr-reviewer only; server returns `forbidden`.

Any check fails → `audit_log(event_type='bro_verification_fail')` + `discussion_append(kind='note', body='Verification fail: <details>')`. Re-spawn SWE with feedback (≤3 retries) or escalate.

If any close-related MCP call returns `is_error: true`, halt and surface verbatim — usually means the call signature is wrong.

## Headless fallback

When `AskUserQuestion` errors OR `TMB_HEADLESS=1`, treat unanswered scope questions as "proceed as proposed":

```
audit_log(kind='event', event_type='headless_fallback', summary='tmb_planning-difficult: scope confirmation auto-accepted')
discussion_append(kind='note', body='Headless fallback: planning-difficult, no Human in loop.')
```

Run the rest of the chain. Still author the ADR — it is the difficult-triage's primary deliverable.
