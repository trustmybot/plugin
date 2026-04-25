# TMB Plugin

> **Trust me bro, it works.**

**Multi-agent engineering workflow for Claude Code. MIT, free forever.**

TMB turns Claude Code from a clever code-generator into a disciplined engineering workflow: one Human entry point (`bro`), a separate executor (`swe`), state that survives session kills, and structural gates that close around every commit.

> **Multi-platform structure, Claude Code today.** TMB ships only the Claude Code adapter as of v0.1.2. Codex / Cursor / OpenCode / Gemini CLI dirs exist as **placeholders** — see [`docs/multi-platform.md`](docs/multi-platform.md). Adapters arrive when there's user demand.

---

## Install

```bash
/plugin marketplace add trustmybot/plugin
/plugin install tmb@trustmybot
```

The plugin sits dormant until you address `@bro` in a message. No auto-takeover, no surprise behavior — every regular Claude Code workflow keeps working in TMB-enabled sessions.

---

## How to use

```
@bro write a todo cli
```

That's the entry point. Saying `@bro` activates the bro persona for the rest of the session. From there:

- **First trigger in a project** runs onboarding — bro asks 3 short questions (name, branching model, PR target). ~30 seconds. Answers persist to the trajectory DB.
- **Code-touching asks** route through bro → SWE, with bro verifying SWE's work before closing the task and pr-reviewer gating at `git push` time.
- **Read-only / casual asks** (status, "what's in this dir") are answered inline by bro without spawning anyone.

Casual messages that don't address `@bro` are answered by regular Claude Code — TMB stays out of your way.

Walkthroughs of every workflow path: [`docs/architecture/FLOWS.md`](docs/architecture/FLOWS.md).

---

## Why TMB

Three structural innovations. Each closes a specific failure mode that single-agent Claude Code hits in real projects.

### 1. Agent Harness — split planning from execution

TMB separates two cognitive jobs into two contexts:

- **`bro` — planner + gate.** Long-term, full-picture. Discusses with you, designs the breakdown, writes task specs to MCP, verifies SWE's work, drives retry loops. **Never writes source code itself** (one narrow exception: Direct Mode for ≤3-line typo fixes).
- **`swe` — executor.** Short-term, single-task focus. Implements one task per spawn in an isolated git worktree. **Cannot self-approve** — bro re-runs the spec's verification before closing the task; pr-reviewer signs off before push.

Memory is structurally split: bro carries strategy, swe carries only the task spec. No cross-contamination, no swe drifting into "while I'm here, let me also refactor X." `requireRoles` middleware in the bundled MCP server rejects out-of-role calls (consultants can't write workflow state, swe can't close its own task).

> **Single-agent (conflict of interest):** one context juggles goals + spec + diff + tests + verification, then claims "done" because the same context that wrote the code is also marking its own homework. You should never trust a guy self-merging their own PR.

Details: [`CLAUDE.md`](CLAUDE.md) (bro persona), [`templates/agents/swe.md`](templates/agents/swe.md), [`templates/agents/pr-reviewer.md`](templates/agents/pr-reviewer.md).

### 2. Trajectory Memory — state survives session kills

Every transition lands in a per-project SQLite DB at `<project>/.claude/tmb/trajectory.db`. Five tables you'll touch directly:

- **`issues`** — your goals + objectives, one row per ask
- **`discussions`** — Human ↔ bro Q+A, ADR (Architecture Decision Record) notes, design decisions
- **`roundtables`** + **`roundtable_votes`** — multi-consultant debate transcripts (when convened)
- **`tasks`** — execution specs (planned by bro, executed by swe), status, commit SHAs
- **`validation_attempts`** — pr-reviewer verdicts; the structural record of what was approved
- **`ledger`** + **`audit`** — append-only event log + tool I/O for replay

Kill Claude mid-task, come back tomorrow, bro reads the trajectory and resumes via `issue_resume` + `task_get`. The DB is canonical state — files are reserved for SE convention (README, CHANGELOG, ADRs) or agent-loaded context (prompts, skills).

