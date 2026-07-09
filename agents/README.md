# agents

The plugin's shipped subagents — the roles bro dispatches a code-touching task to. Each file is a Claude Code agent definition: YAML frontmatter (name, model, tool allow-list, attached skills) followed by the persona prompt. bro itself is defined by the plugin-root `CLAUDE.md`, so it lives outside this directory; only the agents bro spawns are here.

## Agents

| File | Role | Tools / shape |
|---|---|---|
| `swe.md` | Executor — implements one task spec in an isolated git worktree, then closes it atomically. Every production code change routes through swe. | Read/Glob/Grep/Bash/Write/Edit plus `task_brief` + `task_update_status`; attached skills `tmb_swe-checklist`, `tmb_docs-conventions`. |
| `pr-reviewer.md` | Push gate — independently reviews a committed task against its spec and records the `validation_record` verdict that gates the push. Read-only on files by design (no Write/Edit). | Read/Glob/Grep/Bash/Task plus the review + audit MCP tools; attached skill `tmb_review`. |

Both carry `tmb_owner: bro` in frontmatter, marking them plugin-managed.

## Consultants

Domain experts (security, performance, legal, and the like) are not shipped here. The Human creates them on demand with the `/tmb:agent-create` command, which writes the new agent into the project's own `.claude/agents/` directory and registers it. A project may also place a local override of `swe` or `pr-reviewer` at that same path.

## How it fits

These definitions are the executor and gate halves of bro's code-touching flow: bro writes a spec, dispatches `swe` to implement it, then `pr-reviewer` signs off before anything is pushed. The frontmatter tool allow-lists keep each role scoped to what it needs, and the attached skills carry the step-by-step procedures so the persona prompts stay short.
