---
name: agent-create
description: Create or copy an agent into the project's .claude/agents/ directory and (optionally) spawn it on a consultant question. Self-contained — routing/enforcement comes from this command body + the prompt-intent-hints routing hook.
argument-hint: <kebab-case agent name> [optional consultant question]
---

# /tmb:agent-create `<name>` [question]

User-created agents default to `kind='consultant'`.

## Resolution

`agent_resolve(agent='bro', name=<name>)` returns the mode — `collision`, `template-copy`, or `from-scratch` — which decides the path below. Whichever path writes the file at `<project>/.claude/agents/<name>.md`, follow it with `agent_register` to record the new project-local consultant.

## Collision dialog

<!-- LOAD-BEARING-SAFETY: collision dialog is mandatory — silently overwriting user agent files is a hard doctrine violation -->
When `.claude/agents/<name>.md` already exists, read the `tmb_owner` field:

- `tmb_owner: bro` or `tmb_owner: user-adopted` → show unified diff, ask yes/no.
- No `tmb_owner` (user-authored) → AskUserQuestion with options: **Skip (Recommended)**, **Adopt + manage** (insert `tmb_owner: user-adopted`), or **Overwrite** (`tmb_owner: bro`).

## Template-copy

Show the template, ask for confirmation (interactive), then write verbatim. Template content is deterministic — reviewed at plugin release. If a follow-on question was provided, scope an issue and spawn via `Agent`.

## From-scratch

Gather the shape in one AskUserQuestion batch (up to 3 questions): role/title, core responsibilities, and the closest existing agent plus its gap. Read the top-level project files for stack context, then draft from `${CLAUDE_PLUGIN_ROOT}/templates/agents/template.md` — body cap 15 lines after frontmatter. Run the pre-write lint (`${CLAUDE_PLUGIN_ROOT}/scripts/prompt-author-lint.sh <draft-path>`) and surface its findings via AUQ. Show the full draft, and on approval write it with `tmb_owner: bro` in frontmatter.

## Headless mode

If `TMB_HEADLESS=1` or AskUserQuestion errors, HALT for any creation that needs Human input. The only auto-approved path is template-copy (content is deterministic). For collision or from-scratch, surface: "Cannot create agent headless — creation requires Human review."

## Edge case — code-writing consultant

If the user wants a consultant that writes source code, warn:
> This agent will write source code. The plugin's `swe` role already exists for that. Are you sure you want a parallel code-writing consultant? It will need `isolation: worktree` and `Write`/`Edit` tools, which means it bypasses bro's task-spec gating.

If they confirm, add `isolation: worktree` to frontmatter and `Write, Edit` to tools.

## Post-create reminder

After creation completes, emit (interactive only):
> *Agent landed at `.claude/agents/<name>.md` and registered. If your next `Agent` spawn can't find it, run `/reload-plugins`.*
