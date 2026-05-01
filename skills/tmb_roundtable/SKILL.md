---
name: tmb_roundtable
description: Multi-agent deliberation on a topic. Spawns 2-4 participants, collects positions with kind='analysis' DB rows, synthesizes agreements/disagreements, presents AskUserQuestion batch for Human ratification, records all five DB capture surfaces, and files follow-up issues.
allowed-tools: Read, Task, Grep, Glob
---

# Roundtable

Multi-agent deliberation: spawn participants, collect independent positions,
synthesize agreements vs disagreements, present a single AskUserQuestion
batch for Human ratification, and capture everything in the trajectory DB.

## When to invoke

Use roundtable for:

- Divergent opinions that need structured airing
- Multi-dimension trade-offs (product vs. technical vs. business)
- Cross-discipline calls where no single agent owns the answer

Do NOT use roundtable for:

- Quick factual questions — answer directly
- Single-discipline decisions — spawn that agent via `Task` directly
- A caller who wants one voice — roundtable is deliberation, not delegation

## Phase 1 — Setup

1. Glob `.claude/agents/` to enumerate available agents.
2. Read each agent's frontmatter `description` field.
3. Select 2–4 agents whose descriptions best match the topic. Exclude SWE.
4. Prefer domain agents over core roster; fall back to core for general topics.
5. Halt if fewer than 2 suitable participants exist.
6. Call `roundtable_create(agent='bro', issue_id=<carrier>, topic=<topic>)` to
   open the meeting record. Store the returned `roundtable_id`.

## Phase 2 — Collect positions (parallel)

Spawn all selected participants in a single message (parallel `Task` calls).
Each participant receives: the topic, relevant context, and instruction to
state a position with supporting reasoning.

Wait for all responses before proceeding. If a participant refuses or errors,
note the abstention and continue with remaining voices.

**After each participant responds** (before synthesis):

```
discussion_append(
  agent='bro',
  issue_id=<carrier>,
  author='<participant>',
  kind: 'analysis',
  body=<their full position>
)

roundtable_vote(
  agent='bro',
  roundtable_id=<id>,
  participant='<participant>',
  vote=<stance summary ≤60 chars>,
  rationale=<key reasoning ≤120 chars>
)
```

Write these for every participant, in the order responses arrive.

## Phase 3 — Synthesis

After all positions are collected, extract:

**Agreements** — a point at least 2 participants endorsed, OR a unilateral
suggestion no other participant opposed.

**Disagreements** — a point where ≥2 participants took materially different
stances on the same question.

**Capping rules:**
- If >4 agreements: keep the top 4 by salience (most-actionable first); fold
  extras as "noted, not ratified" in the local rollup (if written).
- If >3 disagreements: keep the top 3 by stakes; fold extras the same way.
- Reserve 1 AUQ slot for agreements; up to 3 disagreement radios fill the
  remaining slots — total ≤4 questions per AUQ call.

**Anti-pattern guard — zero agreements AND zero disagreements:**
All participants converged trivially or all abstained. Emit a warning
explaining this, then call AskUserQuestion with a single question:
"No substantive agreements or disagreements emerged. Retry with different
participants, or skip?" Options: Retry / Skip. If skip: call `roundtable_close`
with outcome='skipped — no substance', then stop.

## Phase 4 — AUQ batch

Emit **one** `AskUserQuestion` call with:

- **Question 1** (agreements, multiSelect: true):
  - Header: "Agreements"
  - Text: "Roundtable agreements — which to ratify as next-MR work? (any subset)"
  - Options: one per agreement (up to 4)

- **Questions 2–4** (disagreements, one radio each, as many as exist up to 3):
  - Header: short topic slug ≤12 chars
  - Text: describe the tension in one sentence
  - Options: one per competing stance, plus "Abstain / defer"

**Headless guard:** if `AskUserQuestion` errors or `TMB_HEADLESS=1` is set,
invoke `tmb_headless-fallback` immediately. Do NOT auto-pick any option.

