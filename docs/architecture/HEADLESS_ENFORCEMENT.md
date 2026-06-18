# Headless Enforcement

How TMB's enforcement behaves under `claude -p` (headless), and why enforced headless bro requires a `--plugin-dir` sideload rather than a marketplace install.

## Context

TMB's workflow guarantees are enforced by **hooks**, not by prompt text. The `no-source-edit-from-main` guard is what forces bro to delegate code changes to swe; the swe-boundary and push gates similarly depend on PreToolUse hooks firing. The prompts describe the workflow, but the hooks are what make it binding.

Claude Code does **not** fire marketplace plugin hooks under `claude -p` (reproduced on CC 2.0.51 and 2.1.177). Under a headless marketplace install, MCP servers, agents, and skills all load normally — only the hooks are inert. Because TMB enforcement *is* hooks, marketplace-headless bro is **unenforced**: it degrades to prompt-adherence only, with no deterministic guard backing the workflow.

The hooks do fire in two cases:

- **Interactively** — a normal `claude` session with the marketplace plugin installed fires hooks as expected.
- **Headless via `--plugin-dir` sideload** — pointing CC at the plugin directory directly (the path L5/L6 and the benchmark harness already use) fires hooks under `claude -p`.

This is a Claude Code behavior, not a TMB bug; TMB cannot change how CC loads marketplace hooks in headless mode.

## Decision

1. **Enforced headless bro requires `--plugin-dir` sideload, now.** Any headless run that must honor the workflow guards (L5/L6, benchmarks, CI) sideloads the plugin via `--plugin-dir`. This is the only path that fires hooks under `claude -p` today.

2. **Marketplace-headless is explicitly unenforced.** A marketplace-installed plugin driven via `claude -p` runs bro in prompt-adherence mode with no hook enforcement. This is documented here as a known limitation, not left as a silent gap — callers who need guarantees must sideload.

3. **Long-term: migrate critical gates to MCP-side checks.** The durable fix is to move the load-bearing gates — `no-source-edit-from-main`, swe-boundary, push-gate — into MCP-side checks that don't depend on CC hook execution. MCP servers load under headless marketplace installs, so this is the only route to enforcing marketplace-headless bro. This is a large effort tracked as a separate follow-up; it is out of scope for this document.

### Rejected: a user-settings hooks shim

Pointing a user-level `settings.json` `hooks` block at the cached plugin path would make hooks fire under marketplace-headless without changing CC. It is rejected because it is **version-coupled to the cache directory** (the path embeds the plugin version, so it breaks on `/plugin update`) and **invasively mutates the user's global settings**.

## The L5/L6 caveat

The L5/L6 enforcement gate sideloads the plugin via `--plugin-dir`. That means the gate validates the **sideload** path and does **not** exercise the marketplace-install headless path. The hooks-inert behavior of a marketplace-installed plugin under `claude -p` is therefore *not* covered by the gate — the gate is green precisely because it sideloads. This gap is intentional given the decision above (enforced headless = sideload), but it must be stated so no one reads a green L5/L6 as evidence that marketplace-headless is enforced.

## Consequences

- **Two headless modes, one enforced.** Sideloaded headless is enforced; marketplace headless is prompt-adherence only. Pick the mode that matches the trust you need.
- **Benchmarks and CI stay honest.** Because they sideload, their enforcement matches an interactive marketplace session — the comparison is apples-to-apples.
- **Marketplace-headless users are on notice.** Until the gates migrate MCP-side, anyone running bro via `claude -p` against a marketplace install gets no deterministic enforcement.
- **The real fix is MCP-side gates.** Only checks that live in the MCP server (which loads headless) can close the marketplace-headless gap.

## Upstream

The root cause is that Claude Code does not fire marketplace plugin hooks under `claude -p`. We recommend filing an upstream issue against [`anthropics/claude-code`](https://github.com/anthropics/claude-code/issues) describing the reproduction (marketplace install + `claude -p`: MCP/agents/skills load, hooks do not; sideload via `--plugin-dir` fires hooks; reproduced on 2.0.51 and 2.1.177) and requesting that marketplace hooks fire in headless mode.
