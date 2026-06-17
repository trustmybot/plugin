# 43-cheatcode-install-approval

**Scenario:** Onboarded project. The user has already vetted a candidate cheatcode (a PDF-table-extraction plugin) and explicitly tells bro to install it. Installs are human-approved, never silent (#659): bro records the per-candidate approval via `cheatcode_approve`, then calls `cheatcode_install`. The PreToolUse approval gate allows the install only because the matching `cheatcode_approved` record now exists — it fails closed otherwise. The install writes the `cheatcodes` row + its attachment record in one transaction and emits the `cheatcode_install` / `cheatcode_installed` audit rows.

**Determinism:** `setup-l5.sh` writes a marketplace-install fixture and points `cheatcode_install` at it via `TMB_CHEATCODE_INSTALL_FIXTURE` — no live web, no real marketplace call. The kind-dependent attachment + the skill-kind proposed-PR path are asserted at L2/L3. This row asserts the flow ran (approval recorded, install gate cleared, install + audit records present), not marketplace results.

**L5 mode:** `setup-l5.sh` seeds the fixture; `fixture.txt` seeds `onboarding-named` identity.
**L6 mode:** Standalone — NOT in the chain manifest. Install carries no cumulative state across the journey chain (mirrors 40/41-cheatcode).

## Scorers

| Scorer | Asserts |
|---|---|
| `outcome.sql` | A `cheatcode_approved` audit row exists; a `cheatcode_installed` audit row exists; the `cheatcodes` row + its attachment row were written |
| `tools-required.json` | `cheatcode_approve` + `cheatcode_install` called |
| `cost-budget.json` | Soft 60K tokens / 90s |
