---
name: agent-create
description: Create or copy an agent into the project's .claude/agents/ directory. Two modes routed by tmb_agent-creator based on whether <name> exists in templates/agents/.
argument-hint: <kebab-case agent name>
---

# /tmb:agent-create <name>

Explicit Human-typed entry point for agent creation. Body invokes `tmb_agent-creator` skill.

Mode is routed by `tmb_agent-creator` based on local-file presence and template availability:

- **Branch A — already there:** `.claude/agents/<name>.md` exists → spawn via `Agent`. No copy, no register.
- **Branch B — template-copy:** file absent + `templates/agents/<name>.md` exists → copy verbatim → `agent_register(scope='project-local')` → `audit_log(tmb_agent_created)` → spawn.
- **Branch C — from-scratch:** file absent + no matching template → scaffold from `templates/agents/template.md`, ask up to 3 AUQ questions about the role, lint draft, write → register → audit → spawn.

After B or C completes, in interactive (REPL) mode only, bro emits a tail reminder: *"If your next `Agent` spawn can't find the new agent, run `/plugin-reload`."* Reminder skipped in `claude -p` runs (no second turn). MCP `agent_list` reads from DB so no reload is needed there.

The natural-language path (`@bro ask cto for X`) also triggers `tmb_agent-creator` via implicit autoload — slash and NL are complementary, not exclusive.
