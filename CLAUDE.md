# TMB Plugin

This file is loaded automatically by Claude Code when the TMB plugin is enabled in a project. It defines the agent roster the plugin ships and the rules every agent must follow.

## ⚠️ Workspace boundary (critical rule for TMB-internal contributors)

If you are editing **this plugin itself** (i.e., this is the TMB workspace dogfooding setup, where this plugin's own code is being modified), **task specs and workflow files about plugin changes belong at the parent workspace level**, NOT inside this repo.

| Artifact | Correct location | Wrong location |
|---|---|---|
| Task specs about plugin changes | `../docs/trustmybot/tasks/*.{md,xml}` (TMB workspace) | ❌ `plugin/docs/trustmybot/tasks/` |
| Plugin roadmap / blueprint | `../docs/v0.3-blueprint.md` (TMB workspace) | ❌ `plugin/docs/v0.3-blueprint.md` |
| Implementation code (agents, skills, MCP, hooks) | `plugin/...` ✓ | n/a |

**Why**: this plugin is a public distributable. Downstream users install it and don't need TMB's internal phase-* task specs polluting their `docs/`. The plugin's own `docs/` should hold ONLY user-facing material (`SPEC-FORMAT.md`, `CONFIG_KEYS.md`, etc.).

**Exception**: when this plugin is installed in a downstream user's project, the user's project will legitimately have its OWN `docs/trustmybot/tasks/` directory — that's correct, the plugin teaches that convention. Confusion arises only when developing the plugin itself dogfooding-style at TMB workspace level.

When spawning architect/SWE for plugin work, always direct task spec writes to `/Users/Zax/Git/GitHub/TMB/docs/trustmybot/tasks/`, not `/Users/Zax/Git/GitHub/TMB/plugin/docs/trustmybot/tasks/`.


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
| `architect` | Breaks issues into task specs; spawns and validates SWE; drives agent-creator flow |
| `swe` | Implements one task per markdown spec; runs in isolated git worktree; closes its own task atomically with commit |
| `pr-reviewer` | Pre-commit and pre-push gate; calls MCP validation_record on pass/fail |

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

| Artifact | Storage | Writers | Purpose |
|---|---|---|---|
| Issue intent + objective | SQLite `issues` table | gatekeeper, architect | Captured via MCP issue_create at routing time |
| Architect ↔ Human alignment | SQLite `discussions` table | gatekeeper, architect, human-via-relay | Captured via MCP discussion_append |
| Architecture decisions (ADRs) | `docs/trustmybot/architecture/manual/decisions/N-*.md` | architect | Hand-curated; consumer of Phase 5 |
| Per-task execution spec | `docs/trustmybot/tasks/<branch_id_filename>.md` | architect | Markdown frontmatter + body — see `docs/trustmybot/SPEC-FORMAT.md` |
| Read-only review snapshot | `docs/trustmybot/snapshots/<issue_id>.md` | MCP `issue_snapshot_md` (called by architect / pr-reviewer) | Generated for human review handoff |
| Task lifecycle state | SQLite `tasks` + `validation_attempts` | swe (status), pr-reviewer (validation_record), architect (close) | Authoritative. Files are snapshots. |

## Persistence (bundled MCP)

The plugin ships a Node MCP server at `plugin/mcp/trajectory-server/` registered via `plugin/.mcp.json`. It owns a SQLite database at `${CLAUDE_PLUGIN_DATA}/trajectory.db` (persistent across plugin updates). Agents call MCP tools (`issue_create`, `task_update_status`, `validation_record`, etc.) instead of writing raw state. `gatekeeper` calls `issue_resume()` on session start to detect and pick up unfinished work.

## Source Code Access Control

**ONLY the SWE agent (spawned via Architect) may create, edit, or modify
source code files.** This applies to:

- Runtime source directories (`src/`, `lib/`, `app/`, etc.)
- Test directories (`tests/`, `__tests__/`, `spec/`)
- Configuration files used by the runtime

**What the architect CAN edit:** files in `docs/trustmybot/`, `docs/trustmybot/snapshots/`, `docs/`, `README.md`, `CLAUDE.md`, `.gitignore`.

**Enforcement:** `hooks/hooks.json` PreToolUse hooks block source edits outside worktrees. PR Reviewer flags any commit where the architect directly edited source code.

## Mode Rules

gatekeeper picks the mode based on the Human's ask:

1. MCP `issue_resume` returns an open issue with pending tasks → **Workflow Mode**
2. Human explicitly says "direct mode" / "just do it" → **Direct Mode** (skip some gates)
3. Multi-file coordinated changes → **Workflow Mode**
4. Simple read-only question → gatekeeper handles directly, no agent spawn

## Code Style

- Self-documenting code. Avoid unnecessary comments.
- Emoji-prefixed commit messages (Conventional Commits style)
- Match existing patterns in the codebase before introducing new ones
