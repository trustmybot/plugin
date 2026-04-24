---
name: first-run-onboarding
description: First-time setup flow bro runs when neither branching_model nor identity has been persisted. Uses AskUserQuestion radio UI to collect identity + branching + PR target, then persists via MCP. Hold-and-resume any code-touching ask received during the flow.
agent: bro
allowed-tools: Bash, AskUserQuestion, mcp__plugin_tmb_trajectory-server__identity_set, mcp__plugin_tmb_trajectory-server__config_set, mcp__plugin_tmb_trajectory-server__config_list
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
- Call `AskUserQuestion` to collect answers via the radio UI.
- Call MCP `identity_set`, `config_set`, `config_list` (each with `agent='bro'`).

MUST NOT spawn any agent. MUST NOT run side-effecting shell commands.

## Mandatory MCP write sequence

Onboarding completes ONLY after ALL FOUR writes have succeeded AND `config_list` confirms the state. Do not emit the closing message until every expected row is present:

1. `identity_set(agent='bro', human_name=<answer>)` — skip iff the Human chose Anonymous.
2. `config_set(agent='bro', key='branching_model', value=<canonical>)`
3. `config_set(agent='bro', key='pr_target', value=<answer>)`
4. `config_set(agent='bro', key='protected_branches', value=<JSON array>)`

**Never narrate a rejection** — only report what the MCP tool actually returned. **Never skip a write** because you think it might fail. If a call errors, retry it. If it keeps erroring, surface the exact error to the Human and ask whether to retry or abort.

## Step 1 — Welcome + name + branching + PR target (one batched AskUserQuestion call)

Emit the welcome line first:

> Hey, I'm bro. Trust me bro, it works — that's the plugin's whole pitch. I route your work to the right agents and keep things tidy. Let me grab a couple of settings.

Then call `AskUserQuestion` with three questions batched in one invocation so the Human answers once:

```
AskUserQuestion({
  questions: [
    {
      question: "What should I call you?",
      header: "Your name",
      multiSelect: false,
      options: [
        { label: "Anonymous", description: "No name on file — bro addresses you in plain second-person." }
        // If the Human mentioned a name inline earlier this session (e.g. "I'm Zax"),
        // add a second option: { label: 'Use "<name>"', description: "..." }.
        // Otherwise let the auto-added "Other" handle free-text name entry.
      ]
    },
    {
      question: "How does your team branch?",
      header: "Branching",
      multiSelect: false,
      options: [
        { label: "Trunk + feature branches (GitHub Flow) (Recommended)", description: "Single main, feature branches off main, PRs back to main." },
        { label: "Trunk + develop + releases (Git Flow)", description: "Long-lived develop branch, releases promoted to main." },
        { label: "Custom workflow", description: "Different workflow — describe via Other." }
      ]
    },
    {
      question: "What's your PR target branch?",
      header: "PR target",
      multiSelect: false,
      options: [
        { label: "main (Recommended)", description: "Default for github-flow and most modern repos." },
        { label: "master", description: "Older repos that predate the main-branch rename." },
        { label: "develop", description: "Use this if you chose Git Flow above." },
        { label: "trunk", description: "Some teams still use this." }
      ]
    }
  ]
})
```

## Step 2 — Map answers to canonical values

Parse `AskUserQuestion` response. Map labels:

| Label | Canonical value |
|---|---|
| "Anonymous" | skip `identity_set` |
| `Use "<name>"` or Other (free text) | `<name>` → passed to `identity_set` |
| "Trunk + feature branches (GitHub Flow) (Recommended)" | `github-flow` |
| "Trunk + develop + releases (Git Flow)" | `gitflow` |
| "Custom workflow" | `custom` |
| "main (Recommended)" | `main` |
| "master" / "develop" / "trunk" / Other | literal |

## Step 3 — Protected branches

Compute based on branching + PR target:

| branching | protected_branches |
|---|---|
| `github-flow` | `[<pr_target>]` |
| `gitflow` | `["main", <pr_target>]` deduplicated |
| `custom` | (ask separately — see Step 3a) |

### Step 3a — Custom branching (only if Step 1 answer was "Custom workflow")

Second `AskUserQuestion` call:

```
AskUserQuestion({
  questions: [{
    question: "Which branches should I treat as protected (no direct commits)?",
    header: "Protected",
    multiSelect: true,
    options: [
      { label: `<pr_target>`, description: "Your PR target — almost always protected." },
      { label: "main", description: "Most repos protect this regardless of workflow." },
      { label: "release", description: "For release-branch workflows." },
      { label: "master", description: "Legacy name for main." }
    ]
    // Other for custom branch names the user types freely.
  }]
})
```

Parse the selected labels + any Other entries into a JSON array.

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
