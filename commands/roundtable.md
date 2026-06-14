---
description: Multi-agent deliberation on a topic with checkbox/radio AUQ ratification
argument-hint: <topic to deliberate>
---

# Roundtable on: $ARGUMENTS

Run a structured deliberation: collect parallel agent positions, synthesize into agreements and disagreements, ratify with the Human, then close with decisions.

If `$ARGUMENTS` is empty, ask the user for the topic via AskUserQuestion
before proceeding.

## When to invoke

- Divergent opinions, multi-dimension trade-offs, cross-discipline calls.
- Skip for: factual lookups, single-discipline decisions, or delegation.

## Phase 1 — Setup

Glob `.claude/agents/` and pick 2–4 participants, excluding SWE; halt if fewer than 2 qualify. Open the round with `roundtable_create` (passing the carrier issue, topic, and participant count) and keep the returned `roundtable_id`.

## Phase 2 — Collect (parallel Task spawns)

Each participant delivers a one-line stance and a short rationale — the server enforces the caps. As each one responds, and before you synthesize, capture their full position with `discussion_append` (kind `analysis`) and then their stance with `roundtable_vote`. The server flips `state → awaiting_human` once the Nth distinct non-human vote lands.

## Phase 3 — Synthesize

Extract agreements (≥2 endorsements, or unilateral with no opposition) and disagreements (≥2 materially different stances on one question). When there are more than fit, keep the top 4 agreements and top 3 disagreements — one AUQ slot for agreements, up to 3 radio slots for disagreements.

When synthesis yields neither, ask "Retry or skip?"; on skip, call `roundtable_close(skip:true, outcome='skipped — no substance')` and stop.

## Phase 4 — Ratify (one AUQ)

Q1 (`multiSelect:true`): agreements checkbox.
Q2–Q4 (radio): one per disagreement, `header` ≤12 chars.

## Phase 5 — Close (one composite call)

`roundtable_close_with_decisions` with a one-sentence outcome and decisions payload — the server enforces the caps. Collapses finalize_decisions + close + summarize into one transactional call. The `roundtable-cleanup-postcheck.sh` PostToolUse hook verifies the six capture surfaces and warns on any missing.

## Phase 6 — Follow-ups

Second AUQ (`multiSelect`, one per ratified agreement) → `issue_create`
per checked. Close the carrier issue if it was a one-shot roundtable
carrier.

## Local rollup (optional)

`<workspace>/.claude/tmb/roundtables/<YYYY-MM-DD>-<slug>.md` — skip if
not writable. DB rows are authoritative; the file stays uncommitted.
