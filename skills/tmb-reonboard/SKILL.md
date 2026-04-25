---
name: tmb-reonboard
description: Re-run the TMB onboarding flow on demand. Shows current values as the pre-selected default in an AskUserQuestion radio UI. Handles branching model changes, PR target updates, and identity rename.
agent: bro
allowed-tools: Bash, AskUserQuestion, mcp__plugin_tmb_trajectory-server__identity_get, mcp__plugin_tmb_trajectory-server__identity_set, mcp__plugin_tmb_trajectory-server__identity_reset, mcp__plugin_tmb_trajectory-server__config_list, mcp__plugin_tmb_trajectory-server__config_set
---

# tmb-reonboard

## Purpose

Let a user update branching model, PR target, protected branches, or their name after first-run onboarding completed. Reads current state, shows it as the `Keep "<current>"` first option in a radio form, writes changes via MCP.

## When Invoked

Bro invokes this skill directly (no subagent spawn) on these trigger phrases or close paraphrases:

- "re-onboard", "reset onboarding"
- "change branching model" / "switch to gitflow" / "switch to github-flow"
- "update my name" / "change my name"

## Scope

ONLY:
- `AskUserQuestion` (collect answers)
- `config_list`, `config_set` (keys `branching_model`, `pr_target`, `protected_branches` only)
- `identity_get`, `identity_set`, `identity_reset`

NEVER: `issue_create`, `task_create_batch`, `task_update_status`, `validation_record`, or anything outside the list above.

## Step 1 — Read current state

Call with `agent='bro'`:

```
config_list(agent='bro')
identity_get(agent='bro')
```

Extract (use "(unset)" display for `null`):

- `current_human_name` — from `identity_get().human_name`
- `current_branching_model`, `current_pr_target`, `current_protected_branches` — from `config_list()`.

## Step 2 — Collect new values via AskUserQuestion

One batched call. First option on each question is `Keep "<current>"` (pre-selected default):

```
AskUserQuestion({
  questions: [
    {
      question: "What should I call you?",
      header: "Your name",
      multiSelect: false,
      options: [
        { label: `Keep "${current_human_name}"`, description: "No change." },  // drop this option if current_human_name is null
        { label: "Anonymous", description: "Remove name from file." }
        // Other — free text new name.
      ]
    },
    {
      question: "How does your team branch?",
      header: "Branching",
      multiSelect: false,
      options: [
        { label: `Keep "${current_branching_model}"`, description: "No change." },
        { label: "Switch to Trunk + feature branches (GitHub Flow)", description: "Single main, feature branches, PRs back." },
        { label: "Switch to Trunk + develop + releases (Git Flow)", description: "Long-lived develop + releases to main." },
        { label: "Custom workflow", description: "Describe via Other." }
      ]
    },
    {
      question: "What's your PR target branch?",
      header: "PR target",
      multiSelect: false,
      options: [
        { label: `Keep "${current_pr_target}"`, description: "No change." },
        { label: "main", description: "Most common default." },
        { label: "develop", description: "Common for Git Flow." },
        { label: "master", description: "Older repos." }
      ]
      // Other for any alternative.
    }
  ]
})
```

Dedupe: if `current_<field>` already matches a static option (e.g. `current_pr_target == "main"`), collapse the `Keep "main"` entry with the "main" option to avoid a duplicate.

## Step 3 — Persist via MCP

For each answer:

- Starts with `Keep "`: no write for that field.
- Name = "Anonymous": `identity_reset(agent='bro')`.
- Name = other: `identity_set(agent='bro', human_name=<name>)`.
- Branching changed: `config_set(agent='bro', key='branching_model', value=<canonical>)`.
- PR target changed: `config_set(agent='bro', key='pr_target', value=<value>)` AND recompute `protected_branches`:

  | branching | protected_branches |
  |---|---|
  | `github-flow` | `[<pr_target>]` |
  | `gitflow` | `["main", <pr_target>]` deduped |
  | `custom` | ask separately (second AskUserQuestion round, multiSelect=true like first-run-onboarding Step 3a) |

  Then `config_set(agent='bro', key='protected_branches', value=<new list>)`.

## Step 4 — Verify and close

After writes, `config_list(agent='bro')` + `identity_get(agent='bro')` to confirm. Emit:

> Done. Settings updated:
> - Your name: `<final_human_name>`
> - Branching model: `<final_branching_model>`
> - PR target: `<final_pr_target>`
> - Protected branches: `<final_protected_branches>`
>
> Tell me what you want to work on.

## Error Handling

| Trigger | Response |
|---|---|
| `config_list()` or `identity_get()` fails | Report the exact error, offer to retry or abort. Do NOT proceed with stale state. |
| `config_set` or `identity_set` fails | Report the exact error, retry the same call. Do NOT skip and continue. |
| Invalid answer (e.g. unparseable Other for branching) | Re-ask via a second `AskUserQuestion` round, omit the invalid answer. |
