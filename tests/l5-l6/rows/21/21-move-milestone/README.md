# 21-move-milestone

**Scenario under test (GH 1351, GH 1209):** an existing issue needs re-triage. The Human asks bro to move the count-subcommand issue to the next milestone and mark it low priority. Bro must find the issue, call `issue_update` with the new milestone and a label set carrying `Priority: Low`, and must not open a new issue or start any code work.

## Pre-state

`onboarding-named` fixture. `setup-l5.sh` seeds:
- a `repos` row for the scratch project (name = its directory name)
- open milestones `v0.1.0`, `v0.2.0`, `v0.3.0` on that repo
- `issues(objective='Add count subcommand to todo CLI', milestone='v0.1.0', labels=["Feature","Priority: Medium"])`

"The next milestone" after `v0.1.0` is `v0.2.0`.

## Turns

| # | Speaker | Message |
|---|---|---|
| 1 | user | `@bro move the count-subcommand issue to the next milestone and mark it low priority.\n\nDon't ask questions.` |
| → | bro | Looks up the issue, calls `issue_update(milestone='v0.2.0', labels=[…, 'Priority: Low'])` (one call or two). Sync is off, so the change is local only. Single turn. |

## Pass criteria

| Scorer | Asserts |
|---|---|
| `outcome.sql` | exactly one count-subcommand issue; it sits on `v0.2.0`; its labels hold `Priority: Low` and not `Priority: Medium`; `issue_updated` audit rows record a `milestone` change and a `labels` change |
| `outcome-coherence.json` | non-system issues `=1`; the issue on `v0.2.0` `=1`; `issue_updated` audit rows `>=1` |
| `outcome-git.json` | `base_branch_unchanged: true` |
| `tools-required.json` | `issue_update` |
| `tools-forbidden.json` | `issue_create`, `task_create_batch`, `task_provision`, `Agent` |
| `cost-budget.json` | Soft 150K / 600s |

## Gaps

- Issue sync is off in the fixture, so the remote mirror of the move (GH milestone and label) is not exercised; the row scores the local row and the `issue_updated` audit only.
