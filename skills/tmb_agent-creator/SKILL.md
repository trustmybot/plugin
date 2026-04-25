---
name: tmb_agent-creator
description: Add a project-local agent. PRIMARY MODE — copy from `templates/agents/<name>.md` verbatim. FALLBACK — draft from scratch when no shipped template matches the requested name. Always asks Human approval before writing. Never edits the body of any agent file.
agent: bro
allowed-tools: Read, Write, Glob, Grep, AskUserQuestion, mcp__plugin_tmb_trajectory-server__ledger_log
---

# tmb_agent-creator

## A. Purpose

Add a named, persistent agent to a project's `.claude/agents/`. Two modes:

1. **Template-copy mode** (PRIMARY) — when `${CLAUDE_PLUGIN_ROOT}/templates/agents/<name>.md` exists for the requested name, copy it verbatim into the project. This is the Lego path: bro never edits the body of a copied template.
2. **From-scratch mode** (FALLBACK) — when no template matches (e.g. `legal-reviewer`, `security-reviewer`, project-specific role), bro drafts a fresh prompt with Human approval and writes it into the project.

Every creation requires explicit Human approval — auto-creation is never permitted.

## B. When invoked

Bro invokes this skill when ALL of the following hold:

1. The user's request needs a named, persistent agent (consultant for a specific role) AND
2. The role does not already exist in `.claude/agents/`.

Do NOT invoke for one-off sub-tasks that a Task tool spawn can handle.

User-created agents default to **consultant** scope: they advise, return analysis to bro, and never write workflow state (`task_create_batch`, `task_update_status`, `validation_record`, `issue_create` are all server-rejected for non-bro / non-swe / non-pr-reviewer callers — see `mcp/trajectory-server/src/middleware/agent-scope.ts`). The decision chain stays **Human → bro → swe**, with `pr-reviewer` as the gate.

## C. Shipped templates (template-copy mode triggers when name matches)

| Template | Role | Lines |
|---|---|---|
| `architect.md` | System-design consultant — load-bearing assumptions, simpler alternatives, trade-offs, risks | ~21 |
| `cto.md` | Technical strategy consultant — scaling, dependency posture, build/CI direction | ~21 |
| `ceo.md` | Product-scope consultant — prioritization, business framing | ~21 |
| `pm.md` | Product-strategy consultant — user-need framing, success metrics | ~21 |

