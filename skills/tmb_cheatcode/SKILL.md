---
name: tmb_cheatcode
description: When bro hits a wall — a task leans on a capability the project plainly lacks — and an existing published skill, MCP toolkit, or plugin would close the gap better than hand-rolled code. Bro names the gap, calls cheatcode_search for ranked candidates, judges which best fits this task and codebase, and recommends it for the Human to approve. Loaded when grabbing an external resource beats grinding the capability out from scratch.
allowed-tools: mcp__plugin_tmb_trajectory-server__cheatcode_search, AskUserQuestion
---

# cheatcode

When a task leans on a capability the project plainly lacks and the ecosystem already ships it — a published skill, MCP toolkit, or plugin — reach for that instead of hand-rolling.

## Is the gap real?

Check the request against the project's surface — world model, installed skills/MCP, CLAUDE.md. It's a cheatcode play when:

- The task needs a well-trodden domain with mature tooling (PDF extraction, OCR, a cloud SDK, a protocol client) and the project has nothing for it.
- Building it in-repo would duplicate something the ecosystem already maintains.
- The Human asked "is there a tool/skill for X."

If code you'd write anyway covers it, or a capability already on hand does, it's normal planning — route it that way.

## Find and recommend

Name the capability and call once:

`cheatcode_search(agent='bro', capability_query='<capability>', kind='skill'|'mcp'|'plugin'|'any')`

One call searches, ranks, and records the audit row. Pin `kind` when the shape is obvious; leave `any` when unsure.

Tier+relevance order is an input, not the verdict — you hold the actual requirement and know the codebase, so the pick is yours. Read what each candidate does, commit to the best fit (top two-three only if genuinely close), and lead with the reasoning plus its tier and source URL. Installing is a separate gate.
