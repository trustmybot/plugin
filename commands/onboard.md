---
description: Configure or change identity, branching model, PR target, remotes, and issue-sync. Two-branch flow — local-only projects skip remote-only questions. Pre-fills defaults from a silent git/CLI probe.
argument-hint: (none)
---

# Onboard / Re-onboard

Two-round AskUserQuestion ceremony. **Round 1** asks the project shape (local-only vs remote-tracked) so bro can drop irrelevant questions. **Round 2** asks the per-shape question set with current values pre-selected.

## Auto-fire

Bro runs this command on its own when the trajectory DB has no `identity` row (fresh project init). The trigger is silent — bro doesn't ask permission, it goes straight to Round 1. The DB-empty heuristic: `identity_get(agent='bro')` returns `human_name=null`.

`/onboard` re-runs on demand for any later changes. In re-onboard mode the existing values pre-select as `Keep "<current>"`.

## Scope

Allowed:
- `AskUserQuestion` (collect answers)
- `Bash` (read-only `git remote -v`, `git rev-parse`, `command -v gh/glab`, `gh auth status`, `glab auth status`)
- `config_list`, `config_set` (keys: `branching_model`, `pr_target`, `protected_branches`, `remotes`, `issue_sync` only)
- `identity_get`, `identity_set`, `identity_reset`

Out of scope: `issue_create`, `task_create_batch`, `task_update_status`, `validation_record`, anything else.

## Step 0 — Silent context probe (no AUQ)

Run these read-only commands. They never block the flow; their results pre-fill AUQ defaults.

```bash
git rev-parse --show-toplevel 2>/dev/null   # in_git_repo?
git remote -v 2>/dev/null                    # detected remotes
command -v gh                                # gh installed?
command -v glab                              # glab installed?
gh auth status 2>/dev/null                   # gh authenticated?
glab auth status 2>/dev/null                 # glab authenticated?
```

Build a probe object:

```
{
  in_git: bool,
  detected_remotes: [{name, provider, url}],   // see provider mapping below
  gh_installed: bool, gh_authed: bool,
  glab_installed: bool, glab_authed: bool,
  origin_kind: 'github' | 'gitlab' | 'bitbucket' | 'codeberg' | 'azuredev' | 'other' | null
}
```

URL → provider mapping (`git remote -v` lines):

| URL pattern | provider |
|---|---|
| `github.com` | `github` |
| `gitlab.com` or `gitlab.<corp>.<tld>` | `gitlab` |
| `bitbucket.org` | `bitbucket` |
| `codeberg.org` | `codeberg` |
| `dev.azure.com` | `azuredev` |
| anything else | `other` |

`origin_kind` = the provider of the remote named `origin`, or `null` if no `origin`.

## Step 1 — Read current state

```
config_list(agent='bro')
identity_get(agent='bro')
```

Extract (use `(unset)` display for `null`):
- `current_human_name` — from `identity_get().human_name`
- `current_branching_model`, `current_pr_target`, `current_protected_branches`, `current_remotes`, `current_issue_sync` — from `config_list()`.

If every key matches its schema default AND `current_human_name` is null → this is a **first-run onboard** (no Keep options). Otherwise it's a **re-onboard** (Keep options pre-select).

## Round 1 — Project shape (single AUQ)

```
AskUserQuestion({
  questions: [{
    question: "Is this project local-only or remote-tracked?",
    header: "Shape",
    multiSelect: false,
    options: [
      { label: "Local-only", description: "No GitHub/GitLab. Issues stay in the local trajectory DB; no PR/MR pushes." },
      { label: "Remote-tracked", description: "Pushes to GitHub or GitLab. We'll ask about issue mirroring next." }
    ]
  }]
})
```

**Pre-select rule:** if `probe.origin_kind` is `github` or `gitlab` → preselect `Remote-tracked`. Otherwise preselect `Local-only`.

Store the answer as `shape` ∈ `{local, remote}`. Branch the rest of the flow on it.

## Round 2 — Per-shape questions

### LOCAL branch

