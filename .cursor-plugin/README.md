# `.cursor-plugin/` — placeholder for Cursor adapter

> **Status: not implemented.** This directory is a placeholder so the repo's structure mirrors the multi-platform pattern (Claude / Codex / Cursor / OpenCode / Gemini). TMB ships Claude Code only as of v0.1.1.

## What this would be

Once implemented, this directory would hold the Cursor adapter:

- `plugin.json` — the Cursor-format manifest pointing at shared content
- Cursor-specific hook config (Cursor's hook event names + JSON-decision protocol differ from Claude Code's; expect a separate `../hooks/cursor/hooks.json`)
- Persona loading via `../CURSOR.md` at the repo root

The shared content (skills, agent templates, MCP server, planning protocol) is already platform-agnostic. See [`../docs/multi-platform.md`](../docs/multi-platform.md).

## When this gets built

When the Cursor user community surfaces enough demand AND the per-platform hook abstraction has solidified. Cursor's plugin system is younger and may shift; tracking issue keeps tabs.
