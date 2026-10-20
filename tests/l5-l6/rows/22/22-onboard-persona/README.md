# 22-onboard-persona

**Scenario under test (GH 1339, GH 1496):** the Human runs `/tmb:onboard` on a cold project that already has its own `CLAUDE.md`. Onboarding must complete and leave that `CLAUDE.md` untouched. GH 1339 had `/onboard` write bro's persona into the project `CLAUDE.md` between `tmb:persona` markers; GH 1496 moved the persona to the plugin's persona hooks (`session-start-persona.sh`, `user-prompt-persona.sh`), so `onboard_apply` no longer writes the file. That is why this row asserts the file is unchanged rather than that it gains a persona block.

## Pre-state

`empty` fixture (not onboarded), fed the way the cold-start row (`01-cold-start`) feeds it: "Don't ask questions." makes bro apply the documented defaults instead of rendering AUQ rounds. `setup-l5.sh` writes and commits a Human-owned `CLAUDE.md` and snapshots it to `.claude/tmb/_l5_claude_md_seed.md`.

## Turns

| # | Speaker | Message |
|---|---|---|
| 1 | user | `/tmb:onboard\n\nDon't ask questions.` |
| → | bro | `onboard_state_get` (first_run=true) → `onboard_apply` with defaults → onboarded marker written. `CLAUDE.md` is not touched. Single turn. |

## Pass criteria

| Scorer | Asserts |
|---|---|
| `outcome.sql` | `onboarded` marker `=1`; no `persona_block_written` audit row; the project `CLAUDE.md` holds no `tmb:persona` text and equals the seed snapshot byte for byte |
| `outcome-coherence.json` | `onboarded` marker `=1`; `persona_block_written` rows `=0`; `tasks` `=0` |
| `outcome-files.json` | `CLAUDE.md` still exists |
| `outcome-git.json` | `base_branch_unchanged: true` |
| `tools-required.json` | `onboard_state_get`, `onboard_apply` |
| `tools-forbidden.json` | `task_create_batch`, `task_provision`, `issue_create`, `Agent` |
| `cost-budget.json` | Soft 150K / 600s |

## Gaps

- `outcome.sql` reads `CLAUDE.md` and the seed snapshot with the `sqlite3` shell's `readfile()`, resolving both paths from the scored DB's own path (`pragma_database_list`). A `sqlite3` built without the shell's fileio functions fails those two assertions.
- The runner has no re-run step, so "a second `/tmb:onboard` also leaves it unchanged" is not exercised; one run is scored.
