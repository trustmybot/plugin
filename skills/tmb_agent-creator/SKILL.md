---
name: tmb_agent-creator
description: Add a project-local agent. PRIMARY MODE — copy from `templates/agents/<name>.md` verbatim. FALLBACK — draft from scratch when no shipped template matches the requested name. Always asks Human approval before writing. Never edits the body of any agent file.
agent: bro
allowed-tools: Read, Write, Glob, Grep, AskUserQuestion, mcp__plugin_tmb_trajectory-server__audit_log
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
| `swe.md` | Executor — implements task specs in isolated worktree, atomic close | ~23 |
| `pr-reviewer.md` | Push-time gate — reviews unsigned tasks against spec, records validation_record | ~28 |

If the Human's request matches a shipped template name → **template-copy mode**. Otherwise → **from-scratch mode**.

## D. Reserved names (always refuse)

These names map to plugin protocol roles. If the user requests one, refuse and ask for a different name:

- `bro`

Other names — including `architect`, `cto`, `ceo`, `pm`, `swe`, `pr-reviewer`, `legal-reviewer`, anything else — are allowed. Shipped templates exist for `swe`, `pr-reviewer`, `architect`, `cto`, `ceo`, `pm`; everything else uses from-scratch mode.

## E. Execution — template-copy mode

Triggered when `${CLAUDE_PLUGIN_ROOT}/templates/agents/<name>.md` exists.

### Step 1 — Show + ask

Read the template via `Read` (do not transform). Present it in a fenced code block with a one-liner explaining it's a minimal Lego template and bro will not edit the body. Ask verbatim:

> "Copy `templates/agents/<name>.md` to `.claude/agents/<name>.md` verbatim? Project-specific behavior gets attached later via `tmb_skill-creator`. (yes/no)"

### Step 2 — Copy on approval

On **yes**:
1. Write the template content unmodified to `<project>/.claude/agents/<name>.md`. **No transformations** — preserve frontmatter, body, line endings. The template already contains `tmb_owner: bro` in its frontmatter; do not strip it.
2. If the destination exists, switch to the collision flow (Section H.1) rather than refusing outright.
3. Verify by reading the first 5 lines of the destination.

On **no** / silence / ambiguous: abort, write nothing.

### Step 3 — Log + report

```
audit_log(
  agent='bro',
  kind='event',
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
tmb_owner: bro
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

On **yes**: write the file with `tmb_owner: bro` included in the YAML frontmatter. Verify by reading the first 5 lines.
On **no** / silence / ambiguous: abort, write nothing.

### Step 6 — Log + report

```
audit_log(
  agent='bro',
  kind='event',
  event_type='tmb_agent_created',
  summary='Drafted + wrote <name> from scratch (no shipped template).',
  content_json='{"name": "<name>", "mode": "from-scratch"}',
)
```

Tell the Human: file landed at `<path>`. Return control.

## F.4.5 Pink-elephant check (mandatory before approval, from-scratch mode)

Before presenting the draft to the Human for approval, scan the body for negation patterns:

- `^Don't `, `^Never `, `^Do not ` — start-of-line negative imperatives
- `MUST NOT`, mid-sentence `do not`/`don't`/`never`

For each match:
1. Surface to the Human via the approval AskUserQuestion: "Found N negation patterns. Convert to positive directives?"
2. If Human accepts: rewrite each as positive (`Don't include emojis` → `Use plain text only`)
3. If Human declines a specific one: add `<!-- LOAD-BEARING-SAFETY: <reason> -->` inline so the lint exempts it

Rationale: negation forces the model to process the forbidden concept first (pink elephant problem). Positive directives boost desired-token probability more than negatives suppress unwanted ones.

Note: template-copy mode is exempt — templates are curated post-audit.

## F.5 Pre-write check — no noise-citations

Before writing any agent file (template-copy or from-scratch), scan the body you're about to commit for these patterns. Strip or rewrite each match before saving:

| Pattern | Why it's noise |
|---|---|
| Issue numbers — `#\d+`, `(#W4)`, `[bro #1]` | The agent can't fetch issues at runtime; tokens cost every turn; IDs decay as issues close. |
| Memory file paths — `feedback_*.md`, `~/.claude/projects/<proj>/memory/...` | Memory is per-session and mutable. It is NOT canonical. Note: `~/.claude/` paths that point to runtime artifacts (logs, settings) are fine — only the memory dir is forbidden. |
| Origin attributions — `caught in`, `prior incident`, `regression during X`, `2× during Y` | Tells the LLM nothing actionable. |
| Dates — `2026-04-XX` | Decay; rot as the codebase evolves. |
| PR/MR URLs — `!\d+`, `gitlab.com/.../merge_requests/...` | Same as issue numbers. |
| Tombstones — `previously`, `no longer`, `deprecated`, `do not`, `was` (when used as migration commentary) | Pre-release means delete cleanly, not migrate-with-comments. |

Allowed:

- The rule itself, stated inline.
- Cross-references to other prompt surfaces loaded the same way: `see CLAUDE.md ## <Section>`, `see agents/<name>.md`, `see skills/<name>/SKILL.md`.
- MCP-DB references via tool name: "consult `discussion_list`", "see `audit_log_list` for X events".

If a fact really matters but you can't satisfy this without losing it, ask the Human — don't ship a prompt with noise.

## F.6 Why this rule exists

