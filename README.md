# trustmybot/plugin

Multi-agent engineering workflow for Claude Code. MIT, free forever.

---

## What it is

TMB is a Claude Code plugin that wires up a 5-agent multi-role workflow
(secretary, architect, swe, pr-reviewer, prompt-engineer) with SQLite
run-state persistence via a bundled MCP server. Every task, validation
attempt, and review verdict is recorded across sessions.

---

## Install

Requires Claude Code with native plugin support.

```
/plugin marketplace add trustmybot/plugin
/plugin install tmb@trustmybot
```

---

## Agents

| Agent | Model | Role |
|---|---|---|
| `secretary` | Opus | Human's single entry point. Routes requests, relays results, handles direct ops. |
| `architect` | Opus | Breaks BLUEPRINTs into task XML files, spawns SWE, validates output. |
| `swe` | Sonnet | Implements one task at a time in an isolated git worktree. Executor only. |
| `pr-reviewer` | Opus | Pre-commit and pre-push review gate. Blocks bad diffs before they land. |
| `prompt-engineer` | Sonnet | Rewrites prompts, agent files, and skills. Never touches source code. |

---

## Agent builder

Need a `legal-reviewer` for a compliance PR, or a `data-engineer` for a
migration task? The secretary proposes a tailored agent prompt, shows it to
you, waits for your explicit approval, and writes it to `.claude/agents/`.
Every new agent requires a yes. No silent role sprawl.

See the `agent-creator` skill in `.claude/skills/agent-creator.md`.

---

## Workflow files

Your project's `bro/` folder holds the workflow state:

| File | Purpose |
|---|---|
| `bro/GOALS.md` | You write what to build. Architect reads this first. |
| `bro/DISCUSSION.md` | Architect asks clarifying questions; you answer below them. |
| `bro/BLUEPRINT.md` | Phased design plan. Architect drafts, Human approves. |
| `bro/tasks/*.xml` | One XML per task. Architect writes, SWE executes exactly one at a time. |

The loop: goals -> alignment -> blueprint -> tasks -> review -> ship.

---

## Persistence

TMB ships a local MCP server backed by SQLite. The run-state database lives at
`${CLAUDE_PLUGIN_DATA}/trajectory.db` and survives plugin updates. It exposes
17 tools covering task lifecycle, validation retries, skill usage, and review
verdicts. Kill Claude mid-task, come back tomorrow, and the secretary resumes
from recorded state.

---

## Dependencies

TMB depends on two other plugins from the Claude Code marketplace:

- `anthropic/commit-commands` — provides `/commit` and related git helpers
- `anthropic/pr-review-toolkit` — provides the review primitives pr-reviewer builds on

Install them before or alongside TMB:

```
/plugin marketplace add anthropic/commit-commands
/plugin marketplace add anthropic/pr-review-toolkit
/plugin marketplace add trustmybot/plugin
/plugin install tmb@trustmybot
```

---

## Dogfooding / local dev

To develop TMB against itself using a local checkout:

```
/plugin marketplace add --local ./plugin
/plugin install tmb@local
```

Changes to `plugin/.claude/` are live immediately — no reinstall needed.

---

## Legacy

`install.sh` is deprecated as of v0.2 and will be removed in v0.3. Use the
native plugin install flow above.

---

## License

[MIT](LICENSE). Fork it, ship it, sell it. Credit nice but not required.
