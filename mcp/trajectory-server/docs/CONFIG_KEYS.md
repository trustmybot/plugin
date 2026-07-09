# plugin_config Key Contract

## 1. Key Registry

The four repo-scoped policy fields (`target_branch`/`pr_target`, `branching_model`, `protected_branches`, `remotes`) live **only on the `repos` table** — the sole source of truth (#980). They are NOT stored in `plugin_config`: there is no global key and no global fallback. `/onboard` applies policy workspace-wide by writing the chosen values onto every `repos` row; `scan_run` keeps `repos.remotes` in sync with each repo's actual git remotes (#979). All readers resolve the values per repo from the `repos` row. See §5.

Only workspace-global keys live in `plugin_config`:

| Key | Type | Allowed values | Default | Read by | Written by |
|-----|------|----------------|---------|---------|------------|
| `issue_sync` | string | `auto` \| `gh` \| `glab` \| `both` \| `off` | `"off"` (schema-seeded; safe default — no remote sync without opt-in) | `issue_create`, `issue_close`, `issue_sync_retry` | bro; overridden by `TMB_DISABLE_REMOTE_SYNC=1` env var |
| `onboarded` | boolean (JSON) | `true` | unset until `/onboard` completes | `activation-routine.sh` (banner), `onboard.ts:onboard_state_get` | `onboard_apply` (writes `true` on first successful run); `db.ts:migrateV1toV2` (forward-migrates legacy `identity` marker) |
| `pr_review_bots` | string[] (JSON) | array of bot login patterns | unset (falls back to `DEFAULT_BOT_PATTERNS` in `pr_monitor.ts`) | `pr_monitor_comments_get` — merged with `DEFAULT_BOT_PATTERNS` for bot-comment filtering | bro via `config_set pr_review_bots '[\"bot-login\"]'` |
| `issue_classification_labels` | string[] (JSON) | array of classification label names | `["Bug","Feature","Improvement","Docs","Test","Chore"]` (schema-seeded generic default) | `issue_create` → `validateIssueLabels` (mandatory-tagging check) | project owner via `config_set issue_classification_labels '[...]'` |
| `issue_priority_labels` | string[] (JSON) | array of priority label names | `["Priority: Urgent","Priority: High","Priority: Medium","Priority: Low"]` (schema-seeded generic default) | `issue_create` → `validateIssueLabels` (mandatory-tagging check) | project owner via `config_set issue_priority_labels '[...]'` |

## 1a. Repo-scoped policy (on the `repos` table)

| Column | Type | Allowed values | Read by | Written by |
|--------|------|----------------|---------|------------|
| `repos.branching_model` | string | `github-flow` \| `gitflow` \| `custom` | `git-guards.sh`, bro routing | `onboard_apply` (every repos row) |
| `repos.target_branch` (`pr_target`) | string | any valid branch name | `git-guards.sh` PR rule, `git-push-guard.sh`, `branch-up-to-date-with-remote.sh`, `clean-merged-branch.sh`, `cleanup-worktree-on-task-close.sh`, `task_create_batch` (branch base) | `onboard_apply` (every repos row) |
| `repos.protected_branches` | string[] (JSON) | array of branch names | `git-guards.sh` commit rule, `clean-merged-branch.sh` | `onboard_apply` (every repos row) |
| `repos.remotes` | object[] (JSON) | array of `{name, provider, url}` (`provider` ∈ `github` \| `gitlab` \| `bitbucket` \| `codeberg` \| `azuredev` \| `other`) | issue-scoped sync, `substrate-preflight.sh`, `no-remote-auth-guard.sh`, `tmb_review` push-gate | `scan_run` (from git remotes, #979); `onboard_apply` (every repos row) |

Shell hooks resolve the current repo via `scripts/hooks/lib/resolve-repo.sh` (`tmb_repo_git_root` + `tmb_repo_resolve` / `tmb_repo_remotes`) and read the matching `repos` row.

## 2. Default Derivation

| `branching_model` value | `target_branch` default | `protected_branches` default |
|-------------------------|---------------------|------------------------------|
| `github-flow` | `main` | `["main"]` |
| `gitflow` | `dev` | `["main", "dev"]` |
| `custom` | (caller required) | (caller required) |

`branching_model` sets sensible defaults for `target_branch` and `protected_branches` but does NOT override them once explicitly set. `onboard_apply` derives and writes these onto the `repos` row(s).

## 3. Forward Compatibility

Additional keys can be added to `plugin_config` without schema migration; the table is generic. Any new key that consumers depend on MUST be reflected in this file before code starts reading it.

## 4. Reading-the-Config Policy

The schema-seeded global keys (`issue_sync`, `issue_classification_labels`, `issue_priority_labels`) are present in every properly-initialised DB via `INSERT OR IGNORE`. The label-taxonomy keys fall back to a generic default in code (`validateIssueLabels`) when unset or malformed, so a pre-seed or label-less project can still create issues. Dynamic keys (`onboarded`, `pr_review_bots`) may legitimately be absent until the triggering operation runs; readers must handle `NULL`/absent gracefully. The repo-scoped policy fields live on the `repos` row (§1a) — readers resolve them per repo and treat an unset `branching_model`/`target_branch`/`protected_branches` as "this repo is not onboarded — trigger `/onboard`", never a silent global default.

## 5. Multi-repo workspace support (repos-centric, #155)

**Purpose:** In a multi-repo workspace the trajectory DB lives at `<workspace>/.claude/<plugin>/trajectory.db` while each code git repo lives at `<workspace>/<inner>/`. Repo identity is carried by the `repos` table (one row per `/scan`-discovered repo), and every work-table row (issues, tasks, discussions, audit, agent_runs, validation_attempts) carries a `repo` column that is a real FK to `repos(name)`.

**Repo selection is per-row, not a single workspace-wide default:**

- `task_create_batch` accepts `repo=<name>` per task; when exactly one `repos` row exists it is the single-repo fallback. The value MUST match a `repos.name` row (the FK enforces it).
- `issue_create` accepts `repo=<name>`, defaulting to the sole repo when exactly one is registered. Issue-scoped sync resolves the repo's on-disk path + `repos.remotes` to target the explicit `gh --repo` / `glab -R` — never `process.cwd()` (#146).
- `issue_create` upserts the `milestones(name, repo)` row for an explicitly-passed milestone before inserting the issue, so the composite `issues.milestone` FK is satisfied; an existing row is reused (per-repo PK, no duplicate). When the milestone is omitted it defaults to the issue repo's sole OPEN milestone (zero or more than one open → null), and the default path never creates a milestone row. With a null repo the FK is not enforced and no row is created (#985/#154/#15).
- Per-repo policy (`target_branch`, `branching_model`, `protected_branches`, `remotes`) lives on the `repos` row; readers resolve it from there.
- `onboard_get_questions` and `onboard_apply` accept an optional `repo=<name>` param (`round='main'`, `shape='remote'`). When supplied, the branching + pr_target questions seed from that repos row's `branching_model`/`target_branch`, and `onboard_apply` writes `target_branch` + `branching_model` + derived `protected_branches` to **only that repos row** — other repos rows, `remotes`, `issue_sync`, and the global `onboarded` marker are untouched. Omitting `repo` preserves the workspace-wide apply (every repos row + the global `onboarded`/`issue_sync` markers). An unknown repo name is a validation error with no partial write.

**Default:** single-repo CC — exactly one `repos` row, adopted implicitly; no `repo=` needed.

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
