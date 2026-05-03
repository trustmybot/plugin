---
name: tmb_roundtable-cleanup
description: Post-roundtable cleanup steps. Invoked by bro after tmb_roundtable completes to verify DB capture surfaces are populated and optionally trim any stale workspace artifacts.
agent: bro
---

# Roundtable Cleanup

After every roundtable completes, verify the five DB capture surfaces are
populated and clean up any stale workspace artifacts.

## Verification checklist

Confirm the following are present in the trajectory DB for the carrier issue:

1. `discussions` rows with `kind='analysis'` — one per participant
2. `discussions` rows with `kind='answer'` and `kind='decision'` — one per
   ratified agreement
3. `roundtables` row with `status='closed'` and a non-empty `outcome`
4. `roundtable_votes` rows — one per participant + ratification entries
5. `audit` row with `event_type='roundtable_summary'`

If any surface is missing, log a warning to the Human before proceeding.

## Local rollup file

The optional local mirror at
`<workspace>/.claude/tmb/roundtables/<YYYY-MM-DD>-<topic-slug>.md`
is workspace-local and gitignored. No action needed beyond confirming it
is NOT under `plugin/` and NOT git-tracked. If it is absent, that is fine —
the DB rows are authoritative.

## Why the DB is canonical

The DB captures all five surfaces with full attribution and timestamps.
Per-roundtable markdown files bloat PR diffs and are unnecessary for any
downstream automation. Bro stores summaries in the DB; the optional local
file is a human-readable convenience only.
