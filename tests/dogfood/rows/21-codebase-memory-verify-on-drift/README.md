# 21-codebase-memory-verify-on-drift

**Source:** L5 `11-codebase-memory-verify-on-drift` (renumbered per reconciliation table).

**Scenario:** Existing repo + populated `file_registry` + simulated drift (file content changed on disk after registry was written). On first code-touching ask, bro must run `file_registry_verify` and detect the mismatch.

**L5 mode:** `setup-l5.sh` seeds identity + commits `src/foo.py` + seeds stale `file_registry` row + then modifies the file without committing (creating drift).
**L6 mode:** Not in chain manifest (standalone row).

## Scorers

| Scorer | Asserts |
|---|---|
| `outcome.sql` | `foo.py` md5 refreshed; no stale row remains; issue was created |
| `tools-required.json` | (empty) |
| `tools-forbidden.json` | (empty) |
| `cost-budget.json` | Soft 50K / 180s |