## Phase 5 — Process answers

For each **ratified agreement** (checked in Question 1):

```
discussion_append(agent='bro', issue_id=<carrier>, author='bro',
  kind='answer', body=<agreement statement>)

discussion_append(agent='bro', issue_id=<carrier>, author='bro',
  kind='decision', body='Ratified: <agreement>')

roundtable_vote(agent='bro', roundtable_id=<id>,
  participant='human', vote='ratified',
  rationale=<short summary of what was ratified>)
```

For each **unratified agreement** (not checked):

```
discussion_append(agent='bro', issue_id=<carrier>, author='bro',
  kind='note', body='not ratified: <agreement>')
```

For each **disagreement resolution** (radio answer, not "Abstain"):

```
discussion_append(agent='bro', issue_id=<carrier>, author='bro',
  kind='decision',
  body='Human chose <winning_stance>; <dissenting_participant> dissented but did not block.')

roundtable_vote(agent='bro', roundtable_id=<id>,
  participant='human', vote=<winning_stance>,
  rationale=<short>)
```

## Phase 6 — Close the roundtable

```
roundtable_close(
  agent='bro',
  roundtable_id=<id>,
  outcome=<one-sentence summary of what was decided>
)
```

Log to the ledger:

```
ledger_log(
  agent='bro',
  issue_id=<carrier>,
  event_type='roundtable_summary',
  summary=<topic + one-sentence outcome>,
  content={
    topic: <topic>,
    participants: <comma-separated list>,
    agreements_ratified: <count>,
    disagreements_resolved: <count>
  }
)
```

If `ledger_log` fails, continue — DB rows are the authoritative record.

## Phase 7 — Follow-up issues AUQ

Emit a **second** `AskUserQuestion` call (separate from Phase 4):

- Header: "Follow-up issues"
- Text: "Open follow-up issues for each ratified action? (uncheck to skip)"
- multiSelect: true
- Options: one per ratified agreement (pre-checked implies intent; Human
  unchecks to skip)

For each checked option:

```
issue_create(
  agent='bro',
  objective=<ratified action statement>,
  description=<context: references carrier issue #N, decision made in roundtable>
)
```

After all follow-up issues are created, close the carrier issue if it was
created solely for this roundtable (i.e., it has no other open tasks).
If it was an existing strategic issue, leave it open.

## Local rollup file (convenience only — NOT committed)

Write an optional human-readable mirror to:

```
<workspace>/.claude/tmb/roundtables/<YYYY-MM-DD>-<topic-slug>.md
```

Where `<workspace>` is the directory containing `.claude/` (NOT inside
`plugin/` or any git-tracked path). Skip silently if the directory is not
writable. The DB rows are authoritative — this file is a local read
convenience and is never part of the git history.

Format:

```markdown
# <Topic> — Roundtable <YYYY-MM-DD>

**Participants:** <comma list>
**Carrier issue:** #<N>

## Agreements ratified
- <item>

## Not ratified
- <item> (noted, not ratified)

## Disagreements resolved
- <topic slug>: Human chose <stance>; <dissenter> dissented but did not block.

## Outcome
<one-sentence summary>
```

## Five DB capture surfaces (all required)

Every completed roundtable must populate:

1. `discussions` with `kind='analysis'` — one row per participant position
2. `discussions` with `kind='answer'` + `kind='decision'` — one per Human
   ratification
3. `roundtables` — the meeting record (created + closed)
4. `roundtable_votes` — one row per participant + one per Human ratification /
   disagreement resolution
5. `ledger` with `event_type='roundtable_summary'`

## Deliberation rules

- No groupthink: if all participants agree immediately, probe the weakest
  shared assumption before synthesizing.
- Protect dissent: lone dissenters get explicit airtime; their position is
  recorded in the disagreements section even after Human resolves it.
- No yes-agents: "I agree with X" without new reasoning is not a position.
