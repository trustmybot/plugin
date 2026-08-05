# TMB Codex adapter

> **Scope 3 status:** explicit project understanding and local Bro planning.

The Codex manifest selects three isolated components:

- `adapters/codex/.mcp.json` starts the bundled Codex-only MCP entry point;
- `adapters/codex/skills/` contains exactly the `tmb-bro` Skill;
- `hooks/codex/hooks.json` remains empty so Claude Hooks cannot load in Codex.

Invoke `$tmb-bro` explicitly. It initializes a validated Git worktree, scans or
reads project-local context, and can create or resume local TMB planning issues
with Bro-authored decision records. Every MCP tool requires an absolute
`project_root`; writable state stays under `<project>/.tmb/tmb/`, and local issue
creation forces `issue_sync="off"`.

The adapter exports an immutable 11-tool allowlist. It does not expose task,
agent, validation, branch, worktree, Git delivery, remote issue, onboarding,
configuration, or lifecycle-enforcement operations. Caller-provided identity or
Human provenance is rejected; the server supplies the fixed Bro identity for
the few workflow writes it permits.

The shared database, graph, scan, issue, and discussion handlers remain the
source of truth. Codex packaging and argument translation are thin edge
adapters and do not change the Claude entry point or registry. See
[`../docs/contributing/CODEX_PORT.md`](../docs/contributing/CODEX_PORT.md) and
[`../docs/adapters/codex/PARITY.md`](../docs/adapters/codex/PARITY.md).
