---
description: Configure or change branching model, PR target, protected branches, identity name, git remotes, and issue-sync target — interactive AskUserQuestion ceremony with current values pre-selected.
argument-hint: (none)
---

# Onboard / Re-onboard

Read current state, show it to the user via radio AUQs with `Keep "<current>"`
as the pre-selected first option, write changes via MCP. The plugin has no
first-run onboarding ceremony — bro applies defaults silently on first
activation. This command is the only path to override them.

## Scope

Allowed:
- `AskUserQuestion` (collect answers)
- `Bash` (read-only `git remote -v`, `gh auth status`, `glab auth status`)
- `config_list`, `config_set` (keys `branching_model`, `pr_target`,
  `protected_branches`, `remotes`, `issue_sync` only)
- `identity_get`, `identity_set`, `identity_reset`

Out of scope: `issue_create`, `task_create_batch`, `task_update_status`,
`validation_record`, anything else.

## Step 1 — Read current state

```
config_list(agent='bro')
identity_get(agent='bro')
```

Extract (use "(unset)" display for `null`):
- `current_human_name` — from `identity_get().human_name`
- `current_branching_model`, `current_pr_target`,
  `current_protected_branches`, `current_remotes` — from `config_list()`.

## Step 1.5 — Auto-detect git remotes

```bash
git remote -v
```

`git remote -v` outputs two lines per remote (fetch + push). De-duplicate
by remote name. For each unique remote, extract the URL from the fetch
line and apply this URL-pattern → provider mapping:

| URL pattern | provider |
|---|---|
| contains `github.com` | `github` |
| contains `gitlab.com` or matches `gitlab.<corp>.<tld>` | `gitlab` |
| contains `bitbucket.org` | `bitbucket` |
| contains `codeberg.org` | `codeberg` |
| contains `dev.azure.com` | `azuredev` |
| anything else | `other` |

Build `detected_remotes` — array of `{ name, provider, url }` objects, one
per unique remote name.

- If `detected_remotes` is non-empty AND every detection is unambiguous
  (no provider is `other`): `config_set(agent='bro', key='remotes',
  value=detected_remotes)` and skip the Remotes AUQ tab in Step 2.
- Otherwise fall through to Step 2 — the Remotes tab fires.

## Step 2 — Collect new values via AskUserQuestion

One batched call. First option on each question is `Keep "<current>"`
(pre-selected default):

```
AskUserQuestion({
  questions: [
    {
      question: "What should I call you?",
      header: "Your name",
      multiSelect: false,
      options: [
        { label: `Keep "${current_human_name}"`, description: "No change." },  // drop if current_human_name is null
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
        // AskUserQuestion auto-renders Other for self-hosted / Codeberg / Gitea / etc.
      ]
    }
  ]
})
```

Dedupe: if `current_<field>` already matches a static option (e.g.
`current_pr_target == "main"`), collapse the `Keep "main"` entry with
the `main` option.

Re-onboard hint for the Remotes tab: read `current_remotes` from
`config_list()`. For each Remotes option whose provider matches a
`current_remotes` entry, append `" (in current config)"` to that
option's description. Mapping: `GitHub` → `github`, `GitLab` →
`gitlab`, `Bitbucket` → `bitbucket`.

## Step 3 — Persist via MCP

For each answer:

- Starts with `Keep "`: no write for that field.
- Name = "Anonymous": `identity_reset(agent='bro')`.
- Name = other: `identity_set(agent='bro', human_name=<name>)`.
- Branching changed: `config_set(agent='bro', key='branching_model',
  value=<canonical>)`.
- PR target changed: `config_set(agent='bro', key='pr_target',
  value=<value>)` AND recompute `protected_branches`:

  | branching | protected_branches |
  |---|---|
  | `github-flow` | `[<pr_target>]` |
  | `gitflow` | `["main", <pr_target>]` deduped |
  | `custom` | second AskUserQuestion round, `multiSelect=true` |

  Then `config_set(agent='bro', key='protected_branches', value=<new list>)`.

### Remotes answer

- If Step 1.5 already wrote `remotes`, this block is a no-op.
- **Conflict check**: if the user selected `None / not pushed yet` AND
  any of `GitHub`, `GitLab`, `Bitbucket`, or `Other`, surface the
  conflict and re-ask. Re-render the same AUQ tab; loop until coherent.
- **Map selections to canonical providers**: `GitHub` → `github`,
  `GitLab` → `gitlab`, `Bitbucket` → `bitbucket`,
  `None / not pushed yet` → empty array (stop processing),
  `Other` (free-text) → lowercase + alphanumeric-only normalize; treat
  as `other` if not in the canonical enum (`github`, `gitlab`,
  `bitbucket`, `codeberg`, `gitea`, `forgejo`, `azuredev`).
- **Build the new `remotes` array**: for each selected provider (in
  selection order), emit `{ name, provider, url }`. The `name` defaults
  to `"origin"` for the first selection, `<provider>` for additional.
  The `url` is empty string until first push.
- **Persist**: `config_set(agent='bro', key='remotes', value=<new array>)`.

## Step 3.5 — Issue-sync opt-in (when a remote is available)

1. Run `gh auth status` and `glab auth status`, capture exit codes.
2. If neither is authenticated: skip this phase silently.
3. Compose options:
   - GitHub authenticated → "Mirror to GitHub"
   - GitLab authenticated → "Mirror to GitLab"
   - Both authenticated → "Mirror to both"
   - Always: "Skip — keep local-only"
4. Emit one AskUserQuestion (header "Issue sync", text "Mirror new MCP
   issues to your remote? Detected: <gh|glab|both>.") with the available
   backends + "Skip".
5. On answer: `config_set('issue_sync', 'gh' | 'glab' | 'both' | 'off')`.

## Step 4 — Verify and close

```
config_list(agent='bro')
identity_get(agent='bro')
```

Emit:

> Done. Settings updated:
> - Your name: `<final_human_name>`
> - Branching model: `<final_branching_model>`
> - PR target: `<final_pr_target>`
> - Protected branches: `<final_protected_branches>`
> - Remotes: `<name> → <provider>` (one per line; or "none" if empty)
>
> Tell me what you want to work on.

## Error handling

| Trigger | Response |
|---|---|
| `config_list()` or `identity_get()` fails | Report the exact error, offer to retry or abort. Do not proceed with stale state. |
| `config_set` or `identity_set` fails | Report the exact error, retry the same call. Do not skip and continue. |
| Invalid answer (e.g. unparseable Other for branching) | Re-ask via a second AskUserQuestion round, omit the invalid answer. |

## Headless mode — HALT, do not auto-apply

`/onboard` is interactive by definition. When `TMB_HEADLESS=1` or
AskUserQuestion errors, halt cleanly:

```
audit_log(agent='bro', kind='event',
          event_type='headless_reonboard_blocked',
          summary='Cannot run /onboard headless: policy keys require explicit Human re-confirmation.')
```

Surface: "Re-onboarding requires interactive input. Re-run with a Human
in the loop, or use `config_set` directly if you know the values."

Rationale: onboarding flips policy keys that drive `git-guards.sh` and
other hooks. A silent fallback could break the project's git workflow
with no audit trace.
