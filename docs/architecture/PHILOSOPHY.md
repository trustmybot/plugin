# Design philosophy

The principles behind how TMB is shaped. Each is the reason a design looks the way it does; the other pages here show how it is built. How TMB keeps its own design, relationships and logic apart is in the [README](README.md).

## 1. Ideas become goals, goals become tasks

Work starts as the Human's idea and reaches code only through two conversions, each recorded where the next actor will look.

- **Idea to goal.** bro grounds the idea in past decisions and the project map, then asks two questions before anything is built: is it actionable, and does something existing (a maintained package or a published capability) already cover it? An actionable idea becomes an issue: the goal. Its plan lives in the issue, and every later choice is a recorded decision, the newest one winning.
- **Goal to tasks.** bro splits the goal into tasks. Each task's spec is a contract: numbered success criteria, the surfaces it touches, and the commands that verify it. A spec too large for one swe run splits into linked tasks, so each run fits in one context.

Every later check is judged against these records, never against what someone remembers the Human meant.

## 2. Dev-vs-user-runtime boundary

TMB's docs, test harness and release scripts describe how this project is built: its test levels, its repository, its milestones and its release gates. None of it ships to a user's project.

The shipped runtime (the persona, agents, skills, commands, hooks, templates and the MCP server) is about the user's project and is self-contained. It never refers to TMB's own development process, because a user has none of it and a prompt that cites it leaks meaningless internal context. When a shipped surface needs a rule TMB's docs also describe, it states the rule directly. For the same reason, a feature built for TMB's own needs must work in any user's project, reading that project's labels, milestones and repos from its data rather than assuming TMB's.

## 3. Cut entropy at handoffs

The trajectory exists to cut the context lost at each handoff: Human → bro → swe → code-reviewer → the next session. Stability comes first, then efficiency.

Judge a proposed feature by one question: does it reduce loss at a handoff, or make a past decision re-findable? One discussion maps to one issue, so every decision is findable from the work it shaped.

## 4. One owner per check

Each layer owns one level of quality, and no layer repeats another's check; a repeated check costs tokens and blurs who answers for a miss.

- **The Human** owns intent.
- **bro** owns the environment, the spec and the architecture. At close it judges whether the change fits the whole system, without re-running checks or re-reading the diff.
- **swe** owns functionality. Before closing it reviews its own work: every criterion and edge case has a change behind it, nothing outside the task was touched on the way, the tests for what it touched pass, and its report answers every criterion with evidence. When the spec contradicts itself or a fact is missing, it closes as failed rather than guessing.
- **code-reviewer** owns the diff. It reads it cold and probes what depends on it, and it is strict: a missed bug costs more than a rework.

bro and code-reviewer complement each other through a context asymmetry. bro's full picture makes the system-fit call possible but primes it to read a line for what it was meant to do; code-reviewer's fresh context, unprimed by intent, gives it better odds on the local bug bro would rationalize past.

Exhaustive quality hunting is the audit's job, run separately against live data, so the per-task loop stays lean.

## 5. Code enforces, prompts judge

What code can check, code checks; a prompt keeps only the calls that need judgment. A rule stated only in a prompt is a rule the model may skip.

Gates fail closed. A guard admits what it can prove safe and denies the rest, because a guard that blocks only known-bad input fails open on whatever it did not foresee.

## 6. Remove cleanly

When a design is replaced, delete the old one outright. Code, prompts and docs describe only what is true now, with no notes about what used to be and no commented-out remnants. The reason for a removal lives in the commit message and PR description, where history belongs.

## 7. Memory is hot and cold

The DB is the only source of truth. Context is a disposable cache of it, written through and never the only copy. Every agent loads the smallest page it needs and ends at a task boundary. [MEMORY.md](./MEMORY.md) covers the tiers, what each costs, and how to tell which tier a fact belongs in.
