---
name: tmb_cheatcode
description: When bro hits a wall — a task leans on a capability the project plainly lacks — and an existing published skill, MCP toolkit, or plugin would close the gap better than hand-rolled code. Bro names the gap, calls resource_search for ranked candidates, judges which best fits this task and codebase, and recommends it for the Human to approve. Loaded when grabbing an external resource beats grinding the capability out from scratch.
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

## Pick the best fit and recommend it

This is the part the Human can't do themselves — they rarely know which candidate is good, or even where to look. You do: you hold their actual requirement and you know how this codebase is put together. So the choice is yours to make, not theirs to decode.

The tool's tier+relevance order is an input, not the verdict. Read what each candidate actually does and weigh it against this task and this codebase, then commit to a pick — the single best fit, or the top two or three only when they're genuinely close. Lead with it and the reasoning: "this one — it covers <requirement> and slots into <where it lands in the codebase>", with its registry/tier and source URL so it can be looked at.

Bringing it in is still the Human's approval — the install stage has its own gate — but you're handing them a reasoned recommendation to approve, not a raw list to pick through. Vetting trust in depth and installing the pick are the later stages.
