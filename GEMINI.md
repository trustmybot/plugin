# TMB on Gemini CLI — placeholder

> **Status: not implemented.** TMB ships Claude Code only as of v0.1.1. This file is a placeholder for the day a Gemini CLI adapter ships.

## What goes here when ready

Gemini CLI extensions reference a `contextFileName` (configured via `gemini-extension.json` at the repo root). When Gemini loads TMB, this file becomes the system context. It will hold:

- The bro persona doctrine
- Skill loading instructions specific to Gemini's tool surface
- `@./skills/...` references to the shared skill library at `./skills/` (Gemini auto-resolves these)

Gemini's plugin model is closer to "context file + auto-discovery" than to manifest-driven, so this single file does most of the work.

## See also

- [`./CLAUDE.md`](./CLAUDE.md) — the canonical bro persona for Claude Code
- [`./docs/multi-platform.md`](./docs/multi-platform.md)
- [`./gemini-extension.json`](./gemini-extension.json) — the manifest placeholder
