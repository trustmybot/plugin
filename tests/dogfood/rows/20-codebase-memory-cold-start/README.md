# 20-codebase-memory-cold-start

**Source:** L5 `10-codebase-memory-cold-start` (renumbered per reconciliation table). Rewritten under ADR 0002 to test the kuzu world-model substrate.

**Scenario:** Existing repo with files but the world model is cold (no `deep_scan_completed` audit row) → bro receives the world-model-cold gate from `task_create_batch`. In headless mode (`claude -p`) there's no Human to ask, so bro must self-fire `scan_run` to populate the kuzu graph DB, then continue planning.

**L5 mode:** `setup-l5.sh` seeds `onboarding-named` + commits `src/existing.py` + leaves the world model cold (no `deep_scan_completed` audit row).
**L6 mode:** Not in chain manifest (standalone row).

## Scorers

| Scorer | Asserts |
|---|---|
| `outcome.sql` | `deep_scan_completed` audit row exists (bro self-scanned; proxy for kuzu graph warm); issue created; task created |
| `tools-required.json` | (empty — no tool-level assertion) |
| `tools-forbidden.json` | (empty) |
| `cost-budget.json` | Soft 60K / 180s |
