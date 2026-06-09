# 21-codebase-memory-verify-on-drift

**Source:** L5 `11-codebase-memory-verify-on-drift` (renumbered per reconciliation table). Rewritten under ADR 0002 to test the kuzu world-model substrate.

**Scenario:** Existing repo + kuzu world model pre-warmed with v1's README summary + `README.md` then edited on disk to v2 (without commit). On the next code-touching ask, bro plans and dispatches; the post-task-close-rescan hook (when bro_atomic_close fires) refreshes the kuzu graph from the new README.

**L5 mode:** `setup-l5.sh` commits a v1 `src/foo.py` + `README.md`, seeds a `deep_scan_completed` audit row (SQLite-side proxy for "kuzu world model warm with v1 summary"), then edits both files on disk without committing.
**L6 mode:** Not in chain manifest (standalone row).

## Scorers

| Scorer | Asserts |
|---|---|
| `outcome.sql` | issue created (planning ran) |
| `tools-required.json` | (empty) |
| `tools-forbidden.json` | (empty) |
| `cost-budget.json` | Soft 50K / 180s |
