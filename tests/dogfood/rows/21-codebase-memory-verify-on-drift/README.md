# 21-codebase-memory-verify-on-drift

**Source:** L5 `11-codebase-memory-verify-on-drift` (renumbered per reconciliation table). Rewritten under ADR 0001 to test the world-model substrate instead of file_registry md5 drift.

**Scenario:** Existing repo + a `directories` row seeded with v1's README summary + `README.md` then edited on disk to v2 (without commit). On the next code-touching ask, bro plans and dispatches; the post-task-close-rescan hook (when bro_atomic_close fires) refreshes the world model from the new README.

**L5 mode:** `setup-l5.sh` commits a v1 `src/foo.py` + `README.md`, seeds a `directories` row with the v1 summary, then edits both files on disk without committing.
**L6 mode:** Not in chain manifest (standalone row).

## Scorers

| Scorer | Asserts |
|---|---|
| `outcome.sql` | `directories` ≥1 (substrate survives); issue created (planning ran) |
| `tools-required.json` | (empty) |
| `tools-forbidden.json` | (empty) |
| `cost-budget.json` | Soft 50K / 180s |
