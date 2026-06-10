---
description: Multi-agent deliberation on a topic with checkbox/radio AUQ ratification
argument-hint: <topic to deliberate>
---

# Roundtable on: $ARGUMENTS

If `$ARGUMENTS` is empty, ask the user for the topic via AskUserQuestion
before proceeding.

## When to invoke

- Divergent opinions, multi-dimension trade-offs, cross-discipline calls.
- Skip for: factual lookups, single-discipline decisions, or delegation.

## Phase 1 — Setup

1. Glob `.claude/agents/`, select 2–4 agents (exclude SWE). Halt if < 2.
2. `roundtable_create(agent='bro', issue_id=<carrier>, topic=<topic>,`
   `expected_participants=N)` — store `roundtable_id`.

## Phase 2 — Collect (parallel Task spawns)

After each participant responds, BEFORE synthesis:

```
discussion_append(agent='bro', issue_id=<carrier>, author='<name>',
  kind='analysis', body=<full position>)
roundtable_vote(agent='bro', roundtable_id=<id>, participant='<name>',
  vote=<stance ≤60 chars>, rationale=<reasoning ≤120 chars>)
```

Server auto-flips `state → awaiting_human` after the Nth distinct
non-human vote.

## Phase 3 — Synthesize

Extract agreements (≥2 endorsements, or unilateral with no opposition)
and disagreements (≥2 materially different stances on the same
question).

Capping: >4 agreements → keep top 4; >3 disagreements → keep top 3.
Reserve 1 AUQ slot for agreements; up to 3 radio slots for
disagreements.

Anti-pattern guard (zero/zero): AUQ "Retry or skip?" → on skip:
`roundtable_close(skip:true, outcome='skipped — no substance')` and stop.

## Phase 4 — Ratify (one AUQ)

Q1 (`multiSelect:true`): agreements checkbox.
Q2–Q4 (radio): one per disagreement, `header` ≤12 chars.

Headless guard: see `tmb_recovery` §A — apply the documented fallback
default for each question and continue.

## Phase 5 — Close (one composite call)

```
roundtable_close_with_decisions(agent='bro', roundtable_id=<id>,
  outcome=<one-sentence>,
  decisions={
    ratified=[<checked>], unratified=[<unchecked>],
    resolutions=[{topic_slug, winning_stance, dissenter, rationale?}]
  })
```

Collapses finalize_decisions + close + summarize into one transactional call. The `roundtable-cleanup-postcheck.sh` PostToolUse hook verifies the five capture surfaces and warns on any missing.

## Phase 6 — Follow-ups

Second AUQ (`multiSelect`, one per ratified agreement) → `issue_create`
per checked. Close the carrier issue if it was a one-shot roundtable
carrier.

## Local rollup (optional)

`<workspace>/.claude/tmb/roundtables/<YYYY-MM-DD>-<slug>.md` — skip if
not writable. DB rows are authoritative; the file is never committed.
