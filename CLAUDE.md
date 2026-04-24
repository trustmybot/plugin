# TMB Plugin

This file is loaded automatically by Claude Code when the TMB plugin is enabled in a project. It defines the agent roster the plugin ships and the rules every agent must follow.

## ⚠️ Workspace boundary (critical rule for TMB-internal contributors)

If you are editing **this plugin itself** (i.e., this is the TMB workspace dogfooding setup, where this plugin's own code is being modified), **task specs and workflow files about plugin changes belong at the parent workspace level**, NOT inside this repo.

| Artifact | Correct location | Wrong location |
|---|---|---|
| Task specs about plugin changes | `tasks.spec_body` in the TMB-workspace-shared trajectory DB | ❌ Any on-disk `tasks/` directory under `docs/trustmybot/` |
| Plugin roadmap / blueprint | `../docs/v0.3-blueprint.md` (TMB workspace) | ❌ `plugin/docs/v0.3-blueprint.md` |
| Implementation code (agents, skills, MCP, hooks) | `plugin/...` ✓ | n/a |

**Why**: this plugin is a public distributable. Downstream users install it and don't need TMB's internal phase-* task specs polluting their `docs/`. The plugin's own `docs/` should hold ONLY user-facing material (`CONFIG_KEYS.md`, architecture narrative, etc.).

**Exception**: downstream user projects never have a `tasks/` subdirectory under `docs/trustmybot/`; all task specs live in their project's local trajectory DB. `docs/trustmybot/` is reserved for architecture narrative and generated snapshots.

When spawning architect/SWE for plugin work, task specs are written into the TMB-workspace trajectory DB via `task_create_batch` (with `spec_body`). SWE fetches them via `task_get(task_id)`. No on-disk spec files.


## Agent Roster

The plugin ships **four global workflow agents** — the minimum needed for any code-producing workflow. They live at `plugin/agents/` and load automatically in every project where the plugin is enabled. Users can override any of them for a specific project by creating a same-named file in the project's local `.claude/agents/` — the local file takes precedence.

| Agent | Model | Role |
|---|---|---|
| `gatekeeper` | Opus | Single Human entry point. Routes to specialists, runs a conditional pre-scan, handles direct read-only ops, drives the onboarding flow + `agent-creator`. |
| `architect` | Sonnet | Captures intent into MCP (issues + discussions); writes task specs into `tasks.spec_body` via `task_create_batch`; spawns + validates SWE; **also edits agent prompts, skill files, and workflow markdown when they drift** (see `skills/docs-conventions` prompt-editing rules). |
| `swe` | Sonnet | Implements one task per spec; runs in isolated git worktree; drives state via MCP; closes atomically with commit. |
| `pr-reviewer` | Sonnet | Pre-commit/pre-push review gate. Records verdicts via MCP `validation_record`; no Edit tool (strict read-only). |

### On-demand domain agents (created via `agent-creator` skill)

Nothing else ships. When the user needs a domain role (`ceo`, `cto`, `pm`, `legal-reviewer`, ...), gatekeeper invokes the `agent-creator` skill: understand the need → propose a tailored prompt → ask explicit permission → write to `.claude/agents/<name>.md` on approval. **Every new agent requires explicit Human yes.** No silent ceremony.

## Decision Flow

```
Human
  ↓
gatekeeper (route + pre-scan + direct ops + agent-creator driver
            + simple/difficult triage)
  ↓
architect (task specs via MCP, SWE coordination, validation, markdown edits)
  ↓
swe (executor, in worktree)

architect also invokes: pr-reviewer (review gate)
gatekeeper also invokes: any user-created domain agent in .claude/agents/
```

Architect double-checks the triage; gatekeeper's classification is a proposal.

## First Run

On first activation in a new project, gatekeeper introduces itself and runs a short setup before routing any requests. You'll see:

1. A brief hello and explanation of the four workflow agents.
2. One question about your branching model (e.g., trunk-based, gitflow, feature-branch).
3. One question about how you want agents to identify themselves in commits and comments.

Takes ~30 seconds. The answers are stored in the plugin's trajectory DB via MCP `config_set` and `identity_set` — not in a file. You can re-run this at any time via the `tmb-reonboard` skill. For the exact keys written, see `mcp/trajectory-server/docs/CONFIG_KEYS.md`.

## Workflow Files

| Artifact | Storage | Writers | Purpose |
|---|---|---|---|
| Issue intent + objective | SQLite `issues` table | gatekeeper, architect | Captured via MCP issue_create at routing time |
| Architect ↔ Human alignment | SQLite `discussions` table | gatekeeper, architect, human-via-relay | Captured via MCP discussion_append |
| Architecture decisions (ADRs) | `docs/trustmybot/architecture/manual/decisions/N-*.md` | architect | Hand-curated; referenced by the architecture-regen flow |
| Per-task execution spec | SQLite `tasks.spec_body` | architect | Markdown body stored inline on the tasks row; fetched via `task_get(task_id)` |
| Read-only review snapshot | `docs/trustmybot/snapshots/<issue_id>.md` | MCP `issue_snapshot_md` (called by architect / pr-reviewer) | Generated for human review handoff |
| Task lifecycle state | SQLite `tasks` + `validation_attempts` | swe (status), pr-reviewer (validation_record), architect (close) | Authoritative. Files are snapshots. |

## Persistence (bundled MCP)

The plugin ships a Node MCP server at `plugin/mcp/trajectory-server/` registered via `plugin/.mcp.json`. It owns a SQLite database at `<project-root>/.claude/tmb/trajectory.db` — project-local, per-user, gitignored (the plugin-root `.gitignore` excludes `.claude/`). Each project has its own DB; each developer has their own copy. Set `TRAJECTORY_DB_PATH` to override (e.g., `:memory:` for ephemeral CI runs). Agents call MCP tools (`issue_create`, `task_update_status`, `validation_record`, etc.) instead of writing raw state. `gatekeeper` calls `issue_resume()` on session start to detect and pick up unfinished work.

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

0. **Onboarding Mode** — triggered on first activation when `config_get("branching_model")` returns null OR `identity_get().created_at` is null (i.e., the plugin's trajectory DB has no onboarding record for this project). Gatekeeper runs the onboarding flow before any other routing: asks the branching-model question, asks identity preference. Exits to Silent default or Workflow Mode once config is written via MCP.
1. **Silent default** — read-only, status, or conversational ask. Gatekeeper handles directly; no agent spawn, no inventory.
2. **Workflow Mode** — triggered when MCP `issue_resume` returns an open issue with pending tasks, OR when the ask touches code. Gatekeeper classifies the request as `simple` or `difficult` (heuristic: difficult requires an update to `docs/trustmybot/architecture/`). The architect spawn receives `triage: simple|difficult` and may override. Every code change goes through architect — no bypass.
3. **Direct Mode** — Human explicitly says "direct mode" / "just do it". Skips some gates but architect is still the entry point for source changes.

## Code Style

- Self-documenting code. Avoid unnecessary comments.
- Emoji-prefixed commit messages (Conventional Commits style)
- Match existing patterns in the codebase before introducing new ones
