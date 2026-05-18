# TMB on Gemini CLI — placeholder

> **Status: not implemented.** TMB ships Claude Code only as of v0.7.0. This file is a placeholder for the day a Gemini CLI adapter ships under `.gemini-plugin/`.

## What goes here when ready

Gemini CLI extensions reference a `contextFileName` (configured via `gemini-extension.json` at the repo root). When Gemini loads TMB, this file becomes the system context. It will hold:

- The bro persona doctrine (adapted from `CLAUDE.md`)
- Skill loading instructions specific to Gemini's tool surface
- `@./skills/...` references to the shared skill library at `./skills/` (Gemini auto-resolves these)

As of v0.7.0, the shipped TMB stack is: bro persona + 8 skills + trajectory-server MCP +
enforcement hooks. Gemini's adapter would need to: wire the trajectory-server MCP (Gemini
CLI supports MCP servers via `mcpServers` in `gemini-extension.json`), map Gemini's tool
names to TMB's MCP calls, and determine how to replicate the PreToolUse / PostToolUse hook
enforcement layer (Gemini's extension model is context-file-first, not hook-first).

Gemini's plugin model is closer to "context file + auto-discovery" than to manifest-driven,
so this single file does most of the work.

## See also

- [`./CLAUDE.md`](./CLAUDE.md) — the canonical bro persona for Claude Code
- [`./docs/MULTI_PLATFORM.md`](./docs/MULTI_PLATFORM.md)
- [`./gemini-extension.json`](./gemini-extension.json) — the manifest placeholder
