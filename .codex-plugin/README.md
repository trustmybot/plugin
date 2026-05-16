# `.codex-plugin/` — placeholder for OpenAI Codex adapter

> **Status: not implemented.** This directory is a placeholder so the repo's structure mirrors the multi-platform pattern (Claude / Codex / Cursor / OpenCode / Gemini). TMB ships Claude Code only as of v0.1.1.

## What this would be

Once implemented, this directory would hold the OpenAI Codex adapter:

- `plugin.json` — the Codex-format manifest pointing at the shared `./agents/` (workflow backbone), `./skills/` (protocol + default skills), and `./templates/agents/` (opt-in consultants) directories at the repo root
- Any Codex-specific persona/loading file (likely `../CODEX.md` at the repo root)
- Any Codex-specific hook scripts under `../hooks/codex/`

The shared content (skills, agent templates, MCP server, planning protocol) is already platform-agnostic and would be referenced via relative paths — no duplication. See [`../docs/MULTI_PLATFORM.md`](../docs/MULTI_PLATFORM.md) for the strategy and [Superpowers](https://github.com/obra/superpowers) for the canonical example of this pattern.

## When this gets built

When (a) there's user demand for TMB on Codex, AND (b) the Claude Code experience is stable enough that maintaining a parallel adapter is sustainable. Track via the multi-platform tracking issue.
