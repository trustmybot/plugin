# H1: CLAUDE.md slim — did it actually help?

**Hypothesis from #153.** Tests whether PR #126's aggressive slim (CLAUDE.md 142 → 99 lines, extracting protocols into reactive skills) improved bro's outcome pass-rate, or was cosmetic refactoring.

## Arms

- **A-slim**: current CLAUDE.md (~109 lines after subsequent edits)
- **B-pre-slim**: snapshot from `git show 2f5cc56^:CLAUDE.md` (142 lines, the state right before PR #126 landed)

## Flow

`02-simple-task` — chosen because it exercises the full code-touching chain (prescan → triage → branch-id → planning → SWE spawn → close), giving multiple scorers a chance to discriminate.

## Prompt

`@bro write a python cli todo with add and list commands`

## Run

```bash
N=10 bash tests/dogfood/run-ab.sh h1-claude-md-slim
bash tests/dogfood/scripts/ab-report.sh h1-claude-md-slim --db <persisted-trajectory.db>
```

## What to look for

- **outcome pass-rate**: if A ≈ B (within noise), slim was rearrangement. If A > B by ≥1 std, slim earned its weight. If A < B, the slim regressed.
- **cost (tokens_total)**: A should be cheaper per session (less context). If not, the slim costs the same — only readability win.
- **trajectory_required**: should be similar across arms (same MCP discipline shipped in both).

## Decision

If H1 shows slim was cosmetic + costs the same → file followup to revert or to ship the *next* slim with measurement built-in. If slim earned its weight → write ADR documenting the win + apply the same pattern to skill files.