(`swe.md` and `pr-reviewer.md` also live as templates but they're handled by `tmb_bootstrap`, not this skill.)

If the Human's request matches a shipped template name → **template-copy mode**. Otherwise → **from-scratch mode**.

## D. Reserved names (always refuse)

These names map to plugin protocol roles. If the user requests one, refuse and ask for a different name:

- `bro`
- `swe`
- `pr-reviewer`

Other names — including `architect`, `cto`, `ceo`, `pm`, `legal-reviewer`, anything else — are allowed. Shipped templates exist for the first four; the rest use from-scratch mode.

## E. Execution — template-copy mode

Triggered when `${CLAUDE_PLUGIN_ROOT}/templates/agents/<name>.md` exists.

### Step 1 — Show + ask

Read the template via `Read` (do not transform). Present it in a fenced code block with a one-liner explaining it's a minimal Lego template and bro will not edit the body. Ask verbatim:

> "Copy `templates/agents/<name>.md` to `.claude/agents/<name>.md` verbatim? Project-specific behavior gets attached later via `tmb_skill-creator`. (yes/no)"

### Step 2 — Copy on approval

On **yes**:
1. Write the template content unmodified to `<project>/.claude/agents/<name>.md`. **No transformations** — preserve frontmatter, body, line endings.
2. If the destination exists, refuse + report. Human resolves the collision.
3. Verify by reading the first 5 lines of the destination.

On **no** / silence / ambiguous: abort, write nothing.

### Step 3 — Log + report

```
ledger_log(
  agent='bro',
  event_type='tmb_agent_created',
  summary='Copied template <name> to .claude/agents/<name>.md (template-copy mode).',
  content_json='{"name": "<name>", "mode": "template-copy"}',
)
```

Tell the Human: file landed at `<path>`. Return control. Bro then spawns the new agent for the original ask.

## F. Execution — from-scratch mode

Triggered when no shipped template matches the requested name.

### Step 1 — Discover the gap

Ask the user at most **3 clarifying questions** in a single message:

1. What role/title should this agent have?
2. What are its core responsibilities?
3. Which existing agent is closest, and what gap does the new agent fill?

Wait for answers. Do NOT draft a proposal until you have answers to all three.

### Step 2 — Read the context

1. `Glob` `.claude/agents/` to list existing project agents.
2. Check for a name collision: if `.claude/agents/<proposed-name>.md` exists, pause and switch to overwrite-confirmation flow (Section H).
3. `Glob` the project's top-level files (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `*.md`) to understand the stack and domain.

### Step 3 — Draft the prompt

Produce a Lego-shaped agent file: identity + role + boundary + `skills: []`. Body ≤25 lines. Don't bake in stack-specific content — that comes from skills attached later via `tmb_skill-creator`.

Standard frontmatter:

```yaml
---
name: <kebab-case>
description: <one sentence: role and primary capability>
model: opus                   # default for consultants
tools: Read, Glob, Grep, Bash, mcp__plugin_tmb_trajectory-server
skills: []
---

# <Title — Human-Readable Name>

Your spawn includes `consultant: analysis-only` and a specific question. Reject any spawn missing the marker.

[2-3 sentences: what this consultant focuses on, what kind of analysis it returns, how it differs from other consultants in the roster.]

Persist key points via `discussion_append(agent='<name>', kind='analysis')` or `kind='concern'`.

You decide nothing. Bro summarizes for the Human; the Human decides.

Server-rejected for you: `task_create_batch`, `task_update_status`, `validation_record`, `issue_create`, `issue_close`.

Project-specific context comes from skills the project attaches to this agent's `skills:` list. Never edit this file.
```

Field guidance:

- `name`: kebab-case (e.g. `legal-reviewer`).
- `model`: default `opus` for consultants. Use `sonnet` only if the role is mechanical / cost-sensitive.
- `tools`: minimum viable. Default is read-only + MCP. Add `Bash` only if the consultant needs to verify by running commands. Add `Write`/`Edit` ONLY if the consultant produces output files (rare; most consultants are analysis-only).
- `skills: []` — empty by default. Bro extends via `tmb_skill-creator` after creation.

### Step 4 — Show and ask (mandatory)

Present the full drafted file in a fenced code block, then ask verbatim:

> "Do you want me to create this agent? It will be written to `.claude/agents/<name>.md` and available in future sessions. (yes/no)"

Do NOT write anything until the user responds.

### Step 5 — Write on approval

On **yes**: write the file. Verify by reading the first 5 lines.
On **no** / silence / ambiguous: abort, write nothing.

### Step 6 — Log + report

```
ledger_log(
  agent='bro',
  event_type='tmb_agent_created',
  summary='Drafted + wrote <name> from scratch (no shipped template).',
  content_json='{"name": "<name>", "mode": "from-scratch"}',
)
```

Tell the Human: file landed at `<path>`. Return control.

## G. Hard rules

- **Verbatim copy in template-copy mode.** Never transform a template's body. Project customization happens via `tmb_skill-creator` extending `skills:`, never by editing the agent body.
- **Never write to `plugin/agents/`** or any path inside the plugin install. The plugin is read-only at runtime.
- **Approval is non-negotiable** — both modes require an explicit Yes.
- **Reserved names refused** — `bro`, `swe`, `pr-reviewer` always refused.
- **Existing files never overwritten silently.** Show diff or refuse, depending on mode (Section H).

## H. Error handling

| Trigger | Response |
|---|---|
| User answer is ambiguous (can't determine role/name) | Do NOT proceed. Ask again with a concrete yes/no or fill-in-the-blank prompt. |
| Target `.claude/agents/<name>.md` already exists | Read the existing file. Show a unified diff vs proposed (template or from-scratch). Ask: "This agent already exists. Overwrite? (yes/no)" |
| User requests a reserved name | Refuse: "The name `<name>` is reserved for a plugin core agent. Please choose a different name." Re-ask. |
| User attempts to skip the approval step | Refuse: "Explicit approval is required before writing any agent file. I cannot skip this step." |

## I. Edge case — code-writing consultant

If the user wants a consultant that writes source code (e.g. `data-pipeline-swe`), warn first:

> "This agent will write source code. The plugin's swe role already exists for that. Are you sure you want a parallel code-writing consultant? It will need `isolation: worktree` and `Write`/`Edit` tools, which means it bypasses bro's task-spec gating."

If they confirm, add `isolation: worktree` to frontmatter and `Write, Edit` to tools. Otherwise, propose a skill instead (use `tmb_skill-creator`) so the existing swe gains the new behavior.
