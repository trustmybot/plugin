---
name: tmb-reonboard
description: Re-run the TMB onboarding flow on demand, showing current values as defaults. Handles branching model changes, PR target updates, and optional identity rename.
agent: gatekeeper
allowed-tools: Bash
---

# tmb-reonboard

## A. Purpose

Allow a user who has already completed first-run onboarding to update their
branching model, PR target, protected branches, or gatekeeper/human identity
without needing to know the underlying MCP calls. This skill re-runs the same
3-step sequence as first-run onboarding, but reads current values first and
uses them as press-enter defaults.

This skill does NOT touch issues, tasks, or validation_attempts. It only
reads and writes `plugin_config` keys and `identity`.

## B. When Invoked

Gatekeeper invokes this skill directly (no other agent spawn needed) when the
Human says any of the following — or close paraphrases:

- "re-onboard"
- "change branching model" / "switch to gitflow" / "switch to github-flow"
- "rename gatekeeper" / "rename yourself"
- "update my name" / "change my name in bro"
- "reset onboarding"

## C. Execution Steps

### Step 1 — Read current state

Call:

```
config_list()
identity_get()
```

Extract the following values (use `null` if absent):

- `current_branching_model` — from `config_list()` key `branching_model`
- `current_pr_target` — from `config_list()` key `pr_target`
- `current_protected_branches` — from `config_list()` key `protected_branches`
- `current_human_name` — from `identity_get()` field `human_name`

(bro's name is fixed plugin branding; it is not shown or changed here.)

### Step 2 — Show current values

Present a summary to the Human:

> "Here's what I have on file:
> - Branching model: `<current_branching_model>`
> - PR target: `<current_pr_target>`
> - Protected branches: `<current_protected_branches>`
> - Your name: `<current_human_name>`
>
> Let's walk through each. Press enter to keep the current value."

### Step 3 — Identity (Step 1 of onboarding)

Ask:

> "What should I call you? (Press enter to keep `<current_human_name>`)"

If blank (press-enter), skip the MCP call — nothing changed. Otherwise call:

```
identity_set(human_name=<new answer>)
```

`gatekeeper_name` is not offered as a re-onboard option — bro is the plugin's
branding. Do not prompt to rename it.

**Reset path:** If the Human says "reset everything" or "clear identity" at
any point during this step, call `identity_reset()` then re-prompt the name
question with no default.

### Step 4 — Branching model (Step 2 of onboarding)

Ask:

> "How does your team branch? (1) github-flow — single main, feature branches
> off main, PRs back to main. (2) gitflow — long-lived develop branch,
> releases promoted to main. (3) custom — you tell me.
> (Press enter to keep `<current_branching_model>`)"

If blank (press-enter), skip branching model changes — skip to Step 5.

**Choice 1 (github-flow):**

Ask PR target:

> "What's your PR target branch? (Press enter to keep `<current_pr_target>`)"

MCP calls:

```
config_set("branching_model", "github-flow")
config_set("pr_target", <new answer or current_pr_target if blank>)
config_set("protected_branches", <JSON array containing the chosen pr_target>)
```

**Choice 2 (gitflow):**

Ask PR target:

> "What's your PR target branch? (Press enter to keep `<current_pr_target>`)"

MCP calls:

```
config_set("branching_model", "gitflow")
config_set("pr_target", <new answer or current_pr_target if blank>)
config_set("protected_branches", <JSON array: ["main", <chosen pr_target>] — deduplicated if user picked main>)
```

**Choice 3 (custom):**

Ask:

> "What's your PR target branch? (e.g. main, trunk, release)"

Then:

> "And which branches should I treat as protected (no direct commits)?
> Comma-separated."

MCP calls:

```
config_set("branching_model", "custom")
config_set("pr_target", <answer to first question>)
config_set("protected_branches", <split-and-trim CSV → JSON array>)
```

### Step 5 — Confirm and close

After all MCP writes succeed, say:

> "Done. Settings updated:
> - Branching model: `<final_branching_model>`
> - PR target: `<final_pr_target>`
> - Protected branches: `<final_protected_branches>`
> - Your name: `<final_human_name>`
>
> Tell me what you want to work on."

## D. Scope Constraint

This skill ONLY calls the following MCP tools:

- `config_list` (read)
- `config_set` (write — `branching_model`, `pr_target`, `protected_branches` keys only)
- `identity_get` (read)
- `identity_set` (write)
- `identity_reset` (write — only when user explicitly requests "reset everything")

It MUST NOT call: `issue_create`, `task_create_batch`, `task_update_status`,
`validation_record`, or any other MCP tool outside the above list.

## E. Error Handling

| Trigger | Response |
|---|---|
| `config_list()` or `identity_get()` fails | Report the error to the Human, offer to proceed with blank defaults or abort. Do NOT proceed silently. |
| `config_set` or `identity_set` fails | Report the failure immediately. Do NOT continue to the next step. Ask if the Human wants to retry. |
| Human provides an invalid branching model string | Only accept "github-flow", "gitflow", or "custom". For anything else, re-ask. |
| Human says "reset everything" outside of Step 3 | Acknowledge, call `identity_reset()`, then restart from Step 3 with no defaults for identity and current config defaults for branching. |
