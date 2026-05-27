# TMB Multi-Platform Strategy

## Current state

**TMB ships Claude Code only.** Everything in this repo runs against Claude Code's plugin system: `.claude-plugin/plugin.json`, `agents/*.md` and `skills/<name>/SKILL.md` discovery, the `${CLAUDE_PLUGIN_ROOT}` substitution, the PreToolUse hook event protocol, and the bundled MCP server invoked via `.mcp.json`.

## Vision

Many AI coding agents now exist (Claude Code, OpenAI Codex, Cursor, OpenCode, Gemini CLI, GitHub Copilot CLI, others). The bro doctrine — Human → bro → SWE with pr-reviewer as push gate, Lego templates, lazy-bootstrap project setup, full audit trail in SQLite — is **platform-agnostic** in concept. The implementation is currently Claude-Code-shaped, but most of the content (skills, agent templates, planning protocol, MCP server) would port cleanly.

This doc describes how the repo is structured to make that port realistic when there's demand.

## Structure (the Superpowers pattern)

```
plugin/
├── .claude-plugin/         # Claude Code adapter — IMPLEMENTED
├── .codex-plugin/          # OpenAI Codex adapter — placeholder
├── .cursor-plugin/         # Cursor adapter — placeholder
├── .opencode/              # OpenCode adapter — placeholder
├── gemini-extension.json   # Gemini CLI manifest — placeholder
│
├── # Shared cross-platform content (single source of truth)
├── agents/                 # workflow backbone — swe + pr-reviewer, ship globally
├── skills/                 # tmb_* protocol skills + default workflow skills (all global)
├── templates/agents/       # opt-in consultant templates (architect, cto, ceo, pm)
├── mcp/trajectory-server/  # MCP server — already cross-platform (MCP is the emerging standard)
│
├── # Per-platform hook configs (CC only today; future: hooks/<platform>/)
├── hooks/hooks.json        # Claude Code event protocol
├── scripts/hooks/          # Shell scripts; logic portable, event-name protocol CC-specific
│
├── # Per-platform persona/loading files
├── CLAUDE.md               # bro persona for Claude Code — IMPLEMENTED
├── CODEX.md                # placeholder
├── CURSOR.md               # placeholder
└── GEMINI.md               # placeholder
```

The pattern, copied from [`obra/superpowers`](https://github.com/obra/superpowers): **a single shared source-of-truth for skills/agents/MCP, with thin per-platform manifests in `.<platform>-plugin/` directories that point at the shared content via relative paths.** No content duplication; version coordinated via the per-platform manifests' `version` field.

## What's already portable

| Asset | Status | Notes |
|---|---|---|
| `skills/*` (all — protocol + default) | ✓ Portable | Skill format is shared (Claude/Codex/Cursor all read frontmatter + markdown body) |
| `agents/*.md` body (swe + pr-reviewer) | ✓ Portable | Body is platform-agnostic |
| `agents/*.md` frontmatter | ⚠️ CC-shaped | `tools:`, `model:`, `isolation:`, `skills:` are Claude Code conventions. Other platforms may need adapter-side translation. |
| `templates/agents/*.md` (consultants) | ✓ Portable bodies, ⚠️ CC-shaped frontmatter (same as above) | Opt-in templates, not auto-installed |
| `mcp/trajectory-server/` | ✓ Portable | MCP is the cross-platform standard (Anthropic + OpenAI + Cursor all support) |
| `hooks/hooks.json` | ✗ CC-only | Each platform has different hook event names + decision protocol |
| `scripts/hooks/*.sh` | ⚠️ Partly | Shell logic is portable; the JSON-decision contract is CC-specific |
| `CLAUDE.md` (bro persona) | ⚠️ Partly | Doctrine is portable; trigger-word mechanism is CC-specific |

## What an adapter would do

When a Codex adapter (or Cursor / OpenCode / Gemini) gets built, the work is:

1. Author the platform's manifest in `.<platform>-plugin/plugin.json`. Most fields point at shared content via relative paths (`"skills": "./skills/"`, etc.).
2. Author the platform's persona file (`CODEX.md`, `CURSOR.md`, `GEMINI.md`) — the bro doctrine adapted to the platform's tool names + trigger mechanism.
3. Author the platform's hook configs under `hooks/<platform>/` — translating the doctrine-level rules (no commits to protected, no push without review, etc.) into the platform's native hook event names.
4. Possibly a build/sync script under `scripts/sync-to-<platform>-marketplace.sh` if the platform's marketplace requires a separate fork repo (Superpowers does this for Codex).

The shared skill library + MCP server + planning protocol stay intact. Only the platform-edge translation layer is per-platform.

## Why placeholders now

Two reasons:

1. **Discoverability.** Anyone browsing the repo sees `.codex-plugin/` and immediately understands TMB's vision. No conversation needed.
2. **Path-precedent.** When we DO want to ship Codex/Cursor/Gemini support, the directory structure is already there. The actual work shrinks to "fill in the manifest" rather than "restructure the repo."

The placeholders explicitly say "not implemented." They don't pretend to support what they don't. They're a north star, not a feature claim.

## When real adapters get built

Driven by user demand, not by completionism. If 100 people ask for Codex support, we ship a Codex adapter. If nobody asks, the placeholders stay placeholders forever — and the repo still benefits from the structural clarity. The pattern is cheap to maintain and free to delete if priorities shift.

## See also

- [`obra/superpowers`](https://github.com/obra/superpowers) — the canonical example of this pattern in the AI-skills ecosystem
- [`./CLAUDE.md`](../../CLAUDE.md) — the bro persona for Claude Code
- The placeholder per-platform persona files: [`./CODEX.md`](../../CODEX.md), [`./CURSOR.md`](../../CURSOR.md), [`./GEMINI.md`](../../GEMINI.md)
