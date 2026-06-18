# 08-architectural-change

**Scenario under test:** the Human asks bro to refactor the CLI's existing JSON storage into a backend interface so future implementations (SQLite, in-memory test double, etc.) can be plugged in without touching the command handlers. This is a textbook architectural decision — interface shape, factory wiring, and back-compat for existing `~/.todo-cli/todos.json` files all need to be settled before code lands. Per `tmb_planning` doctrine (§"Architectural changes") bro must write a `kind='decision'` discussion (universal decision gate) before dispatching SWE.

The old simple/difficult triage was retired; the only structural requirement now is the universal `kind='decision'` row required by the server-side **decision gate** on `task_create_batch`. That discussion row *is* the architectural record — no separate ADR file.

The prior prompt for this row ("switch to Clerk for auth") was retired because it conflicted with the test project's actual surface (a 12-line stdlib CLI with no users, no network, no existing auth) and consistently triggered `tmb_concerns-protocol` Path A instead of the architectural-change path — bro correctly refused to bolt a hosted SaaS onto an offline CLI. The current prompt sits on real existing storage code, so the architectural decision is feasible and bro reaches `decision → spec → SWE` deterministically.

## Pre-state

Cumulative chain state from rows 1–7: the CLI in `src/cli.py` is a stdlib-only todo CLI with `add/list/done/remove` subcommands persisting to `~/.todo-cli/todos.json` via atomic-write (tmpfile + `os.replace`). No abstraction layer yet — storage calls are inlined into each handler.

## Turns

| # | Speaker | Message |
|---|---|---|
| 1 | user | `@bro extract the storage layer in src/cli.py into a backend interface so we can swap between JSON file and SQLite implementations later.\n\nDon't ask questions.` |
| → | bro | writes a `kind='decision'` discussion summarizing the chosen approach (interface shape, factory wiring, back-compat for existing files); dispatches SWE. Single turn. |

## Pass criteria

| Scorer | Asserts |
|---|---|
| `outcome.sql` | ≥1 `kind='decision'` discussion; ≥1 `tasks` row (gate cleared, SWE dispatched) |
| `outcome-coherence.json` | `discussions WHERE kind='decision'`: `>=1`; `tasks`: `>=1` |
| `outcome-git.json` | `base_branch_unchanged: true` |
| `tools-required.json` | `discussion_append`, `task_create_batch`, `Agent` (SWE) |
| `tools-forbidden.json` | none |
| `cost-budget.json` | Soft 200K / 900s |

**Failure modes captured:** bro skips the decision-audit row (decision_gate fires); bro dispatches SWE without recording the strategic choice.
