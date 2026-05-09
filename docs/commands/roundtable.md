# /roundtable

## Purpose

`/roundtable` triggers multi-agent deliberation on a topic. A panel of consultant agents (ceo, cto, pm, or other specialists) each analyze the topic independently, vote, and surface their reasoning. The Human ratifies agreements and resolves disagreements via a structured AskUserQuestion (checkbox for agreements, radio for each disagreement). Follow-up issues are created for every ratified action.

## When to use

- Architectural or strategic decisions where multiple perspectives reduce blind spots.
- Trade-off analysis that benefits from adversarial input before committing.
- Situations where bro's single-agent view isn't enough and you want documented dissent.

Do not use for routine implementation tasks — the overhead of a full roundtable is only warranted for consequential decisions.

## Syntax

```
/roundtable <topic>
/roundtable
```

With a topic argument, deliberation starts immediately. Without arguments, Claude Code prompts for the topic before invoking.

### Examples

```
/roundtable Should we adopt feature flags for the next release?
```

```
/roundtable Migrate from REST to GraphQL — worth it at our scale?
```

```
/roundtable
# → Claude Code will prompt: "What topic should the roundtable deliberate on?"
```

## What happens

1. The `/roundtable` command body (in `commands/roundtable.md`) carries the full procedure.
2. A roundtable record is created (`roundtable_create`) with `expected_participants` set to the number of available consultant agents (2–5).
3. Each participant is spawned in parallel; each appends an analysis (`discussion_append(kind='analysis')`) and casts a vote (`roundtable_vote`).
4. After all agent votes are recorded, state flips to `awaiting_human`.
5. One `AskUserQuestion` presents: agreements (multiSelect checkbox) and each disagreement (radio resolution).
6. Human ratification is finalized atomically via `roundtable_finalize_decisions`.
7. `roundtable_close` seals the record; `roundtable_summarize` produces a canonical summary logged to the `audit` table.
8. A second AUQ offers follow-up issue creation per ratified agreement. The carrier issue closes if this was a one-shot roundtable.

For the full deterministic phase-by-phase flow, see [`commands/roundtable.md`](../../commands/roundtable.md).

## Cross-references

- **Procedure:** [`commands/roundtable.md`](../../commands/roundtable.md) — the full deliberation flow lives here (the prior `tmb_roundtable` skill was folded into the slash command body since deliberation is Human-triggered only).
- **MCP tools used:** `roundtable_create`, `roundtable_vote`, `roundtable_finalize_decisions`, `roundtable_close`, `roundtable_summarize`, `discussion_append`, `issue_create`, `audit_log`.
- **AUQ shape enforcement:** `roundtable-auq-shape` hook validates the AskUserQuestion structure while `state=awaiting_human`.
- **Capture-surface verification:** `roundtable-cleanup-postcheck.sh` PostToolUse hook validates the 5 surfaces are populated on `roundtable_close`.
