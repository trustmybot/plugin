# misc/ — edge-case scenarios outside the 13-row journey

These scenarios capture bug classes that aren't part of the canonical TODO-CLI journey (rows 1–13 in [`tests/EVALUATION.md`](../../EVALUATION.md)). They're kept around because they document real captured production violations, but they don't participate in the L6 chain.

| Dir | What it captures |
|---|---|
| `legacy-onboard-then-task/` | Pre-reframe scenario: bro creates a worktree from `main` without first making a feature branch (2026-05 bug). Superseded by the row-4/row-5 split in the journey. |
| `reonboard-redirect/` | Re-onboarding-style ask ("switch to gitflow") — bro must redirect to `/onboard`, not auto-fire. The journey covers reonboard explicitly in row 3 (partial-test). |
| `roundtable-routing-redirect/` | Phrase-trigger `/roundtable` attempt — bro must redirect. Captured-bug-as-failing. Row 11 covers the slash-invoked happy path. |
| `architecture-regen-direct/` | "Refresh the architecture docs" → `architecture_regen` direct, no planning. Edge case; not in the journey. |
| `triage-discussion-before-task/` | Triage discussion gate. Now enforced server-side via the triage gate on `task_create_batch`; the journey row 4 covers it implicitly. |

Run individually if you need to debug one:

```bash
bash tests/dogfood/run-l6.sh misc/legacy-onboard-then-task
```

The L6 chain runner (`run-l6-chain.sh`) skips misc/ entirely — these don't have inter-row continuity expectations.
