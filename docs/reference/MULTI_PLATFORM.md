# TMB Multi-Platform Strategy

## Current state

**TMB's complete workflow ships on Claude Code.** Codex Scope 4 supports explicit local planning and can install two standalone project-level Agents. Those Agents are not connected to TMB task lifecycle, trusted validation, delivery gates, or functional Hooks.

## Operating systems

| OS | Claude Code workflow | Bash sandbox |
|---|---|---|
| macOS | Supported | Supported; `/onboard` defaults to Yes |
| Linux | Supported (CI runs the suite on Linux) | Not yet validated; `/onboard` defaults to No |
| Windows | WSL 2 only (native Windows is untested) | As Linux, under WSL 2; none on native Windows |

Details: [Sandbox support](./INSTALL.md#sandbox-support).

## Structure (the Superpowers pattern)

```
plugin/
├── .claude-plugin/         # Claude Code adapter — IMPLEMENTED
├── .codex-plugin/          # OpenAI Codex adapter — planning + Agent setup
├── .cursor-plugin/         # Cursor adapter — placeholder
├── .opencode/              # OpenCode adapter — placeholder
├── gemini-extension.json   # Gemini CLI manifest — placeholder
│
├── # Shared cross-platform content (single source of truth)
├── agents/                 # workflow backbone — swe + code-reviewer, ship globally
├── skills/                 # tmb_* protocol skills + default workflow skills (all global)
├── templates/agents/       # opt-in consultant templates (architect, cto, ceo, pm)
├── mcp/trajectory-server/  # Shared MCP core with isolated Claude/Codex entries
│
├── # Per-platform hook configs (CC only today)
├── hooks/hooks.json        # Claude Code event protocol
├── mcp/trajectory-server/src/hooks/  # TypeScript gates run by node; logic portable, event-name protocol CC-specific
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
| `agents/*.md` body (swe + code-reviewer) | ⚠️ Portable workflow doctrine, host-specific standalone contract | Codex Scope 4 generates separately authored TOML personas because its Agents have no task, validation, or delivery authority. Before a later scope grants that authority, Codex must use a shared host-neutral source or mechanical edge translation. |
| `agents/*.md` frontmatter | ⚠️ CC-shaped | `tools:`, `model:`, `isolation:`, `skills:` are Claude Code conventions. Other platforms may need adapter-side translation. |
| `templates/agents/*.md` (consultants) | ✓ Portable bodies, ⚠️ CC-shaped frontmatter (same as above) | Opt-in templates, not auto-installed |
| `mcp/trajectory-server/` | ⚠️ Shared core with isolated entries | Claude retains `dist/index.js` and its full registry. Codex uses `dist/codex.js` and a fixed 15-tool registry: 13 local planning tools plus two Agent materialization tools. |
| `hooks/hooks.json` | ✗ CC-only | Each platform has different hook event names + decision protocol |
| `mcp/trajectory-server/src/hooks/*.ts` | ⚠️ Partly | Gate logic is portable; the JSON-decision contract is CC-specific |
| `CLAUDE.md` (bro persona) | ⚠️ Partly | Doctrine is portable; trigger-word mechanism is CC-specific |

The placeholders explicitly say "not implemented." Planned platform work lives in GitHub issues.

## Verified Codex surfaces

Scope 4 targets Codex CLI and Desktop on macOS arm64 once fixed-SHA acceptance
is recorded. CLI `0.146.0` and `0.147.0` both hid the TMB server when the Agent
used the disabled same-name `mcp_servers` shadow; a plugin-scoped override was
not reliable. Desktop acceptance must still inspect the child Agent's live tool
surface rather than infer support from the shell CLI. The project-level Agent
files follow Codex's shared custom-Agent
format, but this scope does not claim verified IDE, cloud, non-macOS, or
stable-channel behavior. A host appearing to read the same configuration is not
enough evidence for a support claim.

## See also

- [`../contributing/CODEX_PORT.md`](../contributing/CODEX_PORT.md) — the permanent guardrails for porting a surface
- [`obra/superpowers`](https://github.com/obra/superpowers) — the canonical example of this pattern in the AI-skills ecosystem
- [`./CLAUDE.md`](../../CLAUDE.md) — the bro persona for Claude Code
- Platform files: [`./CODEX.md`](../../CODEX.md), [`./CURSOR.md`](../../CURSOR.md), [`./GEMINI.md`](../../GEMINI.md)
