# 09-cheatcode-uninstall-plugins

**Scenario:** Onboarded project with two plugins already installed — `feature-dev` (attached to swe) and `code-review` (attached to pr-reviewer). The user tells bro to uninstall both. Uninstall is bro-proposed + Human-confirmed, not PreToolUse-gated (#676): bro discovers each installed cheatcode's id and calls `cheatcode_uninstall` once per plugin. Each uninstall reverses the attachment via the marketplace/plugin uninstall path (no manual file deletion), deletes the `cheatcodes` + `cheatcode_attachments` rows in one transaction, and emits a `cheatcode_uninstalled` audit row. Idempotent — an absent install no-ops cleanly.

**Determinism:** `setup-l5.sh` pre-seeds the installed state (two `cheatcodes` rows scope='local' + their per-agent attachments + the `cheatcode_install`/`cheatcode_installed` audit rows carrying each cheatcode_id) directly into the trajectory DB, then writes a teardown fixture and points `cheatcode_uninstall` at it via `TMB_CHEATCODE_UNINSTALL_FIXTURE` — no live web, no real marketplace call. This row asserts the flow ran (both teardowns recorded, both cheatcodes + their attachments gone), not marketplace results.

**L5 mode:** `setup-l5.sh` seeds the installed state + fixture; `fixture.txt` seeds `onboarding-named` identity.
**L6 mode:** Standalone here — NOT in the chain manifest (L6-B renumbers + wires it into the cheatcode journey chain, where the install row seeds the state instead).

## Scorers

| Scorer | Asserts |
|---|---|
| `outcome.sql` | Two `cheatcode_uninstalled` audit rows; the feature-dev AND code-review cheatcodes rows gone (COUNT=0 by name); their attachment rows (target='swe', target='pr-reviewer') gone |
| `tools-required.json` | `cheatcode_uninstall` called |
| `cost-budget.json` | Soft 60K tokens / 90s |
