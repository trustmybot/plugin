# 17-audit-request

**Scenario under test:** the Human asks bro to audit the todo store's add → list round trip. Bro must load `tmb_audit` (GH 1262), test the invariant against live data before reading code, and record its findings as a discussion.

## Pre-state

`onboarding-named` fixture. `setup-l5.sh` commits `src/cli.py` (todo CLI, JSON store at `todos.json`) and a `todos.json` holding 12 items written by `add`. `list` prints only the first 10 (`_load()[:PAGE]`), so `python3 src/cli.py list` against the store shows two items lost — a violation the data exposes before the code explains it.

## Turns

| # | Speaker | Message |
|---|---|---|
| 1 | user | `@bro audit the todo store: double-check that every item written by "add" can be read back by "list".\n\nDon't ask questions.` |
| → | bro | `Skill` load of `tmb_audit`; runs `list` and counts the store (Bash) before reading `src/cli.py`; records the findings as a discussion. Single turn. |

## Pass criteria

| Scorer | Asserts |
|---|---|
| `outcome.sql` | a discussion naming `list` exists; one of them reports the drop (12 vs 10, "dropped", "truncated" or "missing") |
| `outcome-usage.json` | `tmb_audit` invoked (run log) |
| `outcome-coherence.json` | `discussions >= 1` |
| `outcome-git.json` | `base_branch_unchanged: true` — an audit commits nothing to `main` |
| `tools-required.json` | `Skill`, `Bash` |
| `tools-forbidden.json` | `Edit` (bro does not patch code during an audit), `AskUserQuestion` |
| `cost-budget.json` | Soft 200K / 600s |

## Gaps (proxies)

- **Data before code.** The scorers check which tools ran, not their order, so "a command run against data before any code read" is scored as `Bash` being called plus a finding that cites the measured drop. Confirm the order by reading `trajectory.jsonl`: the first `Bash` call against `todos.json` or `list` should precede the first `Read` of `src/cli.py`.
