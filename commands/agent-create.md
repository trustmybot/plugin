---
name: agent-create
description: Create or copy an agent into the project's .claude/agents/ directory. Two modes routed by tmb_agent-creator based on whether <name> exists in templates/agents/.
argument-hint: <kebab-case agent name>
---

# /tmb:agent-create <name>

Explicit Human-typed entry point for agent creation. Body invokes `tmb_agent-creator` skill.

Mode is routed by `tmb_agent-creator` based on whether `templates/agents/<name>.md` exists:

- **Template-copy** (Branch B): copy `templates/agents/<name>.md` to `.claude/agents/<name>.md` → register at `scope='project-local'` → write `tmb_agent_created` audit row → tell Human the file landed and remind them to `/plugin-reload` (or restart CC) so the new agent is discoverable.

- **From-scratch** (Branch C): scaffold from `templates/agents/template.md` → ask up to 3 AUQ questions about the role → write `.claude/agents/<name>.md` → register → audit → reminder.

The natural-language path (`@bro ask cto for X`) also triggers `tmb_agent-creator` via implicit autoload — slash and NL are complementary, not exclusive.
