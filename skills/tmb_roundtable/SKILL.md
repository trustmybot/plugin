---
name: tmb_roundtable
description: Multi-agent deliberation. Spawns 2-4 participants, collects positions, synthesizes agreements/disagreements, calls roundtable_finalize_decisions (atomic ratification), closes, and files follow-up issues.
allowed-tools: Read, Task, Grep, Glob
---

# Roundtable

## When to invoke

- Divergent opinions, multi-dimension trade-offs, cross-discipline calls.
- Not for: factual lookups, single-discipline decisions, or delegation.

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

Server auto-flips `state → awaiting_human` after the Nth distinct non-human vote.

## Phase 3 — Synthesize

Extract agreements (≥2 endorsements or unilateral + no opposition) and
disagreements (≥2 materially different stances on same question).

Capping: >4 agreements → keep top 4; >3 disagreements → keep top 3.
Reserve 1 AUQ slot for agreements; up to 3 radio slots for disagreements.

Anti-pattern guard (zero/zero): AUQ "Retry or skip?" → on skip:
`roundtable_close(skip:true, outcome='skipped — no substance')` and stop.

## Phase 4 — Ratify (ONE AUQ)

Q1 (`multiSelect:true`): agreements checkbox. Q2–Q4 (radio): one per
disagreement, `header` ≤12 chars. Headless guard: invoke `tmb_headless-fallback`.

## Phase 5 — Finalize (atomic)

```
roundtable_finalize_decisions(agent='bro', roundtable_id=<id>,
  ratified=[<checked>], unratified=[<unchecked>],
  resolutions=[{topic_slug, winning_stance, dissenter, rationale?}])
```

## Phase 6 — Close

```
roundtable_close(agent='bro', roundtable_id=<id>, outcome=<one-sentence>)
roundtable_summarize(agent='bro', roundtable_id=<id>)
audit_log(agent='bro', issue_id=<carrier>, kind='event', event_type='roundtable_summary',
  summary=<topic + outcome>, content_json=<summarize result>)
```

## Phase 7 — Follow-ups

Second AUQ (multiSelect, one per ratified agreement) → `issue_create` per
checked. Close carrier if it was a one-shot roundtable carrier.

## Local rollup (optional)

`<workspace>/.claude/tmb/roundtables/<YYYY-MM-DD>-<slug>.md` — skip if not
writable. DB rows are authoritative; file is never committed.
