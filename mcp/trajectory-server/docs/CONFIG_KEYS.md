# plugin_config Key Contract

## 1. Key Registry

| Key | Type | Allowed values | Default | Read by | Written by |
|-----|------|----------------|---------|---------|------------|
| `branching_model` | string | `github-flow` \| `gitflow` \| `custom` | `"github-flow"` (schema-seeded at DB init) | `git-guards.sh`, bro routing | `/onboard` |
| `pr_target` | string | any valid branch name | `"main"` (schema-seeded at DB init) | `git-guards.sh` PR rule | `/onboard` |
| `protected_branches` | string[] (JSON) | array of branch names | `["main"]` (schema-seeded at DB init) | `git-guards.sh` commit rule | `/onboard` |
| `remotes` | object[] (JSON) | array of `{name, provider, url}` (`provider` ∈ `github` \| `gitlab` \| `bitbucket` \| `codeberg` \| `azuredev` \| `other`) | `[]` (schema-seeded at DB init) | `/onboard`, `tmb_review` push-gate section | bro onboarding (auto-detect or AUQ) |
| `issue_sync` | string | `auto` \| `gh` \| `glab` \| `both` \| `off` | `"off"` (schema-seeded; safe default — no remote sync without opt-in) | `issue_create`, `issue_close`, `issue_sync_retry` | bro; overridden by `TMB_DISABLE_REMOTE_SYNC=1` env var |
| `tmb_default_repo` | string | any relative path (no `..`, no leading `/`) — e.g. `"plugin"`, `"repos/backend"` | unset | `task_create_batch` (MCP), `require-feature-branch-active.sh`, `cleanup-worktree-on-task-close.sh` | bro via `config_set tmb_default_repo <inner>` |

## 2. Default Derivation

| `branching_model` value | `pr_target` default | `protected_branches` default |
|-------------------------|---------------------|------------------------------|
| `github-flow` | `main` | `["main"]` |
| `gitflow` | `develop` | `["main", "develop"]` |
| `custom` | (caller required) | (caller required) |

`branching_model` sets sensible defaults for `pr_target` and `protected_branches` but does NOT override them once explicitly set.

## 3. Forward Compatibility

Additional keys can be added to `plugin_config` without schema migration; the table is generic. Any new key that consumers depend on MUST be reflected in this file before code starts reading it.

## 4. Reading-the-Config Policy

All 5 keys above are seeded at DB creation via `INSERT OR IGNORE`, so they are always present in a properly-initialised DB. Readers MUST treat a missing key as "DB corruption or pre-seed install — trigger `/onboard`" — NOT as "silently default". Silent defaults hide configuration drift. Any key added after DB init may legitimately be absent until the triggering operation runs; readers of such dynamic keys must handle `NULL`/absent gracefully.

## 5. `tmb_default_repo` — Multi-repo workspace support

**Purpose:** In a multi-repo workspace the trajectory DB lives at `<workspace>/.claude/<plugin>/trajectory.db` but the code git repo lives at `<workspace>/<inner>/`. Hooks and `task_create_batch` must know the relative path to the inner repo to run git commands correctly. Setting this key once covers all future tasks without needing to pass `repo=` on every `task_create_batch` call.

**Example:**

```bash
config_set tmb_default_repo plugin   # for a workspace where the code repo is at <ws>/plugin/
```

**Default:** unset (single-repo CC behavior — no repo field, no git routing by hooks).

**When set:**
- `task_create_batch` reads this value and uses it as `repo` for any task where `task.repo` is omitted or empty. Explicit `task.repo` wins — this is the fallback only.
- `require-feature-branch-active.sh` reads this when `tasks.repo IS NULL` to resolve which git repo to check the active branch in.
- `cleanup-worktree-on-task-close.sh` reads this when `tasks.repo IS NULL` to compute the inner repo root for `git worktree` commands.

**Belt-and-suspenders:** setting this key means bro no longer needs to remember to pass `repo=` in `task_create_batch`; both the MCP layer and the hooks use the same single source of truth.

## 6. Committed team config (optional, issue #32)

A project may commit `.claude/tmb/config.json` to share defaults across developers:

```json
{
  "branching_model": "github-flow",
  "pr_target": "main",
  "protected_branches": ["main"]
}
```

Onboarding reads this file (if present) and **pre-selects matching radio options** in `AskUserQuestion`, so each new dev confirms with a single click instead of answering from scratch. The Human can still override locally; their per-developer DB stores their actual answer. The committed file is NOT auto-rewritten — it changes only when a developer edits it deliberately.

The file lives in version control alongside the code; the per-developer trajectory DB at `.claude/tmb/trajectory.db` remains gitignored. Identity (`human_name`) is per-developer and NEVER read from the committed file.

See `templates/project-seed/.claude/tmb/config.example.json` for a starter template.
