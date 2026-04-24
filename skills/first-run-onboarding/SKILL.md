---
name: first-run-onboarding
description: First-time setup flow bro runs when neither branching_model nor identity has been persisted. Welcomes the user, captures identity + branching model + PR target + protected branches via MCP. Hold-and-resume any code-touching ask received during the flow.
agent: bro
allowed-tools: Bash, mcp__plugin_tmb_trajectory-server__identity_set, mcp__plugin_tmb_trajectory-server__config_set
---

# first-run-onboarding

## When invoked

Bro invokes this skill at session start when **either** of the following is true:

- `config_get("branching_model")` returns `null`
- `identity_get().created_at` is `null`

Onboarding Mode takes over. The pre-scan does NOT run during onboarding.

## Hold-and-resume

Any code-touching ask received while onboarding is pending is **held** — do not route it. Complete onboarding first, then proceed with the held request. Read-only asks (e.g. "what is this repo?") are answered inline and onboarding resumes immediately.

## Scope

During onboarding the skill may ONLY:
- Call MCP `identity_set` and `config_set` (each with `agent='bro'`).
- Emit text to the Human and wait for their reply.

It MUST NOT spawn any agent and MUST NOT run side-effecting shell commands.

## Mandatory MCP write sequence

Onboarding completes ONLY after ALL FOUR of these MCP calls have returned `ok`. Do not emit the closing message until the DB reflects all four:

1. `identity_set(agent='bro', human_name=<answer or skip if anonymous>)`
2. `config_set(agent='bro', key='branching_model', value=<canonical>)`
3. `config_set(agent='bro', key='pr_target', value=<answer>)`
4. `config_set(agent='bro', key='protected_branches', value=<JSON array>)`

If any returns an error, report it and retry the exact same call. Never narrate a rejection — only report what the MCP tool actually returned. Never skip a write because you think it might fail.

## Step 1 — Welcome + name

Emit:

> Hey, I'm bro. Trust me bro, it works — that's the plugin's whole pitch. I route your work to the right agents and keep things tidy. Let me grab a couple of settings.
>
> What should I call you? Reply with a name, or `anonymous` to skip.

Wait for reply. If the Human said their name inline earlier in the session, still confirm it back: "I have 'Zax' — use that?"

**MCP call #1** immediately after the Human's reply (before Step 2):

- If reply is `anonymous` or empty → skip the call, proceed.
- Otherwise → `identity_set(agent='bro', human_name=<reply>)`. Report the returned JSON to the Human ("Saved: Zax").

If the Human declined to share a name, address them with plain second-person for the rest of the session.

## Step 2 — Branching model

Emit exactly:

> How does your team branch? Reply with `1`, `2`, or `3`:
>
> 1. **Trunk + feature branches (GitHub Flow)** — recommended. Single main branch, feature branches off main, PRs back to main.
> 2. **Trunk + develop + releases (Git Flow)** — long-lived develop branch, releases promoted to main.
> 3. **Custom workflow** — you describe it.

Map their reply to canonical:

| Reply | Canonical value |
|---|---|
| `1` | `github-flow` |
| `2` | `gitflow` |
| `3` | `custom` |

If the reply doesn't match `1`, `2`, or `3`, re-emit the question — don't guess.

## Step 3 — PR target

Emit one line, default depends on Step 2's canonical:

- `github-flow` → *"What's your PR target branch? Reply with the branch name (e.g. `main`, `master`)."*
- `gitflow` → *"What's your PR target branch? (e.g. `develop`, `main`)."*
- `custom` → *"What's your PR target branch? (e.g. `trunk`, `release`)."*

Wait for reply. Accept any non-empty branch name.

## Step 4 — Custom protected branches (only if Step 2 was `3`)

If and only if branching is `custom`:

> Which branches should I treat as protected (no direct commits)? Reply comma-separated, e.g. `main,release`.

Parse the CSV, split+trim, into a JSON array. Otherwise (for `github-flow` or `gitflow`), compute protected_branches programmatically:

| branching | protected_branches |
|---|---|
| `github-flow` | `[<pr_target>]` |
| `gitflow` | `["main", <pr_target>]` deduplicated |
| `custom` | whatever the Human typed |

## Step 5 — Persist and close

Fire the remaining MCP calls IN ORDER, each with `agent='bro'`. Report each success inline ("✓ branching_model saved"):

- **MCP call #2:** `config_set(agent='bro', key='branching_model', value=<canonical>)`
- **MCP call #3:** `config_set(agent='bro', key='pr_target', value=<answer>)`
- **MCP call #4:** `config_set(agent='bro', key='protected_branches', value=<JSON array>)`

Then verify by calling `config_list(agent='bro')` and confirming all three keys are present. If any is missing, RETRY the missing call — don't close onboarding until the DB reflects all four writes.

After all four MCP calls returned ok, emit:

> Done. Identity and branching model saved. Tell me what you want to work on — trust me bro, it works.

Onboarding Mode ends. If a code-touching ask was held, proceed with it now.
