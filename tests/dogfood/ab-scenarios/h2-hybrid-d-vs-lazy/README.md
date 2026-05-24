# H2: Hybrid D' vs always-lazy on cold-start

**Hypothesis from #153.** Tests whether `tmb_project-prescan`'s Phase 4 (cold-start AskUserQuestion + headless fallback) added measurable value vs. the simpler pre-#45 alternative of "no special cold-start handling, just lazy-fill as we work."

## Arms

- **A-hybrid-d**: current `tmb_project-prescan` with Phase 4 (asks, falls back to lazy in headless, logs `headless_fallback` event)
- **B-always-lazy**: pre-#148 `tmb_project-prescan` (no Phase 4 — codebase memory simply backfills lazily as bro reads files; no question, no event)

## Flow

`10-codebase-memory-cold-start` — built specifically to exercise Phase 4. In headless mode (which both arms run as), A should fire `headless_fallback`; B should just proceed with planning.

## Prompt

`@bro implement a hello world function in src/hello.py`

## What to look for

- **outcome pass-rate**: if A ≈ B, Phase 4 added overhead without benefit in headless. If A > B, the audit-trail completeness pays off. If A < B, Phase 4 confused bro.
- **trajectory_required**: A should show `headless_fallback` audit event (per outcome.sql); B should not. Confirms each arm engages its own protocol.
- **tokens_total**: B should be slightly cheaper (no AskUserQuestion attempt). The question is by how much.

## Decision

If H2 shows Hybrid D' is measurably worse or equal in headless contexts → consider scoping Phase 4 to interactive-only sessions (skip when `TMB_HEADLESS=1` is set). If H2 confirms value → ADR documenting why the audit-trail discipline matters even when the question can't be answered.

## Note

Real-world value of Phase 4 is in INTERACTIVE sessions where the user actually answers the question. This A/B tests only the headless-fallback path. A separate scenario could test interactive-mode value, but that requires a human-in-loop harness that L5 doesn't have.