Local-only projects have no remote, no PR/MR, no team workflow to align with. The minimum is the Human's name; on re-onboard the Branching question is added so they can change models without first switching to remote-tracked.

**First-run (1 question — Name only):**

```
AskUserQuestion({
  questions: [
    {
      question: "What should I call you?",
      header: "Your name",
      multiSelect: false,
      options: [
        { label: "Anonymous", description: "No name stored. Free-floating sessions." }
        // AUQ auto-renders "Other" — that's the typed-name path.
      ]
    }
  ]
})
```

**Re-onboard (2 questions — Name + Branching, both with `Keep` pre-selected):**

```
AskUserQuestion({
  questions: [
    {
      question: "What should I call you?",
      header: "Your name",
      multiSelect: false,
      options: [
        { label: `Keep "${current_human_name}"`, description: "No change." },
        { label: "Anonymous", description: "No name stored. Free-floating sessions." }
      ]
    },
    {
      question: "How does your team branch?",
      header: "Branching",
      multiSelect: false,
      options: [
        { label: `Keep "${current_branching_model}"`, description: "No change." },
        { label: "Trunk + feature branches (GitHub Flow)", description: "Single main, feature branches per task." },
        { label: "Trunk + develop + releases (Git Flow)", description: "Long-lived develop + releases to main." }
      ]
    }
  ]
})
```

**No PR-target/remotes/issue_sync AUQ on the local branch.** On submit:
- `branching_model` — first-run defaults to `github-flow` silently (single main + feature branches per task — the right shape for 90% of local repos). On re-onboard takes the user's answer.
- `pr_target` is derived from `branching_model`: `github-flow` → `main`, `gitflow` → `develop`.
- `remotes` is set to `[]` (empty array).
- `issue_sync` is set to `off`.

### REMOTE branch (4 questions, batched)

```
AskUserQuestion({
  questions: [
    {
      question: "What should I call you?",
      header: "Your name",
      multiSelect: false,
      options: [
        { label: `Keep "${current_human_name}"`, description: "No change." },  // re-onboard only
        { label: "Anonymous", description: "No name stored. Free-floating sessions." }
        // AUQ auto-renders "Other" for typed name.
      ]
    },
    {
      question: "How does your team branch?",
      header: "Branching",
      multiSelect: false,
      options: [
        { label: `Keep "${current_branching_model}"`, description: "No change." },  // re-onboard only
        { label: "Trunk + feature branches (GitHub Flow)", description: "Single main, feature branches, PRs back." },
        { label: "Trunk + develop + releases (Git Flow)", description: "Long-lived develop + releases to main." }
      ]
    },
    {
      question: "What's your PR target branch?",
      header: "PR target",
      multiSelect: false,
      options: [
        { label: `Keep "${current_pr_target}"`, description: "No change." },  // re-onboard only
        { label: "main", description: "Most common default." },
        { label: "develop", description: "Common for Git Flow." },
        { label: "master", description: "Older repos." }
        // AUQ Other for any alternative
      ]
    },
    {
      question: "Which remote does this project use?",
      header: "Remote",
      multiSelect: false,
      options: [
        // pre-select via probe.origin_kind
        { label: "GitHub", description: "github.com or GitHub Enterprise." },
        { label: "GitLab", description: "gitlab.com or self-hosted GitLab." },
        { label: "Both", description: "Mirrored or dual-host." }
      ]
    }
  ]
})
```

**Pre-select rules:**
- `Branching`: pre-select based on `probe.origin_kind` heuristic if first-run (default `github-flow`); otherwise `Keep`.
- `PR target`: if `branching_model` answered as `github-flow` → preselect `main`; `gitflow` → preselect `develop`. On re-onboard, `Keep` wins.
- `Remote`: pre-select `GitHub` if `probe.origin_kind=github`, `GitLab` if `gitlab`. Disable an option if its CLI isn't installed (label suffix `" (CLI not installed)"`).

Then a **second remote-branch round** for issue_sync:

