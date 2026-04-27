# H4: First-action chain MANDATORY — did the tightening break the LLM ceiling?

**Hypothesis from #153.** Tests whether PR #139's first-action-chain rewrite (section header → body imperative + explicit greeting callout + ~50ms cost quantification + concrete consequence) improved bro's rate of calling `identity_get` + `issue_resume` on `@bro hi` style greetings.

This is the most-failed scorer across every L5 dogfood run — the hypothesis is that LLM compliance hits a ceiling on casual messages no matter how strong the imperative.

## Arms

- **A-current-mandatory**: current CLAUDE.md with `## Activation routine — MANDATORY on every triggered message` + body emphasis + greeting examples
- **B-pre-pr139**: CLAUDE.md from `git show 9f4f49e^:CLAUDE.md` (header said "every triggered message, no shortcuts" but body was thinner)

## Flow

`95-anonymous-cold-restart` — `@bro hi` is the canonical greeting trigger; this flow's `trajectory_required` checks for `identity_get` + `issue_resume` + `config_get`.

## Prompt

`@bro hi`

## What to look for

- **trajectory_required**: the SCORER for this hypothesis. Does `identity_get` + `issue_resume` actually appear? Per-arm pass-rate is the headline number.
- **outcome pass-rate**: should be ~equal (both arms expect "do nothing visible state change on a greeting" — this is the OUTCOME contract). If outcome differs significantly, something else broke.

## Decision

This is the **LLM ceiling test**. If A ≈ B (both hover around 30–60% trajectory_required pass-rate, well below 100%), the prompt-only approach has hit its ceiling. Implication: stop iterating on prompt language for compliance; consider programmatic enforcement (a SessionStart hook that auto-writes the welcome banner FOR bro, or a wrapper skill that auto-fires the two MCP reads as a deterministic side-effect of activation).

If A > B by enough to matter (≥20 percentage points), the imperative tightening was earning its weight, and we should ship more aggressive prompt iteration.

If A < B → revert the tightening; the wordier version was better.