Agent and skill prompts load into the LLM context every turn the agent fires. Anything cited there must be either (a) inline (the actual rule), (b) in another canonical SE source loaded the same way (CLAUDE.md, other agent files, other skill files), or (c) in the MCP DB referenced by tool name.

Issue numbers, memory paths, "caught in", origin attributions — none of these are things the LLM can act on at runtime. They cost tokens, they decay (the issue closes, the memory gets renamed), and they bury the actual rule under historical lineage the model has no way to follow.

Citations belong in commits, MRs, and issue bodies — surfaces humans grep, not surfaces the LLM reads top-to-bottom. The two surfaces have opposite economics; the doctrine reflects that.

## G. Hard rules

- **Verbatim copy in template-copy mode.** Never transform a template's body. Project customization happens via `tmb_skill-creator` extending `skills:`, never by editing the agent body.
- **Never write to `plugin/agents/`** or any path inside the plugin install. The plugin is read-only at runtime.
- **Approval is non-negotiable** — both modes require an explicit Yes.
- **Reserved names refused** — `bro` always refused.
- **Existing files never overwritten silently.** Show diff or refuse, depending on mode (Section H).

## H. Error handling

| Trigger | Response |
|---|---|
| User answer is ambiguous (can't determine role/name) | Do NOT proceed. Ask again with a concrete yes/no or fill-in-the-blank prompt. |
| Target `.claude/agents/<name>.md` already exists | See H.1 — read the file, check `tmb_owner`, follow the appropriate collision path. |
| User requests a reserved name | Refuse: "The name `<name>` is reserved for a plugin core agent. Please choose a different name." Re-ask. |
| User attempts to skip the approval step | Refuse: "Explicit approval is required before writing any agent file. I cannot skip this step." |

### H.1 Existing-file dialog (file collision)

When the target `.claude/agents/<name>.md` already exists, do NOT silently overwrite. First, read the existing file and check its `tmb_owner` field:

- `tmb_owner: bro` (plugin-managed): refuse overwrite by default — show a unified diff, then ask whether to proceed (yes/no), since the user almost never wants to clobber a plugin-managed file. Treat as a special case; not the common collision path.
- `tmb_owner: user-adopted` (managed via prior adoption): treat exactly like `tmb_owner: bro` — show diff, ask before overwriting.
- No `tmb_owner` field (user-authored, untouched): show the unified diff vs proposed content, then call AskUserQuestion with three options:

```
AskUserQuestion({
  questions: [{
    question: "I found .claude/agents/<name>.md already. What do you want?",
    header: "Collision",
    multiSelect: false,
    options: [
      { label: "Skip (Recommended)", description: "Keep your file unchanged; abort the skill" },
      { label: "Adopt + manage", description: "Mark file managed; future updates via this skill" },
      { label: "Overwrite", description: "Replace your file with the new content (DESTRUCTIVE)" }
    ]
  }]
})
```

Behavior per choice:

- **Skip** — write nothing; audit event `tmb_agent_collision_skipped`. Report aborted, return control.
- **Adopt + manage** — preserve user's file content. Use Edit to insert `tmb_owner: user-adopted` into the YAML frontmatter (after the opening `---` line, before the closing `---`). Audit event `tmb_agent_adopted`. Report adopted, return control.
- **Overwrite** — write the proposed (template or from-scratch) content with `tmb_owner: bro` in the frontmatter. Audit event `tmb_agent_overwritten`. Report overwritten, return control.

In headless mode (`AskUserQuestion errors / TMB_HEADLESS=1`): HALT per the existing `## Headless mode — HALT, do not auto-approve` section. Never silently choose any of the three.

## I. Edge case — code-writing consultant

If the user wants a consultant that writes source code (e.g. `data-pipeline-swe`), warn first:

> "This agent will write source code. The plugin's swe role already exists for that. Are you sure you want a parallel code-writing consultant? It will need `isolation: worktree` and `Write`/`Edit` tools, which means it bypasses bro's task-spec gating."

If they confirm, add `isolation: worktree` to frontmatter and `Write, Edit` to tools. Otherwise, propose a skill instead (use `tmb_skill-creator`) so the existing swe gains the new behavior.

## Headless mode

Two modes have different headless policies:

### Template-copy mode — auto-approve

Template-copy copies a plugin-shipped file verbatim. The content is deterministic and has already been reviewed as part of the plugin release. In headless mode, proceed without the approval AUQ:

1. Write the template file to `.claude/agents/<name>.md` as normal (Step E.2).
2. Call `audit_log(agent='bro', kind='event', event_type='tmb_agent_created', summary='Copied template <name> to .claude/agents/<name>.md (template-copy mode, headless auto-approved).', content_json='{"name": "<name>", "mode": "template-copy"}')`.
3. Surface a note: "Agent `<name>` created from plugin template (headless mode — template content is deterministic)."

Then proceed to spawn the new agent for the original ask.

### From-scratch mode — HALT

From-scratch mode generates novel agent content that the Human has not reviewed. In headless mode:

1. Halt the skill immediately. Do NOT write any files.
2. Call `audit_log(agent='bro', kind='event', event_type='headless_creator_blocked', summary='tmb_agent-creator blocked: from-scratch mode requires Human approval. Cannot create agent <proposed_name> headlessly.')`.
3. Surface a clear message: "Cannot create agent from scratch in headless mode — novel content requires Human review. Re-run interactively."
