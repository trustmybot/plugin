# TMB Plugin

> **Trust me bro, it works.**

**Multi-agent engineering workflow for Claude Code. MIT, free forever.**

Most "agentic dev" tools either pile 14 skills onto auto-invocation (and watch Claude pick the wrong one) or ship 10 canned agents you didn't ask for. TMB does neither. It gives you **two agents globally**, **five editable placeholders per project**, and **an agent factory** so your roster matches your actual domain — not a company org chart someone imagined.

---

## Install

```bash
# Once Claude Code's plugin marketplace is live:
/plugin marketplace add trustmybot/plugin
/plugin install tmb@trustmybot
```

On first activation, the bro introduces itself and asks 2–3 short questions: your branching model (trunk-based, gitflow, etc.) and your identity preference for commits and agent comments. Takes ~30 seconds. Answers are stored in the plugin's trajectory DB via MCP (see `mcp/trajectory-server/docs/CONFIG_KEYS.md` for the exact keys) and configure the workflow guards for your repo. No files are seeded into your project — domain agents come on-demand (see below).

---

## How the roster works

### Four global workflow agents (ship with the plugin)

Everything a coding workflow needs, nothing else. Install the plugin and you have them in every project where it's enabled.

| Agent | What it does |
|---|---|
| `bro` | Your single entry point. Routes requests to the right specialist, runs a conditional project scan on the first code-touching ask, handles direct read-only ops. Ask it anything — it will either answer or route. |
| `architect` | Captures intent into the trajectory DB (issues + discussions), writes task specs into `tasks.spec_body` via MCP, spawns + validates SWE. Also edits agent prompts, skill files, and workflow markdown when they drift. Double-checks every bro triage. |
| `swe` | Implements one task at a time in an isolated git worktree. Drives state via MCP; never edits its own spec. |
| `pr-reviewer` | Pre-commit and pre-push review gate. Records verdicts via MCP `validation_record`; read-only on files (no Edit tool by design). |

**Override any of these per-project** by creating a same-named file in the project's `.claude/agents/`. The local file wins.

### Domain agents arrive on-demand

When you hit a scenario the four-agent backbone doesn't cover — "I need a `legal-reviewer` for this merger PR", "this project needs a `ceo` to make scope calls", "we need a `cto` for IEC 62304 compliance" — bro invokes the `agent-creator` skill: drafts a tailored prompt for your project's context, shows it to you, asks your explicit permission, and writes it to `.claude/agents/` on approval. **Every new agent requires your explicit yes.** No silent ceremony, no canned company-org-chart pretending to know your domain.

Once created, the agent lives in your project forever (until you delete it). Next session, bro routes to it by name.

---

## Workflow contract

State is SQLite-canonical; files are generated snapshots. Your project's `docs/trustmybot/` directory hosts human-facing artifacts:

```
docs/trustmybot/
├── snapshots/<issue>.md     ← on-demand human-readable snapshot of issue state
└── architecture/
    ├── auto/                ← regenerated via /tmb refresh-architecture
    │   ├── codebase-tree.md
    │   ├── erd.md
    │   ├── module-graph.md
    │   └── changelog.md
    └── manual/              ← human-curated ADRs + narrative
        ├── decisions/
        ├── data-flow.md
        ├── infrastructure.md
        └── security-model.md
```

Per-task execution specs live in the trajectory DB (`tasks.spec_body`),
not on disk — architect writes them via MCP, SWE reads via
`task_get(task_id)`. Only architecture narrative and snapshots are on
the filesystem.

Everything else — goals, discussions, validation attempts, task status, skill effectiveness, identity, branching-model config — lives in the plugin's trajectory DB (see below). The loop: **intent captured → alignment via discussion → tasks → SWE in worktree → pr-reviewer → ship**. Every transition auditable; kill Claude mid-loop, bro resumes on session start.

---

## Persistent trajectory (bundled MCP)

TMB ships a tiny local MCP server with a SQLite-backed trajectory database. Every issue, task, validation attempt, skill usage, and review verdict is recorded. Kill Claude mid-task, come back tomorrow, bro reads the trajectory and resumes where you left off. The database lives in `${CLAUDE_PLUGIN_DATA}/trajectory.db` and survives plugin updates.

Inspired by — and compatible with the lessons of — [claude-mem](https://github.com/thedotmack/claude-mem) and [claude-brain](https://github.com/mikeadolan/claude-brain). Different architecture: TMB's DB is a **workflow state machine**, not a memory bank.

---

## What makes TMB different

| Concern | TMB's take |
|---|---|
| Routing | Explicit — bro is the single door. No skill auto-invocation roulette. |
| State | Bundled SQLite via MCP. Queryable across sessions. |
| Info isolation | SWE literally cannot read your strategic context (issue body, discussion entries) while writing code. No context pollution. |
| Verification | Hard hook gates — no push until pr-reviewer has signed off on every task. |
| Roster | 4 global workflow agents; domain agents on-demand. Not a canned company. |
| Agent creation | User-approved only. No silent role sprawl. |

---

## Compared to adjacent tools

- **claude-mem** — passive memory layer, observational. TMB is active, opinionated workflow.
- **superpowers** — skill library with auto-invocation. TMB has explicit routing via bro to avoid wrong-skill pickup.
- **claude-brain** — SQLite + MCP for memory recall. TMB's SQLite is for trajectory/validation/retry state, not fact recall.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for branch workflow, test expectations, and design principles.

Run the full test suite before opening a PR:

```bash
bash tests/run-all.sh
```

Full testing guide — including manual dogfood walkthrough and how to write new hook/MCP tests — at [tests/README.md](tests/README.md).

**Architecture reference** for new contributors:
- [`docs/architecture/FILES.md`](docs/architecture/FILES.md) — file-by-file map of the whole plugin
- [`docs/architecture/ERD.md`](docs/architecture/ERD.md) — SQLite schema with FK + soft-ref tables
- [`docs/architecture/FLOWS.md`](docs/architecture/FLOWS.md) — 9 workflow flowcharts (onboarding, simple/difficult task, agent-creator, skill creation, PR review, architecture regen, SWE retry, roundtable)
- [`docs/testing/scenarios.md`](docs/testing/scenarios.md) — dogfood test plan: verbatim user-prompt triggers + expected behavior for every flow

---

## License

MIT. Fork it, ship it, sell it. Credit nice but not required.
