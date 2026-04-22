# TMB Plugin

**Multi-agent engineering workflow for Claude Code. MIT, free forever.**

Most "agentic dev" tools either pile 14 skills onto auto-invocation (and watch Claude pick the wrong one) or ship 10 canned agents you didn't ask for. TMB does neither. It gives you **two agents globally**, **five editable placeholders per project**, and **an agent factory** so your roster matches your actual domain — not a company org chart someone imagined.

---

## Install

```bash
# Once Claude Code's plugin marketplace is live:
/plugin marketplace add trustmybot/plugin
/plugin install tmb@trustmybot
```

On first activation, the gatekeeper introduces itself and asks 2–3 short questions: your branching model (trunk-based, gitflow, etc.) and your identity preference for commits and agent comments. Takes ~30 seconds. Answers are stored in the plugin's trajectory DB via MCP (see `mcp/trajectory-server/docs/CONFIG_KEYS.md` for the exact keys) and configure the workflow guards for your repo. After that, it seeds the project's `.claude/agents/` with two editable domain-role placeholders (`ceo`, `cto`).

---

## How the roster works

### Global workflow agents (ship with the plugin)

Workflow agents whose behavior is meant to be consistent across projects. Install the plugin and you have them.

| Agent | What it does |
|---|---|
| `gatekeeper` | Your single entry point. Routes requests to the right specialist, runs a conditional project scan on the first code-touching ask, handles direct ops. Ask it anything — it will either answer or route. |
| `prompt-engineer` | Keeps agent prompts, skills, and workflow docs coherent as the project evolves. Rewrites drift, strips jargon, preserves intent. Never touches source. |
| `architect` | Captures intent into the trajectory DB (issues + discussions), writes task specs into `tasks.spec_body_md` via MCP, spawns + validates SWE. Double-checks every gatekeeper triage. |
| `swe` | Implements one task at a time in an isolated git worktree. Drives state via MCP; never edits its own spec. |
| `pr-reviewer` | Pre-commit and pre-push review gate. Records verdicts via MCP `validation_record`; read-only on files (no Edit tool by design). |

**Override any of these per-project** by creating a same-named file in the project's `.claude/agents/`. The local file wins.

### Domain-role templates (seeded on first activation per project)

When TMB activates in a project for the first time, it writes two editable agent files into your project's `.claude/agents/`:

| Agent | Starter role |
|---|---|
| `ceo` | Product direction and scope calls |
| `cto` | Technical architecture and feasibility |

**These are placeholders.** Every project has different product direction and tech stack — if your project is a medical device, your `cto` should know IEC 62304; if it's fintech, your `ceo` should know SOC 2 deadlines. The plugin doesn't pretend to know your domain; you edit these.

Delete either that doesn't apply (e.g., solo project → delete `ceo.md`).

### On-demand domain agents

When you hit a scenario the default roster doesn't cover — "I need a `legal-reviewer` for this merger PR" — gatekeeper proposes a tailored agent prompt, shows it to you, asks your permission, and writes it to `.claude/agents/` on approval. **Every new agent requires your explicit yes.** No silent ceremony.

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

Per-task execution specs live in the trajectory DB (`tasks.spec_body_md`),
not on disk — architect writes them via MCP, SWE reads via
`task_get(task_id)`. Only architecture narrative and snapshots are on
the filesystem.

Everything else — goals, discussions, validation attempts, task status, skill effectiveness, identity, branching-model config — lives in the plugin's trajectory DB (see below). The loop: **intent captured → alignment via discussion → tasks → SWE in worktree → pr-reviewer → ship**. Every transition auditable; kill Claude mid-loop, gatekeeper resumes on session start.

---

## Persistent trajectory (bundled MCP)

TMB ships a tiny local MCP server with a SQLite-backed trajectory database. Every issue, task, validation attempt, skill usage, and review verdict is recorded. Kill Claude mid-task, come back tomorrow, gatekeeper reads the trajectory and resumes where you left off. The database lives in `${CLAUDE_PLUGIN_DATA}/trajectory.db` and survives plugin updates.

Inspired by — and compatible with the lessons of — [claude-mem](https://github.com/thedotmack/claude-mem) and [claude-brain](https://github.com/mikeadolan/claude-brain). Different architecture: TMB's DB is a **workflow state machine**, not a memory bank.

---

## What makes TMB different

| Concern | TMB's take |
|---|---|
| Routing | Explicit — gatekeeper is the single door. No skill auto-invocation roulette. |
| State | Bundled SQLite via MCP. Queryable across sessions. |
| Info isolation | SWE literally cannot read your strategic context (issue body, discussion entries) while writing code. No context pollution. |
| Verification | Hard hook gates — no push until pr-reviewer has signed off on every task. |
| Roster | 2 global + 5 editable placeholders. Not a canned company. |
| Agent creation | User-approved only. No silent role sprawl. |

---

## Compared to adjacent tools

- **claude-mem** — passive memory layer, observational. TMB is active, opinionated workflow.
- **superpowers** — skill library with auto-invocation. TMB has explicit routing via gatekeeper to avoid wrong-skill pickup.
- **claude-brain** — SQLite + MCP for memory recall. TMB's SQLite is for trajectory/validation/retry state, not fact recall.

---

## Upgrade to Enterprise

Need team dashboards, multi-project trajectories, hardened sandbox permissions, multi-provider LLM?
→ [TMB Enterprise](https://github.com/trustmybot) (commercial, not MIT).

---

## License

MIT. Fork it, ship it, sell it. Credit nice but not required.
