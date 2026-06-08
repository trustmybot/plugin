# TMB on Cursor — placeholder

> **Status: not implemented.** TMB ships Claude Code only as of v0.7.0. This file is a placeholder for the day a Cursor adapter ships under `.cursor-plugin/`.

## What goes here when ready

The bro persona doctrine, equivalent to Claude Code's `CLAUDE.md`:

- The trigger word that activates bro on Cursor
- Cursor-equivalent first-action chain (maps to the `tmb_planning` skill flow)
- Cursor-equivalent push gate (Cursor's hook system is event-driven; the equivalent of
  `git-push-guard.sh` lives under `../hooks/cursor/`)
- Tool-name mapping (Cursor's Read/Edit/Bash equivalents)

As of v0.7.0, the shipped TMB stack is: bro persona + 8 skills + trajectory-server MCP +
enforcement hooks. Cursor's adapter would need to wire the MCP server and map the 8 hook
integration points (PreToolUse, PostToolUse, UserPromptSubmit) to Cursor's event model.

## See also

- [`./CLAUDE.md`](./CLAUDE.md) — the canonical bro persona for Claude Code
- [`./docs/reference/MULTI_PLATFORM.md`](./docs/reference/MULTI_PLATFORM.md)
- [`./.cursor-plugin/`](./.cursor-plugin/)
