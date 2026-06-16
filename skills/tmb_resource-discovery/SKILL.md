---
name: tmb_resource-discovery
description: How bro recognizes that a task needs a capability TMB lacks (a 3rd-party skill, MCP toolkit, or plugin), calls the resource_search tool to get ranked candidates, and presents them to the Human to decide. Loaded when a request would be served by acquiring an external Claude Code resource rather than writing code.
allowed-tools: mcp__plugin_tmb_trajectory-server__resource_search, AskUserQuestion
---

# resource-discovery

## Purpose

Sometimes the cleanest way to satisfy a request is to acquire an existing Claude Code resource — a published skill, MCP toolkit, or plugin — rather than build the capability from scratch. This skill carries the one judgment that has no deterministic substitute: deciding that a capability gap exists and is worth filling externally. Search, ranking, and the audit record live inside the `resource_search` tool, so this skill stays a classification plus one call.

## The judgment: is there a capability gap?

You're looking at a request and the project's current surface (world model, installed skills/MCP, CLAUDE.md). Ask whether the task leans on a capability the project plainly lacks and that an external resource would supply better than new code. Signals that it does:

- The task names a well-trodden domain with mature tooling (PDF extraction, OCR, a cloud SDK, a protocol client) that TMB has no skill or MCP for.
- Reimplementing it in-repo would be substantial work that duplicates something the ecosystem already maintains.
- The Human framed the ask as "is there a tool/skill for X" or "can we pull in something for X".

If the request is squarely served by code you'd write anyway, or by a capability already present, this skill is irrelevant — route it through normal planning instead.

## Get ranked candidates

Once you've classified a genuine gap, name the capability in plain words and call the tool once:

`resource_search(agent='bro', capability_query='<the capability>', kind='skill'|'mcp'|'plugin'|'any')`

The tool forks the discovery script, ranks candidates by relevance and reputation, records the `resource_search` audit row, and returns the ranked list. One call covers the whole mechanical pipeline — search, rank, record — so the result is reproducible from the query alone.

Pick `kind` when the gap is clearly one shape (an MCP toolkit for a service API, a skill for a behavior, a plugin for a bundle); leave it `any` when unsure.

## Present candidates; the Human decides

Acquiring an external resource is the Human's call, not yours. Summarize the top candidates from the returned list — name, kind, what it offers, and its reputation signals — and surface the source URLs so the Human can look before anything is brought in. For a short shortlist, use AskUserQuestion with one option per candidate plus a "none of these" path; for a longer or murkier list, lay it out in prose and ask which (if any) to pursue.

Stop at the recommendation. Vetting trust signals in depth and installing a chosen candidate are later stages with their own tools and approval gate; this skill ends once the Human has the ranked options in hand.
