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

### Channels

The `trustmybot` marketplace currently ships two channels of the `tmb` plugin:

| Channel | Install | Tracks | Audience |
|---|---|---|---|
| **`tmb`** (stable) | `/plugin install tmb@trustmybot` | `main` branch (latest tag) | Production users — only validated releases land here |
| **`tmb-rc`** (release candidate) | `/plugin install tmb-rc@trustmybot` | `rc` branch (currently-testing build) | Beta testers — help validate risky changes pre-promotion. Tolerate occasional breakage. |

The RC channel exists because v0.2.0 and v0.3.0 both shipped install-path bugs that broke every stable user. Now anything risky goes through `tmb-rc` first; stable users only get validated releases. See [`CONTRIBUTING.md` § Release ritual](CONTRIBUTING.md#release-ritual).

### Manage the marketplace from CC

In Claude Code, navigate the plugin UI:

```
/plugin    →    Marketplaces    →    trustmybot    →    Browse plugins
```

You'll see one entry per channel (`tmb`, `tmb-rc`). Future channels and add-on plugins from the trustmybot org will appear here as new entries.

### Refresh after upstream marketplace changes

`/plugin marketplace add trustmybot/plugin` is **idempotent** — it won't re-fetch if the marketplace was already added in a previous session. If new channels (or new plugins) were added upstream after you first added the marketplace, refresh:

```
/plugin marketplace update trustmybot
```

If `update` isn't supported in your CC version:

```
/plugin marketplace remove trustmybot
/plugin marketplace add trustmybot/plugin
```

### Coming later — pinned versions + add-ons

The marketplace can host more channels and entirely new plugins as the trustmybot ecosystem grows:

- **Pinned-version channels** like `tmb-v0.3.1` (locks to a specific release tag, no auto-update). Useful for users who want a frozen baseline. Achievable today by adding a `marketplace.json` entry with `"source": { "ref": "v0.3.1" }` — file an issue if you want a specific pinned channel published.
- **Add-on plugins** like `tmb-monitoring`, `tmb-fintech`, etc. (separate plugins published from the same trustmybot marketplace). Each gets its own entry with its own source repo / ref / channels.

Both extend the same marketplace UI — no separate `add` step needed for users; they just appear in `Browse plugins` when the marketplace refreshes.

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

Four structural innovations, in service of long-term engineering quality. Each closes a specific failure mode that single-agent Claude Code hits in real projects.

### 1. Agent Harness — split planning from execution

TMB separates two cognitive jobs into two contexts:

- **`bro` — planner + gate.** Long-term, full-picture. Discusses with you, designs the breakdown, writes task specs to MCP, verifies SWE's work, drives retry loops. **Never writes source code itself** — every code change goes through SWE.
- **`swe` — executor.** Short-term, single-task focus. Implements one task per spawn in an isolated git worktree. **Cannot self-approve** — bro re-runs the spec's verification before closing the task; pr-reviewer signs off before push.

Memory is structurally split: bro carries strategy, swe carries only the task spec. No cross-contamination, no swe drifting into "while I'm here, let me also refactor X." Out-of-role calls are rejected at the wire — consultants can't write workflow state, swe can't close its own task.

> **Single-agent (conflict of interest):** one context juggles goals + spec + diff + tests + verification, then claims "done" because the same context that wrote the code is also marking its own homework. You should never trust a guy self-merging their own PR.

Details: [`CLAUDE.md`](CLAUDE.md) (bro persona), [`agents/swe.md`](agents/swe.md), [`agents/pr-reviewer.md`](agents/pr-reviewer.md).

### 2. Trajectory Memory — state survives session kills

Every transition lands in a per-project SQLite DB at `<project>/.claude/<plugin-name>/trajectory.db` (`tmb/` for stable, `tmb-rc/` for the RC channel — fully isolated). Five tables you'll touch directly:

- **`issues`** — your goals + objectives, one row per ask
- **`discussions`** — Human ↔ bro Q+A, ADR (Architecture Decision Record) notes, design decisions
- **`roundtables`** + **`roundtable_votes`** — multi-consultant debate transcripts (when convened)
- **`tasks`** — execution specs (planned by bro, executed by swe), status, commit SHAs
- **`validation_attempts`** — pr-reviewer verdicts; the structural record of what was approved
- **`ledger`** + **`audit`** — append-only event log + tool I/O for replay

Kill Claude mid-task, come back tomorrow, bro reads the trajectory and resumes where you left off. The DB is canonical state — files stay reserved for SE convention (README, CHANGELOG, ADRs) or agent-loaded context (prompts, skills).

**Big token dividend — no codebase-rediscovery tax.** A cold-start agent without persistent memory has to re-derive what your project even *is* every session: glob the tree, read scattered files, walk git log, query the schema. Hundreds of tool round-trips, each one pulling content back into context. TMB sidesteps this two ways:

- **Auto-regenerated architecture docs.** A handful of pre-computed snapshots (codebase tree, module graph, schema map, recent changelog) live under your project's docs dir, refreshed lazily as commits drift. Bro reads those once at session start and has the project's shape — no glob-and-read bounce.
- **Local SQLite, no remote round-trips.** Trajectory lives in your project, not in a cloud service. No API call, no rate limit, no auth dance. Resume is one local read.

> **Single-agent (amnesia + rediscovery tax):** kill Claude → lose your place. Re-explain context every session. Worse, the agent re-derives the codebase from scratch on every cold start — globbing, reading, walking git log — paying the discovery tax in tokens before it can do any actual work.

Details: [`docs/architecture/ERD.md`](docs/architecture/ERD.md) (schema + role-by-tool matrix), [`docs/architecture/FILES.md`](docs/architecture/FILES.md) (file map).

### 3. Evaluation System — verification you can audit later

Long-term engineering quality decays when verification is implicit. TMB makes it structural and persistent through **two gates** that close around every commit:

- **Bro's task gate (per task).** Every task carries a contract — what changes, what proves it works, what success looks like. After SWE returns, bro re-runs the verification, checks the diff matches what was promised, confirms success criteria. Fast, mandatory, **never skipped**.
- **PR-reviewer's push gate (per push).** `git push` to a protected branch is blocked by a pre-push hook unless every commit being pushed has been signed off by pr-reviewer. No back-channel, no "I'll review after merge."

**Verdicts persist next to the code they judged.** Every pr-reviewer pass/fail lands in the trajectory DB alongside the task it ruled on — not in chat scrollback that disappears with the session. Six months later, when someone asks "why did we ship this commit?", the verdict + reasoning is still queryable. Long-term quality means the *reasoning* survives, not just the diff.

> **Single-agent (no audit):** the agent says "tests pass" — you trust the chat scrollback. Three days later production breaks, the chat is gone, the reasoning is gone, and the only artifact is a green CI badge that didn't catch what mattered.

Details: [`docs/architecture/FLOWS.md` § 6 (Push gate)](docs/architecture/FLOWS.md#6-push-gate--pr-review), [`agents/pr-reviewer.md`](agents/pr-reviewer.md), [`docs/architecture/ERD.md`](docs/architecture/ERD.md) (`validation_attempts` table).

### 4. Agentic Workflow — composable, not monolithic

The harness + memory + evaluation compose into a workflow whose shape **scales by ask**:

- **Simple task** (a feature, no architecture impact) → bro picks defaults inline, spawns SWE, verifies, closes. ~2–3 min.
- **Difficult task** (architecture change, ADR needed) → bro asks scope-clarifying questions, captures decisions to ADR, then runs the simple-task flow.
- **Multi-task batch** → planning amortized across tasks; pr-reviewer's push gate fires once over the batch, not per task.

Wire-enforced decision chain: the same MCP server that records workflow state structurally rejects calls that would let a consultant decide for you, or let SWE close its own task. Doctrine is a constraint, not a habit.

> **Single-agent (one-shape-fits-all):** every ask gets the same monolithic loop — no fast-lane for typos, no escalation path for cross-cutting changes. Either too heavy for trivial work or too thin for architectural decisions.

Details: [`docs/architecture/FLOWS.md`](docs/architecture/FLOWS.md) (10 workflow flowcharts), [`CONTRIBUTING.md` § Performance](CONTRIBUTING.md#performance) (latency budget + trim doctrine).

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
- [`CLAUDE.md`](CLAUDE.md) — bro persona, first-action chain, push gate
- [`docs/architecture/FLOWS.md`](docs/architecture/FLOWS.md) — workflow flowcharts
- [`docs/architecture/FILES.md`](docs/architecture/FILES.md) — file-by-file map
- [`docs/architecture/ERD.md`](docs/architecture/ERD.md) — SQLite schema
- [`tests/manual/scenarios.md`](tests/manual/scenarios.md) — Layer 3 dogfood test plan

---

## License

MIT. Fork it, ship it, sell it. Credit nice but not required.
