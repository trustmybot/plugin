---
name: first-run-onboarding
description: First-time setup flow bro runs when neither branching_model nor identity has been persisted. Welcomes the user, captures identity + branching model + PR target via AskUserQuestion radio UI, then persists via MCP. Hold-and-resume any code-touching ask received during the flow.
agent: bro
allowed-tools: Bash, AskUserQuestion, mcp__plugin_tmb_trajectory-server__identity_set, mcp__plugin_tmb_trajectory-server__config_set
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
- Call `AskUserQuestion` to collect answers with a proper radio UI
- Call MCP `config_set` and `identity_set` to persist answers
- Use read-only Bash for context if needed

It MUST NOT spawn any agent and MUST NOT run side-effecting shell commands.

## Step 1 — Welcome

Emit this short text, then proceed to Step 2:

> "Hey, I'm bro. Trust me bro, it works — that's the plugin's whole pitch. I route your work to the right agents and keep things tidy. Let me grab a couple of settings."

## Step 2 — Collect answers via AskUserQuestion

Call `AskUserQuestion` with **three questions batched in one call** so the Human sees one form, answers once:

```
AskUserQuestion({
  questions: [
    {
      question: "What should I call you?",
      header: "Your name",
      multiSelect: false,
      options: [
        { label: "Anonymous", description: "No name on file — bro addresses you in plain second-person." },
        { label: "Use inferred name", description: "If the Human mentioned a name (e.g. 'I'm Zax'), use that. Otherwise hide this option." }
      ]
      // 'Other' is auto-added; lets the Human type any name freely.
    },
    {
      question: "How does your team branch?",
      header: "Branching",
      multiSelect: false,
      options: [
        { label: "Trunk + feature branches (GitHub Flow) (Recommended)", description: "Single main branch, feature branches off main, PRs back to main." },
        { label: "Trunk + develop + releases (Git Flow)", description: "Long-lived develop branch, releases promoted to main." },
        { label: "Custom workflow", description: "Something else — you'll describe it via Other." }
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
      // 'Other' auto-added for any other name.
    }
  ]
})
```

If the Human previously introduced themselves inline ("I'm Zax"), pre-populate the name question's second option as `Use "Zax"` so they can one-click confirm. Otherwise omit that option and let them type via Other.

## Step 3 — Persist answers via MCP

After `AskUserQuestion` returns:

```
name_answer       = answers["What should I call you?"]
branching_answer  = answers["How does your team branch?"]
pr_target_answer  = answers["What's your PR target branch?"]
```

Map the labels back to canonical values:

| Label | Canonical value |
|---|---|
| "Anonymous" | skip `identity_set` |
| `Use "<name>"` or Other | `<name>` → `identity_set(agent='bro', human_name=<name>)` |
| "Trunk + feature branches (GitHub Flow) (Recommended)" | `github-flow` |
| "Trunk + develop + releases (Git Flow)" | `gitflow` |
| "Custom workflow" | `custom` |
| "main (Recommended)" / "master" / "develop" / "trunk" / Other | literal value |

MCP writes:

```
if name_answer != "Anonymous":
    identity_set(agent='bro', human_name=name_canonical)

config_set(agent='bro', key='branching_model', value=branching_canonical)
config_set(agent='bro', key='pr_target', value=pr_target_canonical)

# Protected branches:
if branching_canonical == 'github-flow':
    protected = [pr_target_canonical]
elif branching_canonical == 'gitflow':
    protected = dedup(['main', pr_target_canonical])
else:  # custom
    protected = [pr_target_canonical]   # Human can edit later via tmb-reonboard
config_set(agent='bro', key='protected_branches', value=protected)
```

## Step 4 — Custom branching follow-up

If the Human picked "Custom workflow", ask one more batch for their protected-branch list via a second `AskUserQuestion` call — option A: "Just the PR target I picked", option B: "PR target + main", option C: "I'll add more via Other". Whatever they pick, parse into a JSON array and `config_set('protected_branches', ...)`.

## Closing message

After all MCP writes succeed, say:

> "Done. Identity and branching model saved. Tell me what you want to work on — trust me bro, it works."

Onboarding Mode ends. If a code-touching ask was held, proceed with it now.
