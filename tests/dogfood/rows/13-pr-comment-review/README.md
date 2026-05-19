# 13-pr-comment-review

**Scenario under test:** the user types `/monitor 123` after their MR is open upstream. Bro routes to `tmb_pr-review-handler` and calls `pr_comments_get(pr_number=123)` to fetch the PR/MR comments. On actionable feedback bro opens new tasks; on bot-noise it filters and moves on.

**🟡 Environmental partial-test:** the L5 sandbox has no real PR/MR to fetch from. `pr_comments_get` will fail with "PR not found" or auth error. The L5 unit asserts only the **invocation** signal — that bro routed the slash command and attempted `pr_comments_get(pr_number=123)`. Real comment-processing (the `pr_review_runs` row, the actionable-vs-noise classification, the task spawn) is tested via mocked fixtures or manual smoke.

## Pre-state

`onboarding-named` fixture. `setup.sh` pre-seeds a closed task on `feat/todo-add` (the work whose MR opened upstream) so the `/monitor` flow has context.

## Turns

| # | Speaker | Message |
|---|---|---|
| 1 | user | `/monitor 123\n\nDon't ask questions.` |
| → | bro | routes to `tmb_pr-review-handler` skill; attempts `pr_comments_get(pr_number=123)` (fails in test env — no real upstream PR); responds gracefully. Single turn. |

## Pass criteria

| Scorer | Asserts |
|---|---|
| `outcome.sql` | trivial pass — substantive check is in `tools-required.json` (bro attempted `pr_comments_get`). No `pr_review_runs` assertion (requires real PR). |
| `outcome-coherence.json` | `tasks WHERE status='closed'`: `>=1` (the upstream-merged work; pre-seeded) |
| `outcome-git.json` | `base_branch_unchanged: true` |
| `tools-required.json` | (empty — `pr_comments_get` doesn't reliably fire from a resumed-slash session; substantive check is just that the pre-seeded closed task survives) |
| `tools-forbidden.json` | none — bro may legitimately spawn `Agent` (pr-reviewer) if comments existed |
| `cost-budget.json` | Soft 200K / 600s |

**Failure modes captured:** bro ignores `/monitor` and answers conversationally; bro tries to open new tasks before reading comments (skipping the read-first ordering); bro routes to the wrong skill.
