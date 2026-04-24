---
name: tmb-reonboard
description: Re-run the TMB onboarding flow on demand. Shows current values as explicit defaults. Handles branching model changes, PR target updates, and identity rename.
agent: bro
allowed-tools: Bash, mcp__plugin_tmb_trajectory-server__identity_get, mcp__plugin_tmb_trajectory-server__identity_set, mcp__plugin_tmb_trajectory-server__identity_reset, mcp__plugin_tmb_trajectory-server__config_list, mcp__plugin_tmb_trajectory-server__config_set
---

# tmb-reonboard

## Purpose

Let a user update branching model, PR target, protected branches, or their name after first-run onboarding completed. Reads current state, shows it as the default, writes changes via MCP.

## When Invoked

Bro invokes this skill directly (no subagent spawn) on these trigger phrases or close paraphrases:

- "re-onboard", "reset onboarding"
- "change branching model" / "switch to gitflow" / "switch to github-flow"
- "update my name" / "change my name"

## Scope

ONLY:
- `config_list`, `config_set` (keys `branching_model`, `pr_target`, `protected_branches` only)
- `identity_get`, `identity_set`, `identity_reset`

NEVER: `issue_create`, `task_create_batch`, `task_update_status`, `validation_record`, or anything outside the list above.

## Step 1 — Read current state

Call with `agent='bro'`:

```
config_list(agent='bro')
identity_get(agent='bro')
```

Extract (use "(unset)" as the display for `null`):

- `current_human_name` — from `identity_get().human_name`
- `current_branching_model` — from `config_list()` key `branching_model`
- `current_pr_target` — from `config_list()` key `pr_target`
- `current_protected_branches` — from `config_list()` key `protected_branches`

## Step 2 — Show current values

Emit:

> Here's what I have on file:
> - Your name: `<current_human_name>`
> - Branching model: `<current_branching_model>`
> - PR target: `<current_pr_target>`
> - Protected branches: `<current_protected_branches>`
>
> Which do you want to change? Reply with one of: `name`, `branching`, `pr-target`, `protected`, `all`, or `none` to cancel.

## Step 3 — Per-field update

Based on their reply, ask one or more sub-questions. Accept canonical input or sentinel `keep` to preserve current.

**name:**
> Reply with a new name, `anonymous` to clear, or `keep` to keep `<current_human_name>`.

- If `keep` → no MCP call.
- If `anonymous` → `identity_reset(agent='bro')`.
- Otherwise → `identity_set(agent='bro', human_name=<reply>)`.

**branching:**
> Reply with `1` (github-flow), `2` (gitflow), `3` (custom), or `keep` to keep `<current_branching_model>`.

- If `keep` → no MCP call for this field.
- Otherwise → `config_set(agent='bro', key='branching_model', value=<canonical>)`, then proceed to ask pr-target (Step 3/pr-target) so protected_branches can be recomputed correctly.

**pr-target:**
> Reply with a branch name, or `keep` to keep `<current_pr_target>`.

- If `keep` → no MCP call.
- Otherwise → `config_set(agent='bro', key='pr_target', value=<reply>)`.

Recompute `protected_branches` using the (possibly new) branching + (possibly new) pr_target:

| branching | protected_branches |
|---|---|
| `github-flow` | `[<pr_target>]` |
| `gitflow` | `["main", <pr_target>]` deduplicated |
| `custom` | unchanged unless the user explicitly updates it |

If the recomputed list differs from current: `config_set(agent='bro', key='protected_branches', value=<new list>)`.

**protected:**
> Reply with comma-separated branch names, or `keep`.

- If `keep` → no MCP call.
- Otherwise → parse CSV → JSON array → `config_set(agent='bro', key='protected_branches', value=<array>)`.

**all:** sequentially ask name, branching, pr-target, protected — same logic as above.

**none:** no MCP calls, close immediately.

## Step 4 — Confirm and close

After any writes, call `config_list(agent='bro')` + `identity_get(agent='bro')` one more time to verify. Emit:

> Done. Settings:
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
| Invalid branching input (not 1/2/3/keep) | Re-ask the same sub-question; do not guess. |
| Reply doesn't match any Step-2 option | Re-ask Step 2 with the same options. |
