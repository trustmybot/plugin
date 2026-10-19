# 18-spec-shape-gate

**Scenario under test:** the Human asks for a new `priority` column in the todo store schema. A task whose `files[]` touches a schema file needs a `Writer:` + `Populated:` line pair in its `spec_body` before `require-task-spec.sh` lets swe spawn (GH 1264). Bro must write that contract into the spec, not waive the gate.

## Pre-state

`onboarding-named` fixture. `setup-l5.sh` commits a todo CLI backed by SQLite: `src/schema.sql` (the `todos` table) and `src/cli.py` (`add`, `list`; store at `todos.db`, gitignored). It inserts the `repos` row for the project (`INSERT OR IGNORE`, target `main`, `github-flow`) so task provisioning creates the worktree.

## Turns

| # | Speaker | Message |
|---|---|---|
| 1 | user | `@bro add a "priority" column to the todo store schema and show it in "list".\n\nDon't ask questions.` |
| → | bro | plans the task with `files[]` covering `src/schema.sql`, writes `Writer:` and `Populated:` lines under `## Success Criteria`, spawns swe. Single turn. |

## Pass criteria

| Scorer | Asserts |
|---|---|
| `outcome.sql` | a priority task exists; its `spec_body` holds `Writer:` and `Populated:`; no `spec_shape_gate_waived` audit row; a swe `agent_runs` row exists for the priority task |
| `outcome-coherence.json` | `tasks >= 1`; `spec_shape_gate_waived = 0`; swe `agent_runs >= 1` |
| `outcome-git.json` | `base_branch_unchanged: true` |
| `tools-required.json` | `Agent` |
| `tools-forbidden.json` | `AskUserQuestion` |
| `cost-budget.json` | Soft 200K / 900s |

## Gaps (proxies)

- **Lines present before the spawn succeeds.** The DB keeps the final `spec_body`, not its state at spawn time. The proxy: `record-swe-spawn.sh` writes a swe `agent_runs` row only after every spawn gate allowed the spawn, and with no waiver row the gate allows a schema task only when the spec carries `Writer:` + `Populated:` (or `Nullable:`). The final `spec_body` holding both lines plus that row stands in for "before the spawn". A spec that passed on `Nullable:` and gained the pair later via `task_update_spec` would also pass; check the `task_spec_amended` audit rows when that matters.
- **Gate trigger.** The gate fires on `files[]` naming `src/schema.sql` (or "add column" / "new column" in the spec). A plan whose `files[]` misses the schema file would not exercise the gate; the outcome checks still require the two lines.
