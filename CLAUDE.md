# TMB Plugin

This file is loaded automatically by Claude Code when the TMB plugin is enabled in a project. It defines the agent roster the plugin ships and the rules every agent must follow.

## ⚠️ Workspace boundary (critical rule for TMB-internal contributors)

If you are editing **this plugin itself** (i.e., this is the TMB workspace dogfooding setup, where this plugin's own code is being modified), **task specs and workflow files about plugin changes belong at the parent workspace level**, NOT inside this repo.

| Artifact | Correct location | Wrong location |
|---|---|---|
| Task specs about plugin changes | `../docs/trustmybot/tasks/*.{md,xml}` (TMB workspace) | ❌ `plugin/docs/trustmybot/tasks/` |
| Plugin roadmap / blueprint | `../docs/v0.3-blueprint.md` (TMB workspace) | ❌ `plugin/docs/v0.3-blueprint.md` |
| Implementation code (agents, skills, MCP, hooks) | `plugin/...` ✓ | n/a |

**Why**: this plugin is a public distributable. Downstream users install it and don't need TMB's internal phase-* task specs polluting their `docs/`. The plugin's own `docs/` should hold ONLY user-facing material (`CONFIG_KEYS.md`, etc.).

**Exception**: when this plugin is installed in a downstream user's project, the user's project will legitimately have its OWN `docs/trustmybot/tasks/` directory — that's correct, the plugin teaches that convention. Confusion arises only when developing the plugin itself dogfooding-style at TMB workspace level.

When spawning architect/SWE for plugin work, always direct task spec writes to `$WORKSPACE/docs/trustmybot/tasks/`, not `$PLUGIN_PATH/docs/trustmybot/tasks/`.


## Agent Roster (two-tier model)

### Tier 1 — Global workflow agents (plugin ships these; always available when enabled)

Workflow agents whose behavior is meant to be consistent across projects. They live at `plugin/agents/`. Users can override any of them for a specific project by creating a same-named file in the project's local `.claude/agents/` — the local file takes precedence over the plugin-shipped one.

| Agent | Model | Role |
|---|---|---|
| `gatekeeper` | Opus | Single Human entry point. Routes to specialists, runs a conditional pre-scan, handles direct read-only ops, drives the onboarding flow + agent-creator. |
| `prompt-engineer` | Sonnet | Maintains coherence of agent prompts, skill files, and workflow docs. Markdown-only edits; never touches source. |
| `architect` | Sonnet | Captures intent into MCP (issues + discussions); writes markdown task specs at `docs/trustmybot/tasks/<branch_id>.md`; spawns + validates SWE. |
| `swe` | Sonnet | Implements one task per markdown spec; runs in isolated git worktree; drives state via MCP; closes atomically with commit. |
| `pr-reviewer` | Sonnet | Pre-commit/pre-push review gate. Records verdicts via MCP `validation_record`; no Edit tool (strict read-only). |

### Tier 2 — Domain-role templates (seeded into `./.claude/agents/` on first activation per project)

Plugin ships starter prompts at `plugin/templates/agents/`. The `seed-project-agents` skill copies them into the project's `.claude/agents/` on first run. **Users are expected to edit these to match their project's domain** — every project has different product direction and tech stack, so these files are starting points, not shipped defaults.

| Agent | Starter role |
|---|---|
| `ceo` | Product direction, scope calls |
| `cto` | Technical architecture, feasibility |

### Tier 3 — On-demand domain agents (created via `agent-creator` skill)

When the default 2+5 don't cover a need, gatekeeper invokes the `agent-creator` skill to: understand the need → propose a tailored agent prompt → ask user explicit permission → write to `.claude/agents/<name>.md` on approval. **Every new agent requires explicit Human yes.** No silent ceremony.

`pm`, `gtm`, `designer` are NOT in the plugin — those are the TMB team's own product-work roles, kept TMB-workspace-local.

## Decision Flow

```
Human
  ↓
gatekeeper (route + pre-scan + direct ops + agent-creator driver
            + simple/difficult triage)
  ↓
architect (task files, SWE coordination, validation)
  ↓
swe (executor, in worktree)

architect also invokes: pr-reviewer (review gate) / prompt-engineer (doc fixes)
gatekeeper also invokes: ceo, cto, or any user-edited / on-demand agent
```

Architect double-checks the triage; gatekeeper's classification is a proposal.

## First Run

On first activation in a new project, gatekeeper introduces itself and runs a short setup before routing any requests. You'll see:

1. A brief hello and explanation of the two global agents.
2. One question about your branching model (e.g., trunk-based, gitflow, feature-branch).
3. One question about how you want agents to identify themselves in commits and comments.

Takes ~30 seconds. The answers are stored in the plugin's trajectory DB via MCP `config_set` and `identity_set` — not in a file. You can re-run this at any time via the `tmb-reonboard` skill. For the exact keys written, see `mcp/trajectory-server/docs/CONFIG_KEYS.md`.

## Workflow Files

| Artifact | Storage | Writers | Purpose |
|---|---|---|---|
| Issue intent + objective | SQLite `issues` table | gatekeeper, architect | Captured via MCP issue_create at routing time |
| Architect ↔ Human alignment | SQLite `discussions` table | gatekeeper, architect, human-via-relay | Captured via MCP discussion_append |
| Architecture decisions (ADRs) | `docs/trustmybot/architecture/manual/decisions/N-*.md` | architect | Hand-curated; consumer of Phase 5 |
| Per-task execution spec | `docs/trustmybot/tasks/<branch_id_filename>.md` | architect | Markdown frontmatter + body |
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

0. **Onboarding Mode** — triggered on first activation when `config_get("branching_model")` returns null OR `identity_get().created_at` is null (i.e., the plugin's trajectory DB has no onboarding record for this project). Gatekeeper runs the onboarding flow before any other routing: seeds project agents, asks branching-model question, asks identity preference. Exits to Silent default or Workflow Mode once config is written via MCP.
1. **Silent default** — read-only, status, or conversational ask. Gatekeeper handles directly; no agent spawn, no inventory.
2. **Workflow Mode** — triggered when MCP `issue_resume` returns an open issue with pending tasks, OR when the ask touches code. Gatekeeper classifies the request as `simple` or `difficult` (heuristic: difficult requires an update to `docs/trustmybot/architecture/`). The architect spawn receives `triage: simple|difficult` and may override. Every code change goes through architect — no bypass.
3. **Direct Mode** — Human explicitly says "direct mode" / "just do it". Skips some gates but architect is still the entry point for source changes.

## Code Style

- Self-documenting code. Avoid unnecessary comments.
- Emoji-prefixed commit messages (Conventional Commits style)
- Match existing patterns in the codebase before introducing new ones
