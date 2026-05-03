---
name: tmb_reonboard
description: Configure or change bro's per-project state — branching model, PR target, protected branches, identity name. The plugin has no first-run onboarding; bro applies defaults silently on first activation, and this skill is the only path to override them. Shows current values as the pre-selected option in an AskUserQuestion radio UI.
agent: bro
allowed-tools: Bash, AskUserQuestion, mcp__plugin_tmb_trajectory-server__identity_get, mcp__plugin_tmb_trajectory-server__identity_set, mcp__plugin_tmb_trajectory-server__identity_reset, mcp__plugin_tmb_trajectory-server__config_list, mcp__plugin_tmb_trajectory-server__config_set
---

# tmb_reonboard

## Purpose

Let a user configure or update branching model, PR target, protected branches, or their name. The plugin has no first-run onboarding ceremony — bro applies defaults silently on first activation. This skill is the **only** path to write `identity` rows or change policy keys; everything else reads what bro has either defaulted or the user has previously set. Reads current state, shows it as the `Keep "<current>"` first option in a radio form, writes changes via MCP.

## When Invoked

Bro invokes this skill directly (no subagent spawn) on these trigger phrases or close paraphrases:

- "re-onboard", "reset onboarding"
- "change branching model" / "switch to gitflow" / "switch to github-flow"
- "update my name" / "change my name"

## Scope

ONLY:
- `AskUserQuestion` (collect answers)
- `Bash` (read-only `git remote -v` only)
- `config_list`, `config_set` (keys `branching_model`, `pr_target`, `protected_branches`, `remotes` only)
- `identity_get`, `identity_set`, `identity_reset`

NEVER: `issue_create`, `task_create_batch`, `task_update_status`, `validation_record`, or anything outside the list above.

## Step 1 — Read current state

Call with `agent='bro'`:

```
config_list(agent='bro')
identity_get(agent='bro')
```

Extract (use "(unset)" display for `null`):

- `current_human_name` — from `identity_get().human_name`
- `current_branching_model`, `current_pr_target`, `current_protected_branches` — from `config_list()`.

## Step 1.5 — Auto-detect git remotes

Run from the project root:

```bash
git remote -v
```

`git remote -v` outputs two lines per remote (fetch + push). De-duplicate by remote name — keep only unique names. For each unique remote, extract the URL from the fetch line and apply the URL-pattern → provider mapping:

| URL pattern | provider |
|---|---|
| contains `github.com` | `github` |
| contains `gitlab.com` or matches `gitlab\.<corp>\.<tld>` | `gitlab` |
| contains `bitbucket.org` | `bitbucket` |
| contains `codeberg.org` | `codeberg` |
| contains `dev.azure.com` | `azuredev` |
| anything else | `other` |

Build `detected_remotes` — an array of `{ name, provider, url }` objects, one per unique remote name.

- If `detected_remotes` is non-empty AND every detection is unambiguous (no provider is `other`): call `config_set(agent='bro', key='remotes', value=detected_remotes)` and skip the Remotes AUQ tab in Step 2.
- Otherwise fall through to Step 2 — the Remotes tab will fire.

## Step 2 — Collect new values via AskUserQuestion

One batched call. First option on each question is `Keep "<current>"` (pre-selected default):

```
AskUserQuestion({
  questions: [
    {
      question: "What should I call you?",
      header: "Your name",
      multiSelect: false,
      options: [
        { label: `Keep "${current_human_name}"`, description: "No change." },  // drop this option if current_human_name is null
        { label: "Anonymous", description: "Remove name from file." }
        // Other — free text new name.
      ]
    },
    {
      question: "How does your team branch?",
      header: "Branching",
      multiSelect: false,
      options: [
        { label: `Keep "${current_branching_model}"`, description: "No change." },
        { label: "Switch to Trunk + feature branches (GitHub Flow)", description: "Single main, feature branches, PRs back." },
        { label: "Switch to Trunk + develop + releases (Git Flow)", description: "Long-lived develop + releases to main." },
        { label: "Custom workflow", description: "Describe via Other." }
      ]
    },
    {
      question: "What's your PR target branch?",
      header: "PR target",
      multiSelect: false,
      options: [
        { label: `Keep "${current_pr_target}"`, description: "No change." },
        { label: "main", description: "Most common default." },
        { label: "develop", description: "Common for Git Flow." },
        { label: "master", description: "Older repos." }
      ]
      // Other for any alternative.
    },
    {
      question: "Which git remotes does this project use?",
      header: "Remotes",
      multiSelect: true,
      options: [
        { label: "GitHub", description: "github.com or GitHub Enterprise." },
        { label: "GitLab", description: "gitlab.com or self-hosted GitLab." },
        { label: "Bitbucket", description: "Atlassian's git host." },
        { label: "None / not pushed yet", description: "No remote configured." }
      ]
      // AskUserQuestion auto-renders an Other free-text option for self-hosted / Codeberg / Gitea / etc.
    }
  ]
})
```

Dedupe: if `current_<field>` already matches a static option (e.g. `current_pr_target == "main"`), collapse the `Keep "main"` entry with the "main" option to avoid a duplicate.

