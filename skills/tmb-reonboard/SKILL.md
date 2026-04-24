---
name: tmb-reonboard
description: Re-run the TMB onboarding flow on demand. Asks per-field via text Q+A, accepts `keep` to preserve current value. Handles branching model changes, PR target updates, and identity rename.
agent: bro
allowed-tools: Bash, mcp__plugin_tmb_trajectory-server__identity_get, mcp__plugin_tmb_trajectory-server__identity_set, mcp__plugin_tmb_trajectory-server__identity_reset, mcp__plugin_tmb_trajectory-server__config_list, mcp__plugin_tmb_trajectory-server__config_set
---

# tmb-reonboard

## Purpose

Let a user update branching model, PR target, protected branches, or their name after first-run onboarding. Reads current state, asks per-field via text, persists changes via MCP. `AskUserQuestion` is unavailable to plugin subagents — use plain chat output.

## When Invoked

Bro invokes this skill directly (no subagent spawn) on these trigger phrases or close paraphrases:

- "re-onboard", "reset onboarding"
- "change branching model" / "switch to gitflow" / "switch to github-flow"
- "update my name" / "change my name"

## Scope

ONLY:
- `config_list`, `config_set` (keys `branching_model`, `pr_target`, `protected_branches` only)
- `identity_get`, `identity_set`, `identity_reset`

NEVER: `issue_create`, `task_create_batch`, `task_update_status`, `validation_record`, `AskUserQuestion`, or anything outside the list above.

## Step 1 — Read current state

Call with `agent='bro'`:

```
config_list(agent='bro')
identity_get(agent='bro')
```

Extract (use "(unset)" display for `null`):

- `current_human_name` — from `identity_get().human_name`
- `current_branching_model`, `current_pr_target`, `current_protected_branches` — from `config_list()`.

## Step 2 — Show current values + ask which to change

Emit one message:

```
Here's what I have on file:
- Your name: <current_human_name>
- Branching model: <current_branching_model>
- PR target: <current_pr_target>
- Protected branches: <current_protected_branches>

Which do you want to change? Reply with one of: `name`, `branching`, `pr-target`, `protected`, `all`, or `none` to cancel.
```

Wait for reply.

## Step 3 — Per-field update

Based on their reply, ask one or more sub-questions. `keep` preserves current; otherwise write the new value via MCP.

**name:**

```
Reply with a new name, `anonymous` to clear, or `keep` to keep "<current_human_name>".
```

- `keep` → no MCP call.
- `anonymous` → `identity_reset(agent='bro')`.
- otherwise → `identity_set(agent='bro', human_name=<reply>)`.

**branching:**

```
How does your team branch? Reply with one of:
- `1` — Trunk + feature branches (GitHub Flow)
- `2` — Trunk + develop + releases (Git Flow)
- `3` — Custom workflow
- `keep` — keep "<current_branching_model>"
```

- `keep` → no MCP call.
- otherwise → `config_set(agent='bro', key='branching_model', value=<canonical>)`. Then proceed to **pr-target** sub-flow so protected_branches can be recomputed.

**pr-target:**

```
What's your PR target branch? Reply with a branch name, or `keep` to keep "<current_pr_target>".
```

- `keep` → no MCP call.
- otherwise → `config_set(agent='bro', key='pr_target', value=<reply>)`.

After branching or pr-target changes, recompute `protected_branches`:

| branching | protected_branches |
|---|---|
| `github-flow` | `[<pr_target>]` |
| `gitflow` | `["main", <pr_target>]` deduped |
| `custom` | unchanged unless the user explicitly updates it |

If the recomputed list differs from current → `config_set(agent='bro', key='protected_branches', value=<new list>)`.

**protected:**

```
Which branches should I treat as protected? Reply comma-separated (e.g. `main,develop`), or `keep`.
```

- `keep` → no MCP call.
- otherwise → parse CSV → JSON array → `config_set(agent='bro', key='protected_branches', value=<array>)`.

**all:** sequentially ask name, branching, pr-target, protected — same logic as above.

**none:** no MCP calls; close.

## Step 4 — Verify and close

After any writes, call `config_list(agent='bro')` + `identity_get(agent='bro')` to confirm. Emit:

```
Done. Settings:
- Your name: <final_human_name>
- Branching model: <final_branching_model>
- PR target: <final_pr_target>
- Protected branches: <final_protected_branches>

Tell me what you want to work on.
```

## Error Handling

| Trigger | Response |
|---|---|
| `config_list()` or `identity_get()` fails | Report the exact error, offer to retry or abort. Do NOT proceed with stale state. |
| `config_set` or `identity_set` fails | Report the exact error, retry the same call. Do NOT skip and continue. |
| Reply doesn't match any valid option for the active sub-question | Re-ask the sub-question once, listing the valid options again. |