**Big token dividend — no codebase-rediscovery tax.** A cold-start agent without persistent memory has to re-derive what your project even *is* every session: glob the tree, read scattered files, walk git log, query the schema. Hundreds of tool round-trips, each one pulling content back into context. TMB sidesteps this two ways:

- **Auto-regenerated architecture docs.** `docs/trustmybot/architecture/auto/{codebase-tree, module-graph, erd, changelog}.md` are pre-computed snapshots of the project's shape. Bro updates them lazily when ≥25 commits drift, so they're cheap. Bro reads ~4 files (~20 KB total) and knows the codebase — instead of dozens of Glob + Read calls bouncing into context.
- **Local SQLite, no remote round-trips.** The trajectory DB lives at `<project>/.claude/tmb/trajectory.db`. No memory service to call, no API to query, no rate-limit. `issue_resume` returns the active issue + recent ledger events as one local read.

> **Single-agent (amnesia + rediscovery tax):** kill Claude → lose your place. Re-explain context every session. Worse, the agent re-derives the codebase from scratch on every cold start — globbing, reading, walking git log — paying the discovery tax in tokens before it can do any actual work.

Details: [`docs/architecture/ERD.md`](docs/architecture/ERD.md) (schema + role-by-tool matrix), [`docs/architecture/FILES.md`](docs/architecture/FILES.md) (file map).

### 3. Agentic Workflow — structural gates, not habits

The harness + memory combine into a workflow with **two structural gates**, both hook-enforced:

- **Bro's task gate.** After SWE returns, bro re-runs the spec's `## Verification` commands, sanity-checks the diff against `## Files`, confirms each `## Success Criteria` bullet. Only then does the task flip to `closed`. **Non-negotiable, never skipped.**
- **PR-reviewer's push gate.** `scripts/hooks/git-push-guard.sh` blocks `git push` to protected branches until every commit in the push range has a passing `validation_attempts.verdict='pass'` row.

Plus structural decision-chain enforcement: `requireRoles` rejects role violations at the MCP boundary. Consultants (architect, cto, ceo, pm, your domain reviewers) literally cannot write `task_create_batch`, `task_update_status`, or `validation_record`. They're advisors, not deciders.

> **Single-agent (no brakes):** the agent says "done" — no structural gate before push, no second context to second-guess the verdict, no audit trail of what was actually verified.

Details: [`docs/architecture/FLOWS.md`](docs/architecture/FLOWS.md) (10 workflow flowcharts), [`CONTRIBUTING.md`](CONTRIBUTING.md#performance) (latency budget + trim doctrine).

---

## Roster on disk

The plugin ships **zero subagents**. Bro is a CLAUDE.md persona on main Claude. Every other agent lives as a **Lego template** that bro copies into `<project>/.claude/agents/` on demand:

| Template | When bro copies it |
|---|---|
| `swe.md` | First-run onboarding (silent, no extra question) |
| `pr-reviewer.md` | First time the push gate fires (`@bro review before push`) |
| `architect.md`, `cto.md`, `ceo.md`, `pm.md` | First time you ask for that consultant's read |

Domain consultants outside this set (`legal-reviewer`, `security-reviewer`, …) are drafted on demand via the `tmb_agent-creator` skill — bro proposes a tailored prompt, you approve, the file gets written. No canned company-org-chart pretending to know your domain.

Override any agent by editing the project-local file. Local wins.

---

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for branch workflow, test expectations, design principles, and the release ritual.

```bash
bash tests/run-all.sh
```

Architecture reference for new contributors:
- [`CLAUDE.md`](CLAUDE.md) — bro persona, first-action chain, push gate, Direct Mode
- [`docs/architecture/FLOWS.md`](docs/architecture/FLOWS.md) — workflow flowcharts
- [`docs/architecture/FILES.md`](docs/architecture/FILES.md) — file-by-file map
- [`docs/architecture/ERD.md`](docs/architecture/ERD.md) — SQLite schema
- [`tests/manual/scenarios.md`](tests/manual/scenarios.md) — Layer 3 dogfood test plan

---

## License

MIT. Fork it, ship it, sell it. Credit nice but not required.
