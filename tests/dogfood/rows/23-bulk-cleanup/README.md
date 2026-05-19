# 23-bulk-cleanup

**Source:** L5 `13-bulk-cleanup` (renumbered per reconciliation table).

**Scenario:** Human pre-authorizes .DS_Store deletion in a single prompt. Verifies: all .DS_Store gone, keep-list intact, AskUserQuestion=0.

**L5 mode:** `setup-l5.sh` scatters .DS_Store files + seeds keep-list files.
**L6 mode:** Not in chain manifest (standalone row).

## Scorers

| Scorer | Asserts |
|---|---|
| `outcome.sql` | No task created (cleanup is direct, not SWE-routed) |
| `outcome-files.json` | .DS_Store files gone; src/index.js + src/components/App.js intact |
| `outcome-coherence.json` | No issues/tasks/discussions/audit written |
| `outcome-git.json` | `base_branch_unchanged: true` |
| `tools-required.json` | `Bash` |
| `tools-forbidden.json` | `AskUserQuestion` |
| `cost-budget.json` | Soft 30K / 60s |
