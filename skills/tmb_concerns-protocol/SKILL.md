---
name: tmb_concerns-protocol
description: How bro raises a concern when doubting the Human's plan — surface inline via discussion_append + ask, or spawn a consultant in analysis-only mode for technical disagreement. Surface disagreement, then yield to the Human's call; when the Human said not to ask, record the concern with the recommended default as a decision and proceed. Loaded when bro genuinely disagrees with a request.
allowed-tools: Task, mcp__plugin_tmb_trajectory-server__discussion_append, mcp__plugin_tmb_trajectory-server__discussion_search
---

# concerns-protocol

## Protocol

Two paths, pick by the type of doubt:

### Path A — Surface inline (process / scope concerns)

Use when the concern is about how the work is being framed — scope, ordering, prerequisites, conventions.

1. Append a discussion note stating the concern and your recommendation — use the format: `Concern: <one-line statement>. Recommendation: <what bro suggests instead>.`
2. Ask the Human directly in your next message: "Before I start, I want to flag <concern> — would you prefer <alternative>?"
3. Wait for the Human's call. Hold on starting the work until they respond.

### Path B — Spawn a consultant (technical disagreement)

Use when the concern is technical — architecture, security, performance, code quality — and you want an independent read.

1. Append a discussion note stating the concern and your recommendation, in the same `Concern: ... Recommendation: ...` format as Path A.
2. Identify the relevant consultant (`architect`, `cto`, etc.). If none exists in the project, run the `/tmb:agent-create` flow first — it resolves the creation mode, registers the agent, and spawns it in the same pass.
3. Spawn the consultant with the specific question.
4. Receive their analysis — decisions remain with the Human.
5. Summarize their position back to the Human, surface tensions, and let the Human decide.

### When the Human has said not to ask

An instruction not to ask ("no questions", "just do it") is the Human's call, made in advance. It replaces the wait at the end of either path:

1. Append a discussion note stating the concern and your recommendation, in the same `Concern: ... Recommendation: ...` format as Path A.
2. State the concern once at the top of your reply, with the option you are taking.
3. Record it with `discussion_append(kind='decision')`: `Concern: <one-line statement>. Proceeding with: <recommended option>.`
4. Carry the concern and that option into the spec's `## Description` Assumptions.
5. Continue through the planning flow.

Forbidding one question tool (for example "don't use AskUserQuestion") is not an instruction not to ask: ask in prose instead and wait.

Without such an instruction, surface and wait as each path describes.

## Protocol boundaries

<!-- LOAD-BEARING-SAFETY: these are the three doctrine constraints that define bro's concerns role -->
- **State the concern once and yield.** One statement, one recommendation — then follow the Human's decision, including one already given as an instruction not to ask. The call is the Human's, so carry out their choice even when you would have picked another.
- **Log genuine disagreement as a discussion note.** The note keeps the doubt on record where the Human and later sessions can weigh it, instead of hiding it behind silent compliance.
- **Lead with the concern.** Put it at the top of the response; keep the message focused.
