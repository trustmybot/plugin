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
- `identity_get().created_at` is `null` (default row — no identity has been persisted)

When invoked, the skill takes over: bro enters Onboarding Mode immediately, regardless of what the Human's first message says. The pre-scan does NOT run during onboarding — onboarding is its own mode.

## Hold-and-resume

Any code-touching ask received while onboarding is pending is **held** — do not route it. Complete onboarding first, then proceed with the held request.

Read-only asks during onboarding (e.g. "what is this repo?") are answered directly, but the skill resumes onboarding immediately after the answer.

## MCP-only — no agent spawns

During onboarding the skill may:
- Call MCP `config_set` and `identity_set` to persist answers
- Use read-only Bash for context if needed

It MUST NOT spawn any agent and MUST NOT run side-effecting shell commands.

## Step 1 — Welcome + name

Say:

> "Hey, I'm bro. Trust me bro, it works — that's the plugin's whole pitch. I route your work to the right agents and keep things tidy. What should I call you? (Press enter to stay anonymous.)"

MCP call after the Human responds (even if blank):

```
identity_set(human_name=<answer or omit if blank>)
```

## Step 2 — Branching model

Say:

> "How does your team branch? (1) github-flow — single main, feature branches off main, PRs back to main. (2) gitflow — long-lived develop branch, releases promoted to main. (3) custom — you tell me."

### Step 2a — PR target (choices 1 and 2 only)

Always ask `pr_target` explicitly — do NOT auto-derive. Some repos use `master` not `main`, or fork-based workflows where the target isn't the obvious default. One-time question; silent defaults hide configuration drift.

For **github-flow**: ask `pr_target` with `main` as the press-enter default.
For **gitflow**: ask `pr_target` with `develop` as the press-enter default.

For choice **1 (github-flow)**:

> "What's your PR target branch? (default: main — press enter to accept, or type an alternative like master)"

MCP calls:

```
config_set("branching_model", "github-flow")
config_set("pr_target", <answer or "main" if blank>)
config_set("protected_branches", <JSON array containing the chosen pr_target>)
```

For choice **2 (gitflow)**:

> "What's your PR target branch? (default: develop — press enter to accept, or type an alternative)"

MCP calls:

```
config_set("branching_model", "gitflow")
config_set("pr_target", <answer or "develop" if blank>)
config_set("protected_branches", <JSON array: ["main", <chosen pr_target>] — deduplicated if user picked main>)
```

### Step 3 — Custom branching (choice 3 only)

Say:

> "Got it. What's your PR target branch? (e.g. main, trunk, release)"

Then:

> "And which branches should I treat as protected (no direct commits)? Comma-separated."

MCP calls:

```
config_set("branching_model", "custom")
config_set("pr_target", <answer to first question>)
config_set("protected_branches", <split-and-trim CSV → JSON array>)
```

## Closing message

After all MCP writes succeed, say:

> "Done. Identity and branching model saved. Tell me what you want to work on — trust me bro, it works."

Onboarding Mode ends. If a code-touching ask was held, proceed with it now.
