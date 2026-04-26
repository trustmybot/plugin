---
name: tmb_first-run-onboarding
description: First-time setup flow bro runs when neither branching_model nor identity has been persisted. Uses AskUserQuestion radio UI to collect identity + branching + PR target, persists via MCP, logs the onboarding_complete audit row. Does NOT copy any files — swe + pr-reviewer + default skills ship globally with the plugin. Hold-and-resume any code-touching ask received during the flow.
agent: bro
allowed-tools: Bash, AskUserQuestion, mcp__plugin_tmb_trajectory-server__identity_set, mcp__plugin_tmb_trajectory-server__config_set, mcp__plugin_tmb_trajectory-server__config_list, mcp__plugin_tmb_trajectory-server__ledger_log, mcp__plugin_tmb_trajectory-server__ledger_list
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

Onboarding completes ONLY after ALL of the following have succeeded AND a final `ledger_list` confirms the audit row landed. Do not emit the closing message until every expected row is present:

1. `identity_set(agent='bro', ...)` — **always called.** Pass `human_name=<answer>` for a named identity, or `anonymous=true` for Anonymous. Both forms write a row; downstream code distinguishes "onboarded" by the row's existence (`identity_get().created_at != null`), not by whether `human_name` is set. Skipping this call here is the bug class fixed in v0.4.1 (issue #95).
2. `config_set(agent='bro', key='branching_model', value=<canonical>)` — `value` is a string, e.g. `value="github-flow"`.
3. `config_set(agent='bro', key='pr_target', value=<answer>)` — `value` is a string, e.g. `value="main"`.
4. `config_set(agent='bro', key='protected_branches', value=<array of strings>)` — `value` is a **raw JSON array**, e.g. `value=["main"]`. Do NOT pass `value="[\"main\"]"` (a pre-serialized string). The MCP server calls `JSON.stringify(value)` on what you pass; if you pre-serialize, the DB stores a string and every downstream hook that expects an array breaks.
5. `ledger_log(agent='bro', event_type='tmb_onboarding_complete', summary='...')` — **non-optional audit-trail row.** Without this, the trajectory loses the "onboarding ran here" anchor; future skills + tests assume it exists. (No file copies — `swe`, `pr-reviewer`, and 7 default skills ship globally with the plugin.)

**Never narrate a rejection** — only report what the MCP tool actually returned. **Never skip a write** because you think it might fail. If a call errors, retry it. If it keeps erroring, surface the exact error to the Human and ask whether to retry or abort.

## Step 0 — Probe local identity sources + committed team config (read-only Bash)

Before rendering the AskUserQuestion form, probe two sources the Human has already set themselves.

### 0a — Local git identity

```bash
git config --get user.name   # user's own git identity
```

Cache the result as `git_user_name` if non-empty. This is **user-set local config**, not CC environment metadata — safe to offer as a pre-populated option.

Do NOT use CC's `# userEmail` / session-level env context to infer a name. That's external metadata the Human hasn't confirmed in this repo.

### 0b — Committed team config (issue #32)

```bash
TEAM_CFG=".claude/tmb/config.json"
if [ -f "$TEAM_CFG" ]; then
  team_branching=$(jq -r '.branching_model // empty' "$TEAM_CFG" 2>/dev/null)
  team_pr_target=$(jq -r '.pr_target // empty' "$TEAM_CFG" 2>/dev/null)
  team_protected=$(jq -c '.protected_branches // empty' "$TEAM_CFG" 2>/dev/null)
fi
```

If `.claude/tmb/config.json` exists, it's a **committed team-default**. The format:

```json
{
  "branching_model": "github-flow",
  "pr_target": "main",
  "protected_branches": ["main"]
}
```

Use the values to **pre-select the matching radio option** in each onboarding question (so the team default is one click away). The Human can still override locally; their local DB stores their actual answer. The committed file is unchanged unless they explicitly edit it.

Identity (`human_name`) is NEVER read from the committed file — that's per-user.

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
| "Anonymous" | call `identity_set(anonymous=true)` — writes a row with `human_name=NULL` |
| `Use "<name>"` (git-detected) | strip the `Use "` prefix + trailing `"`, pass the inner name as `identity_set(human_name=<name>)` |
| Other (free text) | pass verbatim to `identity_set(human_name=<text>)` |
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
if name == "Anonymous":
    identity_set(agent='bro', anonymous=True)
else:
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

## Step 5 — Log the onboarding-complete audit row

**No file copying.** As of v0.3.0, `swe` and `pr-reviewer` ship globally in the plugin's `agents/` directory and are already discoverable by CC. Same for the 7 default skills (`swe-checklist`, `code-quality`, `docs-conventions`, `git-conventions`, `naming-conventions`, `review-protocol`, `review-findings`) — all live in the plugin's `skills/` directory. Onboarding does NOT copy anything into the project. Projects can later override per-name by writing `<project>/.claude/agents/<name>.md` or `<project>/.claude/skills/<name>/SKILL.md` — but that's a per-project customization decision, not a default.

This step is **not optional** and **must be the last MCP call before the closing message**. Skipping it leaves the trajectory without the "onboarding ran here" anchor — downstream tests check for it, and `issue_resume` uses it to detect "first session in this project."

```
ledger_log(
  agent='bro',
  from_node='bro',
  event_type='tmb_onboarding_complete',
  summary='Identity + branching + PR target persisted. swe + pr-reviewer + 7 default skills available globally from the plugin.',
)
```

Then verify the row landed:

```
ledger_list(agent='bro', limit=5)
```

If `tmb_onboarding_complete` is not in the returned rows, **retry the `ledger_log` call** before closing onboarding. Do not emit the closing message until the audit row is confirmed present.

## Closing message

Emit only after the identity + 3 config writes succeeded AND `ledger_list` confirms `tmb_onboarding_complete`:

> Done. Identity + branching model saved. swe + pr-reviewer + default skills are already available from the plugin — no setup needed in your project. Tell me what you want to work on — trust me bro, it works.

Onboarding Mode ends. If a code-touching ask was held, proceed with it now.
