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

First time you activate TMB in a project, it seeds the project's `.claude/agents/` with five editable placeholders (see below).

---

## How the roster works

### Global (ships with the plugin)

| Agent | What it does |
|---|---|
| `gatekeeper` | Your single entry point. Routes requests to the right specialist, runs a deterministic project scan before any LLM-driven agent touches your code, handles direct ops (reads, greps, status). Ask it anything; it will either answer or route. |
| `prompt-engineer` | Keeps your agent prompts, skills, and workflow docs coherent as the project evolves. Rewrites drift, strips jargon, preserves intent. Never touches source code. |

These two are enough to start. You install the plugin and you have them.

### Project-level placeholders (seeded on first activation per project)

When TMB activates in a project for the first time, it writes five editable agent files into your project's `.claude/agents/`:

| Agent | Starter role |
|---|---|
| `ceo` | Product direction and scope calls |
| `cto` | Technical architecture and feasibility |
| `architect` | Breaks plans into task XML files, spawns SWE, validates output |
| `swe` | Implements one task at a time in an isolated git worktree |
| `pr-reviewer` | Pre-commit and pre-push review gate |

**These are placeholders.** TMB ships sane defaults, but you're expected to edit them to match your project's domain. If your project is a medical device, your "pr-reviewer" might gain knowledge of HIPAA checklists. If it's a fintech, your "cto" might load compliance skills. The plugin doesn't pretend to know your domain.

### On-demand domain agents

When you hit a scenario the default 5+2 don't cover — "I need a `legal-reviewer` for this merger PR" — gatekeeper proposes a tailored agent prompt, shows it to you, asks your permission, and writes it to `.claude/agents/` on approval. **Every new agent requires your explicit yes.** No silent ceremony.

---

## Workflow contract

Your project's `bro/` directory becomes the workflow state:

```
bro/
├── GOALS.md           ← you write what to build
├── DISCUSSION.md      ← architect asks clarifying questions, you answer below them
├── BLUEPRINT.md       ← architect (or cto) drafts phased design; you approve
└── tasks/*.xml        ← architect breaks blueprint into executable tasks
                        (one SWE spawn per task file)
```

The loop: **goals → alignment → blueprint → tasks → review → ship**. Each phase is a file, each file has a designated writer and reader, each transition is auditable.

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
| Info isolation | SWE literally cannot read your `GOALS.md` while writing code. No context pollution. |
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
