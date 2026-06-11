---
name: agent-create
description: Create or copy an agent into the project's .claude/agents/ directory and (optionally) spawn it on a consultant question. Self-contained — routing/enforcement comes from this command body + the prompt-intent-hints routing hook.
argument-hint: <kebab-case agent name> [optional consultant question]
---

# /tmb:agent-create `<name>` [question]

Explicit Human-typed (or hook-routed) entry point for agent creation + optional consultant spawn. User-created agents default to `kind='consultant'`.

## Resolution

Resolve the mode with `agent_resolve(agent='bro', name=<name>)` — returns `collision`, `template-copy`, or `from-scratch`. Write the file to `<project>/.claude/agents/<name>.md`, then call `agent_register(agent='bro', name, kind='consultant', scope='project-local', file_path='.claude/agents/<name>.md')`.

## Collision dialog

<!-- LOAD-BEARING-SAFETY: collision dialog is mandatory — silently overwriting user agent files is a hard doctrine violation -->
When `.claude/agents/<name>.md` already exists, read the `tmb_owner` field:

- `tmb_owner: bro` or `tmb_owner: user-adopted` → show unified diff, ask yes/no.
- No `tmb_owner` (user-authored) → AskUserQuestion with options: **Skip (Recommended)**, **Adopt + manage** (insert `tmb_owner: user-adopted`), or **Overwrite** (`tmb_owner: bro`).

## Template-copy

Show the template, ask for confirmation (interactive), then write verbatim. Template content is deterministic — reviewed at plugin release. If a follow-on question was provided, scope an issue and spawn via `Agent`.

## From-scratch

1. AskUserQuestion (up to 3 questions in one batch): role/title, core responsibilities, closest existing agent + gap.
2. Read `.claude/agents/` for name collision + stack context from top-level files.
3. Draft from `${CLAUDE_PLUGIN_ROOT}/templates/agents/template.md`. Body cap: 15 lines after frontmatter.
4. Pre-write lint: `${CLAUDE_PLUGIN_ROOT}/scripts/prompt-author-lint.sh <draft-path>`. Surface findings via AUQ.
5. Show full draft, ask for approval. Write on approval with `tmb_owner: bro` in frontmatter.

## Headless mode

If `TMB_HEADLESS=1` or AskUserQuestion errors, HALT for any creation that needs Human input. The only auto-approved path is template-copy (content is deterministic). For collision or from-scratch, surface: "Cannot create agent headless — creation requires Human review."

## Edge case — code-writing consultant

If the user wants a consultant that writes source code, warn:
> This agent will write source code. The plugin's `swe` role already exists for that. Are you sure you want a parallel code-writing consultant? It will need `isolation: worktree` and `Write`/`Edit` tools, which means it bypasses bro's task-spec gating.

If they confirm, add `isolation: worktree` to frontmatter and `Write, Edit` to tools.

## Post-create reminder

After creation completes, emit (interactive only):
> *Agent landed at `.claude/agents/<name>.md` and registered. If your next `Agent` spawn can't find it, run `/reload-plugins`.*

## Routing from naturalistic prompts

When a Human asks an expertise question without typing the slash, the `prompt-intent-hints.sh` hook injects a routing hint reminding bro to use `/tmb:agent-create <inferred-role>`.
