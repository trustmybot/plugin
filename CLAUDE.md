# TMB Plugin

This file is loaded automatically by Claude Code when the TMB plugin is enabled in a project. It defines the agent roster the plugin ships and the rules every agent must follow.

## Agent Roster (two-tier model)

### Tier 1 — Global (plugin ships these; always available when enabled)

| Agent | Model | Role |
|---|---|---|
| `gatekeeper` | Opus | Single Human entry point. Routes requests to specialists, runs a deterministic project pre-scan before any LLM-driven agent touches code, handles direct ops (reads, greps, status). Drives the agent-creator flow when a needed role doesn't exist yet. |
| `prompt-engineer` | Sonnet | Maintains coherence of agent prompts, skill files, and workflow docs as the project evolves. Markdown-only edits; never touches source. |

These two are the plugin's rigid contract with the user. They live at `plugin/agents/`.

### Tier 2 — Project-level placeholders (seeded into `./.claude/agents/` on first activation per project)

Plugin ships starter prompts at `plugin/templates/agents/`. The `seed-project-agents` skill copies them into the project's `.claude/agents/` on first run. **Users are expected to edit these to match their project's domain.**

| Agent | Starter role |
|---|---|
| `ceo` | Product direction, scope calls |
| `cto` | Technical architecture, feasibility |
| `architect` | Breaks BLUEPRINTs into task XML files; spawns and validates SWE; drives agent-creator flow |
| `swe` | Implements one task per XML spec; runs in isolated git worktree; closes its own task XML atomically with commit |
| `pr-reviewer` | Pre-commit and pre-push gate; signs `<reviewed-by>` and `<closed-by>` tags on task XML |

### Tier 3 — On-demand domain agents (created via `agent-creator` skill)

When the default 2+5 don't cover a need, gatekeeper invokes the `agent-creator` skill to: understand the need → propose a tailored agent prompt → ask user explicit permission → write to `.claude/agents/<name>.md` on approval. **Every new agent requires explicit Human yes.** No silent ceremony.

`pm`, `gtm`, `designer` are NOT in the plugin — those are the TMB team's own product-work roles, kept TMB-workspace-local.

## Decision Flow

```
Human
  ↓
gatekeeper (route + pre-scan + direct ops + agent-creator driver)
  ↓
architect (task files, SWE coordination, validation)
  ↓
swe (executor, in worktree)

architect also invokes: pr-reviewer (review gate) / prompt-engineer (doc fixes)
gatekeeper also invokes: ceo, cto, or any user-edited / on-demand agent
```

## Workflow Files

| File | Writers | Purpose |
|---|---|---|
| `bro/GOALS.md` | Human | Intent, priorities, constraints |
| `bro/DISCUSSION.md` | architect, Human | Alignment before BLUEPRINT |
| `bro/BLUEPRINT.md` | architect (Human approves) | Phased plan |
| `bro/tasks/*.xml` | architect | Per-task execution specs for SWE |

## Persistence (bundled MCP)

The plugin ships a Node MCP server at `plugin/mcp/trajectory-server/` registered via `plugin/.mcp.json`. It owns a SQLite database at `${CLAUDE_PLUGIN_DATA}/trajectory.db` (persistent across plugin updates). Agents call MCP tools (`issue_create`, `task_update_status`, `validation_record`, etc.) instead of writing raw state. `gatekeeper` calls `issue_resume()` on session start to detect and pick up unfinished work.

## Source Code Access Control

**ONLY the SWE agent (spawned via Architect) may create, edit, or modify
source code files.** This applies to:

- Runtime source directories (`src/`, `lib/`, `app/`, etc.)
- Test directories (`tests/`, `__tests__/`, `spec/`)
- Configuration files used by the runtime

**What the architect CAN edit:** files in `bro/`, `docs/`, `README.md`, `CLAUDE.md`, `.gitignore`.

**Enforcement:** `hooks/hooks.json` PreToolUse hooks block source edits outside worktrees. PR Reviewer flags any commit where the architect directly edited source code.

## Mode Rules

gatekeeper picks the mode based on the Human's ask:

1. `bro/GOALS.md` has unclosed goals and the ask relates to them → **Workflow Mode** (full GOALS → DISCUSSION → BLUEPRINT → tasks loop)
2. Human explicitly says "direct mode" / "just do it" → **Direct Mode** (skip some gates)
3. Multi-file coordinated changes → **Workflow Mode**
4. Simple read-only question → gatekeeper handles directly, no agent spawn

## Code Style

- Self-documenting code. Avoid unnecessary comments.
- Emoji-prefixed commit messages (Conventional Commits style)
- Match existing patterns in the codebase before introducing new ones
