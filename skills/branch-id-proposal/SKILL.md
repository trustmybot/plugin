---
name: branch-id-proposal
description: Derive and propose a git-convention branch_id for a code-changing request, present it to the Human alongside the simple/difficult triage label, wait for confirmation, then open or resume the MCP issue and append the routing-note discussion entries before architect spawn.
agent: bro
allowed-tools: Bash, AskUserQuestion, mcp__plugin_tmb_trajectory-server__issue_create, mcp__plugin_tmb_trajectory-server__issue_get, mcp__plugin_tmb_trajectory-server__issue_resume, mcp__plugin_tmb_trajectory-server__discussion_append, mcp__plugin_tmb_trajectory-server__ledger_log
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
2. Present both the candidate branch_id and the triage label to the Human via `AskUserQuestion` **before routing to architect**.

### AskUserQuestion specification

Render exactly this form. Do NOT add improvised options — the skill's option set is fixed.

```
AskUserQuestion({
  questions: [{
    question: `Proceed with branch_id "${candidate}", triage: ${triageLabel}?`,
    header: "Routing",
    multiSelect: false,
    options: [
      {
        label: "Yes, proceed (Recommended)",
        description: "Open the MCP issue and route to architect with this branch_id + triage label.",
      },
      {
        // Conditional: include only if current triage is `difficult`.
        // Goal: let the Human DOWNGRADE template depth, NOT skip architect.
        label: "Downgrade triage to simple",
        description: "Still routes through architect, but architect uses the trivial template (lighter ceremony, no ADR).",
      },
      {
        // Conditional: include only if current triage is `simple`.
        // Mirrors the Downgrade option above for the other direction.
        label: "Upgrade triage to difficult",
        description: "Architect treats this as architecture-touching: adds an ADR + uses the standard template.",
      },
      {
        label: "Suggest different branch_id",
        description: "Architect spawn is paused. Type a replacement via Other (must match the regex above).",
      },
      // Do NOT add any synonym-of-Other placeholder ("Type something",
      // "I'll enter it", "Custom"). AskUserQuestion auto-renders Other
      // for free-text input.
    ]
  }]
})
```

**Hard rules for this form:**

- **No "Skip architect" option.** Architect is mandatory for every code change per bro's routing contract. The triage label adjusts template depth, NOT whether architect runs.
- **Never include a placeholder option that just redirects to Other.** AskUserQuestion auto-adds Other for free-text entry.
- **Conditional options:** include either Downgrade-to-simple OR Upgrade-to-difficult based on the proposed triage, never both. They're mutually exclusive depending on the starting triage.
- **Suggest different branch_id** routes the Human to the auto-Other field. The free-text reply must match the regex; reject and re-ask if it doesn't.

### Handling the answer

| Selection | Action |
|---|---|
| "Yes, proceed (Recommended)" | Persist + spawn architect with proposed branch_id + original triage. |
| "Downgrade triage to simple" | Persist + spawn architect with proposed branch_id + `triage: simple`. |
| "Upgrade triage to difficult" | Persist + spawn architect with proposed branch_id + `triage: difficult`. |
| "Suggest different branch_id" + Other text | Validate the typed value against the regex. If valid, persist + spawn with that branch_id + original triage. If invalid, re-render the form with a note about the mismatch. |

3. Wait for explicit confirmation via `AskUserQuestion`. Do NOT route to architect until confirmed.

4. Pass the confirmed `branch_id` and (possibly adjusted) triage classification in the Task tool prompt:

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
