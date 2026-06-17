# 44-cheatcode-install-plugins

**Scenario:** Onboarded project. The user tells bro to install two already-chosen plugins — `feature-dev` and `code-review` — in local scope. Installs are human-approved, never silent (#659): bro records the per-candidate approval via `cheatcode_approve`, then calls `cheatcode_install` once per plugin. The PreToolUse approval gate allows each install only because the matching `cheatcode_approved` record now exists — it fails closed otherwise. Each install writes the `cheatcodes` row (scope='local') + its attachment record in one transaction and emits the `cheatcode_install` / `cheatcode_installed` audit rows. The per-agent attachment routes feature-dev → swe and code-review → pr-reviewer.

**Determinism:** `setup-l5.sh` writes a marketplace-install fixture and points `cheatcode_install` at it via `TMB_CHEATCODE_INSTALL_FIXTURE` — no live web, no real marketplace call. The fixture supplies the per-agent attachment targets (swe, pr-reviewer) that pass through verbatim. This row asserts the flow ran (approval recorded, install gate cleared, both installs + audit + per-agent attachment records present), not marketplace results.

**L5 mode:** `setup-l5.sh` seeds the fixture; `fixture.txt` seeds `onboarding-named` identity.
**L6 mode:** Standalone here — NOT in the chain manifest (L6-B renumbers + wires it into the cheatcode journey chain).

## Scorers

| Scorer | Asserts |
|---|---|
| `outcome.sql` | Two `cheatcode_installed` audit rows; two `cheatcodes` rows `scope='local'`; the feature-dev AND code-review cheatcodes rows; `cheatcode_attachments` target='swe' AND target='pr-reviewer' |
| `tools-required.json` | `cheatcode_approve` + `cheatcode_install` called |
| `cost-budget.json` | Soft 60K tokens / 90s |
