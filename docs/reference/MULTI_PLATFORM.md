# TMB Multi-Platform Strategy

## Current state

**TMB's complete workflow ships on Claude Code.** Codex Scope 5 supports local planning, explicit setup of two standalone project-level Agents, and a bounded repository-write Hook. It still has no TMB task lifecycle, trusted validation, or delivery workflow.

## Vision

Many AI coding agents now exist (Claude Code, OpenAI Codex, Cursor, OpenCode, Gemini CLI, GitHub Copilot CLI, others). The bro doctrine — Human → bro → SWE with pr-reviewer as push gate, Lego templates, lazy-bootstrap project setup, full audit trail in SQLite — is **platform-agnostic** in concept. The implementation is currently Claude-Code-shaped, but most of the content (skills, agent templates, planning protocol, MCP server) would port cleanly.

This doc describes how the repo is structured to make that port realistic when there's demand.

## Structure (the Superpowers pattern)

```
plugin/
├── .claude-plugin/         # Claude Code adapter — IMPLEMENTED
├── .codex-plugin/          # OpenAI Codex adapter — planning + Agent setup + Hook
├── .cursor-plugin/         # Cursor adapter — placeholder
├── .opencode/              # OpenCode adapter — placeholder
├── gemini-extension.json   # Gemini CLI manifest — placeholder
│
├── # Shared cross-platform content (single source of truth)
├── agents/                 # workflow backbone — swe + pr-reviewer, ship globally
├── skills/                 # tmb_* protocol skills + default workflow skills (all global)
├── templates/agents/       # opt-in consultant templates (architect, cto, ceo, pm)
├── mcp/trajectory-server/  # Shared MCP core with isolated Claude/Codex entries
│
├── # Per-platform hook configs
├── hooks/hooks.json        # Claude Code event protocol
├── hooks/codex/hooks.json  # Codex PreToolUse dispatcher
├── scripts/hooks/          # Shell scripts; logic portable, event-name protocol CC-specific
│
├── # Per-platform persona/loading files
├── CLAUDE.md               # bro persona for Claude Code — IMPLEMENTED
├── CODEX.md                # current Codex scope and usage boundary
├── CURSOR.md               # placeholder
└── GEMINI.md               # placeholder
```

The pattern, copied from [`obra/superpowers`](https://github.com/obra/superpowers): **a single shared source of truth for protected workflow skills, shared protected personas, and MCP, with thin per-platform manifests in `.<platform>-plugin/` directories that point at shared content via relative paths.** Host-local standalone surfaces are narrow, declared exceptions under the [adapter contract](../adapters/ADAPTER_CONTRACT.md); they do not duplicate protected workflow content or receive protected-core authority. Versions remain coordinated through the per-platform manifests' `version` field.

## What's already portable

| Asset | Status | Notes |
|---|---|---|
| Claude `skills/*` | ⚠️ Portable ideas, host-specific packaging | Codex exposes two separately authored adapter Skills; it does not load the Claude skill catalog. |
| `agents/*.md` body (swe + pr-reviewer) | ⚠️ Portable workflow doctrine, host-specific standalone contract | Codex Scope 4 generates separately authored TOML personas because its Agents have no task, validation, or delivery authority. Before a later scope grants that authority, Codex must use a shared host-neutral source or mechanical edge translation. |
| `agents/*.md` frontmatter | ⚠️ CC-shaped | `tools:`, `model:`, `isolation:`, `skills:` are Claude Code conventions. Other platforms may need adapter-side translation. |
| `templates/agents/*.md` (consultants) | ✓ Portable bodies, ⚠️ CC-shaped frontmatter (same as above) | Opt-in templates, not auto-installed |
| `mcp/trajectory-server/` | ⚠️ Shared core with isolated entries | Claude retains `dist/index.js` and its full registry. Codex uses `dist/codex.js` and a fixed 15-tool registry: 13 local planning tools plus two Agent materialization tools. |
| Hook manifests | ⚠️ Host-specific | Claude keeps `hooks/hooks.json`; Codex uses `hooks/codex/hooks.json` plus a zero-dependency ESM policy. Event and decision protocols are not shared. |
| `scripts/hooks/*.sh` | ⚠️ Partly | Shell logic is portable; the JSON-decision contract is CC-specific |
| `CLAUDE.md` (bro persona) | ⚠️ Partly | Doctrine is portable; trigger-word mechanism is CC-specific |

## What an adapter would do

For later Codex scopes, or when another platform adapter gets built, the work is:

1. Extend the platform's verified packaging and discovery mechanism without widening incomplete surfaces.
2. Author the platform's persona file (`CODEX.md`, `CURSOR.md`, `GEMINI.md`) — the bro doctrine adapted to the platform's tool names + trigger mechanism.
3. Author the platform's hook configs under `hooks/<platform>/` — translating the doctrine-level rules (no commits to protected, no push without review, etc.) into the platform's native hook event names.
4. Possibly a build/sync script under `scripts/sync-to-<platform>-marketplace.sh` if the platform's marketplace requires a separate fork repo (Superpowers does this for Codex).

The shared MCP foundations remain intact, while prompts, manifests, Agent configuration, and host enforcement stay at the platform edge. A port reuses behavior only where the host contract can support and verify it.

## Why the remaining placeholders stay

Two reasons:

1. **Discoverability.** Anyone browsing the repo sees `.codex-plugin/` and immediately understands TMB's vision. No conversation needed.
2. **Path-precedent.** When we do ship Codex/Cursor/Gemini support, the directory structure already separates shared content from platform adapters. A real adapter still needs verified installation, runtime dispatch, configuration, and validation; filling in a placeholder manifest alone is not sufficient.

The remaining placeholders explicitly say "not implemented." Codex documentation states its narrower Scope-5 boundary instead of implying the complete Claude workflow is available.

## Verified Codex surfaces

Scope 5 targets Codex CLI and Desktop on macOS arm64. Clean-commit automated
acceptance passed on CLI `0.146.0` and Desktop 26.820.60940's bundled
`codex-cli 0.150.0-alpha.8`. Both loaded the plugin Hook from installed-cache and
blocked primary `apply_patch`, redirected shell writes, and persistent command
receivers before execution; a linked-worktree patch succeeded. The Hook payload
in these runs did not expose MCP provider identity, so TMB MCP calls fail closed
when project-level `.codex/config.toml` could shadow the bundled server. The
launcher returns an internal deny after four seconds rather than relying on the
host's five-second timeout, which can continue the tool call. Separately, CLI
`0.146.0` and `0.147.0` both hid the TMB server when the Agent
used the disabled same-name `mcp_servers` shadow; a plugin-scoped override was
not reliable. Desktop Hook and Agent acceptance must still inspect the live tool
surface rather than infer support from the shell CLI. The project-level Agent
files follow Codex's shared custom-Agent
format, but this scope does not claim verified IDE, cloud, non-macOS, or
stable-channel behavior. A host appearing to read the same configuration is not
enough evidence for a support claim.

## When later adapter scopes get built

Driven by user demand, not by completionism. Each scope ports one verified surface while preserving the existing Claude behavior. The permanent guardrails are in [`../contributing/CODEX_PORT.md`](../contributing/CODEX_PORT.md).

## See also

- [`obra/superpowers`](https://github.com/obra/superpowers) — the canonical example of this pattern in the AI-skills ecosystem
- [`./CLAUDE.md`](../../CLAUDE.md) — the bro persona for Claude Code
- Platform files: [`./CODEX.md`](../../CODEX.md), [`./CURSOR.md`](../../CURSOR.md), [`./GEMINI.md`](../../GEMINI.md)
