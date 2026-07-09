# 03-multirepo-onboard-scan

**Scenario under test:** a multi-repo workspace where two sibling repos carry **distinct** git remotes — `repo-a` on GitHub, `repo-b` on GitLab. The user onboards and asks bro to scan. This is the acceptance test for the live merged behavior of:

- **#979** — `scan_run` captures each repo's git remotes into `repos.remotes` (per-repo, not a single workspace-wide list).
- **#980** — the four repo-scoped keys (`remotes`, `pr_target`, `branching_model`, `protected_branches`) are gone from `plugin_config`; the `repos` table is the sole source of truth.

## Pre-state

`onboarding-named` fixture (clean schema v27 — `plugin_config` already holds none of the four repo-scoped keys). `setup-l5.sh` then:

- `git init`s `repo-a` and `repo-b` under the session dir, each with one commit and a distinct origin remote (`git@github.com:acme/repo-a.git` / `git@gitlab.com:acme/repo-b.git`). `git remote add` / `get-url` are pure local config, so the stubbed `git-remote-http(s)` transport helpers never fire and no network is touched.
- Seeds the two `repos` rows with workspace-wide policy (`target_branch` + `branching_model` + `protected_branches`) and a NULL `remotes` column. The policy seed stands in for the post-AUQ `onboard_apply`, which the harness suppresses (no AskUserQuestion in test mode). `scan_run` upserts these rows by `name` and fills `remotes` **without** touching the policy columns, so the distinct per-repo remotes land while the seeded policy survives.

## Turns

| # | Speaker | Message |
|---|---|---|
| 1 | user | `/onboard` + "scan the workspace" + `Don't ask questions.` |
| → | bro | Reads onboard state, then calls `scan_run`. Scan discovers `repo-a`/`repo-b` (plus the harness's root repo, which has no remote), reads each repo's git remotes, classifies the provider, and writes them to `repos.remotes`. |

## Pass criteria

| Scorer | Asserts |
|---|---|
| `outcome.sql` | (a) `repo-a.remotes[0]` provider=`github` non-blank url; `repo-b.remotes[0]` provider=`gitlab` non-blank url; the two URLs DISTINCT. (b) `plugin_config` holds none of the four repo-scoped keys. (c) `repo-a`+`repo-b` carry non-null `target_branch`+`branching_model`+`protected_branches`. |
| `outcome-coherence.json` | `repos >= 2`; `tasks = 0`; no work issues; zero repo-scoped keys in `plugin_config`. |
| `outcome-git.json` | `base_branch_unchanged: true` |
| `tools-required.json` | `scan_run` (bro refreshed the world model). |
| `tools-forbidden.json` | `task_create_batch`, `task_provision`, `issue_create`, `Agent`. |
| `cost-budget.json` | Soft 150K / 600s. |

**Failure modes captured:** scan writes a single shared remote list across both repos (would collapse the distinct URLs); a regression reintroduces any of the four keys into `plugin_config`; scan clobbers the per-repo policy columns.

## Future extension (#992 — out of scope here)

This row exercises onboard applied **workspace-wide**, so it asserts distinct per-repo **remotes** (from scan) but NOT distinct per-repo `branching_model` / `pr_target`. Per-repo distinct *policy* requires the #992 onboard skill loop (a per-repo `onboard_get_questions` / `onboard_apply` pass with the optional `repo` argument). When #992 lands, extend this row (or add a sibling) to seed two repos with different chosen branching models and assert each `repos` row keeps its own `target_branch` / `branching_model`.
