# 04-cheatcode-install-plugins

**Scenario:** Onboarded project. The user tells bro to install two already-chosen plugins — `feature-dev` for swe and `code-review` for pr-reviewer — in local scope. Installs are human-approved, never silent (#659): bro records the per-candidate approval via `cheatcode_approve`, then calls `cheatcode_install` once per plugin, passing the consuming agent as `target` so the install materializes it. The PreToolUse approval gate allows each install only because the matching `cheatcode_approved` record now exists — it fails closed otherwise. Each install writes the `cheatcodes` row (scope='local') + its attachment record in one transaction and emits the `cheatcode_install` / `cheatcode_installed` audit rows. The per-agent attachment routes feature-dev → swe and code-review → pr-reviewer.

**Determinism:** `setup-l5.sh` writes a marketplace-install fixture and points `cheatcode_install` at it via `TMB_CHEATCODE_INSTALL_FIXTURE` — no live web, no real marketplace call. The fixture supplies the per-agent attachment targets (swe, pr-reviewer) that pass through verbatim. This row asserts the flow ran (approval recorded, install gate cleared, both installs + audit + per-agent attachment records present) AND that the targeted install materialized each consuming agent on disk (#95) — not marketplace results. The marketplace boundary stays fixtured (#108/#120's offline-tested domain); the materialization — the previously-faked part — runs for real and is asserted by `outcome-materialized.json`.

**L5 mode:** `setup-l5.sh` seeds the fixture; `fixture.txt` seeds `onboarding-named` identity.
**L6 mode:** Standalone here — NOT in the chain manifest (L6-B renumbers + wires it into the cheatcode journey chain).

## Scorers

| Scorer | Asserts |
|---|---|
| `outcome.sql` | Two `cheatcode_installed` audit rows; two `cheatcodes` rows `scope='local'`; the feature-dev AND code-review cheatcodes rows; `cheatcode_attachments` target='swe' AND target='pr-reviewer' |
| `outcome-materialized.json` | On disk: `.claude/agents/swe.md` lists `feature-dev` and `.claude/agents/pr-reviewer.md` lists `code-review` in their `skills:` headers — the agent md copied global→local + header edit (#95), no longer faked |
| `tools-required.json` | `cheatcode_approve` + `cheatcode_install` called |
| `cost-budget.json` | Soft 60K tokens / 90s |

> Row 05 (swe hot-load) asserts swe-side skill USAGE, which the run-log scorer cannot attribute because swe runs in its own CC session whose stream-json is not merged into bro's log — a known limitation (#119, see `lib/assert-usage.sh`). This row proves the on-disk materialization that precedes that hot-load; the usage attribution is left untouched.
