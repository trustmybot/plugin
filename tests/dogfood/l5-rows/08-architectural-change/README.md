# 08-architectural-change

**Scenario under test:** the Human asks for a strategic stack swap ("let's switch to Clerk for auth"). Per `tmb_planning` doctrine (§"Architectural changes") this crosses the architectural threshold — bro must write a `kind='decision'` discussion (universal decision gate) AND co-author an ADR before dispatching SWE.

The old simple/difficult triage was retired; the only structural requirement now is the universal `kind='decision'` row required by the server-side **decision gate** on `task_create_batch`. The `adr-required-hint.sh` UserPromptSubmit hook fires on architectural intent ("switch to clerk", "migrate to ...", etc.) and reminds bro to also author an ADR + apply the blast-radius checklist.

## Pre-state

`onboarding-named` fixture. Empty repo (no auth code yet — the request introduces a new auth system).

## Turns

| # | Speaker | Message |
|---|---|---|
| 1 | user | `@bro let's switch to Clerk for auth.\n\nDon't ask questions.` |
| → | bro | writes a `kind='decision'` discussion summarizing the planned switch (what, why, trade-offs); authors an ADR at `docs/trustmybot/architecture/manual/decisions/N-*.md`; dispatches SWE. Single turn. |

## Pass criteria

| Scorer | Asserts |
|---|---|
| `outcome.sql` | ≥1 `kind='decision'` discussion; ≥1 `tasks` row (gate cleared, SWE dispatched) |
| `outcome-coherence.json` | `discussions WHERE kind='decision'`: `>=1`; `tasks`: `>=1` |
| `outcome-git.json` | `base_branch_unchanged: true` |
| `tools-required.json` | `discussion_append`, `task_create_batch`, `Agent` (SWE) |
| `tools-forbidden.json` | none |
| `cost-budget.json` | Soft 200K / 900s |

**Failure modes captured:** bro skips the decision-audit row (decision_gate fires); bro dispatches SWE without recording the strategic choice; bro forgets the ADR (caught by the hook advisory but not server-gated).
