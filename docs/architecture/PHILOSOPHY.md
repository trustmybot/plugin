# Design philosophy

The principles behind how the TMB plugin is shaped — how the two review gates differ, where the line sits between TMB's own development process and the runtime that ships to a user's project, why the trajectory exists to cut entropy at handoffs, why gates catch false success while audits chase perfection, why a replaced design is removed cleanly, why memory is split into hot and cold, and why every fact about the codebase lives in exactly one of three layers: docs, world model or code.

## 1. Two review perspectives

The workflow has two review gates. Both read the diff line by line — what differs is the context each brings to it, and what that context does to what they catch.

- **bro reviews at the SYSTEM level.** The question bro answers is "does this change fit the whole system?" — does it belong in this milestone, does it respect the role boundaries, does it ripple into surfaces the spec didn't name, is it the right shape of work at all.
- **code-reviewer reviews at the diff level.** The question code-reviewer answers is "does this diff break other behaviour?", probed through the world model's dependents with the spec as the basis for what the diff intends; whether the diff meets its criteria is owned by swe's recorded checks and criterion report, and scope and design are bro's.

The two perspectives are complementary because of a context asymmetry. bro carries the full picture — the plan, the decisions, the prior turns — which is what makes the system-fit call possible; but that same context biases bro toward expecting correctness, so bro can read a line for what it was *meant* to do and wave a real low-level bug through. code-reviewer arrives with fresh memory and little of the big picture, and that freshness is the point: reading the diff cold, unprimed by intent, is what gives it the better odds of catching the local bug bro rationalizes past. Neither substitutes for the other — bro's context catches scope and ripple problems code-reviewer can't see; code-reviewer's fresh eyes catch correctness bugs bro's context hides.

## 2. Dev-vs-user-runtime boundary

`docs/` is TMB-internal, alongside the test harness (`tests/`) and the release and maintenance scripts. `docs/` documents how *this project* is built and operated: the L0–L6 test harness, the `trustmybot/plugin` repository itself, GitHub milestones and labels, the rc and release-gate flow, the contributing guide, and the benchmark campaign. None of it is part of the runtime a user's project uses.

The shipped runtime must be about THE USER'S project and fully self-contained:

- `CLAUDE.md`, `agents/`, `skills/`, `commands/`, `hooks/`, `templates/`
- the user-facing MCP server code

These surfaces must never reference TMB's own development process — no harness paths, no `L1`/`L5/L6` levels, no `tests/` directories, no internal milestone or release machinery. A user installing the plugin has none of that, so a prompt or hook that cites it leaks meaningless internal context and erodes trust. When a shipped surface needs to state a rule that TMB's docs also describe, it states the rule directly rather than pointing at a `docs/` file the user does not have.
## 3. Cut entropy at handoffs

TMB's trajectory exists to cut the entropy lost at each handoff: Human → bro → swe → code-reviewer → the next session. The design priority is stability first, then efficiency.

Judge a proposed feature by one question: does it reduce entropy at a handoff, or make a past decision re-findable? One discussion maps to one issue, so every decision is findable from the work it shaped.

## 4. Gates catch false success; audits chase perfection

swe and the two review gates optimize for speed. The swe checklist and its one trusted gate run are trusted, and a reviewer's job is to catch a false success claim — verify the recorded test results — not to demand a perfect change.

Exhaustive quality hunting is the audit's job, run separately against live data. This keeps the per-task loop fast without lowering the bar for what reaches main.

## 5. Remove cleanly

When a design is replaced, delete the old one outright. Code, prompts and docs describe only what is true now: no `no longer`, `used to`, `deprecated` or `previously` notes, and no commented-out remnants. The reason for the removal lives in the commit message and PR description, where history belongs.

## 6. Memory is hot and cold

**The DB is the only source of truth. Context is a disposable cache of it, written through and never the only copy. Every agent loads the smallest page it needs, and ends at a task boundary.** The tiers, their costs and the design test live in [`MEMORY.md`](./MEMORY.md).

## 7. Three layers of knowledge

Every fact about the codebase lives in exactly one of three layers:

1. **Docs: architecture.** Components, boundaries, invariants, and why they are built that way. A hand-written doc never names a class, function, file, column or enum value; where a reader needs one, it points to the world model or the code.
2. **World model: relationships.** What calls, reads or changes what (symbols), and the named design ideas anchored to them (concepts). It is generated by `/scan` and swe's completion report, never written by hand.
3. **Code: logic.** Self-explaining names and small cohesive units; a comment only for a why the code cannot show.

A fact in the wrong layer moves to the right one; it is never copied. One exception: a generated section guarded by a freshness test (such as the `audit.event_type` table in `ENUMS.md`) may carry detail, because the test fails when it drifts. When a doc drifts from the code, fix it by deleting the detail, not by re-copying it.