```
AskUserQuestion({
  questions: [{
    question: "Mirror new MCP issues to your remote?",
    header: "Issue sync",
    multiSelect: false,
    options: [
      { label: `Keep "${current_issue_sync}"`, description: "No change." },  // re-onboard only
      { label: "Auto — sync to the remote you picked", description: "issue_create writes to GitHub/GitLab as well as the local DB." },
      { label: "Off — local DB only", description: "Issues stay in the trajectory DB; no remote mirror." }
    ]
  }]
})
```

If the chosen remote's CLI is **not authenticated** (probe), surface a one-line warning before persisting: `Heads up: \`gh auth status\` failed — issue_sync='auto' will retry until you authenticate.`

## Step 3 — Persist via MCP

For each answer:

- Starts with `Keep "`: no write for that field.
- Name = `Anonymous`: `identity_reset(agent='bro')`.
- Name = typed (Other path): `identity_set(agent='bro', human_name=<name>)`.
- Branching changed: `config_set(agent='bro', key='branching_model', value=<canonical>)`.
- PR target changed: `config_set(agent='bro', key='pr_target', value=<value>)` AND recompute `protected_branches`:

  | branching | protected_branches |
  |---|---|
  | `github-flow` | `[<pr_target>]` |
  | `gitflow` | `["main", <pr_target>]` (deduped) |
  | `custom` | second AUQ round, `multiSelect=true` |

  Then `config_set(agent='bro', key='protected_branches', value=<new list>)`.

### Remote-branch persistence

- Map answer → providers: `GitHub` → `[{name:'origin', provider:'github', url:<from probe or "">}]`; `GitLab` → `[{name:'origin', provider:'gitlab', ...}]`; `Both` → both entries.
- Reuse `probe.detected_remotes` URLs when the provider matches; empty `url` if not yet pushed.
- `config_set(agent='bro', key='remotes', value=<array>)`.
- `config_set(agent='bro', key='issue_sync', value='auto'|'off')`.

### Local-branch persistence

- `config_set(agent='bro', key='remotes', value=[])`.
- `config_set(agent='bro', key='issue_sync', value='off')`.
- `config_set(agent='bro', key='pr_target', value=<derived>)` if not already set.

## Step 4 — Verify and close

```
config_list(agent='bro')
identity_get(agent='bro')
```

Emit:

> Done. Settings updated:
> - Your name: `<final_human_name>`
> - Project shape: `<local|remote>`
> - Branching model: `<final_branching_model>`
> - PR target: `<final_pr_target>`
> - Protected branches: `<final_protected_branches>`
> - Remotes: `<name> → <provider>` (one per line; or `none — local-only` if empty)
> - Issue sync: `<final_issue_sync>`
>
> Tell me what you want to work on.

## Error handling

| Trigger | Response |
|---|---|
| `config_list()` or `identity_get()` fails | Report the exact error, offer retry or abort. Do not proceed with stale state. |
| `config_set` or `identity_set` fails | Report the exact error, retry the same call. Do not skip. |
| Invalid answer (e.g. unparseable Other for branching) | Re-ask via a second AUQ round, omit the invalid answer. |
| Conflict (e.g. user picks Local-only but probe shows GitHub origin) | Surface the contradiction, re-ask Round 1 once. Trust the user's second answer. |

## Headless mode — HALT, do not auto-apply

`/onboard` is interactive by definition. When `TMB_HEADLESS=1` or `AskUserQuestion` errors, halt cleanly:

```
audit_log(agent='bro', issue_id='999999', kind='event',
          event_type='headless_reonboard_blocked',
          summary='Cannot run /onboard headless: policy keys require explicit Human re-confirmation. Tell the Human to run /onboard interactively.')
discussion_append(agent='bro', issue_id='999999', kind='note',
          body='Headless reonboard blocked. The Human must type /onboard interactively to apply policy changes.')
```

Surface: `Re-onboarding requires interactive input. Re-run with a Human in the loop, or use \`config_set\` directly if you know the values.`

Rationale: onboarding flips policy keys that drive `git-guards.sh` and other hooks. A silent fallback could break the project's git workflow with no audit trace.
