# plugin_config Key Contract

## 1. Key Registry

| Key | Type | Allowed values | Default | Read by | Written by |
|-----|------|----------------|---------|---------|------------|
| `branching_model` | string | `github-flow` \| `gitflow` \| `custom` | (none — first-run prompt sets it) | git-guards.sh (Phase 4), gatekeeper routing (Phase 4) | gatekeeper onboarding (Phase 4) |
| `pr_target` | string | any valid branch name | derived from `branching_model` when first-run sets it | git-guards.sh PR rule (Phase 4) | gatekeeper onboarding (Phase 4) |
| `protected_branches` | string[] (JSON) | array of branch names | derived from `branching_model` | git-guards.sh commit rule (Phase 4) | gatekeeper onboarding (Phase 4) |

## 2. Default Derivation

| `branching_model` value | `pr_target` default | `protected_branches` default |
|-------------------------|---------------------|------------------------------|
| `github-flow` | `main` | `["main"]` |
| `gitflow` | `develop` | `["main", "develop"]` |
| `custom` | (caller required) | (caller required) |

`branching_model` sets sensible defaults for `pr_target` and `protected_branches` but does NOT override them once explicitly set.

## 3. Forward Compatibility

Additional keys can be added to `plugin_config` without schema migration; the table is generic. Any new key that consumers depend on MUST be reflected in this file before Phase 4 or later phases consume it.

## 4. Reading-the-Config Policy

Readers MUST treat a missing key as "uninitialized; trigger onboarding flow" — NOT as "default to a safe value". Silent defaults hide configuration drift and mask missing onboarding steps. This is a deliberate design choice.
