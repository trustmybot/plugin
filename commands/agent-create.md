---
name: agent-create
description: Create an agent in <project>/.claude/agents/ and (optionally) spawn it on a consultant question.
argument-hint: <kebab-case agent name> [optional consultant question]
---

# /tmb:agent-create `<name>` [question]

User-created agents default to `kind='consultant'`.

## Resolution

`agent_resolve(agent='bro', name=<name>)` returns the mode — `collision` or `from-scratch` — which decides the path below. Whichever path writes the file at `<project>/.claude/agents/<name>.md`, follow it with `agent_register` to record the new project-local consultant. If a follow-on question was provided, scope an issue and spawn the agent on it via `Agent`.

Every write of that file — from-scratch or a collision answer that changes it (a diff Yes, **Adopt + manage**, **Overwrite**) — comes after the Human's approval and one `audit_append(agent='bro', from_node='bro', issue_id=<in-flight issue, else -1>, event_type='prompt_write_approved', summary=<what the Human approved>, content_json='{"path":"<path>","scope":"full"}')`, where `<path>` is the file's absolute canonical path (symlinks resolved, spelled as you will write it). An approval holds for 30 minutes.

## Collision dialog

<!-- LOAD-BEARING-SAFETY: collision dialog is mandatory — silently overwriting user agent files is a hard doctrine violation -->
When `<project>/.claude/agents/<name>.md` already exists, read the `tmb_owner` field:

- `tmb_owner: bro` or `tmb_owner: user-adopted` → show unified diff, ask yes/no.
- No `tmb_owner` (user-authored) → AskUserQuestion with options: **Skip (Recommended)**, **Adopt + manage** (insert `tmb_owner: user-adopted`), or **Overwrite** (`tmb_owner: bro`).

## From-scratch

Gather the shape in one AskUserQuestion batch (up to 3 questions): role/title, core responsibilities, and the closest existing agent plus its gap. Read the top-level project files for stack context, then draft from `${CLAUDE_PLUGIN_ROOT}/templates/agents/template.md` at `<project>/.claude/tmb/prompt-drafts/<name>.md` — body cap 15 lines after frontmatter. Run the pre-write lint (`node --experimental-sqlite "${CLAUDE_PLUGIN_ROOT}/mcp/trajectory-server/dist/cli.js" prompt-author-lint <project>/.claude/tmb/prompt-drafts/<name>.md`) and surface its findings via AUQ. Show the full draft, and on approval, after the `prompt_write_approved` row above, write it to `<project>/.claude/agents/<name>.md` with `tmb_owner: bro` in frontmatter.

## Edge case — code-writing consultant

If the user wants a consultant that writes source code, warn:
> This agent will write source code. The plugin's `swe` role already exists for that. Are you sure you want a parallel code-writing consultant? It will need `isolation: worktree` and `Write`/`Edit` tools, which means it bypasses bro's task-spec gating.

If they confirm, add `isolation: worktree` to frontmatter and `Write, Edit` to tools.

## Prompt-cache TTL

Every agent written from scratch keeps the `experimental:` / `  cacheTtl:` block as the last frontmatter key. Use `5m` by default; choose `1h` only for an agent expected to run multi-minute commands (builds, full test suites) between turns.

## Post-create reminder

After creation completes, emit (interactive only):
> *Agent landed at `<project>/.claude/agents/<name>.md` and registered. If your next `Agent` spawn can't find it, fully quit and relaunch Claude Code.*
