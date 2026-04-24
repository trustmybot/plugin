---
name: branch-id-proposal
description: Derive and propose a git-convention branch_id for a code-changing request, present it to the Human alongside the simple/difficult triage label, wait for confirmation, then open or resume the MCP issue and append the routing-note discussion entries before architect spawn.
agent: bro
allowed-tools: Bash
---

# branch-id-proposal

## Purpose

A `branch_id` is the working git branch name for a task. It doubles as the task's identifier inside the MCP `tasks` table — so the format is enforced at runtime by `task_create_batch`. **If bro proposes an invalid branch_id, task creation will fail.** This skill produces a valid, intent-matching branch_id and gets explicit Human approval before any architect spawn.

## When invoked

Bro invokes this skill when a Human request crosses into a code or prompt change (i.e., a task will be created). It runs **after** the C.0 triage decision (`simple` or `difficult`), and **before** any architect spawn.

Direct read-only ops do NOT require a branch_id. Skip this skill in that case.

## Validation regex (verbatim from MCP enforcement)

```
^(feat|fix|refactor|chore|docs|test|perf|build|ci|style|revert)\/[a-z0-9][a-z0-9-]{0,62}$
```

Format: `<type>/<slug>` where `<slug>` is lowercase alphanumeric + hyphens, max 63 chars total for the slug portion.

## Intent → type prefix mapping

| Signal words in the Human's request | Use prefix |
|---|---|
| add / implement / new feature | `feat/` |
| fix / bug / broken / crash | `fix/` |
| rename / extract / restructure / clean up | `refactor/` |
| update docs / readme / comments | `docs/` |
| add tests / coverage | `test/` |
| speed up / optimize | `perf/` |
| build script / dependency | `build/` |
| CI pipeline | `ci/` |
| housekeeping (no user-facing change) | `chore/` |
| when uncertain | ask Human to disambiguate |

## Protocol

1. Derive a candidate `branch_id` from the intent using the table above.
2. Present both the candidate branch_id and the triage label to the Human **before routing to architect**:

   > `Proposed branch_id: feat/foo-bar, triage: simple — proceed? (y / suggest different)`

3. Wait for explicit confirmation. Do NOT route to architect until confirmed.

4. Pass the confirmed `branch_id` and triage classification in the Task tool prompt:

   > `architect, plan and execute on branch_id "feat/foo-bar" for issue <id>, triage: simple`

5. Open or resume the MCP issue for this work and record the human's intent and routing note as discussion entries:

   - If no open issue exists: call `issue_create(objective=<short summary of the request>)`.
   - In either case: call:

     ```
     discussion_append(issue_id, author='human', kind='intent',
       body=<the verbatim Human request>)
     discussion_append(issue_id, author='bro', kind='note',
       body='Routed to architect on branch_id <the branch_id>, triage: <simple|difficult>')
     ```

   Pass the `issue_id` in the architect spawn prompt as shown in step 4. This guarantees architect can append further discussion entries and create tasks under a real issue row.
