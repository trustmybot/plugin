---
name: tmb_first-run-onboarding
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

## Hard rule — AskUserQuestion is mandatory, no text fallback

The `AskUserQuestion` call in Step 1 is **mandatory**. This is the contract of this skill.

**You MUST call `AskUserQuestion`.** If you emit the onboarding questions as plain text ("reply with 1/2/3", "reply with a name") instead of invoking `AskUserQuestion`, you have violated the skill's contract — the text fallback is NOT allowed.

If the `AskUserQuestion` call errors (tool returns an error), do this:
1. Read the exact error.
2. Retry the call once.
3. If the retry also errors, surface the error verbatim to the Human (do NOT silently fall back to text) and ask them how to proceed.

Do not skip the call because:
- CC's environment context leaked the user's email / name (inferred identity is not confirmed identity).
- Auto mode says "minimize interruptions" (onboarding is never a routine decision — it configures the project's trust model).
- You think you know the answers (you don't — branching model is explicit policy, not a guess).
- It seems faster to just ask in text (it isn't — it breaks the radio-form contract the scenarios test against).

Never call `identity_set` or `config_set` until the Human has explicitly answered via the radio form (or an Other free-text reply).

## Context-leak rule — local git config OK, CC env context NOT OK

Allowed identity sources to pre-populate a `Use "<name>"` option:

- **`git config --get user.name`** — user-set local config, attributable to the Human's own commit identity. OK.

Forbidden sources:

- CC's `# userEmail` / session-level env context. That's external metadata the Human didn't set in this repo; treat it as untrusted.
- Inferences from filesystem paths, `$USER`, `whoami`, or LDAP/SSO data.

Other rules:

- Do NOT put an inferred name in the question text as an example (keep the question neutral: *"What should I call you?"*).
- Do NOT add placeholder options that just point the user at the auto-added `Other`. AskUserQuestion already surfaces `Other` for free-text entry; adding a synonym option (e.g. one labeled as "enter a custom value", "pick Other below", etc.) is redundant and confuses the UI.
- Do NOT write `identity_set(human_name=…)` based on any source until the Human picks an option (or types free-text via Other). The form is where consent lives.

## Mandatory MCP write sequence

Onboarding completes ONLY after ALL FOUR writes have succeeded AND `config_list` confirms the state. Do not emit the closing message until every expected row is present:

1. `identity_set(agent='bro', human_name=<answer>)` — skip iff the Human chose Anonymous.
2. `config_set(agent='bro', key='branching_model', value=<canonical>)` — `value` is a string, e.g. `value="github-flow"`.
3. `config_set(agent='bro', key='pr_target', value=<answer>)` — `value` is a string, e.g. `value="main"`.
4. `config_set(agent='bro', key='protected_branches', value=<array of strings>)` — `value` is a **raw JSON array**, e.g. `value=["main"]`. Do NOT pass `value="[\"main\"]"` (a pre-serialized string). The MCP server calls `JSON.stringify(value)` on what you pass; if you pre-serialize, the DB stores a string and every downstream hook that expects an array breaks.

**Never narrate a rejection** — only report what the MCP tool actually returned. **Never skip a write** because you think it might fail. If a call errors, retry it. If it keeps erroring, surface the exact error to the Human and ask whether to retry or abort.

## Step 0 — Probe local identity sources (read-only Bash)

Before rendering the AskUserQuestion form, probe the local machine for a name the Human has already set themselves:

```bash
git config --get user.name   # user's own git identity
```

Cache the result as `git_user_name` if non-empty. This is **user-set local config**, not CC environment metadata — safe to offer as a pre-populated option.

Do NOT use CC's `# userEmail` / session-level env context to infer a name. That's external metadata the Human hasn't confirmed in this repo.

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
        // IF `git_user_name` from Step 0 is non-empty, append a second option:
        //   { label: `Use "${git_user_name}"`, description: "Detected from git config user.name" }
        // Otherwise do NOT add a second option. AskUserQuestion auto-adds
        // `Other` for free-text entry; the UI surfaces it automatically.
        // Do NOT add any synonym/placeholder option that redirects the user
        // to `Other` — it's redundant and confuses the form.
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
| `Use "<name>"` (git-detected) | strip the `Use "` prefix + trailing `"`, pass the inner name to `identity_set` |
| Other (free text) | pass verbatim to `identity_set` |
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

config_set(agent='bro', key='branching_model',    value="github-flow")   # string
config_set(agent='bro', key='pr_target',          value="main")           # string
config_set(agent='bro', key='protected_branches', value=["main"])         # raw array — NOT "[\"main\"]"
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
