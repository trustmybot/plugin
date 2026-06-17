# scripts

Top-level shell + Node entry scripts that the plugin's hooks, MCP tools, and Human-run release flow shell out to. These are the deterministic, language-agnostic side of TMB — work that must run identically whether triggered by a hook, an MCP tool, or a person at a terminal, with no LLM in the loop.

## Key files

| Script | Purpose |
|---|---|
| `scan.sh` | Deterministic project scanner. Walks the session dir for git repos, enumerates each repo's tracked files, computes md5 + size + last-commit SHA per file, and emits a single JSON document. Forked by the `scan_run` MCP tool to feed the world model. |
| `cheatcode-search.sh` | Discovers + ranks candidate Claude Code cheatcodes (skills, MCP/toolkits, plugins) for a capability query from reputable registries. |
| `cheatcode-vet.sh` | Gathers reputation + security-surface signals for one candidate and emits a deterministic trust-tier classification. |
| `cheatcode-install.sh` | Installs one approved cheatcode via the marketplace path and reports what was wired. |
| `cheatcode-uninstall.sh` | Reverses one installed cheatcode and reports what was torn down. |
| `release.sh` | Cuts a release from `main` after `dev` is merged and the version bump has landed. |
| `prompt-author-lint.sh` | Pre-write lint for agent + skill files — flags pink-elephant negations and other prompt anti-patterns before a prompt file is written. |

## Subdirectories

- `hooks/` — the Claude Code lifecycle hook engine (PreToolUse gates, PostToolUse reactions, SessionStart preflight, etc.).
- `lib/` — shared shell helpers sourced by the scripts and hooks above.
- `maintenance/` — operational / one-off scripts (version bump, cache healing, stale-worktree cleanup, standalone scan invokers).

## How it fits

The `cheatcode-*` scripts back the `cheatcode_*` MCP tools; `scan.sh` backs `scan_run`; `release.sh` is Human-run release tooling. Keeping this logic in deterministic scripts lets the same behavior be exercised from a hook, an MCP tool, and the test suite without re-implementation.