Re-onboard hint for the Remotes tab: read `current_remotes` from `config_list()`. For each Remotes option whose provider matches a `current_remotes` entry, append `" (in current config)"` to that option's description. Mapping: `GitHub` → `github`, `GitLab` → `gitlab`, `Bitbucket` → `bitbucket`. For example, if `current_remotes` includes `{ provider: "gitlab" }`, the `GitLab` option becomes `{ label: "GitLab", description: "gitlab.com or self-hosted GitLab. (in current config)" }`.

## Step 3 — Persist via MCP

For each answer:

- Starts with `Keep "`: no write for that field.
- Name = "Anonymous": `identity_reset(agent='bro')`.
- Name = other: `identity_set(agent='bro', human_name=<name>)`.
- Branching changed: `config_set(agent='bro', key='branching_model', value=<canonical>)`.
- PR target changed: `config_set(agent='bro', key='pr_target', value=<value>)` AND recompute `protected_branches`:

  | branching | protected_branches |
  |---|---|
  | `github-flow` | `[<pr_target>]` |
  | `gitflow` | `["main", <pr_target>]` deduped |
  | `custom` | ask separately (second AskUserQuestion round, multiSelect=true) |

  Then `config_set(agent='bro', key='protected_branches', value=<new list>)`.

### Remotes answer

- If Step 1.5 already wrote `remotes`, this block is a no-op (the AUQ tab did not render).
- **Conflict check**: if the user selected `None / not pushed yet` AND any of `GitHub`, `GitLab`, `Bitbucket`, or `Other`, surface the conflict and re-ask. Sample re-ask wording: "You picked both 'None' and a provider. Did you mean: have a remote (drop 'None'), or no remote (drop the others)?" Re-render the same AUQ tab; loop until coherent.
- **Map selections to canonical providers**:
  - `GitHub` → `github`
  - `GitLab` → `gitlab`
  - `Bitbucket` → `bitbucket`
  - `None / not pushed yet` → empty array (no further processing)
  - `Other` (free-text) → lowercase + alphanumeric-only normalize; treat as `other` if not in the canonical enum (`github`, `gitlab`, `bitbucket`, `codeberg`, `gitea`, `forgejo`, `azuredev`)
- **Build the new `remotes` array**: for each selected provider (in selection order), emit `{ name, provider, url }`. The `name` defaults to `"origin"` for the first selection, then `<provider>` for additional. The `url` is empty string until first push.
  - Example: user picks `[GitHub, GitLab]` → `[{ name: "origin", provider: "github", url: "" }, { name: "gitlab", provider: "gitlab", url: "" }]`
- **Persist**: `config_set(agent='bro', key='remotes', value=<new array>)`.

## Step 3.5 — Issue-sync opt-in (when remote available)

1. Run `gh auth status` and `glab auth status` (Bash, capture exit codes).
2. If neither is authenticated: skip this phase silently.
3. Compose options:
   - GitHub authenticated → "Mirror to GitHub"
   - GitLab authenticated → "Mirror to GitLab"
   - Both authenticated → "Mirror to both"
   - Always: "Skip — keep local-only"
4. Emit ONE AskUserQuestion:
   - Header: "Issue sync"
   - Text: "Mirror new MCP issues to your remote? Detected: <gh|glab|both>."
   - Options: per the available backends + "Skip"
5. On answer:
   - "Mirror to GitHub" → `config_set('issue_sync', 'gh')`
   - "Mirror to GitLab" → `config_set('issue_sync', 'glab')`
   - "Mirror to both" → `config_set('issue_sync', 'both')`
   - "Skip" → `config_set('issue_sync', 'off')` (explicit; reaffirms safe-default)
6. Headless mode (TMB_HEADLESS=1 or AUQ errors) → leave at 'off' silently.

## Step 4 — Verify and close

After writes, `config_list(agent='bro')` + `identity_get(agent='bro')` to confirm. Emit:

> Done. Settings updated:
> - Your name: `<final_human_name>`
> - Branching model: `<final_branching_model>`
> - PR target: `<final_pr_target>`
> - Protected branches: `<final_protected_branches>`
> - Remotes: `<name> → <provider>` (one per line; or "none" if empty)
>
> Tell me what you want to work on.

## Error Handling

| Trigger | Response |
|---|---|
| `config_list()` or `identity_get()` fails | Report the exact error, offer to retry or abort. Do NOT proceed with stale state. |
| `config_set` or `identity_set` fails | Report the exact error, retry the same call. Do NOT skip and continue. |
| Invalid answer (e.g. unparseable Other for branching) | Re-ask via a second `AskUserQuestion` round, omit the invalid answer. |

## Headless fallback

When `AskUserQuestion` errors OR `TMB_HEADLESS=1` is set, **do not silently overwrite policy keys with defaults** — re-onboard is by definition a Human-driven re-confirmation. Instead:

1. Halt the skill cleanly.
2. Call `audit_log` **immediately** — this write is the non-negotiable audit record:
   ```
   audit_log(agent='bro',
             kind='event',
             event_type='headless_reonboard_blocked',
             summary='tmb_reonboard cannot run headless: policy keys (branching_model, pr_target, protected_branches, remotes) require explicit Human re-confirmation.')
   ```
3. Surface a clear message: "Re-onboarding requires interactive input. Re-run with a Human in the loop, or use `config_set` directly if you know the values."

Rationale: re-onboarding flips policy keys that drive `git-guards.sh` and other hooks. A silent fallback here could break the project's git workflow with no audit trace pointing to the cause.
