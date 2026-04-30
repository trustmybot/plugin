---
name: tmb_branch-id-proposal
description: Derive and propose a git-convention branch_id for a code-changing request, present it to the Human alongside the simple/difficult triage label, wait for confirmation, then open or resume the MCP issue and append the routing-note discussion entries before bro begins planning.
agent: bro
allowed-tools: Bash, AskUserQuestion, mcp__plugin_tmb_trajectory-server__issue_create, mcp__plugin_tmb_trajectory-server__issue_get, mcp__plugin_tmb_trajectory-server__issue_resume, mcp__plugin_tmb_trajectory-server__discussion_append, mcp__plugin_tmb_trajectory-server__ledger_log
---

# branch-id-proposal

## Purpose

A `branch_id` is the working git branch name for a task. It doubles as the task's identifier inside the MCP `tasks` table — so the format is enforced at runtime by `task_create_batch`. **If bro proposes an invalid branch_id, task creation will fail.** This skill produces a valid, intent-matching branch_id and gets explicit Human approval before bro begins planning.

## When invoked

Bro invokes this skill when a Human request crosses into a code or prompt change (i.e., a task will be created). It runs **after** the C.0 triage decision (`simple` or `difficult`), and **before** bro loads the planning skill (`tmb_planning-simple` or `tmb_planning-difficult` per triage).

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

### Step 0 — Base branch confirm + pull (only if git remote is configured)

Before deriving the branch name, confirm the **base** the new branch should be created from. When a remote exists, branching off whatever HEAD happens to point at silently breaks team workflows.

1. Probe for a remote:
   ```bash
   REMOTES=$(git remote -v 2>/dev/null | awk '{print $1}' | sort -u)
   ```
   If empty → skip Step 0 entirely (no remote, no concern about being behind origin).

2. Read the configured `pr_target` via `config_get(agent='bro', key='pr_target')` and the current branch via `git branch --show-current`.

3. Render this `AskUserQuestion`:

   ```
   AskUserQuestion({
     questions: [{
       question: "Which branch should I create the new feature branch from?",
       header: "Base branch",
       multiSelect: false,
       options: [
         { label: `${pr_target} (pull origin/${pr_target} first)`,
           description: `Default — matches your branching model.` },
         // If current_branch != pr_target, include this option:
         { label: `${current_branch} (stay on current branch)`,
           description: `Branch from where you are now.` },
         // Detect 1-3 other prominent local branches via:
         //   git for-each-ref --format='%(refname:short)' refs/heads --sort=-committerdate | head -5
         // Skip if the branch equals pr_target or current_branch (no duplicates).
       ]
       // Other lets the Human type any branch name (must exist locally or be fetchable).
     }]
   })
   ```

4. On the answer:
   - If the chosen base is `${pr_target}` → run `git fetch origin ${pr_target} && git checkout ${pr_target} && git pull origin ${pr_target} --ff-only` before proceeding. This guarantees the new branch is created from latest origin/pr_target, not stale local state.
   - If a non-pr_target base → switch to it but do NOT auto-pull (the Human picked it deliberately; bro asks before any pull).
   - On any git error (merge conflict, dirty tree, network) → halt, surface the error to the Human, ask how to proceed. **Do not silently proceed.**

5. Log the base-branch decision: `discussion_append(kind='note', body='Base branch: <chosen_base> (pulled: yes|no)')`.

### Step 1 — Derive + propose branch_id

1. Derive a candidate `branch_id` from the intent using the table above.
2. Present both the candidate branch_id and the triage label to the Human via `AskUserQuestion` **before bro starts planning**.

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
        description: "Open the MCP issue and begin planning with this branch_id + triage label.",
      },
      {
        // Conditional: include only if current triage is `difficult`.
        // Goal: let the Human DOWNGRADE template depth, NOT skip planning.
        label: "Downgrade triage to simple",
        description: "Bro plans with the trivial template (lighter ceremony, no ADR).",
      },
      {
        // Conditional: include only if current triage is `simple`.
        // Mirrors the Downgrade option above for the other direction.
        label: "Upgrade triage to difficult",
        description: "Bro treats this as architecture-touching: ADR + standard template.",
      },
      {
        label: "Suggest different branch_id",
        description: "Planning is paused. Type a replacement via Other (must match the regex above).",
      },
      // Do NOT add any synonym-of-Other placeholder ("Type something",
      // "I'll enter it", "Custom"). AskUserQuestion auto-renders Other
      // for free-text input.
    ]
  }]
})
```

**Hard rules for this form:**

- **No "Skip planning" option.** (Legacy name retained for lint: No "Skip architect" — same intent: planning is mandatory for every code change. The triage label adjusts template depth, NOT whether bro plans.) SWE never runs without a `task_id` written by `task_create_batch`, and `task_create_batch` only fires after planning produces a spec.
- **Never include a placeholder option that just redirects to Other.** AskUserQuestion auto-adds Other for free-text entry.
- **Conditional options:** include either Downgrade-to-simple OR Upgrade-to-difficult based on the proposed triage, never both. They're mutually exclusive depending on the starting triage.
- **Suggest different branch_id** routes the Human to the auto-Other field. The free-text reply must match the regex; reject and re-ask if it doesn't.

### Handling the answer

| Selection | Action |
|---|---|
| "Yes, proceed (Recommended)" | Persist + begin planning with proposed branch_id + original triage. |
| "Downgrade triage to simple" | Persist + begin planning with proposed branch_id + `triage: simple`. |
| "Upgrade triage to difficult" | Persist + begin planning with proposed branch_id + `triage: difficult`. |
| "Suggest different branch_id" + Other text | Validate the typed value against the regex. If valid, persist + begin planning with that branch_id + original triage. If invalid, re-render the form with a note about the mismatch. |

3. Wait for explicit confirmation via `AskUserQuestion`. Do NOT begin planning until confirmed.

4. Open or resume the MCP issue for this work and record the human's intent and the proceed-to-planning note as discussion entries:

   - If no open issue exists: call `issue_create(objective=<short summary of the request>)`.
   - In either case: call:

     ```
     discussion_append(issue_id, author='human', kind='intent',
       body=<the verbatim Human request>)
     discussion_append(issue_id, author='bro', kind='note',
       body='Beginning planning on branch_id <the branch_id>, triage: <simple|difficult>')
     ```

5. Load `tmb_planning-simple` (if triage=simple) or `tmb_planning-difficult` (if triage=difficult) and proceed with planning. The `issue_id` and confirmed `branch_id` carry forward into `task_create_batch` when the spec is ready.

## Headless fallback

When `AskUserQuestion` errors OR `TMB_HEADLESS=1` is set, accept the proposed branch_id without Human confirmation. Per CLAUDE.md doctrine, record both:

- `ledger_log(agent='bro', event_type='headless_fallback', summary='tmb_branch-id-proposal: confirm "<proposed_id>" → auto-accepted')`
- `discussion_append(agent='bro', kind='note', body='Headless fallback: branch-id-proposal asked to confirm <proposed_id>, no Human in loop, auto-accepted. Reason: bro already chose intelligently from project context.')`

Then proceed with the planning chain as if the Human had typed "Yes, proceed". Do NOT auto-pick "Upgrade to difficult" or "Suggest different branch_id" — those require Human intent.
