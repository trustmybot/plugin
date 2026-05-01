# plugin_config Key Contract

## 1. Key Registry

| Key | Type | Allowed values | Default | Read by | Written by |
|-----|------|----------------|---------|---------|------------|
| `branching_model` | string | `github-flow` \| `gitflow` \| `custom` | (none — first-run prompt sets it) | `git-guards.sh`, bro routing | bro onboarding |
| `pr_target` | string | any valid branch name | derived from `branching_model` when first-run sets it | `git-guards.sh` PR rule | bro onboarding |
| `protected_branches` | string[] (JSON) | array of branch names | derived from `branching_model` | `git-guards.sh` commit rule | bro onboarding |
| `remotes` | object[] (JSON) | array of `{name, provider, url}` — see `ENUMS.md` for `provider` values | `[]` | tmb_reonboard, tmb_push-gate (future) | bro onboarding (auto-detect or AUQ) |
| `issue_sync` | string | `auto` \| `gh` \| `glab` \| `both` \| `off` | `off` | `issue_create`, `issue_close`, `issue_sync_retry` | bro |

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

Readers MUST treat a missing key as "uninitialized; trigger onboarding flow" — NOT as "default to a safe value". Silent defaults hide configuration drift and mask missing onboarding steps. This is a deliberate design choice.

## 5. Committed team config (optional, issue #32)

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
