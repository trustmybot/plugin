---
name: tmb_cheatcode
description: When bro hits a wall — a task leans on a capability the project plainly lacks — and an existing published skill, MCP toolkit, or plugin would close the gap better than hand-rolled code. Bro names the gap, calls resource_search for ranked candidates, and presents them to the Human to decide. Loaded when grabbing an external resource beats grinding the capability out from scratch.
allowed-tools: mcp__plugin_tmb_trajectory-server__resource_search, AskUserQuestion
---

# cheatcode

Sometimes the smart play is to stop grinding and grab a cheatcode — an external Claude Code resource (a published skill, MCP toolkit, or plugin) that hands you a capability the project doesn't have. The ecosystem already maintains the mature stuff; reaching for it beats reinventing it.

This skill carries the one call that has no deterministic substitute: spotting that the gap is real and worth filling from outside. The search, the tiered ranking, and the audit record all live inside `resource_search`, so your job is a judgment plus one call.

## Is this a real gap?

Look at the request against the project's current surface — world model, installed skills and MCP, CLAUDE.md. The cheatcode play fits when:

- The task leans on a well-trodden domain with mature tooling (PDF extraction, OCR, a cloud SDK, a protocol client) and the project has nothing for it.
- Building it in-repo would be real work that duplicates something the ecosystem already ships.
- The Human framed it as "is there a tool/skill for X" or "can we pull something in for X".

If code you'd write anyway covers it, or a capability already on hand does, this is a normal planning job — route it that way.

## Grab the ranked candidates

Name the capability in plain words and call it once:

`resource_search(agent='bro', capability_query='<the capability>', kind='skill'|'mcp'|'plugin'|'any')`

The tool forks the discovery script, queries the tiered registries (official sources rank above curated ones), records the audit row, and returns the ranked list — reproducible from the query alone. Pin `kind` when the gap is clearly one shape; leave it `any` when unsure.

## Hand it to the Human

Bringing in an external resource is the Human's call. Summarize the top candidates — name, kind, what each offers, which registry and tier vouches for it — and surface the source URLs so the Human can look before anything lands. For a short shortlist, use AskUserQuestion with one option per candidate plus a "none of these" path; for a longer or murkier list, lay it out in prose and ask which (if any) to pursue.

Stop at the recommendation. Vetting trust in depth and installing a pick are later stages with their own gates; your part ends once the Human holds the ranked options.
