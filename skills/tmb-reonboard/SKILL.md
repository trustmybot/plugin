---
name: tmb-reonboard
description: Re-run the TMB onboarding flow on demand, showing current values as the pre-selected default in a radio UI via AskUserQuestion. Handles branching model changes, PR target updates, and identity rename.
agent: bro
allowed-tools: Bash, AskUserQuestion, mcp__plugin_tmb_trajectory-server__identity_get, mcp__plugin_tmb_trajectory-server__identity_set, mcp__plugin_tmb_trajectory-server__identity_reset, mcp__plugin_tmb_trajectory-server__config_list, mcp__plugin_tmb_trajectory-server__config_set
---

# tmb-reonboard

## A. Purpose

Allow a user who has already completed first-run onboarding to update branching model, PR target, protected branches, or their name, without typing MCP calls. Uses `AskUserQuestion` so the current value can be the first (pre-selected) option.

This skill does NOT touch issues, tasks, or validation_attempts. It only reads/writes `plugin_config` keys and `identity`.

## B. When Invoked

Bro invokes this skill directly (no other agent spawn needed) when the Human says any of the following — or close paraphrases:

- "re-onboard"
- "change branching model" / "switch to gitflow" / "switch to github-flow"
- "update my name" / "change my name"
- "reset onboarding"

## C. Execution Steps

### Step 1 — Read current state

```
config_list(agent='bro')
identity_get(agent='bro')
```

Extract (use `null` if absent):

- `current_branching_model`
- `current_pr_target`
- `current_protected_branches`
- `current_human_name`

### Step 2 — Collect new values via AskUserQuestion

One batched call. For each question, make the **current value the first option** (pre-selected default):

```
AskUserQuestion({
  questions: [
    {
      question: "What should I call you?",
      header: "Your name",
      multiSelect: false,
      options: [
        { label: `Keep "${current_human_name}"`, description: "No change." },  // hide if null
        { label: "Anonymous", description: "Remove name from file." }
      ]
      // 'Other' lets the Human type a new name.
    },
    {
      question: "How does your team branch?",
      header: "Branching",
      multiSelect: false,
      options: [
        // Current value goes first, labeled "Keep …"
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
      // 'Other' for any alternative.
    }
  ]
})
```

Dedupe logic: if `current_pr_target` is already one of the static options (e.g. "main"), collapse the `Keep "main"` entry with the second option to avoid a duplicate.

### Step 3 — Persist via MCP

Parse each answer. If it starts with "Keep ", no write for that field. Otherwise:

```
if name_answer == "Anonymous":
    identity_reset(agent='bro')
elif name_answer != Keep:
    identity_set(agent='bro', human_name=<name>)

if branching_answer != Keep:
    config_set(agent='bro', key='branching_model', value=<canonical>)

if pr_target_answer != Keep:
    config_set(agent='bro', key='pr_target', value=<value>)
    # Update protected_branches when PR target changes:
    if final_branching == 'github-flow':
        protected = [final_pr_target]
    elif final_branching == 'gitflow':
        protected = dedup(['main', final_pr_target])
    else:
        protected = [final_pr_target]
    config_set(agent='bro', key='protected_branches', value=protected)
```

**Reset path:** If the Human types "reset everything" via Other on the name question, call `identity_reset(agent='bro')` and re-ask via a second `AskUserQuestion` round with no "Keep" default.

### Step 4 — Confirm and close

After writes:

> "Done. Settings updated:
> - Branching model: `<final_branching_model>`
> - PR target: `<final_pr_target>`
> - Protected branches: `<final_protected_branches>`
> - Your name: `<final_human_name>`
>
> Tell me what you want to work on."

## D. Scope Constraint

This skill ONLY calls:

- `AskUserQuestion` (read Human input)
- `config_list`, `config_set` (write — `branching_model`, `pr_target`, `protected_branches` keys only)
- `identity_get`, `identity_set`, `identity_reset`

It MUST NOT call `issue_create`, `task_create_batch`, `task_update_status`, `validation_record`, or anything outside the list above.

## E. Error Handling

| Trigger | Response |
|---|---|
| `config_list()` or `identity_get()` fails | Report the error, offer to proceed with blank defaults or abort. Never proceed silently. |
| `config_set` or `identity_set` fails | Report immediately. Do NOT continue to the next step. Ask whether to retry. |
| Human picks Custom + invalid branching value via Other | Re-ask via a second `AskUserQuestion` round. Don't accept free-text model strings other than via valid canonical mapping. |
