# H3: Direct Mode framing — did NEVER-SKIP-THIS move the needle?

**Hypothesis from #153.** Tests whether PR #139's strong imperative framing on the Direct Mode protocol (3-step + soft → "ALL THREE STEPS ARE MANDATORY" / "NEVER SKIP THIS"), later expanded to 4 steps in PR #148, actually improved bro's rate of completing the audit-trail steps.

## Arms

- **A-current-4step**: current `tmb_direct-mode/SKILL.md` with strong imperative + 4 mandatory steps (Edit, Bash commit, ledger_log, file_registry_update_summaries)
- **B-pre-pr139**: snapshot from `git show 9f4f49e^:skills/tmb_direct-mode/SKILL.md` (3-step + softer "log to ledger as direct_mode_used" wording, no "NEVER SKIP THIS")

## Flow

`D-direct-mode` — exercises the protocol directly.

## Prompt

`@bro fix the typo 'recieve' to 'receive' in README.md`

## What to look for

- **outcome pass-rate**: specifically the `exactly-one-direct_mode_used-ledger-event` and `file_registry-row-after-direct-mode-edit` assertions. These measure whether the audit + registry steps actually fired.
- **trajectory_required**: should show `ledger_log` for both arms ideally; absence indicates compliance failure.
- **Note**: PR #148 added step 4 (file_registry update); B-pre-pr139 doesn't have that step at all. So B can't pass `last_verified_sha` assertions. Compare arms only on the OVERLAPPING 3-step assertions.

## Decision

If A ≈ B on the audit step (ledger_log firing), strong imperative framing didn't move the needle → file followup to either (a) revert prompt-only fixes for compliance, or (b) implement programmatic enforcement (e.g. PostToolUse hook on Edit-during-Direct-Mode that auto-writes the ledger event). If A > B → strong framing earned its weight; apply pattern elsewhere.
