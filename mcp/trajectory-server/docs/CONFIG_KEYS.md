# plugin_config Key Contract

## 1. Key Registry

The repo-shaped policy keys (`branching_model`, `pr_target`, `protected_branches`, `remotes`) are **per-repo** state, drained into the `repos` table as of the repos-centric schema (#155). `/onboard` still writes the global `plugin_config` rows (back-compat) AND mirrors them onto the `repos` row(s); the **authoritative readers read the repos row**, never the global key. See §7.

| Key | Type | Allowed values | Default | Read by | Written by |
|-----|------|----------------|---------|---------|------------|
| `branching_model` | string | `github-flow` \| `gitflow` \| `custom` | `"github-flow"` (schema-seeded at DB init) | `git-guards.sh`, bro routing (authoritative source: `repos.branching_model`) | `/onboard` (mirrors to `repos`) |
| `pr_target` | string | any valid branch name | `"main"` (schema-seeded at DB init) | `git-guards.sh` PR rule (authoritative source: `repos.target_branch`; `task_create_batch` reads `repos.target_branch`, not this key) | `/onboard` (mirrors to `repos`) |
| `protected_branches` | string[] (JSON) | array of branch names | `["main"]` (schema-seeded at DB init) | `git-guards.sh` commit rule (authoritative source: `repos.protected_branches`) | `/onboard` (mirrors to `repos`) |
| `remotes` | object[] (JSON) | array of `{name, provider, url}` (`provider` ∈ `github` \| `gitlab` \| `bitbucket` \| `codeberg` \| `azuredev` \| `other`) | `[]` (schema-seeded at DB init) | `/onboard`, `tmb_review` push-gate section (issue-scoped sync reads `repos.remotes`, not this key) | bro onboarding (auto-detect or AUQ; mirrors to `repos.remotes`) |
| `issue_sync` | string | `auto` \| `gh` \| `glab` \| `both` \| `off` | `"off"` (schema-seeded; safe default — no remote sync without opt-in) | `issue_create`, `issue_close`, `issue_sync_retry` | bro; overridden by `TMB_DISABLE_REMOTE_SYNC=1` env var |
| `onboarded` | boolean (JSON) | `true` | unset until `/onboard` completes | `activation-routine.sh` (banner), `onboard.ts:onboard_state_get` | `onboard_apply` (writes `true` on first successful run); `db.ts:migrateV1toV2` (forward-migrates legacy `identity` marker) |
| `pr_review_bots` | string[] (JSON) | array of bot login patterns | unset (falls back to `DEFAULT_BOT_PATTERNS` in `pr_comments.ts`) | `pr_comments_get` — merged with `DEFAULT_BOT_PATTERNS` for bot-comment filtering | bro via `config_set pr_review_bots '[\"bot-login\"]'` |
| `issue_classification_labels` | string[] (JSON) | array of classification label names | `["Bug","Feature","Improvement","Docs","Test","Chore"]` (schema-seeded generic default) | `issue_create` → `validateIssueLabels` (mandatory-tagging check) | project owner via `config_set issue_classification_labels '[...]'` |
| `issue_priority_labels` | string[] (JSON) | array of priority label names | `["Priority: Urgent","Priority: High","Priority: Medium","Priority: Low"]` (schema-seeded generic default) | `issue_create` → `validateIssueLabels` (mandatory-tagging check) | project owner via `config_set issue_priority_labels '[...]'` |

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

The schema-seeded keys (`branching_model`, `pr_target`, `protected_branches`, `remotes`, `issue_sync`, `issue_classification_labels`, `issue_priority_labels`) are present in every properly-initialised DB via `INSERT OR IGNORE`. Readers of the policy keys MUST treat a missing seeded key as "DB corruption or pre-seed install — trigger `/onboard`" — NOT as "silently default". Silent defaults hide configuration drift. The label-taxonomy keys are the deliberate exception: `validateIssueLabels` falls back to the generic default in code when the key is unset or malformed, so a pre-seed or label-less project can still create issues. Dynamic keys (`onboarded`, `pr_review_bots`) may legitimately be absent until the triggering operation runs; readers of such keys must handle `NULL`/absent gracefully.

## 5. Multi-repo workspace support (repos-centric, #155)

**Purpose:** In a multi-repo workspace the trajectory DB lives at `<workspace>/.claude/<plugin>/trajectory.db` while each code git repo lives at `<workspace>/<inner>/`. Repo identity is carried by the `repos` table (one row per `/scan`-discovered repo), and every work-table row (issues, tasks, discussions, audit, agent_runs, validation_attempts) carries a `repo` column that is a real FK to `repos(name)`.

**Replaces `tmb_default_repo`.** The old global `tmb_default_repo` config key is removed — repo selection is now per-row, not a single workspace-wide default:

- `task_create_batch` accepts `repo=<name>` per task; when exactly one `repos` row exists it is the single-repo fallback. The value MUST match a `repos.name` row (the FK enforces it).
- `issue_create` accepts `repo=<name>`, defaulting to the sole repo when exactly one is registered. Issue-scoped sync resolves the repo's on-disk path + `repos.remotes` to target the explicit `gh --repo` / `glab -R` — never `process.cwd()` (#146).
- Per-repo policy (`target_branch`, `branching_model`, `protected_branches`, `remotes`) lives on the `repos` row; readers resolve it from there.

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
