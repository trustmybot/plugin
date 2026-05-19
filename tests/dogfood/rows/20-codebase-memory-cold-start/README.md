# 20-codebase-memory-cold-start

**Source:** L5 `10-codebase-memory-cold-start` (renumbered per reconciliation table).

**Scenario:** Existing repo with files but empty `file_registry` → bro must trigger the AskUserQuestion in `session-start-prescan.sh` hook + `tmb_planning §Step 0`. In headless mode (claude -p), AskUserQuestion errors → `tmb_recovery §A` fires with default 'lazy', which records a `headless_fallback` audit event. After fallback, bro still plans the task.

**L5 mode:** `setup-l5.sh` seeds `onboarding-named` + commits `src/existing.py` + leaves `file_registry` empty.
**L6 mode:** Not in chain manifest (standalone row).

## Scorers

| Scorer | Asserts |
|---|---|
| `outcome.sql` | deep_scan NOT completed in headless; issue created; task created |
| `tools-required.json` | (empty — no tool-level assertion) |
| `tools-forbidden.json` | (empty) |
| `cost-budget.json` | Soft 60K / 180s |
