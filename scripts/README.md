# scripts

Top-level shell + Node entry scripts that the plugin's hooks, MCP tools, and Human-run release flow shell out to. These are the deterministic, language-agnostic side of TMB — work that must run identically whether triggered by a hook, an MCP tool, or a person at a terminal, with no LLM in the loop.

## Key files

| Script | Purpose |
|---|---|
| `release.ts` | Run as `node --experimental-strip-types scripts/release.ts`. Cuts a release from `main` after `dev` is merged and the version bump has landed. |
| `prompt-author-lint.sh` | Pre-write lint for agent + skill files — flags pink-elephant negations and other prompt anti-patterns before a prompt file is written. |

## Subdirectories

- `hooks/` — the Claude Code lifecycle hook engine (PreToolUse gates, PostToolUse reactions, SessionStart preflight, etc.).
- `lib/` — shared shell helpers sourced by the scripts and hooks above.
- `maintenance/` — operational / one-off scripts (version bump, cache healing, stale-worktree cleanup, standalone scan invokers).

## How it fits

`release.ts` is Human-run release tooling; `scan_run` and the `cheatcode_*` MCP tools run in-process TypeScript under `mcp/trajectory-server/src/tools/`. Keeping this logic in deterministic scripts lets the same behavior be exercised from a hook, an MCP tool, and the test suite without re-implementation.
