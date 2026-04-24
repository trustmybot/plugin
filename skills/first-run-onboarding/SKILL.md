---
name: first-run-onboarding
description: First-time setup flow bro runs when neither branching_model nor identity has been persisted. Captures identity + branching + PR target via text Q+A in chat, then persists via MCP. Hold-and-resume any code-touching ask received during the flow.
agent: bro
allowed-tools: Bash, mcp__plugin_tmb_trajectory-server__identity_set, mcp__plugin_tmb_trajectory-server__config_set, mcp__plugin_tmb_trajectory-server__config_list
---

# first-run-onboarding

## When invoked

Bro invokes this skill at session start when **either** of the following is true:

- `config_get("branching_model")` returns `null`
- `identity_get().created_at` is `null`

Onboarding Mode takes over. The pre-scan does NOT run during onboarding.

## Hold-and-resume

Any code-touching ask received while onboarding is pending is **held** — do not route it. Complete onboarding first, then proceed with the held request. Read-only asks (e.g. "what is this repo?") are answered inline; onboarding resumes immediately after.

## Scope

During onboarding the skill may ONLY:
- Emit text questions to the Human via regular chat output.
- Call MCP `identity_set`, `config_set`, `config_list` (each with `agent='bro'`).

MUST NOT spawn any agent. MUST NOT run side-effecting shell commands. MUST NOT call `AskUserQuestion` — it is unavailable to plugin subagents (see [anthropics/claude-code#12890](https://github.com/anthropics/claude-code/issues/12890)).

## Context-leak rule — never surface inferred identity

CC's subagent context includes the user's email (e.g. `# userEmail zax.shen@gmail.com`). The Human's FIRST interaction with bro must not leak that inference:

- Do NOT put an inferred name in the question text as an example. The question should be neutral ("What should I call you?") with no example values that hint at what bro might already know.
- Do NOT pre-populate the answer based on email-derived guesses. The Human's reply is the only confirmed identity.
- Do NOT write `identity_set(human_name='Zax')` based on email inference, even if the Human never actually answers.

Treat CC's environment identity as external metadata that the Human hasn't confirmed. The reply is where consent lives.

## Mandatory MCP write sequence

Onboarding completes ONLY after ALL FOUR writes have succeeded AND `config_list` confirms the state. Do not emit the closing message until every expected row is present:

1. `identity_set(agent='bro', human_name=<answer>)` — skip iff the Human chose Anonymous.
2. `config_set(agent='bro', key='branching_model', value=<canonical>)`
3. `config_set(agent='bro', key='pr_target', value=<answer>)`
4. `config_set(agent='bro', key='protected_branches', value=<JSON array>)`

**Never narrate a rejection** — only report what the MCP tool actually returned. **Never skip a write** because you think it might fail. If a call errors, retry it. If it keeps erroring, surface the exact error to the Human and ask whether to retry or abort.

## Step 1 — Welcome + three questions in one message

Emit the welcome line plus all three questions in a single message so the Human can answer once. Wait for the reply before moving on:

```
Hey, I'm bro. Trust me bro, it works — that's the plugin's whole pitch. I route your work to the right agents and keep things tidy. Three quick questions:

1. **What should I call you?** Reply with a name, or `anonymous` to skip.
2. **How does your team branch?** Reply with one of:
   - `1` — Trunk + feature branches (GitHub Flow) (recommended)
   - `2` — Trunk + develop + releases (Git Flow)
   - `3` — Custom workflow (you describe it)
3. **What's your PR target branch?** Reply with: `main` (recommended), `master`, `develop`, `trunk`, or any other name.

Reply in any order — quote each question briefly so I can match.
```

## Step 2 — Parse the Human's reply, map to canonical values

The Human will reply in free text. Extract:

- **Name** — whatever they typed for question 1. If it's `anonymous` (case-insensitive), `none`, blank, or a similar refusal → skip `identity_set`.
- **Branching** — match `1`/`2`/`3` or the words "github", "gitflow", "custom":

| Reply | Canonical value |
|---|---|
| `1` or "github-flow" or "github flow" | `github-flow` |
| `2` or "gitflow" or "git flow" | `gitflow` |
| `3` or "custom" | `custom` |

- **PR target** — accept the literal branch name they typed (`main`, `master`, `develop`, `trunk`, or anything else).

If any of the three answers can't be parsed unambiguously, ask ONE focused follow-up question for that field only. Do not retry the whole onboarding.

## Step 3 — Protected branches

Compute based on branching + PR target:

| branching | protected_branches |
|---|---|
| `github-flow` | `[<pr_target>]` |
| `gitflow` | `["main", <pr_target>]` deduplicated |
| `custom` | (ask separately — see Step 3a) |

### Step 3a — Custom branching (only if branching answer was `custom`)

Ask one follow-up message:

```
Which branches should I treat as protected (no direct commits)? Reply comma-separated, e.g. `main,release` or `main,develop,staging`.
```

Parse the CSV (split on `,`, trim each), produce a JSON array.

## Step 4 — Persist + verify

Fire the writes IN ORDER, each with `agent='bro'`. Report each success inline ("✓ name saved", "✓ branching_model saved", etc.):

```
if name != "Anonymous":
    identity_set(agent='bro', human_name=<name>)

config_set(agent='bro', key='branching_model', value=<canonical>)
config_set(agent='bro', key='pr_target', value=<pr_target>)
config_set(agent='bro', key='protected_branches', value=<JSON array>)
```

Then verify:

```
config_list(agent='bro')
```

Expected keys: `branching_model`, `pr_target`, `protected_branches`. If any is missing, RETRY the missing write. Do not close onboarding until the config_list return reflects all three.

## Closing message

After every expected write succeeded AND `config_list` confirmed the state, emit:

> Done. Identity and branching model saved. Tell me what you want to work on — trust me bro, it works.

Onboarding Mode ends. If a code-touching ask was held, proceed with it now.
